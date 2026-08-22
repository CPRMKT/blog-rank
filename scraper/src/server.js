// Express 진입점. 인증 + /scrape + /place-search 라우트.
import express from 'express';
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
    const r = await scrapeBlogRank(keyword, { placeId, storeName, maxRank: count });
    res.json({ ...r, method: 'playwright', elapsedMs: Date.now() - t0, scrapedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[blog-rank error]', e);
    res.status(500).json({ error: e.message || 'blog-rank failed', elapsedMs: Date.now() - t0 });
  }
});

// 플레이스 키워드 검색 순위(1~50위)
app.get('/place-search', async (req, res) => {
  const keyword = (req.query.keyword || '').toString().trim();
  const count = parseInt(req.query.count || '50', 10);

  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  if (!Number.isFinite(count) || count < 1 || count > 300) {
    return res.status(400).json({ error: 'count must be 1~300' });
  }

  const t0 = Date.now();
  try {
    const items = await scrapePlaceSearch(keyword, count);
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
