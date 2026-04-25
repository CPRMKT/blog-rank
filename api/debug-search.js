// api/debug-search.js
// 디버깅 전용 — 문제 해결 후 삭제
// 네이버 블로그 탭 HTML 파싱 과정과 본문 fetch 결과를 상세히 반환

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { query, test } = req.query;

  // test=blog 이면 블로그 본문 fetch 테스트
  if (test === 'blog') {
    const { blogId, postId } = req.query;
    try {
      const url = `https://m.blog.naver.com/${blogId}/${postId}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': BLOG_UA, 'Accept': 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
        redirect: 'follow',
      });
      const html = await resp.text();
      const hasPlaceLink = html.includes('place.naver.com') || html.includes('map.naver.com');
      const placeIds = [...html.matchAll(/(?:place|restaurant|hairshop)\/(\d{6,12})/g)].map(m => m[1]);
      return res.status(200).json({
        status: resp.status,
        htmlLength: html.length,
        hasPlaceLink,
        placeIds: [...new Set(placeIds)],
        sample: html.substring(0, 500),
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    // 1. 네이버 블로그 탭 HTML fetch
    const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}&sm=tab_opt`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    const html = await resp.text();

    // 2. href 안의 blog URL 추출 (현재 파싱 방식)
    const hrefPattern = /href="(https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,}))[^"]*"/g;
    const hrefMatches = [];
    const seenKeys = new Set();
    let m;
    while ((m = hrefPattern.exec(html)) !== null) {
      const key = `${m[2]}/${m[3]}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      hrefMatches.push({ url: m[1], blogId: m[2], postId: m[3] });
    }

    // 3. 모든 blog URL 추출 (href 밖 포함)
    const allPattern = /https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,})/g;
    const allMatches = [];
    const seenAll = new Set();
    while ((m = allPattern.exec(html)) !== null) {
      const key = `${m[1]}/${m[2]}`;
      if (seenAll.has(key)) continue;
      seenAll.add(key);
      allMatches.push({ url: m[0], blogId: m[1], postId: m[2] });
    }

    // 4. HTML 구조 분석 - 검색 결과 영역 찾기
    const areaPatterns = [
      { name: 'sp_blog', count: (html.match(/sp_blog/g) || []).length },
      { name: 'blog_item', count: (html.match(/blog_item/g) || []).length },
      { name: 'api_txt_lines', count: (html.match(/api_txt_lines/g) || []).length },
      { name: 'title_link', count: (html.match(/title_link/g) || []).length },
      { name: 'total_wrap', count: (html.match(/total_wrap/g) || []).length },
      { name: 'data-cr-area', count: (html.match(/data-cr-area/g) || []).length },
    ];

    return res.status(200).json({
      fetchStatus: resp.status,
      htmlLength: html.length,
      hrefBlogUrls: hrefMatches.length,
      hrefResults: hrefMatches.slice(0, 15),
      allBlogUrls: allMatches.length,
      allResults: allMatches.slice(0, 15),
      htmlStructure: areaPatterns,
      // HTML 샘플 (첫 blog URL 주변)
      firstUrlIndex: html.indexOf('blog.naver.com'),
      htmlSample: html.substring(
        Math.max(0, html.indexOf('blog.naver.com') - 200),
        html.indexOf('blog.naver.com') + 300
      ),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
