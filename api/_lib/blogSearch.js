// api/_lib/blogSearch.js
// 네이버 블로그 탭 검색 결과를 가져오는 통합 모듈.
//
// 주 방식 (default): 한국 서버 (NCP) 의 Playwright 스크래퍼 호출.
//   네이버는 IP/지역에 따라 결과 순서가 달라지므로 한국 IP 에서 직접 스크랩해야
//   사용자가 보는 화면 순서와 일치한다.
//
// 폴백:
//   - 'direct'    : 네이버 검색 결과 HTML 직접 스크래핑 (해외 IP, 8개 한계)
//   - 'naver_api' : 네이버 공식 검색 API (sort=sim, 순위 부정확)
//
// 환경변수 SEARCH_METHOD 로 메서드 강제 가능.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================
// 방법 1 (메인): 한국 서버 Playwright 스크래퍼
// ============================================================

async function searchKoreanScraper(keyword, count = 30) {
  const baseUrl = process.env.KOREAN_SCRAPER_URL;
  const apiKey = process.env.KOREAN_SCRAPER_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('KOREAN_SCRAPER_URL / KOREAN_SCRAPER_KEY 환경변수가 설정되지 않았습니다');
  }

  const endpoint =
    `${baseUrl.replace(/\/$/, '')}/scrape` +
    `?keyword=${encodeURIComponent(keyword)}&count=${count}`;

  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `한국 스크래퍼 호출 실패 (status=${resp.status}): ${text.substring(0, 300)}`
    );
  }

  const data = await resp.json();
  return {
    items: data.items || [],
    total: data.total ?? (data.items?.length || 0),
    method: 'korean',
  };
}

// ============================================================
// 방법 2 (폴백): 네이버 검색 결과 HTML 직접 스크래핑
// ============================================================

async function searchDirect(keyword, count = 30) {
  // start 페이지네이션은 신버전 페이지에서 무시되지만 일단 시도
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
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'identity',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow',
      });
      if (!resp.ok) {
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

    let added = 0;
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
      added++;
      if (merged.length >= count) break;
    }
    if (added === 0) break;
  }

  return {
    items: merged,
    total: totalReported || merged.length,
    method: 'direct',
  };
}

function parseNaverBlogHTML(html, count = 30) {
  const items = [];
  const seenKeys = new Set();
  const urlPattern =
    /href="(https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,}))[^"]*"/g;

  let match;
  while ((match = urlPattern.exec(html)) !== null && items.length < count) {
    const link = match[1];
    const blogId = match[2];
    const postId = match[3];
    const key = `${blogId}/${postId}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const title = extractTitleNearUrl(html, match.index, link);
    items.push({
      rank: items.length + 1,
      link: `https://blog.naver.com/${blogId}/${postId}`,
      title,
      blogId,
      postId,
    });
  }

  let total = items.length;
  const totalMatch = html.match(/(?:"total"|totalCount)\s*[":]\s*(\d+)/);
  if (totalMatch) total = parseInt(totalMatch[1], 10);

  return { items, total, method: 'direct' };
}

function extractTitleNearUrl(html, urlIndex, url) {
  const start = Math.max(0, urlIndex - 500);
  const end = Math.min(html.length, urlIndex + 2000);
  const snippet = html.substring(start, end);

  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aTagMatch = snippet.match(
    new RegExp(`<a[^>]+href="${escapedUrl}[^"]*"[^>]*>([\\s\\S]*?)<\\/a>`, 'i')
  );
  if (aTagMatch) {
    const cleaned = aTagMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > 5 && cleaned.length < 200) return decodeHTMLEntities(cleaned);
  }

  const titleClassMatch = snippet.match(
    /class="[^"]*title[^"]*"[^>]*>([^<]+(?:<(?!\/a)[^>]*>[^<]*)*)/i
  );
  if (titleClassMatch) {
    const cleaned = titleClassMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
// 방법 3 (폴백): 네이버 공식 API
// ============================================================

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
// 통합 인터페이스
// ============================================================

/**
 * 블로그 탭 검색 결과를 가져옵니다.
 * 환경변수 SEARCH_METHOD 로 강제:
 *   - 'korean'    : 한국 서버 Playwright 스크래퍼 (default)
 *   - 'direct'    : 네이버 HTML 스크래핑 (8개 한계)
 *   - 'naver_api' : 네이버 공식 API (순위 부정확)
 *   - 'auto'      : korean → direct → naver_api 순서로 폴백
 *
 * @param {string} keyword
 * @param {number} [count=30]
 * @returns {Promise<{items: Array, total: number, method: string}>}
 */
export async function getBlogRankings(keyword, count = 30) {
  const method = (process.env.SEARCH_METHOD || 'korean').toLowerCase();

  if (method === 'korean') {
    return searchKoreanScraper(keyword, count);
  }
  if (method === 'direct') {
    return searchDirect(keyword, count);
  }
  if (method === 'naver_api') {
    return searchNaverApi(keyword, count);
  }

  // auto: korean → direct → naver_api
  try {
    const r = await searchKoreanScraper(keyword, count);
    if (r.items.length > 0) return r;
    console.log('[blogSearch] korean 결과 0건, direct 폴백');
  } catch (e) {
    console.log(`[blogSearch] korean 실패 (${e.message}), direct 폴백`);
  }
  try {
    const r = await searchDirect(keyword, count);
    if (r.items.length > 0) return r;
    console.log('[blogSearch] direct 결과 0건, naver_api 폴백');
  } catch (e) {
    console.log(`[blogSearch] direct 실패 (${e.message}), naver_api 폴백`);
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
