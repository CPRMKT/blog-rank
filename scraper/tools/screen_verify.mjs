// 체험단 후보 블로거 심사 검증. 화면과 같은 공식을 쓰기 위해 라이브 index.html에서 엔진을 그대로 추출한다.
// 네이버 요청은 화면과 동일 경로(/api/search, db blog_profile)로 순차 수행.
// 사용: node tools/screen_verify.mjs --kw="부산 전포 맛집" --ids=a,b,c [--posts=5]
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' };
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const db = (a, d = {}) => fetch(`${BASE}/api/db`, { method: 'POST', headers: H, body: JSON.stringify({ action: a, data: d }) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSTS = parseInt(arg('posts', '5'), 10);

async function engine() {
  const html = await fetch(BASE + '/').then((r) => r.text());
  const a = html.indexOf('const BD_W='), b = html.indexOf('async function bdScreenOne(');
  if (a < 0 || b < 0) throw new Error('엔진 추출 실패');
  return new Function(html.slice(a, b) + '\nreturn {bdScore,bdFit,bdProbability,bdCompetition,bdKwMeta,bdExtractKeyword,bdRankPoint,bdLoadRegions,getDict:()=>bdRegionDict};')();
}
const search = async (q, n = 30) => {
  try { const d = await fetch(`${BASE}/api/search?query=${encodeURIComponent(q)}&count=${n}`).then((r) => r.json()); return d && !d.error ? { items: d.items || [], total: d.total || 0 } : null; }
  catch { return null; }
};

async function screenOne(E, blogId, meta, comp) {
  const t0 = Date.now();
  const prof = await db('blog_profile', { blog_id: blogId, bodies: POSTS });
  if (!prof || !prof.ok) return { blogId, error: (prof && prof.error) || 'profile 실패' };
  const all = prof.items || [], posts = all.slice(0, POSTS), recent = all.slice(0, 30);
  if (!posts.length) return { blogId, error: '공개 글 없음' };
  let calls = 0;
  for (const p of posts) {
    const t = await search(`"${p.title}"`, 30); calls++;
    p.titleFound = t ? t.items.some((it) => String(it.link || '').includes(`/${blogId}/`)) : null;
    p.keyword = E.bdExtractKeyword(p.title, [meta.keyword]);
    if (p.keyword) {
      const k = await search(p.keyword, 30); calls++;
      if (k) { const hit = k.items.find((it) => String(it.link || '').includes(`/${blogId}/`) && String(it.link || '').includes(p.logNo)); p.kwRank = hit ? hit.rank : 0; }
    }
  }
  const miss = posts.filter((p) => p.titleFound === false).length;
  const res = E.bdScore(posts, recent, { lowQualitySuspect: miss >= 3, missTitle: miss });
  const fit = E.bdFit(recent, posts, meta);
  const ex = res.parts.find((p) => p.key === 'expose');
  const pr = E.bdProbability(res.score, fit, comp, ex ? ex.earned / ex.weight : 0);
  return { blogId, score: res.score, grade: res.grade, fit, pr, calls, sec: Math.round((Date.now() - t0) / 1000), cats: recent.map((p) => p.category).filter(Boolean).slice(0, 3) };
}

async function main() {
  const E = await engine();
  const kw = arg('kw', '부산 전포 맛집');
  const ids = arg('ids', '').split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.BD_NO_REGION !== '1') await E.bdLoadRegions();   // 인접 지역 사전(BD_NO_REGION=1이면 끄고 비교)
  const meta = E.bdKwMeta(kw);
  console.log(`지역 사전: ${E.getDict() ? E.getDict().groups.length + '개 그룹 적용' : '미적용(기존 방식)'} | 지역 토큰 ${meta.regions.length}개`);
  let vol = 0;
  try { const vr = await fetch(`${BASE}/api/search-volume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: [kw] }) }).then((r) => r.json()); if (vr && vr.ok && vr.volumes[kw]) vol = vr.volumes[kw].total; } catch {}
  const k = await search(kw, 30);
  const comp = E.bdCompetition(k ? k.total : 0, vol);
  console.log(`목표 키워드 "${kw}" | 업종 ${meta.group} | 지역 ${JSON.stringify(meta.regions)} | 경쟁도 ${comp.c.toFixed(2)} (${comp.basis})`);
  const out = [];
  let totalCalls = 0, t0 = Date.now();
  for (const id of ids) {
    const r = await screenOne(E, id, meta, comp);
    totalCalls += r.calls || 0;
    out.push(r);
    console.log(r.error ? `  ${id}: 실패 ${r.error}`
      : `  ${id.slice(0, 3)}***: 지수 ${r.score}(${r.grade}) | 업종 ${Math.round(r.fit.industry * 100)}% 지역 ${Math.round(r.fit.region * 100)}% 관련 ${r.fit.relCount}글(7위내 ${r.fit.relTop}) | 체험단 ${r.fit.sponsored != null ? Math.round(r.fit.sponsored * 100) + '%' : '-'} | 확률 ${r.pr.p}% ${r.pr.band} | ${r.sec}초`);
    await sleep(1000);
  }
  const ok = out.filter((r) => !r.error).sort((a, b) => b.pr.p - a.pr.p);
  console.log(`\n확률 순위: ${ok.map((r, i) => `${i + 1}위 ${r.blogId.slice(0, 3)}*** ${r.pr.p}%`).join(' | ')}`);
  console.log(`총 ${ids.length}명 · 검색 ${totalCalls}회 · ${Math.round((Date.now() - t0) / 1000)}초`);
  console.log('SCREEN-DONE');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
