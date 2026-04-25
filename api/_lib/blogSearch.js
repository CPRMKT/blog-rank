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
  // 네이버 블로그 탭은 페이지당 약 7~8개만 SSR 렌더링하므로
  // start 파라미터로 페이지네이션해서 결과를 합쳐야 충분한 개수 확보 가능
  // start=1, 11, 21로 최대 30개까지 시도
  const pageStarts = [1, 11, 21];
  const merged = [];
  const seenKeys = new Set();
  let totalReported = 0;

  for (const start of pageStarts) {
    if (merged.length >= count) break;

    const url =
      `https://search.naver.com/search.naver?where=blog` +
      `&query=${encodeURIComponent(keyword)}` +
      `&sm=tab_opt&nso=so%3Ar%2Cp%3Aall` +
      `&start=${start}`;

    let html;
    try {
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
        // 첫 페이지가 실패하면 전체 실패로 간주, 이후 페이지 실패는 무시
        if (start === 1) {
          throw new Error(`네이버 검색 요청 실패 (status=${resp.status})`);
        }
        break;
      }
      html = await resp.text();
    } catch (e) {
      if (start === 1) throw e;
      break;
    }

    const pageResult = parseNaverBlogHTML(html, count);
    if (pageResult.total > totalReported) totalReported = pageResult.total;

    let addedThisPage = 0;
    for (const item of pageResult.items) {
      const key = `${item.blogId}/${item.postId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      merged.push({
        rank: merged.length + 1,
        link: item.link,
        title: item.title,
        blogId: item.blogId,
        postId: item.postId,
      });
      addedThisPage++;
      if (merged.length >= count) break;
    }

    // 이번 페이지에서 신규로 추가된 게 없으면 더 이상 시도해도 의미 없음
    if (addedThisPage === 0) break;
  }

  return {
    items: merged,
    total: totalReported || merged.length,
    method: 'direct',
  };
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

  // SerpApi Naver 엔진은 공식적으로 where=blog를 지원하지 않으므로
  // where=nexearch로 통합검색 호출 후 view_results 또는 organic_results에서
  // 블로그 포스트만 추출. count > 페이지당 결과 수면 page 파라미터로 페이지네이션.
  const items = [];
  const seenKeys = new Set();
  let totalReported = 0;

  for (let page = 1; page <= 3 && items.length < count; page++) {
    const params = new URLSearchParams({
      engine: 'naver',
      query: keyword,
      where: 'nexearch',
      page: String(page),
      api_key: apiKey,
    });

    const resp = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!resp.ok) {
      const err = await resp.text();
      if (page === 1) {
        throw new Error(`SerpApi 요청 실패 (status=${resp.status}): ${err}`);
      }
      break;
    }

    const data = await resp.json();
    if (data.search_information?.total_results) {
      totalReported = data.search_information.total_results;
    }

    const candidates = collectBlogResultsFromSerpApi(data);
    let added = 0;
    for (const r of candidates) {
      const link = r.link || r.url || r.blog_link || '';
      const parsed = parseBlogUrl(link);
      const key = parsed ? `${parsed.blogId}/${parsed.postId}` : link;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);

      items.push({
        rank: items.length + 1,
        link,
        title: (r.title || r.post_title || '').replace(/<[^>]+>/g, ''),
        blogId: parsed?.blogId || '',
        postId: parsed?.postId || '',
      });
      added++;
      if (items.length >= count) break;
    }

    // 이번 페이지에서 새 결과가 0개면 더 시도해도 의미 없음
    if (added === 0) break;
  }

  return {
    items,
    total: totalReported || items.length,
    method: 'serpapi',
  };
}

/**
 * SerpApi Naver nexearch 응답에서 블로그 포스트들을 추출.
 * 응답 형태가 버전/검색에 따라 다양하므로 알려진 키들을 모두 시도하고,
 * blog.naver.com URL을 가진 항목만 골라냄.
 */
function collectBlogResultsFromSerpApi(data) {
  const buckets = [
    data.blog_results,
    data.view_results,
    data.organic_results,
    data.posts_results,
  ].filter(Array.isArray);

  // 일부 응답은 inline_videos / inline_news처럼 categorized
  // view_results 안에 items 또는 contents 가 있을 수도
  if (Array.isArray(data.view_results)) {
    for (const v of data.view_results) {
      if (Array.isArray(v?.items)) buckets.push(v.items);
      if (Array.isArray(v?.contents)) buckets.push(v.contents);
    }
  }

  const out = [];
  const seenLinks = new Set();
  for (const bucket of buckets) {
    for (const r of bucket) {
      const link = r?.link || r?.url || r?.blog_link || '';
      if (!link || seenLinks.has(link)) continue;
      // blog.naver.com 또는 m.blog.naver.com 만 채택
      if (!/(?:m\.)?blog\.naver\.com\//i.test(link)) continue;
      seenLinks.add(link);
      out.push(r);
    }
  }
  return out;
}


// ============================================================
// 방법 2.5: Apify Naver Blog & Cafe Scraper
// ============================================================

/**
 * Apify의 huggable_quote/naver-blog-cafe-scraper를 호출해 블로그 탭 결과를 가져옴.
 * 헤드리스 브라우저로 무한스크롤을 처리하므로 30위까지 정확한 순위를 받을 수 있음.
 *
 * @param {string} keyword
 * @param {number} [count=30]
 */
async function searchApify(keyword, count = 30) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN 환경변수가 설정되지 않았습니다');
  }

  // Actor ID는 URL path에서 user/actor 슬래시 대신 ~ 사용
  const actorId = process.env.APIFY_ACTOR_ID || 'huggable_quote~naver-blog-cafe-scraper';
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&clean=true`;

  const body = {
    searchKeywords: [keyword],
    searchType: 'blog',
    maxResults: count,
    sortBy: 'sim',
    scrapeContent: false,
    scrapeComments: false,
    // maxConcurrency: 5 (기본값) 으로 병렬 스크랩하면 빠르게 끝나는 순서대로 dataset에
    // push 되어 검색 순위가 섞임. 1로 고정해 네이버 화면 순서를 보존.
    maxConcurrency: 1,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Apify 요청 실패 (status=${resp.status}): ${err.substring(0, 300)}`);
  }

  const dataset = await resp.json();
  // dataset은 결과 item 배열. 배열 순서가 곧 검색 결과 순위.
  const arr = Array.isArray(dataset) ? dataset : (dataset.items || []);

  const items = [];
  const seenKeys = new Set();
  for (const r of arr) {
    if (items.length >= count) break;
    const link = r.url || r.link || '';
    const parsed = parseBlogUrl(link);
    const key = parsed ? `${parsed.blogId}/${parsed.postId}` : link;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    items.push({
      rank: items.length + 1,
      link,
      title: (r.title || '').replace(/<[^>]+>/g, ''),
      blogId: parsed?.blogId || '',
      postId: parsed?.postId || '',
    });
  }

  return {
    items,
    total: items.length,
    method: 'apify',
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
  if (method === 'apify') {
    return searchApify(keyword, count);
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
