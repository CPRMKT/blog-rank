// 지운 행이 정말 오염이었는지 백업으로 다시 판정한다(읽기 전용).
//
// 왜 필요한가: 1~2차 판정은 get_place_rankings가 1,000행에서 잘린 응답으로 돌았다(2026-11-14 수정).
// 지금은 끝까지 받으므로, 지운 날의 목록(백업)과 온전한 정상기간 기준을 다시 맞춰 본다.
//
//   node tools/verify_deleted.mjs /var/backups/blog-rank/place_rankings_contam_2026-11-14.json \
//                                 /var/backups/blog-rank/place_rankings_contam2_2026-11-14.json
import fs from 'fs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.log('백업 파일 경로를 하나 이상 주세요.'); process.exit(1); }

const db = async (action, data = {}) => {
  const r = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(120000),
  });
  return JSON.parse(await r.text());
};

// 백업에서 (키워드, 날짜) -> place_id 목록
const day = {};
for (const f of files) {
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const row of b.data || []) {
    if (row.rank == null) continue;
    const k = row.keyword + '|' + row.checked_date;
    (day[k] = day[k] || []).push({ id: String(row.place_id), rank: row.rank, name: row.name });
  }
  console.log(`${f.split('/').pop()} — 쌍 ${b.pairs_found} / 행 ${b.rows}`);
}
const keywords = [...new Set(Object.keys(day).map((k) => k.split('|')[0]))];
console.log(`\n지운 (키워드,날짜) ${Object.keys(day).length}쌍 / 키워드 ${keywords.length}개 재판정\n`);

const out = [];
let noRef = 0;
for (let i = 0; i < keywords.length; i++) {
  const kw = keywords[i];
  let rows = [];
  try { const r = await db('get_place_rankings', { keyword: kw, days: 46 }); rows = (r && r.result) || []; } catch { continue; }
  const per = {};
  for (const x of rows) { if (x.rank == null) continue; (per[x.checked_date] = per[x.checked_date] || []).push(x); }
  for (const d of Object.keys(per)) per[d].sort((a, b) => a.rank - b.rank);
  // 기준: 10/15~10/28 + 11/11 이후 (지운 구간은 어차피 DB에 없다)
  const clean = Object.keys(per).filter((d) => (d >= '2026-10-15' && d <= '2026-10-28') || d >= '2026-11-11').sort();
  if (clean.length < 3) { noRef++; continue; }
  const cnt = {};
  for (const d of clean) for (const x of per[d].slice(0, 10)) cnt[String(x.place_id)] = (cnt[String(x.place_id)] || 0) + 1;
  const need = Math.max(1, Math.ceil(clean.length * 0.5));
  const top = Object.entries(cnt).filter(([, c]) => c >= need).map(([id]) => id);
  if (!top.length) { noRef++; continue; }
  for (const k of Object.keys(day)) {
    if (!k.startsWith(kw + '|')) continue;
    const ids = new Set(day[k].map((x) => x.id));
    const hit = top.filter((x) => ids.has(x)).length;
    out.push({ kw, d: k.split('|')[1], n: ids.size, recall: Math.round((hit / top.length) * 100), cleanDays: clean.length });
  }
  if ((i + 1) % 40 === 0) console.log(`  ... ${i + 1}/${keywords.length}`);
}

const tier = (r) => (r === 0 ? 'A' : r < 20 ? 'B' : r < 40 ? 'C' : '정상');
const c = { A: 0, B: 0, C: 0, '정상': 0 };
for (const o of out) c[tier(o.recall)]++;
console.log(`\n■ 지운 ${out.length}쌍 재판정 (기준일 부족으로 판정 못 한 키워드 ${noRef}개)`);
console.log(`   A(0%) ${c.A} / B(1~19%) ${c.B} / C(20~39%) ${c.C} / 정상(40%+) ${c['정상']}`);
const bad = out.filter((o) => o.recall >= 40).sort((a, b) => b.recall - a.recall);
if (bad.length) {
  console.log(`\n⚠ 되돌릴지 봐야 할 행 ${bad.length}건 (정상으로 판정됨)`);
  for (const b of bad.slice(0, 40)) console.log(`   ${b.d} ${b.kw} — ${b.n}곳 / 재현율 ${b.recall}%`);
} else {
  console.log('\n✅ 지운 행 중 정상으로 뒤집힌 건 없음');
}
fs.writeFileSync('/tmp/verify_deleted.json', JSON.stringify(out));
