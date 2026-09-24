// Express 진입점. 인증 + /scrape + /place-search + /failures 라우트.
import express from 'express';
import fs from 'fs';
import { scrapeBlogTab, scrapeBlogRank, initBrowser, closeBrowser } from './scraper.js';
import { scrapePlaceSearch } from './placeSearch.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const API_KEY = process.env.SCRAPER_API_KEY;

if (!API_KEY) {
  console.error('SCRAPER_API_KEY 환경변수가 필수입니다');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

// /health 외 모든 요청은 Bearer 토큰 검증
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/scrape', async (req, res) => {
  const keyword = (req.query.keyword || '').toString().trim();
  const count = parseInt(req.query.count || '15', 10);
  const sort = (req.query.sort || 'date').toString() === 'rel' ? 'rel' : 'date';

  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  if (!Number.isFinite(count) || count < 1 || count > 300) {
    return res.status(400).json({ error: 'count must be 1~300' });
  }

  const t0 = Date.now();
  try {
    const items = await scrapeBlogTab(keyword, count, sort);
    res.json({
      items,
      total: items.length,
      method: 'playwright',
      elapsedMs: Date.now() - t0,
      scrapedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[scrape error]', e);
    res.status(500).json({
      error: e.message || 'scrape failed',
      elapsedMs: Date.now() - t0,
    });
  }
});

// 매장 블로그 순위 딜스캔(최대 300위) + 매칭 조기종료. 매칭은 여기(NCP)에서 수행.
let blogRankQueue = Promise.resolve(); // /blog-rank 전용 직렬화 체인(동시 딥스캔 금지)
app.get('/blog-rank', async (req, res) => {
  const keyword = (req.query.keyword || '').toString().trim();
  const placeId = (req.query.placeId || '').toString().trim();
  const storeName = (req.query.storeName || '').toString().trim();
  const count = parseInt(req.query.count || '300', 10);

  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  if (!placeId && !storeName) return res.status(400).json({ error: 'placeId or storeName required' });
  if (!Number.isFinite(count) || count < 1 || count > 300) {
    return res.status(400).json({ error: 'count must be 1~300' });
  }

  const t0 = Date.now();
  try {
    // 직렬화 뮤텍스: 블로그 딥스캔도 동시 요청 시 경합→전체 타임아웃 연쇄(키워드 연속등록 사건과 동일 패턴) 차단
    // 하드 타임아웃(90초): 스크랩이 영원히 안 끝나는 병리 상황에서도 체인이 막히지 않게 보장
    const job = () => Promise.race([
      scrapeBlogRank(keyword, { placeId, storeName, maxRank: count }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scan hard-timeout 90s')), 90000)),
    ]);
    const p = blogRankQueue.then(job, job);
    blogRankQueue = p.then(() => {}, () => {});
    const r = await p;
    console.log(`[blog-rank] "${keyword}" → ${r && Array.isArray(r.items) ? r.items.length + '건 매칭' + (r.rank ? '(최고 ' + r.rank + '위)' : '') + ' / ' + r.scanned + '건 스캔' : '응답형식이상'} (${Date.now() - t0}ms, 대기포함)`);
    res.json({ ...r, method: 'playwright', elapsedMs: Date.now() - t0, scrapedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[blog-rank error]', e);
    res.status(500).json({ error: e.message || 'blog-rank failed', elapsedMs: Date.now() - t0 });
  }
});

// 플레이스 키워드 검색 순위(1~300위)
let placeQueue = Promise.resolve(); // /place-search 전용 직렬화 체인(동시 딥스캔 금지)
app.get('/place-search', async (req, res) => {
  const keyword = (req.query.keyword || '').toString().trim();
  const count = parseInt(req.query.count || '50', 10);

  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  if (!Number.isFinite(count) || count < 1 || count > 300) {
    return res.status(400).json({ error: 'count must be 1~300' });
  }

  const t0 = Date.now();
  try {
    // 직렬화 뮤텍스: 딥스캔(300)은 무겁다. 동시 요청이 오면 한 번에 하나씩 처리해
    // 브라우저 경합으로 전부 느려져 다 같이 타임아웃 나는 연쇄(키워드 연속등록 사건)를 차단.
    // 하드 타임아웃(90초): 병리적 무한대기에도 체인이 막히지 않게.
    const job = () => Promise.race([
      scrapePlaceSearch(keyword, count),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scan hard-timeout 90s')), 90000)),
    ]);
    const p = placeQueue.then(job, job);
    placeQueue = p.then(() => {}, () => {});
    const items = await p;
    console.log(`[place-search] "${keyword}" count=${count} → ${items.length}곳 (${Date.now() - t0}ms, 대기포함)`);
    res.json({
      items,
      total: items.length,
      method: 'playwright',
      elapsedMs: Date.now() - t0,
      scrapedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[place-search error]', e);
    res.status(500).json({
      error: e.message || 'place-search failed',
      elapsedMs: Date.now() - t0,
    });
  }
});

// ── 블로그 진단용 공개정보 수집 (RSS + 글 본문 통계). 검색 경로와 무관한 별도 호스트라
//    기존 place-search/blog-rank 뮤텍스·페이스에는 영향 없음. 글 본문은 순차로만 가져온다.
const MOBILE_UA_BLOG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const BLOG_UA = { 'User-Agent': MOBILE_UA_BLOG };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const cdata = (s) => String(s || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
const tagOf = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? cdata(m[1]) : ''; };

// se-main-container(본문 영역)만 div 균형을 맞춰 잘라낸다 → 댓글·추천글 제외
function extractBody(html) {
  const key = 'se-main-container';
  const at = html.indexOf(key);
  if (at < 0) return null;
  let i = html.lastIndexOf('<div', at);
  if (i < 0) i = at;
  let depth = 0, j = i;
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    j = re.lastIndex;
    if (depth === 0) break;
    if (j - i > 600000) break;
  }
  return html.slice(i, j);
}
function bodyStats(html) {
  const seg = extractBody(html);
  if (!seg) return null;
  const imgCount = (seg.match(/<img\b[^>]*>/gi) || []).filter((t) => !/se-sticker|emoticon/i.test(t)).length;
  const text = seg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8203;|​/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  // 과최적화 판정용: 2글자 이상 한글 토큰 최다 반복 횟수
  const freq = {};
  for (const t of text.match(/[가-힣]{2,}/g) || []) freq[t] = (freq[t] || 0) + 1;
  let topToken = '', topCount = 0;
  for (const [t, c] of Object.entries(freq)) if (c > topCount) { topToken = t; topCount = c; }
  // 체험단·협찬 표기 여부(감점이 아니라 정보로 쓴다)
  const sponsored = /체험단|협찬|제공받아|제공 받아|원고료|소정의 (원고료|수수료)|무상으로 제공/.test(text);
  return { charCount: text.length, imgCount, topToken, topCount, sponsored };
}

app.get('/blog-profile', async (req, res) => {
  const blogId = (req.query.id || '').toString().trim().replace(/[^A-Za-z0-9_-]/g, '');
  const bodies = Math.min(15, Math.max(0, parseInt(req.query.bodies || '10', 10)));
  if (!blogId) return res.status(400).json({ error: 'id required' });
  const t0 = Date.now();
  try {
    const rr = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, { headers: BLOG_UA });
    if (!rr.ok) return res.status(502).json({ error: `RSS ${rr.status}`, blogId });
    const xml = await rr.text();
    const chunks = xml.split('<item>').slice(1);
    const items = chunks.map((c) => {
      const link = tagOf(c, 'link') || tagOf(c, 'guid');
      const lm = link.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/);
      return {
        title: tagOf(c, 'title'),
        link: lm ? `https://blog.naver.com/${lm[1]}/${lm[2]}` : link,
        logNo: lm ? lm[2] : '',
        pubDate: tagOf(c, 'pubDate'),
        category: tagOf(c, 'category'),
      };
    }).filter((x) => x.logNo);
    // 최근 글 본문 통계(순차)
    for (let i = 0; i < Math.min(bodies, items.length); i++) {
      try {
        const h = await fetch(`https://m.blog.naver.com/${blogId}/${items[i].logNo}`, { headers: BLOG_UA }).then((r) => r.text());
        const s = bodyStats(h);
        if (s) Object.assign(items[i], s);
      } catch { /* 본문 실패 → 해당 글은 통계 없음("확인 불가") */ }
      await sleepMs(300);
    }
    res.json({ ok: true, blogId, items, rssCount: items.length, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message || 'blog-profile failed' });
  }
});

// 수집 실패 현황: failures.log 최근분 + 두 배치의 마지막 "완료" 요약 라인.
// 대시보드 배너용 — 서버에 직접 안 들어가도 실패를 볼 수 있게.
app.get('/failures', (req, res) => {
  const LOG_DIR = '/var/log/blog-rank-scraper';
  // 큰 로그는 꼬리만 읽는다(최대 64KB)
  const readTail = (p, max = 65536) => {
    try {
      const st = fs.statSync(p);
      const len = Math.min(max, st.size);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch { return ''; }
  };
  const lastMatch = (txt, pat) => {
    const ls = txt.split('\n').filter((l) => l.includes(pat));
    return ls.length ? ls[ls.length - 1] : null;
  };
  try {
    const failures = readTail(`${LOG_DIR}/failures.log`).split('\n').filter(Boolean).slice(-80);
    res.json({
      ok: true,
      failures,
      lastPlace: lastMatch(readTail(`${LOG_DIR}/place-collect.log`), '완료 —'),
      lastBlog: lastMatch(readTail(`${LOG_DIR}/collect.log`), '완료 —'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  await closeBrowser();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await initBrowser();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on :${PORT}`);
});
