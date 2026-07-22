// src/placeSearch.js
// 네이버 플레이스 키워드 검색 순위(1~N위) 스크래퍼.
// 실브라우저로 리스트 페이지를 열어 내부 GraphQL(placeList) 응답을 가로채
// 조직(PlaceListBusinesses) 결과를 순위대로 수집한다. 광고(adBusinesses)는 제외.

import { initBrowser } from './scraper.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const toNum = (s) => parseInt(String(s == null ? '' : s).replace(/[^\d]/g, ''), 10) || 0;

// 키워드로 플레이스 vertical(리스트 경로) 판별. m.place는 generic list가 없어
// 업종 vertical 경로로 접근해야 검색 결과가 렌더된다. 기본은 restaurant.
function listPath(keyword) {
  const k = String(keyword || '');
  if (/미용실|헤어|네일|왁싱|피부관리|에스테틱|뷰티|메이크업|반영구|속눈썹/.test(k)) return 'hairshop';
  if (/병원|의원|치과|한의원|약국|정형외과|피부과|이비인후|안과|산부인과/.test(k)) return 'hospital';
  if (/카페|커피|디저트|베이커리|빵집|브런치/.test(k)) return 'cafe';
  return 'restaurant';
}

export async function scrapePlaceSearch(keyword, count = 50) {
  const b = await initBrowser();
  const context = await b.newContext({
    userAgent: MOBILE_UA,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
  const page = await context.newPage();

  const items = [];
  const seen = new Set();
  const addItem = (it) => {
    if (!it || !it.id || seen.has(String(it.id))) return;
    // 장소 항목만(리뷰수 필드 보유), 광고 항목 제외
    if (it.visitorReviewCount === undefined && it.blogCafeReviewCount === undefined) return;
    if (it.isAd || it.adId || it.isAdDup) return;
    seen.add(String(it.id));
    items.push({
      placeId: String(it.id),
      name: it.name || '',
      category: it.category || '',
      visitorReviews: toNum(it.visitorReviewCount),
      blogReviews: toNum(it.blogCafeReviewCount),
    });
  };
  // 응답 JSON에서 items 배열을 순서대로 수집하되, 광고 컨테이너(키에 ad 포함)는 제외.
  const walk = (o, parentKey) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const e of o) walk(e, parentKey);
      return;
    }
    const isAdContainer = /ad/i.test(parentKey || '');
    for (const k in o) {
      const v = o[k];
      if (k === 'items' && Array.isArray(v) && !isAdContainer) {
        for (const it of v) addItem(it);
      } else if (v && typeof v === 'object') {
        walk(v, k);
      }
    }
  };
  page.on('response', async (resp) => {
    if (!resp.url().includes('api.place.naver.com/graphql')) return;
    try {
      const j = await resp.json();
      walk(j, '');
    } catch {}
  });

  try {
    const url = `https://m.place.naver.com/${listPath(keyword)}/list?query=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 12 && items.length < count; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1400);
    }
    return items.slice(0, count).map((it, i) => ({
      rank: i + 1,
      placeId: it.placeId,
      name: it.name,
      category: it.category,
      visitorReviews: it.visitorReviews,
      blogReviews: it.blogReviews,
      placeUrl: `https://map.naver.com/p/entry/place/${it.placeId}`,
    }));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
