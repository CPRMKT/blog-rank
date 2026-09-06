// src/placeSearch.js
// 네이버 플레이스 키워드 검색 순위(1~N위) 스크래퍼.
// 실브라우저로 리스트 페이지를 열어 내부 GraphQL(placeList) 응답을 가로채
// 조직(PlaceListBusinesses) 결과를 순위대로 수집한다. 광고(adBusinesses)는 제외.

import fs from 'fs';
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

export async function scrapePlaceSearch(keyword, count = 50, budgetMs = 50000) {
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
      saves: it.saveCount == null ? null : toNum(it.saveCount),
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
  // GraphQL 요청 템플릿(쿼리·헤더·쿠키) 캡처 → 이후 start 오프셋만 바꿔 직접 호출.
  // 모바일 스크롤 UI는 ~110위에서 자동로딩을 멈추지만, GraphQL은 start로 300위까지 페이지네이션됨.
  let cap = null;
  page.on('request', (req) => {
    if (req.url().includes('api.place.naver.com/graphql') && req.method() === 'POST' && !cap) {
      const pd = req.postData();
      if (pd && /PlaceList|business/i.test(pd)) cap = { url: req.url(), headers: req.headers(), body: pd };
    }
  });
  const findInput = (v) =>
    (v && (v.input || v.restaurantListInput || v.businessListInput || v.hairShopListInput || v.hospitalListInput || v.cafeListInput)) || null;

  try {
    const url = `https://m.place.naver.com/${listPath(keyword)}/list?query=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForTimeout(2500);
    // 요청 캡처 보장(안 잡히면 스크롤 몇 번으로 유도)
    for (let i = 0; i < 4 && !cap; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    // 캡처 실패 = 스크랩 실패다. 빈 배열(정상 0곳)로 위장하면 저장 로직이
    // 기존 스냅샷을 0곳으로 덮어쓴다(9/6 저녁 37건 파괴 사건) → 명시적 에러로 승격.
    if (!cap) throw new Error('GraphQL 캡처 실패(페이지 미로드·차단 의심)');
    // 진단용: 캡처된 GraphQL 요청 변수(쿼리 해석·좌표 등)를 1회 기록
    if (process.env.PLACE_DEBUG_FILE) {
      try {
        const b = JSON.parse(cap.body);
        const ops = (Array.isArray(b) ? b : [b]).map((op) => ({ op: op.operationName, vars: op.variables }));
        fs.appendFileSync(process.env.PLACE_DEBUG_FILE, JSON.stringify({ type: 'cap', keyword, url: cap.url, ops }) + '\n');
      } catch {}
    }

    // start=1,51,101…로 올리며 GraphQL 직접 호출. count 도달 or 2회 연속 신규 없음 → 종료.
    const t0 = Date.now();
    const PAGE = 50;
    let empties = 0;
    for (let start = 1; items.length < count && start <= count + 50 && empties < 2; start += PAGE) {
      if (Date.now() - t0 > budgetMs) break; // 시간예산 초과 → 여기까지 수집한 선에서 종료
      const body = JSON.parse(cap.body);
      const arr = Array.isArray(body) ? body : [body];
      const idx = arr.findIndex((op) => op && op.variables && findInput(op.variables));
      if (idx < 0) break;
      const inp = findInput(arr[idx].variables);
      inp.start = start;
      inp.display = PAGE;
      let j = null;
      try {
        const res = await context.request.post(cap.url, {
          headers: cap.headers,
          data: Array.isArray(body) ? arr : arr[0],
          timeout: 15000,
        });
        if (res.ok()) j = await res.json();
      } catch { /* 네트워크 오류 → 빈 페이지 취급 */ }
      const before = items.length;
      // 진단용 원시 덤프: PLACE_DEBUG_FILE 지정 시 페이지별 raw 항목(광고 포함) 기록
      if (process.env.PLACE_DEBUG_FILE && j) {
        try {
          const raw = [];
          (function dig(o, pk) {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { for (const e of o) dig(e, pk); return; }
            for (const k in o) {
              const v = o[k];
              if (k === 'items' && Array.isArray(v)) {
                for (const it of v) raw.push({ c: pk, id: it && it.id, name: it && it.name, ad: !!(it && (it.isAd || it.adId)), adDup: !!(it && it.isAdDup), rv: !!(it && (it.visitorReviewCount !== undefined || it.blogCafeReviewCount !== undefined)) });
              } else if (v && typeof v === 'object') dig(v, k);
            }
          })(j, '');
          fs.appendFileSync(process.env.PLACE_DEBUG_FILE, JSON.stringify({ keyword, start, rawCount: raw.length, raw }) + '\n');
        } catch {}
      }
      if (j) walk(j, '');
      if (items.length === before) empties++; else empties = 0;
      await page.waitForTimeout(350); // 차단 방지용 요청 간 딜레이
    }

    // 자체점검: 300 요청에 100곳 미만이면 축소 변형 응답 가능성 — 서버 로그에 경고(조용한 누락 방지)
    if (count >= 200 && items.length > 0 && items.length < 100) {
      console.warn(`[place-search] "${keyword}" 결과 ${items.length}곳뿐 (count=${count}) — 축소 응답 의심`);
    }
    return items.slice(0, count).map((it, i) => ({
      rank: i + 1,
      placeId: it.placeId,
      name: it.name,
      category: it.category,
      visitorReviews: it.visitorReviews,
      blogReviews: it.blogReviews,
      saves: it.saves,
      placeUrl: `https://map.naver.com/p/entry/place/${it.placeId}`,
    }));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
