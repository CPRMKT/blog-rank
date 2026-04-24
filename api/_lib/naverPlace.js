// api/_lib/naverPlace.js
// 네이버 지도 URL에서 Place ID 추출

/**
 * 네이버 지도 URL에서 Place ID를 추출합니다.
 * 지원 패턴:
 *   - https://map.naver.com/p/entry/place/1234567890
 *   - https://map.naver.com/p/search/키워드/place/1234567890
 *   - https://map.naver.com/v5/entry/place/1234567890        (구버전)
 *   - https://pcmap.place.naver.com/restaurant/1234567890/home
 *   - https://pcmap.place.naver.com/place/1234567890/home
 *   - https://m.place.naver.com/restaurant/1234567890/home
 *   - https://m.place.naver.com/place/1234567890/home
 *   - https://naver.me/xxxxx           (단축 URL - 리다이렉트 추적 필요)
 *
 * @param {string} input - 네이버 지도 URL 또는 Place ID 문자열
 * @returns {Promise<{placeId: string, normalizedUrl: string, originalUrl: string}>}
 * @throws {Error} Place ID를 찾을 수 없을 때
 */
export async function parsePlaceUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('URL이 비어있습니다');
  }

  const trimmed = input.trim();

  // 1. 숫자만 입력한 경우 (Place ID 직접 입력)
  if (/^\d{6,12}$/.test(trimmed)) {
    return {
      placeId: trimmed,
      normalizedUrl: `https://map.naver.com/p/entry/place/${trimmed}`,
      originalUrl: trimmed,
    };
  }

  // 2. URL 형태로 입력한 경우
  let url = trimmed;
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let finalUrl = url;

  // 3. naver.me 단축 URL → 리다이렉트 추적
  if (/naver\.me/i.test(url)) {
    finalUrl = await resolveShortUrl(url);
  }

  // 4. 다양한 패턴에서 Place ID 추출
  const placeId = extractPlaceIdFromUrl(finalUrl);

  if (!placeId) {
    throw new Error(
      `Place ID를 찾을 수 없습니다. 네이버 지도에서 매장을 검색하고 URL을 복사해주세요.\n입력된 URL: ${finalUrl}`
    );
  }

  return {
    placeId,
    normalizedUrl: `https://map.naver.com/p/entry/place/${placeId}`,
    originalUrl: trimmed,
  };
}

/**
 * URL 문자열에서 Place ID를 추출 (순수 함수, 네트워크 호출 없음)
 * 테스트하기 쉽도록 분리
 *
 * @param {string} url
 * @returns {string | null}
 */
