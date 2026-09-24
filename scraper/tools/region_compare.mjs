// 지역 일치 채점 방식 전후 비교(같은 블로거·같은 글 데이터로 두 방식 동시 계산 → 재스크래핑 없음).
//  전(前): 좁은 지명·광역 지명 구분 없이 하나라도 맞으면 1.0
//  후(後): 좁은 지명 1.0 / 광역 지명만 0.5 / 없음 0
// 확률 비교까지 하려면 --full (블로거당 검색 10회), 지역 분포만 보려면 기본(프로필만, 검색 0회).
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' };
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const FULL = process.argv.includes('--full');
const db = (a, d = {}) => fetch(`${BASE}/api/db`, { method: 'POST', headers: H, body: JSON.stringify({ action: a, data: d }) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function engine() {
  const html = await fetch(BASE + '/').then((r) => r.text());
  const a = html.indexOf('const BD_W='), b = html.indexOf('async function bdScreenOne(');
  return new Function(html.slice(a, b) + '\nreturn {bdScore,bdFit,bdProbability,bdCompetition,bdKwMeta,bdExtractKeyword,bdRankPoint,bdLoadRegions};')();
}
const search = async (q, n = 30) => {
  try { const d = await fetch(`${BASE}/api/search?query=${encodeURIComponent(q)}&count=${n}`).then((r) => r.json()); return d && !d.error ? { items: d.items || [], total: d.total || 0 } : null; } catch { return null; }
};
// 이전 방식(구분 없음) 재현
function oldRegion(recent, meta) {
  const txt = (p) => String(p.title || '') + ' ' + String(p.category || '');
  const hit = recent.filter((p) => (meta.regions || []).some((t) => txt(p).includes(t))).length;
  return recent.length ? hit / recent.length : 0;
}

async function main() {
  const E = await engine();
  await E.bdLoadRegions();
  const ids = arg('ids', '').split(',').map((x) => x.trim()).filter(Boolean);
  const kws = arg('kws', '부산 전포 맛집|전포동 삼겹살').split('|').map((x) => x.trim());
  const metas = kws.map((k) => E.bdKwMeta(k));
  metas.forEach((m) => console.log(`[${m.keyword}] 좁은 지명 ${m.regionsNarrow.length}개 · 광역 ${m.regionsWide.join(',') || '없음'}`));
  const comps = {};
  if (FULL) {
    let vols = {};
    try { const vr = await fetch(`${BASE}/api/search-volume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: kws }) }).then((r) => r.json()); if (vr && vr.ok) vols = vr.volumes || {}; } catch {}
    for (const k of kws) { const s = await search(k, 30); comps[k] = E.bdCompetition(s ? s.total : 0, vols[k] ? vols[k].total : 0); }
  }
  const rows = [];
  for (const id of ids) {
    const prof = await db('blog_profile', { blog_id: id, bodies: FULL ? 5 : 0 });
    if (!prof || !prof.ok || !(prof.items || []).length) { console.log(`  ${id}: 조회 실패`); continue; }
    const all = prof.items, posts = all.slice(0, 5), recent = all.slice(0, 30);
    if (FULL) {
      for (const p of posts) {
        const t = await search(`"${p.title}"`, 30);
        p.titleFound = t ? t.items.some((it) => String(it.link || '').includes(`/${id}/`)) : null;
        p.keyword = E.bdExtractKeyword(p.title, kws);
        if (p.keyword) { const k = await search(p.keyword, 30); if (k) { const h = k.items.find((it) => String(it.link || '').includes(`/${id}/`) && String(it.link || '').includes(p.logNo)); p.kwRank = h ? h.rank : 0; } }
      }
    }
    const res = FULL ? E.bdScore(posts, recent, {}) : null;
    const ex = res && res.parts.find((p) => p.key === 'expose');
    const fb = ex ? ex.earned / ex.weight : 0;
    const row = { id, score: res ? res.score : null, kw: {} };
    for (const m of metas) {
      const fit = E.bdFit(recent, posts, m);
      const before = oldRegion(recent, m);
      const cell = { before: Math.round(before * 100), after: Math.round(fit.region * 100), narrow: fit.regNarrowCount, wide: fit.regWideCount };
      if (FULL) {
        cell.pAfter = E.bdProbability(res.score, fit, comps[m.keyword], fb).p;
        cell.pBefore = E.bdProbability(res.score, { ...fit, region: before }, comps[m.keyword], fb).p;
      }
      row.kw[m.keyword] = cell;
    }
    rows.push(row);
    console.log(`  ${id.slice(0, 3)}***: ` + metas.map((m) => { const c = row.kw[m.keyword]; return `[${m.keyword}] 지역 ${c.before}%→${c.after}%` + (FULL ? ` 확률 ${c.pBefore}%→${c.pAfter}%` : ''); }).join(' | '));
    await sleep(800);
  }
  for (const m of metas) {
    const avgB = Math.round(rows.reduce((s, r) => s + r.kw[m.keyword].before, 0) / rows.length);
    const avgA = Math.round(rows.reduce((s, r) => s + r.kw[m.keyword].after, 0) / rows.length);
    console.log(`\n[${m.keyword}] 지역 일치 평균 ${avgB}% → ${avgA}%`);
    if (FULL) {
      const ord = (k) => rows.slice().sort((a, b) => b.kw[m.keyword][k] - a.kw[m.keyword][k]).map((r) => `${r.id.slice(0, 3)}*** ${r.kw[m.keyword][k]}%`).join(' > ');
      console.log(`  확률 순서 전: ${ord('pBefore')}`);
      console.log(`  확률 순서 후: ${ord('pAfter')}`);
    }
  }
  console.log('COMPARE-DONE');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
