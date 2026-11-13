// 기존 키워드 백필 — 한쪽 탭에만 있는 (매장, 키워드)를 반대쪽에도 채운다.
//
// 한 번에 다 채우면 플레이스 크론 부하가 급증하므로 하루 최대 30건씩만 처리한다
// (네이버 약 100건 한도와 35분 백오프 구조를 깨지 않기 위해).
// 조회·등록만 하며 DELETE나 덮어쓰기는 하지 않는다. 수집은 다음 크론이 알아서 한다.
//
// 사용:
//   node tools/backfill_links.mjs --dry           대상만 보고(기본값, 아무것도 바꾸지 않음)
//   node tools/backfill_links.mjs --run           실제 등록(하루치 30건)
//   node tools/backfill_links.mjs --run --n=10    건수 지정
//   node tools/backfill_links.mjs --run --only=place   한쪽 방향만(place|blog)
import fs from 'fs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const has = (k) => process.argv.includes(`--${k}`);

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET || '';
const LOG = '/var/log/blog-rank-scraper/backfill-links.log';
const DAILY = parseInt(arg('n', '30'), 10);
const ONLY = arg('only', '');
const RUN = has('run');

// 플레이스 쪽 백필 게이트: 직전 수집 회차에 '미수집'이 1건이라도 있으면 그날은 건너뛴다.
// 하루 1회 갱신도 못 채우는 상태에서 키워드를 더 넣으면 미수집이 눈덩이처럼 커진다.
function lastRunNotRun() {
  const dir = '/var/log/blog-rank-scraper';
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^held-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return null; }
  if (!files.length) return null;
  try {
    const j = JSON.parse(fs.readFileSync(`${dir}/${files[files.length - 1]}`, 'utf8'));
    return { date: j.date, notRun: Array.isArray(j.notRun) ? j.notRun.length : (j.remaining || 0) };
  } catch { return null; }
}

// 3일 게이트: 최근 회차 기록 3일치가 모두 '미수집 0 + 보류율 5% 미만'이어야 플레이스 백필을 시작한다.
// (2026-11-14 결정: 7일 → 3일로 완화. 오염 정리 완료 후 적용.) 조건을 못 채우면 그날은 아무것도 등록하지 않는다.
function placeGate(need = parseInt(process.env.BACKFILL_GATE_DAYS || '3', 10)) {
  const dir = '/var/log/blog-rank-scraper';
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^held-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return { ok: false, why: '회차 기록 없음', rows: [] }; }
  files = files.slice(-need);
  if (files.length < need) return { ok: false, why: `회차 기록 ${files.length}/${need}일`, rows: [] };
  const rows = [];
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { return { ok: false, why: `${f} 읽기 실패`, rows }; }
    const nr = Array.isArray(j.notRun) ? j.notRun.length : (j.remaining || 0);
    const total = j.total || 0;
    const held = j.held != null ? j.held : (Array.isArray(j.keywords) ? j.keywords.length : 0);
    const pct = total ? Math.round((held / total) * 1000) / 10 : 100;
    rows.push({ d: j.date || f, nr, pct, ok: nr === 0 && total > 0 && pct < 5 });
  }
  return { ok: rows.every((r) => r.ok), rows };
}

const ts = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const log = (m) => { const line = `[${ts()} KST] ${m}`; console.log(line); if (RUN) { try { fs.appendFileSync(LOG, line + '\n'); } catch {} } };

// get_place_snapshot처럼 result 밖의 필드를 쓰는 액션용(응답 전체를 돌려준다)
async function dbRaw(action, data = {}) {
  const r = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': SECRET },
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(45000),
  });
  return r.json();
}

