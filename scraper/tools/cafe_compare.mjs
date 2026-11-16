// 카페·디저트 키워드 정확도 대조 — **조회 전용(저장 0건)**.
//
// 왜: 2026-11-16에 단어 기반 카페 차단을 없애고 /restaurant/list 경로로 보내게 바꿨다.
// 그 경로로 카페 키워드가 "쓸 만한 목록"을 주는지 확인해야 켜 둘 수 있다. 확인 항목은 세 가지다.
//   (a) 0곳이 나오는지
//   (b) 같은 키워드를 두 번 조회했을 때 상위 10곳이 일치하는지(회차마다 목록이 바뀌는지)
//   (c) 캡처된 GraphQL 연산자 이름이 허용 목록(LIST_OPS)에 있는지 — '신규 오픈' 모듈 오염 재발 감시
//
// 안전장치(네이버 요청을 흘리지 않기 위한 것들):
//   · 심야(KST 02:00~05:00)에만 돈다. 05:30 넘으면 시작하지 않고, 도중에도 멈춘다(05:50 pm2 재시작 전 종료).
//   · 수집(collect.mjs / collectPlace.mjs)이 돌고 있으면 즉시 중단한다.
//   · 요청 상한을 둔다(기본 12건 = 키워드 5개 × 2회 + 여유 2). 상한에 닿으면 그 자리에서 끝낸다.
//   · 유효기간이 있다(EXPIRES). 지나면 --force 없이는 돌지 않는다 — 임시 측정이 조용히 상주하는 걸 막는다.
//   · DB를 건드리지 않는다. 이 파일에는 저장 호출이 없다.
//
// 사용: node tools/cafe_compare.mjs [--keywords=a,b] [--rounds=2] [--count=30] [--max-requests=12] [--gap=60] [--force]
// 결과: /var/log/blog-rank-scraper/cafe-compare-<날짜>.json / .txt
import fs from 'fs';
import { execSync } from 'child_process';
import { scrapePlaceSearch, LIST_OPS } from '../src/placeSearch.js';
import { closeBrowser } from '../src/scraper.js';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const has = (k) => process.argv.includes(`--${k}`);

const KEYWORDS = arg('keywords', '해운대 카페,해운대 디저트,광안리 카페,동래 카페,수원 카페').split(',').map((s) => s.trim()).filter(Boolean);
const ROUNDS = Math.min(2, Math.max(1, parseInt(arg('rounds', '2'), 10)));
const COUNT = Math.min(50, Math.max(10, parseInt(arg('count', '30'), 10)));
const MAX_REQ = Math.min(12, Math.max(1, parseInt(arg('max-requests', '12'), 10)));   // 하루 요청 상한(하드)
const GAP_MS = Math.max(20000, parseInt(arg('gap', '60'), 10) * 1000);
const FORCE = has('force');
const EXPIRES = '2026-11-20';   // 이 날짜가 지나면 --force 없이는 안 돈다

const LOG_DIR = '/var/log/blog-rank-scraper';
const kst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const kstDate = () => kst().slice(0, 10);
const kstHour = () => parseInt(kst().slice(11, 13), 10);
const kstMin = () => parseInt(kst().slice(14, 16), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = [];
const log = (m) => { const line = `[${kst()} KST] ${m}`; console.log(line); L.push(line); };
const collecting = () => {
  for (const p of ['[c]ollectPlace.mjs', '[c]ollect.mjs']) {
    try { execSync(`pgrep -f "${p}"`, { stdio: 'ignore' }); return p.replace(/[[\]]/g, ''); } catch {}
  }
  return null;
};
// 05:30을 넘겼으면 더 쏘지 않는다(05:50 pm2 재시작·06:00 수집 전에 확실히 비운다)
const tooLate = () => kstHour() > 5 || (kstHour() === 5 && kstMin() >= 30);

let used = 0;   // 네이버로 나간 요청 수
async function probe(keyword) {
  if (used >= MAX_REQ) return { skipped: '요청 상한 도달' };
  used++;
  const dbg = `/tmp/cafe_cap_${Date.now()}.jsonl`;
  process.env.PLACE_DEBUG_FILE = dbg;
  const t0 = Date.now();
  let items = null, err = null;
  try { items = await scrapePlaceSearch(keyword, COUNT); } catch (e) { err = e.message || String(e); }
  delete process.env.PLACE_DEBUG_FILE;
  let ops = [];
  try {
    ops = fs.readFileSync(dbg, 'utf8').trim().split('\n').filter(Boolean)
      .flatMap((l) => (JSON.parse(l).ops || []).map((o) => o.op));
  } catch {}
  try { fs.unlinkSync(dbg); } catch {}
  return {
    keyword, elapsedMs: Date.now() - t0, error: err,
    total: items ? items.length : 0,
    ops, opsAllowed: ops.length ? ops.every((o) => LIST_OPS.has(o)) : null,
    top: (items || []).slice(0, 10).map((x, i) => ({ rank: x.rank || i + 1, name: x.name, category: x.category || '', place_id: String(x.place_id || x.id || '') })),
  };
}

const idsOf = (r, n) => (r && r.top ? r.top.slice(0, n).map((x) => x.place_id) : []);
const sameOrder = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  return Math.round((inter / (A.size + B.size - inter)) * 100);
};

