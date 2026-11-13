// 오염 행 정리 도구 — '신규 오픈' 캡처 버그(2026-10-30~11-09)로 저장된 (키워드, 날짜) 쌍만 다룬다.
//
//   node tools/contam_cleanup.mjs --pairs=/tmp/contam_sure_pairs.json --backup=/var/backups/blog-rank/xxx.json
//   node tools/contam_cleanup.mjs --pairs=... --dry
//   node tools/contam_cleanup.mjs --pairs=... --delete --backup-file=<위에서 만든 백업>
//
// 삭제는 백업 파일이 실제로 있고, 그 안의 쌍 수가 --pairs와 같을 때만 진행한다.
// 되돌리려면: --restore=<백업파일> (save_place_rankings로 날짜별 재삽입)
import fs from 'fs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const arg = (k, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes(`--${k}`);

async function dbCall(action, data = {}) {
  const resp = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(120000),
  });
  const t = await resp.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!resp.ok) throw new Error(`db ${action} HTTP ${resp.status}: ${t.slice(0, 200)}`);
  if (j && j.ok === false) throw new Error(`db ${action}: ${j.error}`);
  return j;
}

const pairsFile = arg('pairs');
if (!pairsFile) { console.log('--pairs=<json> 가 필요하다'); process.exit(1); }
const pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf8')).map((p) => ({ keyword: p.keyword, date: p.date }));
const key = (p) => p.keyword + '|' + p.date;
const want = new Set(pairs.map(key));
const keywords = [...new Set(pairs.map((p) => p.keyword))];
console.log(`대상: ${pairs.length}쌍 / 키워드 ${keywords.length}개 (${pairsFile})`);

// ── 백업: 대상 쌍에 해당하는 place_rankings 행 전체를 JSON으로 받아 적는다 ──
if (arg('backup')) {
  const out = arg('backup');
  const bag = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const r = await dbCall('get_place_rankings', { keyword: kw, days: 40 });
    const rows = (r && r.result) || [];
    for (const row of rows) if (want.has(row.keyword + '|' + row.checked_date)) bag.push(row);
    if ((i + 1) % 20 === 0) console.log(`  ... ${i + 1}/${keywords.length} 키워드, 누적 ${bag.length}행`);
  }
  const seen = new Set(bag.map((r) => r.keyword + '|' + r.checked_date));
  const body = {
    made_at: new Date().toISOString(),
    reason: "신규 오픈 캡처 버그 오염 행 삭제 전 백업 (2026-10-30~11-09)",
    pairs_file: pairsFile,
    pairs_requested: pairs.length,
    pairs_found: seen.size,
    rows: bag.length,
    pairs: pairs,
    data: bag,
  };
  fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(body));
  console.log(`백업 완료 → ${out}`);
  console.log(`  요청 ${pairs.length}쌍 중 DB에 실제로 있던 쌍 ${seen.size}개 / 행 ${bag.length}개`);
  const missing = [...want].filter((k) => !seen.has(k));
  if (missing.length) console.log(`  ⚠ DB에 없는 쌍 ${missing.length}개(이미 지워졌거나 rank NULL만 있음): ${missing.slice(0, 5).join(' / ')}`);
}

// ── dry: 지워질 행 수를 센다 ──
if (has('dry')) {
  const r = await dbCall('purge_place_rankings', { pairs, dry: true });
  console.log(`\n[dry] 지워질 쌍 ${r.pairs}개 / 행 ${r.rows}개`);
  for (const p of r.per) console.log(`  ${p.date} — 키워드 ${p.keywords}개 / 행 ${p.rows}개`);
  console.log(r.pairs === pairs.length ? `✅ 보고서의 ${pairs.length}건과 일치` : `❌ 불일치: 보고서 ${pairs.length} vs dry ${r.pairs}`);
}

// ── delete: 백업이 있어야만 진행 ──
if (has('delete')) {
  const bf = arg('backup-file') || arg('backup');
  if (!bf || !fs.existsSync(bf)) { console.log('❌ --backup-file=<백업json> 이 없으면 삭제하지 않는다'); process.exit(1); }
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  if (b.pairs_requested !== pairs.length) { console.log(`❌ 백업의 쌍 수(${b.pairs_requested}) ≠ 대상(${pairs.length})`); process.exit(1); }
  console.log(`\n백업 확인: ${bf} (쌍 ${b.pairs_found}개 / 행 ${b.rows}개, ${b.made_at})`);
  const r = await dbCall('purge_place_rankings', { pairs });
  let left = 0;
  for (const p of r.per) { console.log(`  ${p.date} — 키워드 ${p.keywords}개 / 삭제 ${p.rows}행 / 남음 ${p.left}`); left += p.left; }
  console.log(`삭제 완료: 쌍 ${r.pairs}개 / 행 ${r.rows}개 / 남은 행 ${left}개`);
  if (left) console.log('⚠ 남은 행이 있다 — 다시 실행할 것');
}

// ── restore: 백업에서 되돌린다 ──
if (arg('restore')) {
  const b = JSON.parse(fs.readFileSync(arg('restore'), 'utf8'));
  const groups = {};
  for (const row of b.data) (groups[row.keyword + '|' + row.checked_date] = groups[row.keyword + '|' + row.checked_date] || []).push(row);
  let n = 0;
  for (const [k, rows] of Object.entries(groups)) {
    const [keyword, checked_date] = k.split('|');
    await dbCall('save_place_rankings', {
      keyword, checked_date, owner_id: rows[0].owner_id,
      rows: rows.map((r) => ({ rank: r.rank, place_id: r.place_id, name: r.name, category: r.category, visitor_reviews: r.visitor_reviews, blog_reviews: r.blog_reviews, saves: r.saves })),
    });
    n++;
    if (n % 50 === 0) console.log(`  ... ${n}/${Object.keys(groups).length}쌍 복원`);
  }
  console.log(`복원 완료: ${n}쌍`);
}
