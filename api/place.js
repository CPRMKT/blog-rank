// api/place.js
// 네이버 플레이스 조회 API (프론트엔드에서 호출)
//
// 사용법:
//   1. URL 파싱 + 매장 정보:
//      GET /api/place?url=<네이버 지도 URL>
//
//   2. Place ID로 매장 정보 + 블로그 리뷰 수집:
//      GET /api/place?placeId=<ID>&action=fetch_reviews

import {
  parsePlaceUrl,
  fetchPlaceDetail,
  fetchAllBlogReviews,
  parseBlogUrl,
} from './_lib/naverPlace.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.query.action || 'detail';

    // ============================================
    // [1] URL 파싱 + 매장 기본 정보
    //    클라이언트 매장 등록 폼에서 URL 붙여넣기 직후 호출
    //    GET /api/place?url=<네이버 지도 URL>
    // ============================================
    if (action === 'detail' || action === 'parse') {
      let placeId = req.query.placeId;
      let originalUrl = null;

      // URL이 주어진 경우 파싱 먼저
      if (!placeId && req.query.url) {
        const parsed = await parsePlaceUrl(req.query.url);
        placeId = parsed.placeId;
        originalUrl = parsed.originalUrl;
      }

      if (!placeId) {
        return res.status(400).json({
          ok: false,
          error: 'url 또는 placeId 파라미터가 필요합니다',
        });
      }

      // action=parse이면 Place ID만 반환 (매장 기본정보 조회 안 함 - 빠른 프리뷰용)
      if (action === 'parse') {
        return res.status(200).json({
          ok: true,
          placeId,
          originalUrl,
        });
      }

      // 매장 기본 정보 조회 (businessType은 리다이렉트로 자동 감지)
      const detail = await fetchPlaceDetail(placeId);

      return res.status(200).json({
        ok: true,
        placeId,
        placeUrl: `https://map.naver.com/p/entry/place/${placeId}`,
        originalUrl,
        detail,
      });
    }

    // ============================================
    // [2] 매장 블로그 리뷰 전체 수집
    //    순위 조회 시점 또는 매장 등록 직후 호출
    //    GET /api/place?placeId=<ID>&action=fetch_reviews&businessType=restaurant
    // ============================================
    if (action === 'fetch_reviews') {
      const placeId = req.query.placeId;
      if (!placeId) {
        return res.status(400).json({ ok: false, error: 'placeId가 필요합니다' });
      }

      // businessType이 주어지지 않으면 detail 조회해서 파악
      let businessType = req.query.businessType;
      if (!businessType) {
        const detail = await fetchPlaceDetail(placeId);
        businessType = detail.businessType || 'place';
      }

      const { total, maxItemCount, collected } = await fetchAllBlogReviews(
        placeId,
        businessType,
        { maxPages: 11, display: 10, includeTypes: ['blog'] }
      );

      // 각 리뷰에서 blog_id, post_id 추출 (매칭 속도 향상용)
      const posts = collected.map(item => {
        const parsed = parseBlogUrl(item.url);
        return {
          blog_url: item.url,
          blog_id: parsed?.blogId || null,
          post_id: parsed?.postId || null,
          title: item.title || null,
          author_name: item.name || null,
          created_string: item.createdString || null,
        };
      });

      return res.status(200).json({
        ok: true,
        placeId,
        businessType,
        total,            // 네이버가 알려준 전체 리뷰 수 (참고용, 실제는 maxItemCount까지만)
        maxItemCount,     // 실제로 가져올 수 있는 최대 개수 (보통 101)
        collected_count: posts.length,
        posts,
      });
    }

    return res.status(400).json({
      ok: false,
      error: `Unknown action: ${action}. Use 'detail', 'parse', or 'fetch_reviews'.`,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
}
