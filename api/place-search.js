// api/place-search.js
// 플레이스 키워드 검색 순위(1~300위)를 한국 스크래퍼(NCP)에서 가져온다.
//   GET /api/place-search?keyword=<키워드>&count=300
// 깊은 스크롤(최대 ~50초)을 스크래퍼가 수행하므로 함수 실행시간을 60초로 늘린다.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const keyword = (req.query.keyword || '').toString().trim();
  const count = Math.min(300, Math.max(1, parseInt(req.query.count, 10) || 300));
  if (!keyword) return res.status(400).json({ ok: false, error: 'keyword required' });

  const base = process.env.KOREAN_SCRAPER_URL;
  const key = process.env.KOREAN_SCRAPER_KEY;
  if (!base || !key) {
    return res.status(500).json({ ok: false, error: '스크래퍼 환경변수(KOREAN_SCRAPER_URL/KEY) 미설정' });
  }

  try {
    const endpoint =
      `${base.replace(/\/$/, '')}/place-search` +
      `?keyword=${encodeURIComponent(keyword)}&count=${count}`;
    const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` } });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: data.error || `스크래퍼 오류 ${resp.status}` });
    }
    return res.status(200).json({ ok: true, keyword, items: data.items || [], total: data.total || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
