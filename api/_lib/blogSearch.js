// api/_lib/blogSearch.js
// 네이버 블로그 탭 검색 결과를 가져오는 통합 모듈
// 방법 1: 네이버 검색 결과 HTML 직접 스크래핑 (무료)
// 방법 2: SerpApi (유료, 안정적)
// 환경변수 SEARCH_METHOD=serpapi 로 전환 가능

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================
// 방법 1: 네이버 블로그 탭 HTML 직접 스크래핑
// ============================================================

/**
 * 네이버 블로그 탭 검색 결과 HTML을 fetch하고
 * 블로그 포스트 URL + 제목을 순위 순서대로 파싱
 *
 * @param {string} keyword - 검색 키워드
 * @param {number} [count=30] - 가져올 결과 수 (최대 30)
 * @returns {Promise<{items: Array<{rank, link, title, blogId, postId}>, total: number, method: string}>}
 */
async function searchDirect(keyword, count = 30) {
  // 네이버 블로그 탭 URL
  const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(keyword)}&sm=tab_opt&nso=so%3Ar%2Cp%3Aall`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });

  if (!resp.ok) {
    throw new Error(`네이버 검색 요청 실패 (status=${resp.status})`);
  }

  const html = await resp.text();
  return parseNaverBlogHTML(html, count);
}

/**
 * 네이버 블로그 탭 HTML에서 검색 결과를 파싱
 * 
 * 전략: blog.naver.com/{blogId}/{postId} URL을 출현 순서대로 추출
 * 네이버 검색 결과 HTML에서 블로그 포스트 URL은 고유한 패턴이므로
 * 복잡한 DOM 구조 파싱 없이 URL 패턴으로 순위를 정확히 추출 가능
 */
function parseNaverBlogHTML(html, count = 30) {
  const items = [];
  const seenKeys = new Set(); // blogId+postId 중복 방지

  // 1단계: 모든 blog.naver.com/{blogId}/{postId} URL을 출현 순서대로 추출
  //   - href="..." 안에 있는 것만 추출 (본문 텍스트의 URL 혼입 방지)
  //   - blogId는 영문/숫자/언더스코어, postId는 12자리 이상 숫자
  const urlPattern = /href="(https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,}))[^"]*"/g;

  let match;
  while ((match = urlPattern.exec(html)) !== null && items.length < count) {
    const link = match[1];
    const blogId = match[2];
    const postId = match[3];
    const key = `${blogId}/${postId}`;

    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // 제목 추출: 해당 URL 주변에서 제목 텍스트 찾기
    const title = extractTitleNearUrl(html, match.index, link);

    items.push({
      rank: items.length + 1,
      link: `https://blog.naver.com/${blogId}/${postId}`,
      title,
      blogId,
      postId,
    });
  }

  // 전체 검색 결과 수 추출 시도
  let total = items.length;
  const totalMatch = html.match(/(?:"total"|totalCount)\s*[":]\s*(\d+)/);
  if (totalMatch) total = parseInt(totalMatch[1], 10);

  return { items, total, method: 'direct' };
}

/**
 * HTML에서 URL 출현 위치 근처의 제목 텍스트를 추출
 * 검색 결과에서 제목은 보통 URL이 포함된 <a> 태그 안에 있거나
 * 바로 뒤에 있는 텍스트 노드에 있음
 */
function extractTitleNearUrl(html, urlIndex, url) {
  // URL 앞뒤 2000자 범위에서 제목 추출 시도
  const start = Math.max(0, urlIndex - 500);
  const end = Math.min(html.length, urlIndex + 2000);
  const snippet = html.substring(start, end);

  // 방법1: 해당 URL을 href로 가진 <a> 태그의 내용
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aTagMatch = snippet.match(
    new RegExp(`<a[^>]+href="${escapedUrl}[^"]*"[^>]*>([\\s\\S]*?)<\\/a>`, 'i')
  );
  if (aTagMatch) {
    const cleaned = aTagMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 5 && cleaned.length < 200) return decodeHTMLEntities(cleaned);
  }

  // 방법2: class="title" 또는 class="title_link" 등의 요소에서 추출
  const titleClassMatch = snippet.match(
    /class="[^"]*title[^"]*"[^>]*>([^<]+(?:<(?!\/a)[^>]*>[^<]*)*)/i
  );
  if (titleClassMatch) {
    const cleaned = titleClassMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 5 && cleaned.length < 200) return decodeHTMLEntities(cleaned);
  }

  return '';
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}


