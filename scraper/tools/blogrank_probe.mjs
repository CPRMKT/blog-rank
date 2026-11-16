// 블로그 순위 불일치 확인 — **조회 전용(저장 0건)**.
//
// 왜: 화면이 "3위"라고 하는데 사장님이 네이버에서 본 순서와 다르다는 신고가 있을 때,
// 무엇을 보고 3위라고 했는지를 그 자리에서 보여 주는 도구다. 세 가지를 한 번에 찍는다.
//   1) 최신순(sort=date) 상위 10개 — 우리 수집이 쓰는 목록
//   2) 관련도순(nso=so:r) 상위 10개 — 사장님이 보는 기본 화면에 가까운 목록
//   3) 운영 경로(/api/store-rank)가 돌려주는 매칭 결과 — 몇 위의 어떤 글을 우리 글로 봤는지
// 1과 3이 같고 2가 다르면 "정렬 기준 차이"이고, 1과 3이 다르면 매칭 쪽 문제다.
//
// 안전장치: 심야(KST 02:00~05:30)에만, 수집이 안 돌 때만, 요청 상한 안에서만 돈다. DB는 건드리지 않는다.
// 사용: node tools/blogrank_probe.mjs --keyword="해운대 연말모임" [--store=4] [--top=10] [--force]
// 결과: /var/log/blog-rank-scraper/blogrank-probe-<날짜>.txt / .json
import fs from 'fs';
import { execSync } from 'child_process';
import { scrapeBlogTab, closeBrowser } from '../src/scraper.js';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const has = (k) => process.argv.includes(`--${k}`);

const KEYWORD = arg('keyword', '');
const STORE_ID = parseInt(arg('store', '0'), 10);
const TOP = Math.min(20, Math.max(5, parseInt(arg('top', '10'), 10)));
const FORCE = has('force');
const MAX_REQ = Math.min(6, Math.max(1, parseInt(arg('max-requests', '4'), 10)));
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const LOG_DIR = '/var/log/blog-rank-scraper';

const kst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const kstDate = () => kst().slice(0, 10);
const hh = () => parseInt(kst().slice(11, 13), 10);
const mm = () => parseInt(kst().slice(14, 16), 10);
const tooLate = () => hh() > 5 || (hh() === 5 && mm() >= 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = [];
const log = (m) => { const l = `[${kst()} KST] ${m}`; console.log(l); T.push(l); };
const collecting = () => {
  for (const p of ['[c]ollectPlace.mjs', '[c]ollect.mjs']) {
    try { execSync(`pgrep -f "${p}"`, { stdio: 'ignore' }); return p.replace(/[[\]]/g, ''); } catch {}
  }
  return null;
};
const db = async (action, data = {}) => fetch(`${BASE}/api/db`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
  body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(60000),
}).then((r) => r.json());

// 운영 수집과 같은 이름 토큰 규칙(scraper.js rankNameTokens와 같은 규칙을 눈으로 확인하기 위한 사본)
const nameTokens = (name) => {
  const raw = String(name || '').trim(); if (!raw) return [];
  const sq = (x) => x.replace(/\s+/g, ''); const out = new Set();
  if (sq(raw).length >= 3) out.add(sq(raw));
  const first = raw.split(/\s+/)[0] || ''; if (first.length >= 3) out.add(sq(first));
  const nb = raw.replace(/\s*[가-힣A-Za-z0-9]*(?:본점|직영점|점)\s*$/, '').trim();
  if (nb && sq(nb).length >= 3) out.add(sq(nb));
  return [...out];
};