export function extractPlaceIdFromUrl(url) {
  if (!url) return null;

  const patterns = [
    // map.naver.com/p/entry/place/{id}
    // map.naver.com/v5/entry/place/{id}
    /map\.naver\.com\/(?:p|v5)\/entry\/place\/(\d{6,12})/i,

    // map.naver.com/p/search/{keyword}/place/{id}
    /map\.naver\.com\/p\/search\/[^/]+\/place\/(\d{6,12})/i,

    // pcmap.place.naver.com/restaurant/{id}/...
    // pcmap.place.naver.com/place/{id}/...
    // pcmap.place.naver.com/hairshop/{id}/...
    // (카테고리 이름은 다양하므로 와일드카드)
    /pcmap\.place\.naver\.com\/[a-z]+\/(\d{6,12})/i,

    // m.place.naver.com/restaurant/{id}/...
    /m\.place\.naver\.com\/[a-z]+\/(\d{6,12})/i,

    // map.naver.com/p/directions/.../{placeName},{placeId},PLACE_POI/...
    /map\.naver\.com\/p\/directions\/.*?,(\d{6,12}),PLACE_POI/i,

    // 쿼리 파라미터에 들어간 경우 (?placeId=1234567890 등)
    /[?&]placeId=(\d{6,12})/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}



/**
 * naver.me 단축 URL을 풀어서 실제 URL을 반환합니다.
 * GET + redirect:manual 로 Location 헤더를 따라갑니다 (최대 5회).
 * HEAD를 쓰면 일부 서버가 405를 반환하므로 GET 사용.
 *
 * @param {string} shortUrl
 * @returns {Promise<string>} 최종 URL
 * @throws {Error} 리다이렉트 실패 또는 네트워크 에러 시
 */
export async function resolveShortUrl(shortUrl) {
  let currentUrl = shortUrl;
  const maxRedirects = 5;

  for (let i = 0; i < maxRedirects; i++) {
    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
            'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
            'Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
      });
    } catch (e) {
      throw new Error(`단축 URL 접속 실패: ${e.message}`);
    }

    // 3xx 리다이렉트
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`리다이렉트 Location 헤더가 없습니다 (status=${response.status})`);
      }

      // 상대 경로면 절대 경로로 변환
      currentUrl = new URL(location, currentUrl).toString();

      // naver.me 이외의 도메인으로 넘어가면 최종 URL로 간주
      if (!/naver\.me/i.test(currentUrl)) {
        return currentUrl;
      }
      continue;
    }

    // 200이면 body에서 meta refresh / JS location 확인 (드문 케이스)
    if (response.status === 200) {
      try {
        const html = await response.text();
        const metaMatch = html.match(/<meta[^>]+url=([^"'>\s]+)/i);
        if (metaMatch) {
          return new URL(metaMatch[1], currentUrl).toString();
        }
        const jsMatch = html.match(/location\.(?:href|replace)\s*=\s*['"]([^'"]+)/);
        if (jsMatch) {
          return new URL(jsMatch[1], currentUrl).toString();
        }
      } catch {}
      return currentUrl;
    }

    // 3xx, 200 이외 (403, 404, 5xx 등)
    throw new Error(`단축 URL 리졸브 실패 (status=${response.status})`);
  }

  return currentUrl;
}

/**
 * 네이버 블로그 URL에서 blog_id와 post_id를 추출합니다.
 * 1~10위 결과와 매장 블로그 목록을 비교할 때 사용.
 *
 * 지원 패턴:
 *   - https://blog.naver.com/{blogId}/{postId}
 *   - https://blog.naver.com/PostView.naver?blogId={blogId}&logNo={postId}
 *   - https://blog.naver.com/PostView.nhn?blogId={blogId}&logNo={postId}
 *   - https://m.blog.naver.com/{blogId}/{postId}
 *   - https://m.blog.naver.com/PostView.naver?blogId={blogId}&logNo={postId}
 *
 * @param {string} url
 * @returns {{blogId: string, postId: string} | null}
 */
export function parseBlogUrl(url) {
  if (!url) return null;

  // PostView.naver?blogId=xxx&logNo=yyy 형태
  const postViewMatch = url.match(
    /blog\.naver\.com\/PostView\.n(?:aver|hn)\?.*?blogId=([^&]+).*?logNo=(\d+)/i
  );
  if (postViewMatch) {
    return { blogId: postViewMatch[1], postId: postViewMatch[2] };
  }

  // blog.naver.com/{blogId}/{postId} 형태
  const pathMatch = url.match(
    /(?:m\.)?blog\.naver\.com\/([^/?#]+)\/(\d+)/i
  );
  if (pathMatch) {
    return { blogId: pathMatch[1], postId: pathMatch[2] };
  }

  return null;
}

/**
 * 두 네이버 블로그 URL이 같은 포스트를 가리키는지 비교합니다.
 * URL 형태가 달라도 blogId + postId가 같으면 같은 포스트.
 *
 * @param {string} urlA
 * @param {string} urlB
 * @returns {boolean}
 */
export function isSameBlogPost(urlA, urlB) {
  const a = parseBlogUrl(urlA);
  const b = parseBlogUrl(urlB);
  if (!a || !b) return false;
  return a.blogId === b.blogId && a.postId === b.postId;
}

// ============================================================
// 네이버 플레이스 비공식 GraphQL API 클라이언트
// ============================================================
// 참고: 이 API는 네이버가 공식 문서를 제공하지 않는 내부 API입니다.
// 스펙이 변경될 수 있으며, 과도한 호출 시 IP 차단 가능성이 있습니다.
// 프로덕션에서는 결과를 반드시 캐싱해서 호출 빈도를 최소화하세요.
// ============================================================

const PLACE_GRAPHQL_ENDPOINT = 'https://api.place.naver.com/graphql';
const PLACE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * x-wtm-graphql 헤더 값을 생성합니다.
 * Base64로 인코딩된 JSON: {arg: placeId, type: businessType, source: "place"}
 */
function buildWtmHeader(placeId, businessType) {
  const payload = JSON.stringify({
    arg: placeId,
    type: businessType,
    source: 'place',
  });
  // Node(Vercel 서버리스)와 Edge 모두 커버
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(payload, 'utf-8').toString('base64');
  }
  // Edge Runtime fallback
  return btoa(unescape(encodeURIComponent(payload)));
}

/**
 * 매장의 플레이스 홈 페이지를 fetch해서 businessType을 추정합니다.
 * (restaurant / place / hairshop / accommodation 등)
 *
 * @param {string} placeId
 * @returns {Promise<string>} businessType (기본값: 'place')
 */
export async function detectBusinessType(placeId) {
  const url = `https://m.place.naver.com/place/${placeId}/home`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': PLACE_USER_AGENT,
        'Accept': 'text/html',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    // 리다이렉트 최종 URL에서 businessType 추출
    // ex) https://m.place.naver.com/restaurant/2005368682/home
    const m = resp.url.match(/m\.place\.naver\.com\/([a-z]+)\//i);
    if (m && m[1] !== 'place') return m[1];
    return 'place';
  } catch {
    return 'place';
  }
}

/**
 * 매장 기본 정보(이름, 주소, 업종, 전화번호 등)를 가져옵니다.
 * 플레이스 페이지 HTML에서 __APOLLO_STATE__를 파싱.
 *
 * @param {string} placeId
 * @param {string} [businessType]
 * @returns {Promise<{name, category, roadAddress, address, phone, visitorReviewsTotal, businessType} | null>}
 */
export async function fetchPlaceDetail(placeId, businessType = null) {
  const type = businessType || 'place';
  const url = `https://m.place.naver.com/${type}/${placeId}/home`;

  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': PLACE_USER_AGENT,
      'Accept': 'text/html',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://map.naver.com/',
    },
  });

  if (!resp.ok) {
    throw new Error(`플레이스 페이지 요청 실패 (status=${resp.status})`);
  }

  // 리다이렉트된 최종 URL에서 실제 businessType 추출
  const finalType =
    (resp.url.match(/m\.place\.naver\.com\/([a-z]+)\//i) || [])[1] || type;

  const html = await resp.text();

  // window.__APOLLO_STATE__ = {...};
  const match = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error('플레이스 페이지에서 매장 정보를 찾을 수 없습니다');
  }

  let apolloState;
  try {
    apolloState = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`매장 정보 파싱 실패: ${e.message}`);
  }

  const detail = apolloState[`PlaceDetailBase:${placeId}`];
  if (!detail) {
    throw new Error('해당 Place ID의 매장을 찾을 수 없습니다');
  }

  return {
    placeId,
    businessType: finalType,
    name: detail.name || null,
    category: detail.category || null,
    roadAddress: detail.roadAddress || null,
    address: detail.address || null,
    phone: detail.virtualPhone || detail.phone || null,
    visitorReviewsTotal: detail.visitorReviewsTotal || 0,
  };
}

/**
 * 매장의 블로그 리뷰 목록을 가져옵니다.
 * GraphQL API (getFsasReviews) 호출.
 *
 * @param {string} placeId
 * @param {string} businessType - 'restaurant', 'place', 'hairshop' 등
 * @param {object} [options]
 * @param {number} [options.page=1] - 페이지 번호 (1-indexed)
 * @param {number} [options.display=100] - 페이지당 항목 수 (최대 100)
 * @returns {Promise<{total, maxItemCount, items: Array}>}
 */
export async function fetchBlogReviewsPage(placeId, businessType, options = {}) {
  const { page = 1, display = 100 } = options;

  const body = [
    {
      operationName: 'getFsasReviews',
      variables: {
        input: {
          businessId: placeId,
          businessType: businessType,
          page,
          display,
          deviceType: 'mobile',
          query: null,
          excludeGdids: [],
          buyWithMyMoneyType: false,
        },
      },
      query: `query getFsasReviews($input: FsasReviewsInput) {
  fsasReviews(input: $input) {
    total
    maxItemCount
    items {
      name
      type
      typeName
      url
      home
      id
      title
      rank
      date
      reviewId
      authorName
      createdString
      __typename
    }
    __typename
  }
}`,
    },
  ];

  const resp = await fetch(PLACE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'ko',
      'content-type': 'application/json',
      'origin': 'https://m.place.naver.com',
      'referer': `https://m.place.naver.com/${businessType}/${placeId}/review/ugc`,
      'user-agent': PLACE_USER_AGENT,
      'x-wtm-graphql': buildWtmHeader(placeId, businessType),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`플레이스 GraphQL 요청 실패 (status=${resp.status})`);
  }

  const json = await resp.json();
  const result = json?.[0]?.data?.fsasReviews;

  if (!result) {
    const errMsg = json?.[0]?.errors?.[0]?.message;
    throw new Error(`플레이스 리뷰 응답이 비어있습니다${errMsg ? `: ${errMsg}` : ''}`);
  }

  return {
    total: result.total || 0,
    maxItemCount: result.maxItemCount || 0,
    items: result.items || [],
  };
}

