// 블로그 진단 검증 스크립트.
// 화면과 같은 공식을 쓰기 위해 라이브 index.html에서 채점 코드(BD_*)를 그대로 추출해 실행한다.
// 네이버 요청은 화면과 동일한 경로(/api/search, db blog_profile)만 사용 — 순차.
// 사용: node tools/blogdiag_verify.mjs --mode=store|ext|repeat|load
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' };
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const db = (action, data = {}) => fetch(`${BASE}/api/db`, { method: 'POST', headers: H, body: JSON.stringify({ action, data }) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadScoring() {
  const html = await fetch(BASE + '/').then((r) => r.text());
  const a = html.indexOf('const BD_W='), b = html.indexOf('async function bdRun(){');
  if (a < 0 || b < 0) throw new Error('채점 코드 추출 실패');
  return new Function(html.slice(a, b) + '\nreturn {bdScore,bdProbability,bdExtractKeyword,bdRankPoint,BD_W,BD_TH};')();
}
const search = async (q, n = 30) => {
  try { const d = await fetch(`${BASE}/api/search?query=${encodeURIComponent(q)}&count=${n}`).then((r) => r.json()); return d && !d.error ? { items: d.items || [], total: d.total || 0 } : null; }
  catch { return null; }
};

// 화면 bdRun과 같은 순서로 진단 1건 수행
async function diagnose(S, blogId, storeKws, nPosts) {
  const t0 = Date.now();
  const prof = await db('blog_profile', { blog_id: blogId, bodies: nPosts });
  if (!prof || !prof.ok) return { ok: false, error: (prof && prof.error) || 'profile 실패' };
  const all = prof.items || [], posts = all.slice(0, nPosts), recent = all.slice(0, 30);
  let calls = 0;
  for (const p of posts) {
    const t = await search(`"${p.title}"`, 30); calls++;
    p.titleFound = t ? t.items.some((it) => String(it.link || '').includes(`/${blogId}/`)) : null;
    p.keyword = S.bdExtractKeyword(p.title, storeKws);
    if (p.keyword) {
      const k = await search(p.keyword, 30); calls++;
      if (k) { const hit = k.items.find((it) => String(it.link || '').includes(`/${blogId}/`) && String(it.link || '').includes(p.logNo)); p.kwRank = hit ? hit.rank : 0; p.kwDocs = k.total || 0; }
    }
  }
  const missTitle = posts.slice(0, 5).filter((p) => p.titleFound === false).length;
  const res = S.bdScore(posts, recent, { lowQualitySuspect: missTitle >= 3, missTitle });
  return { ok: true, score: res.score, grade: res.grade, parts: res.parts, posts, calls, sec: Math.round((Date.now() - t0) / 1000) };
}

async function storeBlogId(sid) {
  const r = await db('get_store_blog_posts', { store_id: sid });
  const cnt = {};
  for (const p of (r && r.posts) || []) { const id = p.blog_id || ((p.blog_url || '').match(/blog\.naver\.com\/([^/?#]+)/) || [])[1]; if (id) cnt[id] = (cnt[id] || 0) + 1; }
  const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function main() {
  const S = await loadScoring();
  const mode = arg('mode', 'store');

  if (mode === 'store') {
    // 검증1: 우리 매장 블로그 → 진단 경로 순위가 기존 store_rankings와 일치하는지
    const stores = ((await db('list_stores')).result || []).filter((s) => s.in_blog !== false);
    let done = 0;
    for (const st of stores) {
      if (done >= 3) break;
      const blogId = await storeBlogId(st.id); if (!blogId) continue;
      const rr = await db('get_store_rankings', { store_id: st.id, days: 2 });
      const rows = (rr.result || []).filter((r) => r.rank > 0).sort((a, b) => (a.checked_date < b.checked_date ? 1 : -1)).slice(0, 3);
      if (!rows.length) continue;
      done++;
      console.log(`\n[매장] ${st.name} (blog ${blogId})`);
      for (const row of rows) {
        const k = await search(row.keyword, 30);
        const hit = k ? k.items.find((it) => String(it.link || '').includes(`/${blogId}/`)) : null;
        const now = hit ? hit.rank : 0;
        const diff = Math.abs(now - row.rank);
        console.log(`  "${row.keyword}" 기존 ${row.rank}위(${row.checked_date.slice(5)}) vs 진단경로 ${now || '미노출'} → ${diff === 0 ? '일치 ✅' : (diff <= 2 ? `±${diff} (시점차) ✅` : `차이 ${diff} ⚠`)}`);
        await sleep(1000);
      }
    }
  }

  if (mode === 'ext') {
    // 검증2: 외부 공개 블로그 2개 — 끝까지 도는지 + 소요시간
    for (const id of (arg('ids', 'naverofficial,naver_diary')).split(',')) {
      const d = await diagnose(S, id.trim(), [], 5);
      console.log(d.ok ? `[외부] ${id}: ${d.score}점(${d.grade}) | 검색 ${d.calls}회 | ${d.sec}초` : `[외부] ${id}: 실패 ${d.error}`);
    }
  }

  if (mode === 'repeat') {
    // 검증3: 같은 블로그 2회 → 점수 동일(결정성)
    const id = arg('blog', 'naverofficial');
    const a = await diagnose(S, id, [], 5); await sleep(3000);
    const b = await diagnose(S, id, [], 5);
    const same = a.ok && b.ok && a.score === b.score && JSON.stringify(a.parts.map((x) => x.earned)) === JSON.stringify(b.parts.map((x) => x.earned));
    console.log(`[반복] ${id}: 1회차 ${a.score}점 / 2회차 ${b.score}점 → ${same ? '동일 ✅' : '불일치 ⚠ (순위 변동 시 발생 가능)'}`);
    if (!same && a.ok && b.ok) console.log('  항목별:', a.parts.map((x, i) => `${x.key} ${x.earned}→${b.parts[i] && b.parts[i].earned}`).join(' '));
  }

  if (mode === 'load') {
    // 검증4: 연속 분석 중 기존 수집 지표(0곳 보류·실패)가 늘지 않는지
    const ids = (arg('ids', '')).split(',').filter(Boolean);
    let calls = 0;
    for (const id of ids) { const d = await diagnose(S, id.trim(), [], 5); calls += d.calls || 0; console.log(`  ${id}: ${d.ok ? d.score + '점 / ' + d.sec + '초' : '실패 ' + d.error}`); }
    console.log(`[부하] 분석 ${ids.length}건, 블로그탭 검색 ${calls}회`);
  }
  console.log('VERIFY-DONE');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
