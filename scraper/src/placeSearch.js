// src/placeSearch.js
// 네이버 플레이스 키워드 검색 순위(1~N위) 스크래퍼.
// 실브라우저로 리스트 페이지를 열어 내부 GraphQL(placeList) 응답을 가로채
// 조직(PlaceListBusinesses) 결과를 순위대로 수집한다. 광고(adBusinesses)는 제외.

import fs from 'fs';
import { initBrowser } from './scraper.js';
import { LIST_OPS, isListOp, inspectCapture, findInput } from './captureSelect.js';

export { LIST_OPS, isListOp, inspectCapture, findInput };   // 기존 import 경로 유지

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const toNum = (s) => parseInt(String(s == null ? '' : s).replace(/[^\d]/g, ''), 10) || 0;

// ── 리뷰 항목 형태 계수(2026-11-22 승인) ──
// 네이버가 리뷰 0개 매장에 0 을 주는지 항목을 빼는지 알기 위해, 평소 수집 응답 안에서 형태별 개수만 센다.
// 매장·키워드·이름 같은 내용은 남기지 않는다. 저장값·반환값·순위에는 영향 없음(계수만).
// 형태: none(항목 없음) / null / empty(빈 문자열) / zero(0 또는 "0") / num(양수) / other(숫자로 못 읽는 값)
const SHAPE_LOG = process.env.PLACE_SHAPE_LOG || '/var/log/blog-rank-scraper/place-review-shape.jsonl';
function shapeOf(v) {
  if (v === undefined) return 'none';
  if (v === null) return 'null';
  if (typeof v === 'string' && v.trim() === '') return 'empty';
  if (v === 0 || (typeof v === 'string' && /^\s*0+\s*$/.test(v))) return 'zero';
  if ((typeof v === 'number' && v > 0) || (typeof v === 'string' && toNum(v) > 0)) return 'num';
  return 'other';
}
const newShape = () => ({ none: 0, null: 0, empty: 0, zero: 0, num: 0, other: 0 });

// 페이지(50건) 사이 딜레이 350ms. 150ms로 줄였던 9/18~19에 수집 45분차부터 약 35분간 네이버가 빈 목록을
// 연속 반환(0곳보류 10→55→56건, 이전 5회 연속 0건). 짧은 A/B로는 누적 속도 제한이 재현되지 않으므로
// 낮추려면 전체 크론 1회분(300여 키워드) 규모로 검증할 것.
const PAGE_DELAY_MS = parseInt(process.env.PLACE_PAGE_DELAY_MS || '350', 10);