// ============================================================
// 방법 2: SerpApi
// ============================================================

/**
 * SerpApi를 통해 네이버 블로그 검색 결과를 가져옴
 *
 * @param {string} keyword
 * @param {number} [count=30]
 * @returns {Promise<{items: Array<{rank, link, title, blogId, postId}>, total: number, method: string}>}
 */
async function searchSerpApi(keyword, count = 30) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error('SERPAPI_KEY 환경변수가 설정되지 않았습니다');
  }

  const params = new URLSearchParams({
    engine: 'naver',
    query: keyword,
    where: 'blog',
    api_key: apiKey,
  });

  const resp = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`SerpApi 요청 실패 (status=${resp.status}): ${err}`);
  }

  const data = await resp.json();
  const blogResults = data.blog_results || data.organic_results || [];

  const items = [];
  for (let i = 0; i < Math.min(blogResults.length, count); i++) {
    const r = blogResults[i];
    const link = r.link || r.url || '';
    const parsed = parseBlogUrl(link);

    items.push({
      rank: i + 1,
      link,
      title: (r.title || '').replace(/<[^>]+>/g, ''),
      blogId: parsed?.blogId || '',
      postId: parsed?.postId || '',
    });
  }

  return {
    items,
    total: data.search_information?.total_results || items.length,
    method: 'serpapi',
  };
}


// ============================================================
// 방법 3: 기존 네이버 공식 API (폴백)
// ============================================================

/**
 * 기존 네이버 블로그 검색 API (sort=sim)
 * 순위는 정확하지 않지만, 다른 방법이 모두 실패했을 때 폴백으로 사용
 */
async function searchNaverApi(keyword, count = 30) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 설정되지 않았습니다');
  }

  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=${count}&start=1&sort=sim`;
  const resp = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`네이버 API 요청 실패 (status=${resp.status}): ${err}`);
  }

  const data = await resp.json();
  const items = (data.items || []).slice(0, count).map((item, i) => {
    const parsed = parseBlogUrl(item.link || '');
    return {
      rank: i + 1,
      link: item.link || '',
      title: (item.title || '').replace(/<[^>]+>/g, ''),
      blogId: parsed?.blogId || '',
      postId: parsed?.postId || '',
    };
  });

  return { items, total: data.total || items.length, method: 'naver_api' };
}


// ============================================================
// 통합 인터페이스 (자동 폴백 포함)
// ============================================================

/**
 * 블로그 탭 검색 결과를 가져옵니다.
 * 환경변수 SEARCH_METHOD에 따라 방법을 선택:
 *   - 'serpapi' : SerpApi 사용
 *   - 'direct'  : 네이버 HTML 직접 스크래핑
 *   - 'naver_api' : 기존 네이버 공식 API (순위 부정확)
 *   - 'auto' (기본값) : direct → naver_api 순서로 시도
 *
 * @param {string} keyword
 * @param {number} [count=30]
 * @returns {Promise<{items: Array, total: number, method: string}>}
 */
export async function getBlogRankings(keyword, count = 30) {
  const method = (process.env.SEARCH_METHOD || 'auto').toLowerCase();

  // 명시적으로 지정된 경우 해당 방법만 사용
  if (method === 'serpapi') {
    return searchSerpApi(keyword, count);
  }
  if (method === 'direct') {
    return searchDirect(keyword, count);
  }
  if (method === 'naver_api') {
    return searchNaverApi(keyword, count);
  }

  // auto: direct → naver_api 순서로 폴백
  try {
    const result = await searchDirect(keyword, count);
    if (result.items.length > 0) {
      return result;
    }
    // 결과가 비어있으면 폴백
    console.log('[blogSearch] direct 결과 0건, naver_api로 폴백');
  } catch (e) {
    console.log(`[blogSearch] direct 실패 (${e.message}), naver_api로 폴백`);
  }

  return searchNaverApi(keyword, count);
}


// ============================================================
// 유틸리티
// ============================================================

function parseBlogUrl(url) {
  if (!url) return null;
  const m1 = url.match(
    /blog\.naver\.com\/PostView\.n(?:aver|hn)\?.*?blogId=([^&]+).*?logNo=(\d+)/i
  );
  if (m1) return { blogId: m1[1], postId: m1[2] };
  const m2 = url.match(/(?:m\.)?blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (m2) return { blogId: m2[1], postId: m2[2] };
  return null;
}