/**
 * 매장의 모든 블로그/카페 리뷰를 페이지네이션을 돌아 수집합니다.
 * 네이버 정책상 최대 maxItemCount(보통 101)개까지만 가져올 수 있습니다.
 *
 * @param {string} placeId
 * @param {string} businessType
 * @param {object} [options]
 * @param {number} [options.maxPages=2] - 안전 상한 (무한 루프 방지)
 * @param {number} [options.display=100] - 페이지당 개수
 * @param {string[]} [options.includeTypes=['blog']] - 'blog' | 'cafe' 중 수집할 타입들
 * @returns {Promise<{total, collected: Array}>}
 */
export async function fetchAllBlogReviews(placeId, businessType, options = {}) {
  const { maxPages = 2, display = 100, includeTypes = ['blog'] } = options;

  const collected = [];
  let total = 0;
  let maxItemCount = 0;
  let seenUrls = new Set();

  for (let page = 1; page <= maxPages; page++) {
    let pageResult;
    try {
      pageResult = await fetchBlogReviewsPage(placeId, businessType, { page, display });
    } catch (e) {
      // 첫 페이지에서 실패하면 에러 던지고, 2페이지 이상에서 실패하면 여기까지로 마감
      if (page === 1) throw e;
      break;
    }

    if (page === 1) {
      total = pageResult.total;
      maxItemCount = pageResult.maxItemCount;
    }

    const filtered = (pageResult.items || []).filter(
      item => includeTypes.includes(item.type) && item.url
    );

    for (const item of filtered) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      collected.push(item);
    }

    // 더 이상 가져올 게 없으면 종료
    if (pageResult.items.length < display) break;
    if (collected.length >= maxItemCount) break;
  }

  return { total, maxItemCount, collected };
}