async function db(action, data = {}) {
  const r = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': SECRET },
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(45000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${action}: ${j.error}`);
  return j.result;
}

// 앞뒤 공백 제거 + 연속 공백 1개 + 소문자 — add_linked_keyword와 같은 규칙.
// 공백을 완전히 지우면 띄어쓰기만 다른 별개 키워드가 뭉쳐 누락된다.
const norm = (x) => String(x || '').trim().toLowerCase().split(/\s+/).join(' ');

// ── 오타·죽은 키워드 자동 제외 ──
// (1) 최근 4회차 내내 플레이스 0곳인 키워드  (2) 월 검색량 0인 키워드
function alwaysZeroKeywords() {
  let txt = '';
  try { txt = fs.readFileSync('/var/log/blog-rank-scraper/place-collect.log', 'utf8'); } catch { return new Set(); }
  const runs = []; let cur = null;
  for (const l of txt.split('\n')) {
    if (l.includes('플레이스 순위 수집 시작')) { cur = { zero: new Set(), ok: new Set() }; runs.push(cur); }
    if (!cur) continue;
    const m = l.match(/"([^"]+)"/);
    if (!m) continue;
    if (l.includes('0곳 응답')) cur.zero.add(m[1]);
    else if (l.includes('• "')) cur.ok.add(m[1]);
  }
  const last = runs.slice(-4);
  if (last.length < 2) return new Set();
  return new Set([...last[0].zero].filter((k) => last.every((r) => r.zero.has(k) && !r.ok.has(k))));
}

// 검색량 조회 실패(null)는 제외하지 않는다 — 모르는 것을 오타로 단정하지 않기 위해
async function zeroVolume(keywords) {
  const out = new Set();
  for (let i = 0; i < keywords.length; i += 100) {
    const chunk = keywords.slice(i, i + 100);
    try {
      const r = await fetch(`${BASE}/api/search-volume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: chunk }), signal: AbortSignal.timeout(30000),
      }).then((x) => x.json());
      if (r && r.ok) for (const [k, v] of Object.entries(r.volumes || {})) {
        if (v && typeof v.total === 'number' && v.total === 0) out.add(k);
      }
    } catch {}
  }
  return out;
}

const stores = await db('list_stores');
const targets = [];   // {store_id, name, keyword, target}
for (const st of stores) {
  const [bk, pk] = await Promise.all([
    db('list_store_keywords', { store_id: st.id }).catch(() => []),
    db('list_store_place_keywords', { store_id: st.id }).catch(() => []),
  ]);
  const blog = bk.map((r) => r.keyword).filter(Boolean);
  const place = pk.map((r) => r.keyword).filter(Boolean);
  const bn = new Set(blog.map(norm));
  const pn = new Set(place.map(norm));
  // 한도를 넘길 만큼은 애초에 대상에서 뺀다(액션에서도 한 번 더 막는다)
  let placeRoom = 40 - place.length;
  let blogRoom = 40 - blog.length;
  for (const k of blog) {
    if (pn.has(norm(k))) continue;
    if (placeRoom <= 0) { targets.push({ store_id: st.id, name: st.name, keyword: k, target: 'place', skip: '플레이스 40개 한도' }); continue; }
    placeRoom--;
    targets.push({ store_id: st.id, name: st.name, keyword: k, target: 'place' });
  }
  for (const k of place) {
    if (bn.has(norm(k))) continue;
    if (blogRoom <= 0) { targets.push({ store_id: st.id, name: st.name, keyword: k, target: 'blog', skip: '블로그 40개 한도' }); continue; }
    blogRoom--;
    targets.push({ store_id: st.id, name: st.name, keyword: k, target: 'blog' });
  }
}

// 오타 의심 제외
// 주의: "최근 4회차 0곳"만으로는 오타로 단정할 수 없다. 2026-10-30 이후 수집이 중간에 끊기면서
// 멀쩡한 키워드(명륜역 미용실 — 10/29에 300곳)도 매 회차 0곳으로 찍혔다.
// 그래서 "마지막으로 결과가 있던 날이 30일 이상 전"인 것만 오타로 본다.
const deadKw = alwaysZeroKeywords();
const volZero = await zeroVolume([...new Set(targets.filter((t) => !t.skip).map((t) => t.keyword))]);
// 0곳이 이어지는 키워드라도 최근에 결과가 있었으면 수집 문제이지 오타가 아니다
const lastOk = {};
for (const kw of deadKw) {
  try {
    const r = await dbRaw('get_place_snapshot', { keyword: kw }).catch(() => null);
    lastOk[kw] = (r && r.checked_date) || null;
  } catch { lastOk[kw] = null; }
}
const DEAD_DAYS = 30;
for (const t of targets) {
  if (t.skip) continue;
  if (deadKw.has(t.keyword)) {
    const d = lastOk[t.keyword];
    const days = d ? Math.round((Date.now() - new Date(d)) / 86400000) : 9999;
    if (days >= DEAD_DAYS) t.skip = `계속 0곳 + 마지막 결과 ${d || '없음'}(${days}일 전)`;
  }
  if (!t.skip && volZero.has(t.keyword)) t.skip = '월 검색량 0';
}

