// api/search.js
// 블로그 탭 순위 검색 API
// 환경변수 SEARCH_METHOD로 검색 방법 전환:
//   auto (기본) → direct 스크래핑 시도, 실패 시 네이버 API 폴백
//   direct     → 네이버 블로그 탭 HTML 직접 스크래핑
//   serpapi    → SerpApi 사용 (SERPAPI_KEY 필요)
//   naver_api  → 기존 네이버 공식 API (순위 부정확)

import { getBlogRankings } from './_lib/blogSearch.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { query, count } = req.query;
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }

  try {
    const result = await getBlogRankings(query, parseInt(count) || 30);

    // 기존 프론트엔드 호환: items + total 형태 유지
    return res.status(200).json({
      items: result.items,
      total: result.total,
      method: result.method,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
