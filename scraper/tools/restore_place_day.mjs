// 10/26~11/10 플레이스 순위 복원 — 날짜 하나씩 (2026-11 일회용)
// 근거·절차: docs/place-snapshot-recovery-2026-11.md
//
//   node tools/restore_place_day.mjs --target=<복구대상.jsonl> --suspect=<suspect_pairs_129.json> --dry
//   node tools/restore_place_day.mjs --target=... --suspect=... --date=2026-10-26 --expected=25702 --reason="..."
//   (시간 측정) ... --date=2026-10-26 --limit=1000 --expected=1000 --dry-call --reason="..."  → 운영 표에 넣고 재고 DB 가 롤백
//
// 복구 대상 파일은 snapshot_recover_check.mjs --out 이 만든 것(오염 1,782쌍·되살린 16쌍 이미 제외).
// 여기서 오염 의심 쌍(--suspect)을 한 번 더 뺀다. 날짜의 행 수가 --expected 와 다르면 보내지 않는다.
// 보내면 DB 함수 restore_place_day 가 한 트랜잭션으로 넣고, 다르면 통째로 롤백한다. 네이버 요청 없음.
import fs from 'fs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const OWNER = '246f38bc-5279-47a6-9d4e-aed83c540a3c';   // 유일한 계정(전 행이 이 값)
const arg = (k, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes(`--${k}`);

const target = fs.readFileSync(arg('target'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sus = new Set(JSON.parse(fs.readFileSync(arg('suspect'), 'utf8')).map((p) => p.date + '|' + p.keyword));
const byDate = {};
let held = 0;
for (const r of target) {
  if (sus.has(r.checked_date + '|' + r.keyword)) { held++; continue; }
  (byDate[r.checked_date] = byDate[r.checked_date] || []).push({ keyword: r.keyword, place_id: String(r.place_id), rank: Number(r.rank) });
}
const total = Object.values(byDate).reduce((a, v) => a + v.length, 0);

if (has('dry')) {
  for (const d of Object.keys(byDate).sort()) console.log(d, byDate[d].length, '행', new Set(byDate[d].map((r) => r.keyword)).size, '키워드');
  console.log(`합계 ${total}행 (보류한 오염 의심 ${held}행)`);
  process.exit(0);
}

const d = arg('date'); const expected = Number(arg('expected')); const reason = arg('reason', '');
if (!d || !byDate[d]) { console.log(`날짜 ${d} 의 복구 대상이 없다`); process.exit(1); }
// --limit=N : 시간 측정용으로 앞 N행만(반드시 --dry-call 과 함께 — 진짜 복원에선 거부)
const lim = Number(arg('limit', 0));
const dryCall = has('dry-call');
if (lim && !dryCall) { console.log('--limit 는 --dry-call 과만 쓴다'); process.exit(1); }
const rows = lim ? byDate[d].slice(0, lim) : byDate[d];
if (rows.length !== expected) { console.log(`❌ ${d}: 파일 ${rows.length}행 ≠ 예상 ${expected}행 — 보내지 않았다`); process.exit(1); }
if (reason.trim().length < 5) { console.log('--reason= (5자 이상) 필요'); process.exit(1); }

const t = Date.now();
const resp = await fetch(`${BASE}/api/db`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
  body: JSON.stringify({ action: 'restore_place_day', data: { date: d, owner_id: OWNER, rows, expected_rows: expected, reason, ...(dryCall ? { dry: true } : {}) } }),
  signal: AbortSignal.timeout(280000),
});
const txt = await resp.text();
let j = null; try { j = JSON.parse(txt); } catch {}
if (!resp.ok || !j || !j.ok) { console.log(`❌ ${d}: HTTP ${resp.status} ${txt.slice(0, 400)}`); process.exit(1); }
if (j.dry) { console.log(`🧪 ${d} 시험(롤백됨): ${rows.length}행 측정 ${JSON.stringify(j.measured)} / API ${j.api_ms}ms / 왕복 ${((Date.now() - t) / 1000).toFixed(1)}초`); process.exit(0); }
console.log(`✅ ${d}: ${JSON.stringify(j.result)} (왕복 ${((Date.now() - t) / 1000).toFixed(1)}초)`);
