// 글 품질·과최적화 임계값을 우리 DB 실데이터로 산출한다.
// 노출된 글(store_rankings에 순위로 잡힌 글) vs 미노출 글(매장 블로그 목록에 있으나 순위에 안 잡힌 글)의
// 글자수·이미지수·최다 단어 반복수 중앙값을 비교. 검색 요청은 0건(글 페이지만 읽음).
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' };
const db = (a, d = {}) => fetch(`${BASE}/api/db`, { method: 'POST', headers: H, body: JSON.stringify({ action: a, data: d }) }).then((r) => r.json());
const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = parseInt((process.argv.find((a) => a.startsWith('--cap=')) || '--cap=30').split('=')[1], 10);

// server.js /blog-profile 과 동일한 추출 규칙(본문 영역만 div 균형으로 잘라 통계)
function bodyStats(html) {
  const at = html.indexOf('se-main-container'); if (at < 0) return null;
  let i = html.lastIndexOf('<div', at); if (i < 0) i = at;
  let depth = 0, j = i; const re = /<div\b|<\/div>/gi; re.lastIndex = i; let m;
  while ((m = re.exec(html))) { depth += m[0] === '</div>' ? -1 : 1; j = re.lastIndex; if (depth === 0) break; if (j - i > 600000) break; }
  const seg = html.slice(i, j);
  const imgCount = (seg.match(/<img\b[^>]*>/gi) || []).filter((t) => !/se-sticker|emoticon/i.test(t)).length;
  const text = seg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8203;|​/g, ' ').replace(/\s+/g, ' ').trim();
  const freq = {}; for (const t of text.match(/[가-힣]{2,}/g) || []) freq[t] = (freq[t] || 0) + 1;
  const topCount = Math.max(0, ...Object.values(freq));
  return { charCount: text.length, imgCount, topCount };
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const toM = (u) => String(u || '').replace('blog.naver.com', 'm.blog.naver.com').split('?')[0];

async function collect(urls) {
  const out = [];
  for (const u of urls) {
    try { const h = await fetch(toM(u), { headers: UA }).then((r) => r.text()); const s = bodyStats(h); if (s && s.charCount > 50) out.push(s); }
    catch { /* 건너뜀 */ }
    await sleep(250);
  }
  return out;
}

async function main() {
  const stores = (await db('list_stores')).result || [];
  const exposedTop = new Set(), exposedAny = new Set();
  for (const st of stores.filter((s) => s.in_blog !== false)) {
    const rr = await db('get_store_rankings', { store_id: st.id, days: 14 });
    for (const row of (rr.result || [])) for (const m of (row.matches || [])) {
      if (!m || !m.url) continue; exposedAny.add(m.url.split('?')[0]);
      if (m.rank > 0 && m.rank <= 7) exposedTop.add(m.url.split('?')[0]);
    }
  }
  const notExposed = new Set();
  for (const st of stores.filter((s) => s.in_blog !== false)) {
    const pr = await db('get_store_blog_posts', { store_id: st.id });
    for (const p of (pr.posts || [])) { const u = (p.blog_url || '').split('?')[0]; if (u && !exposedAny.has(u)) notExposed.add(u); }
    if (notExposed.size > CAP * 3) break;
  }
  const pick = (set) => [...set].slice(0, CAP);
  console.log(`표본: 노출(7위 내) ${Math.min(exposedTop.size, CAP)}건 / 미노출 ${Math.min(notExposed.size, CAP)}건 (전체 후보 ${exposedTop.size}/${notExposed.size})`);
  const A = await collect(pick(exposedTop));
  const B = await collect(pick(notExposed));
  const rowOf = (label, arr) => `${label} n=${arr.length} | 글자수 중앙 ${median(arr.map((x) => x.charCount))} | 이미지 중앙 ${median(arr.map((x) => x.imgCount))} | 최다반복 중앙 ${median(arr.map((x) => x.topCount))} / 90분위 ${pct(arr.map((x) => x.topCount), 0.9)}`;
  console.log(rowOf('노출 7위내', A));
  console.log(rowOf('미노출   ', B));
  console.log(`제안 임계값: 글자수 ${median(A.map((x) => x.charCount))} · 이미지 ${median(A.map((x) => x.imgCount))} · 반복 ${pct(A.map((x) => x.topCount), 0.9)}`);
  console.log(`표본 충분 여부: ${A.length >= 20 && B.length >= 20 ? '충분(20건 이상)' : '부족 → 임시값 유지'}`);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