async function main() {
  if (!KEYWORD) { console.log('--keyword=... 가 필요하다.'); return; }
  if (!FORCE && (hh() < 2 || tooLate())) { console.log(`심야(02:00~05:30) 밖이라 돌지 않는다 — 지금 ${kst()} KST.`); return; }
  const busy = collecting();
  if (busy) { console.log(`수집(${busy})이 돌고 있어 중단한다.`); return; }
  // 오늘 결과가 이미 있으면 다시 돌지 않는다(재시도 크론이 예산을 두 번 쓰지 않게).
  if (!FORCE && fs.existsSync(`${LOG_DIR}/blogrank-probe-${kstDate()}.json`)) {
    console.log(`오늘(${kstDate()}) 결과가 이미 있다 — 다시 돌지 않는다.`); return;
  }

  // 매장 정보(DB 읽기 — 네이버 요청 아님)
  const stores = (await db('list_stores')).result || [];
  const store = STORE_ID ? stores.find((s) => String(s.id) === String(STORE_ID)) : null;
  const tokens = store ? nameTokens(store.name) : [];
  log(`블로그 순위 확인 — "${KEYWORD}"${store ? ` / 매장 ${store.id} ${store.name}` : ''} (조회 전용, 요청 상한 ${MAX_REQ}건)`);
  if (store) log(`  이름 매칭 토큰: ${tokens.join(', ') || '(없음)'} | place_id ${store.place_id || '없음'}`);

  const out = { date: kstDate(), at: new Date().toISOString(), keyword: KEYWORD, store: store ? { id: store.id, name: store.name, place_id: store.place_id } : null, tokens, lists: {}, production: null };
  let used = 0;
  const grab = async (sort, label) => {
    if (used >= MAX_REQ || tooLate()) { log(`  ${label}: 상한/시간으로 건너뜀`); return; }
    used++;
    const t0 = Date.now();
    try {
      const items = await scrapeBlogTab(KEYWORD, TOP, sort);
      const list = (items || []).slice(0, TOP).map((x, i) => ({
        rank: x.rank || i + 1, title: String(x.title || '').replace(/<[^>]+>/g, ''),
        blogId: x.blogId || '', link: x.link || x.url || '',
        // scrapeBlogTab은 제목만 돌려준다(본문·요약 없음) → 여기 ★는 '제목에 가게 이름이 보인다'는 뜻이다.
        // 운영 매칭은 요약문과 본문까지 보므로, ★가 없어도 운영 경로에서는 매칭될 수 있다.
        hitTitle: tokens.some((t) => String(x.title || '').replace(/\s+/g, '').includes(t)),
      }));
      out.lists[sort] = list;
      log(`  ${label} 상위 ${list.length}개 (${Date.now() - t0}ms, 누적 ${used}건)`);
      for (const x of list) log(`    ${String(x.rank).padStart(2)}위 ${x.hitTitle ? '★제목에 가게이름' : '                '} ${x.blogId} | ${x.title.slice(0, 48)}`);
    } catch (e) { out.lists[sort] = { error: e.message }; log(`  ${label} 실패: ${e.message}`); }
    await sleep(20000);
  };

  await grab('date', '최신순(우리 수집 기준)');
  await grab('rel', '관련도순(화면 기본에 가까움)');

  // 운영 경로 그대로 한 번 — 저장은 하지 않는다(store-rank는 읽기 전용 조회 API다)
  if (store && used < MAX_REQ && !tooLate()) {
    used++;
    const p = new URLSearchParams({ keyword: KEYWORD, placeId: store.place_id || '', storeName: store.name || '', count: '300' });
    try {
      const d = await fetch(`${BASE}/api/store-rank?${p.toString()}`, { signal: AbortSignal.timeout(180000) }).then((r) => r.json());
      const ms = (d && d.matches) || [];
      out.production = { ok: !!(d && d.ok), rank: ms.length ? ms[0].rank : 0, scanned: d && (d.scanned || d.searchCount || d.total), matches: ms.slice(0, 5) };
      log(`  운영 경로(/api/store-rank) → ${ms.length ? ms[0].rank + '위' : '매칭 없음'} / 스캔 ${out.production.scanned || '?'}건`);
      for (const m of ms.slice(0, 5)) log(`    ${m.rank}위 ${String(m.title || '').replace(/<[^>]+>/g, '').slice(0, 48)} | ${m.link || m.url || ''}`);
    } catch (e) { out.production = { error: e.message }; log(`  운영 경로 실패: ${e.message}`); }
  }

  out.requests_used = used;
  fs.writeFileSync(`${LOG_DIR}/blogrank-probe-${kstDate()}.json`, JSON.stringify(out, null, 1));
  fs.appendFileSync(`${LOG_DIR}/blogrank-probe-${kstDate()}.txt`, T.join('\n') + '\n');
  log(`끝 — 요청 ${used}건. 결과: ${LOG_DIR}/blogrank-probe-${kstDate()}.txt`);
  await closeBrowser().catch(() => {});
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