const doable = targets.filter((t) => !t.skip);
const skipped = targets.filter((t) => t.skip);
const toPlace = doable.filter((t) => t.target === 'place').length;
const toBlog = doable.filter((t) => t.target === 'blog').length;

log(`백필 대상 ${doable.length}건 (플레이스에 추가 ${toPlace} / 블로그에 추가 ${toBlog})`
  + (skipped.length ? ` · 한도로 제외 ${skipped.length}건` : ''));
log(`하루 ${DAILY}건 기준 남은 기간 약 ${Math.ceil(doable.length / DAILY)}일`);

if (!RUN) {
  console.log('\n=== 오늘 처리될 목록(미리보기) ===');
  for (const t of doable.filter((t) => !ONLY || t.target === ONLY).slice(0, DAILY)) {
    console.log(`  [${t.name}] "${t.keyword}" → ${t.target === 'place' ? '플레이스' : '블로그'}`);
  }
  if (skipped.length) {
    console.log('\n=== 제외 목록 ===');
    const byReason = {};
    for (const t of skipped) (byReason[t.skip] = byReason[t.skip] || []).push(t);
    for (const [reason, list] of Object.entries(byReason)) {
      console.log(`\n  [${reason}] ${list.length}건`);
      for (const t of list) console.log(`    ${t.name} / "${t.keyword}" -> ${t.target === 'place' ? '플레이스' : '블로그'}`);
    }
  }
  console.log('\n(--dry 미리보기입니다. 실제 등록은 --run)');
  process.exit(0);
}

// 플레이스에 키워드를 더하는 백필은 수집 여유가 있을 때만 돈다(블로그 쪽 백필은 플레이스 부하와 무관).
if (ONLY !== 'blog') {
  const lr = lastRunNotRun();
  if (lr && lr.notRun > 0) {
    log(`건너뜀 — 직전 회차(${lr.date})에 미수집 ${lr.notRun}건. 미수집 0인 날에만 플레이스 백필을 진행한다.`);
    process.exit(0);
  }
  if (!lr) log('주의 — 직전 회차 기록(held-*.json)을 찾지 못했다. 미수집 확인 없이 진행한다.');
  const g = placeGate();
  const detail = g.rows.map((r) => `${r.d} 미수집 ${r.nr}·보류율 ${r.pct}%${r.ok ? '' : ' ✗'}`).join(' / ') || g.why;
  if (!g.ok) {
    log(`건너뜀 — 백필 게이트 미충족 (${detail}). 3일 연속 '미수집 0 + 보류율 5% 미만'이면 자동으로 시작한다.`);
    process.exit(0);
  }
  log(`게이트 충족 (${detail}) → 플레이스 백필 진행`);
}

const batch = doable.filter((t) => !ONLY || t.target === ONLY).slice(0, DAILY);
let ok = 0, fail = 0;
for (const t of batch) {
  try {
    const r = await db('add_linked_keyword', { store_id: t.store_id, keyword: t.keyword, origin: t.target });
    const code = r[t.target];
    if (code === 'added' || code === 'exists') { ok++; log(`  + [${t.name}] "${t.keyword}" → ${t.target} (${code})`); }
    else { fail++; log(`  ! [${t.name}] "${t.keyword}" → ${t.target} (${code})`); }
  } catch (e) {
    fail++;
    log(`  ✗ [${t.name}] "${t.keyword}" → ${t.target}: ${String(e.message).slice(0, 80)}`);
  }
}
log(`오늘치 완료 — 성공 ${ok} / 실패 ${fail} · 남은 대상 ${doable.length - ok}건`);