// 키워드로 플레이스 vertical(리스트 경로) 판별. m.place는 generic list가 없어
// 업종 vertical 경로로 접근해야 검색 결과가 렌더된다. 기본은 restaurant.
function listPath(keyword) {
  if (process.env.PLACE_FORCE_PATH) return process.env.PLACE_FORCE_PATH;   // 진단용: 다른 vertical로 열어보기
  const k = String(keyword || '');
  if (/미용실|헤어|네일|왁싱|피부관리|에스테틱|뷰티|메이크업|반영구|속눈썹/.test(k)) return 'hairshop';
  if (/병원|의원|치과|한의원|약국|정형외과|피부과|이비인후|안과|산부인과/.test(k)) return 'hospital';
  // 카페·디저트·브런치는 restaurant 경로로 보낸다. /cafe/list 는 404지만,
  // /restaurant/list 가 카페·디저트 업종까지 같이 돌려준다(2026-11-16 실측:
  // "해운대 브런치" 50곳, 상위 5곳에 '카페,디저트' 3곳 포함). 네이버 모바일 검색의
  // '더보기'도 카페 키워드를 /restaurant/list 로 보낸다.
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
  // 형태 계수(내용 없이 개수만). skip=리뷰 항목이 둘 다 없어 건너뛴 수,
  // skipMid=그중 같은 목록에서 뒤에 남은 매장이 있는 것(= 뒤 순위가 한 칸씩 당겨졌을 수 있는 것)
  const shape = { v: newShape(), b: newShape(), s: newShape(), kept: 0, skip: 0, skipMid: 0, skipAd: 0 };
  let pendingSkip = 0;   // 현재 items 배열에서 아직 뒤에 남은 매장이 안 나온 건너뛴 수
  const addItem = (it) => {
    if (!it || !it.id || seen.has(String(it.id))) return;
    // 장소 항목만(리뷰수 필드 보유), 광고 항목 제외
    if (it.visitorReviewCount === undefined && it.blogCafeReviewCount === undefined) {
      if (it.isAd || it.adId || it.isAdDup) shape.skipAd++; else { shape.skip++; pendingSkip++; }
      return;
    }
    if (it.isAd || it.adId || it.isAdDup) return;
    try {
      shape.v[shapeOf(it.visitorReviewCount)]++;
      shape.b[shapeOf(it.blogCafeReviewCount)]++;
      shape.s[shapeOf(it.saveCount)]++;
      shape.kept++;
      shape.skipMid += pendingSkip; pendingSkip = 0;
    } catch {}
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
        pendingSkip = 0;   // 목록마다 따로 센다
        for (const it of v) addItem(it);
        pendingSkip = 0;
      } else if (v && typeof v === 'object') {
        walk(v, k);
      }
    }
  };
  // GraphQL 요청 템플릿(쿼리·헤더·쿠키) 캡처 → 이후 start 오프셋만 바꿔 직접 호출.
  // 모바일 스크롤 UI는 ~110위에서 자동로딩을 멈추지만, GraphQL은 start로 300위까지 페이지네이션됨.
  let cap = null;
  const seenOps = new Set();   // 실패 시 "무엇을 봤는지"를 로그에 남기기 위해 모아 둔다
  page.on('request', (req) => {
    if (cap) return;
    if (!req.url().includes('api.place.naver.com/graphql') || req.method() !== 'POST') return;
    const pd = req.postData();
    if (!pd || !/PlaceList|business/i.test(pd)) return;
    const v = inspectCapture(pd);
    for (const n of v.ops) seenOps.add(n);
    if (!v.accept) return;
    cap = { url: req.url(), headers: req.headers(), body: pd };
  });

  try {
    const path = listPath(keyword);
    const url = `https://m.place.naver.com/${path}/list?query=${encodeURIComponent(keyword)}`;
    const nav = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    const navStatus = nav ? nav.status() : 0;
    // 고정 2.5초 대기. 이 대기가 키워드 사이 간격 역할도 해서, 캡처 즉시 진행으로 줄이면
    // 요청 속도가 올라가 네이버 누적 속도 제한에 걸린다(9/18~19 0곳 다발).
    await page.waitForTimeout(2500);
    // 요청 캡처 보장(안 잡히면 스크롤 몇 번으로 유도)
    for (let i = 0; i < 4 && !cap; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    // 캡처 실패 = 스크랩 실패다. 빈 배열(정상 0곳)로 위장하면 저장 로직이
    // 기존 스냅샷을 0곳으로 덮어쓴다(9/6 저녁 37건 파괴 사건) → 명시적 에러로 승격.
    if (!cap) {
      // 목록 페이지 자체가 열리지 않은 경우(404 등)만 '업종 미지원'으로 안내한다.
      // 키워드에 든 단어로 미리 판단하지 않는다 — "해운대 브런치"처럼 식당인데
      // 카페류 단어가 섞인 키워드를 막아 버렸다(2026-11-16 수정).
      if (navStatus >= 400) {
        throw new Error(`LIST_PAGE_UNAVAILABLE 목록 페이지가 열리지 않았습니다 — m.place.naver.com/${path}/list 가 ${navStatus}를 돌려줍니다(네이버가 이 업종 목록을 제공하지 않습니다)`);
      }
      const seen = [...seenOps].join(', ') || '없음';
      // 이름을 봤는데 허용 목록에 없다 = 네이버가 쿼리를 바꾼 것. 0곳으로 넘기지 않고 에러로 올린다.
      throw new Error(seenOps.size
        ? `순위 목록 GraphQL 미채택 — 본 쿼리: ${seen} (허용: ${[...LIST_OPS].join(', ')})`
        : 'GraphQL 캡처 실패(페이지 미로드·차단 의심)');
    }
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
      const idx = arr.findIndex((op) => isListOp(op));
      // 첫 페이지부터 입력 자리를 못 찾으면 스크랩 실패다. 0곳으로 위장하면 기존 스냅샷이
      // 0으로 덮이거나 화면에 가짜 미노출이 뜬다 → 명시적 에러로 올린다.
      if (idx < 0) { if (start === 1) throw new Error('목록 GraphQL 입력 없음(요청 캡처 오류)'); break; }
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
      await page.waitForTimeout(PAGE_DELAY_MS); // 차단 방지용 요청 간 딜레이(기본 350ms, PLACE_PAGE_DELAY_MS로 조정)
    }

    // 자체점검: 300 요청에 100곳 미만이면 축소 변형 응답 가능성 — 서버 로그에 경고(조용한 누락 방지)
    if (count >= 200 && items.length > 0 && items.length < 100) {
      console.warn(`[place-search] "${keyword}" 결과 ${items.length}곳뿐 (count=${count}) — 축소 응답 의심`);
    }
    // 형태 계수 1줄 기록(개수만). 기록 실패는 수집에 영향 주지 않는다.
    try {
      fs.appendFileSync(SHAPE_LOG, JSON.stringify({ t: new Date().toISOString(), n: Math.min(items.length, count), ...shape }) + '\n');
    } catch {}
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