async function main() {
  if (!FORCE && kstDate() > EXPIRES) { console.log(`유효기간(${EXPIRES}) 지남 — 돌지 않는다. 다시 쓰려면 --force 또는 EXPIRES 갱신.`); return; }
  if (!FORCE && (kstHour() < 2 || tooLate())) { console.log(`심야(02:00~05:30) 밖이라 돌지 않는다 — 지금 ${kst()} KST.`); return; }
  const busy = collecting();
  if (busy) { console.log(`수집(${busy})이 돌고 있어 중단한다 — 네이버 요청이 겹치면 안 된다.`); return; }
  // 오늘 결과가 이미 있으면 다시 돌지 않는다. 재시도 크론(03:30)이 예산을 두 번 쓰는 걸 막는다.
  if (!FORCE && fs.existsSync(`${LOG_DIR}/cafe-compare-${kstDate()}.json`)) {
    console.log(`오늘(${kstDate()}) 결과가 이미 있다 — 다시 돌지 않는다.`); return;
  }

  log(`카페류 대조 시작 — 키워드 ${KEYWORDS.length}개 × ${ROUNDS}회, 요청 상한 ${MAX_REQ}건, 간격 ${GAP_MS / 1000}초, count=${COUNT} (저장 없음)`);
  const rounds = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const res = [];
    for (const kw of KEYWORDS) {
      if (tooLate()) { log('05:30을 넘겨 중단한다(남은 조회 취소).'); rounds.push(res); return finish(rounds); }
      if (used >= MAX_REQ) { log(`요청 상한 ${MAX_REQ}건에 닿아 중단한다.`); rounds.push(res); return finish(rounds); }
      const p = await probe(kw);
      res.push(p);
      log(`  ${r}회차 "${kw}" → ${p.error ? '실패: ' + p.error.slice(0, 90) : p.total + '곳'}`
        + (p.ops && p.ops.length ? ` | 쿼리 ${p.ops.join(',')}${p.opsAllowed === false ? ' ⚠허용목록에 없음' : ''}` : '')
        + ` (${p.elapsedMs}ms, 누적 ${used}건)`);
      await sleep(GAP_MS);
    }
    rounds.push(res);
  }
  return finish(rounds);
}

function finish(rounds) {
  const out = { date: kstDate(), at: new Date().toISOString(), keywords: KEYWORDS, rounds_run: rounds.length, requests_used: used, max_requests: MAX_REQ, count: COUNT, gap_s: GAP_MS / 1000, rounds };
  const cmp = [];
  for (const kw of KEYWORDS) {
    const a = (rounds[0] || []).find((x) => x.keyword === kw);
    const b = (rounds[1] || []).find((x) => x.keyword === kw);
    const row = { keyword: kw, zero: !!(a && !a.error && a.total === 0) || !!(b && !b.error && b.total === 0),
      total1: a ? a.total : null, total2: b ? b.total : null,
      ops: [...new Set([...(a && a.ops || []), ...(b && b.ops || [])])],
      opsAllowed: a ? a.opsAllowed : null };
    if (a && b && !a.error && !b.error) {
      row.top10_same_order = sameOrder(idsOf(a, 10), idsOf(b, 10));
      row.top10_same_set = jaccard(idsOf(a, 10), idsOf(b, 10)) === 100;
      row.top10_jaccard = jaccard(idsOf(a, 10), idsOf(b, 10));
      row.top5_same_order = sameOrder(idsOf(a, 5), idsOf(b, 5));
    }
    cmp.push(row);
  }
  out.compare = cmp;
  fs.writeFileSync(`${LOG_DIR}/cafe-compare-${kstDate()}.json`, JSON.stringify(out, null, 1));

  const T = [];
  T.push(`카페류 정확도 대조 — ${kstDate()} (조회 전용, 저장 0건)`);
  T.push(`요청 ${used}/${MAX_REQ}건 · 키워드 ${KEYWORDS.length}개 · ${rounds.length}회차 · count=${COUNT} · 간격 ${GAP_MS / 1000}초`);
  T.push('');
  T.push('키워드 | 1회차 | 2회차 | 0곳 | 상위10 같은순서 | 상위10 같은집합(일치율) | 상위5 같은순서 | 쿼리');
  for (const r of cmp) {
    T.push([r.keyword, r.total1 == null ? '-' : r.total1 + '곳', r.total2 == null ? '-' : r.total2 + '곳',
      r.zero ? '⚠있음' : '없음',
      r.top10_same_order == null ? '-' : (r.top10_same_order ? '예' : '아니오'),
      r.top10_same_set == null ? '-' : (r.top10_same_set ? '예' : '아니오') + `(${r.top10_jaccard}%)`,
      r.top5_same_order == null ? '-' : (r.top5_same_order ? '예' : '아니오'),
      (r.ops.join(',') || '-') + (r.opsAllowed === false ? ' ⚠허용목록 밖' : '')].join(' | '));
  }
  for (let i = 0; i < rounds.length; i++) {
    for (const p of rounds[i]) {
      T.push('', `── ${i + 1}회차 "${p.keyword}" ${p.error ? '실패: ' + p.error : p.total + '곳'}`);
      for (const x of (p.top || [])) T.push(`   ${String(x.rank).padStart(2)}위 ${x.name} [${x.category}] ${x.place_id}`);
    }
  }
  fs.writeFileSync(`${LOG_DIR}/cafe-compare-${kstDate()}.txt`, T.join('\n'));
  log(`끝 — 요청 ${used}건. 결과: ${LOG_DIR}/cafe-compare-${kstDate()}.txt`);
  try { fs.appendFileSync(`${LOG_DIR}/cafe-compare.log`, L.join('\n') + '\n'); } catch {}
  return closeBrowser().catch(() => {});
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); try { fs.appendFileSync(`${LOG_DIR}/cafe-compare.log`, `[${kst()} KST] 오류 ${e && e.message}\n`); } catch {} process.exit(1); });
