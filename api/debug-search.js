// api/debug-search.js
// 디버깅 전용 — 문제 해결 후 삭제

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { query, test } = req.query;

  // test=blog: 블로그 본문 fetch 테스트
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
      // 매장명 검색
      const has조개옥 = html.includes('조개옥');
      return res.status(200).json({
        status: resp.status,
        htmlLength: html.length,
        hasPlaceLink,
        placeIds: [...new Set(placeIds)],
        has조개옥,
        sample: html.substring(0, 500),
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // test=mobile: 모바일 검색 결과 시도
  if (test === 'mobile' && query) {
    try {
      const url = `https://m.search.naver.com/search.naver?where=m_blog&query=${encodeURIComponent(query)}&sm=mtb_opt`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': BLOG_UA,
          'Accept': 'text/html',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        redirect: 'follow',
      });
      const html = await resp.text();

      // blog URL 추출
      const allPattern = /https?:\/\/(?:m\.)?blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,})/g;
      const matches = [];
      const seen = new Set();
      let m;
      while ((m = allPattern.exec(html)) !== null) {
        const key = `${m[1]}/${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ blogId: m[1], postId: m[2] });
      }

      return res.status(200).json({
        fetchStatus: resp.status,
        htmlLength: html.length,
        blogUrls: matches.length,
        results: matches.slice(0, 15),
        sample: html.substring(0, 1000),
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // test=api2: 네이버 공식 API로 비교 (display=30, sort=sim)
  if (test === 'api2' && query) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    try {
      const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=30&start=1&sort=sim`;
      const resp = await fetch(url, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
      });
      const data = await resp.json();
      const items = (data.items || []).map((item, i) => {
        const pm = (item.link || '').match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/);
        return {
          rank: i + 1,
          blogId: pm ? pm[1] : '',
          postId: pm ? pm[2] : '',
          title: (item.title || '').replace(/<[^>]+>/g, ''),
        };
      });
      return res.status(200).json({ total: data.total, count: items.length, items: items.slice(0, 15) });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  if (!query) return res.status(400).json({ error: 'query required. use test=blog|mobile|api2' });

  // test=apollo: __APOLLO_STATE__에서 블로그 데이터 추출
  if (req.query.test === 'apollo') {
    try {
      const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}&sm=tab_opt`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'identity',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow',
      });
      const html = await resp.text();

      // __APOLLO_STATE__ 추출
      const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
      if (!apolloMatch) {
        return res.status(200).json({ error: 'APOLLO_STATE not found', htmlLength: html.length });
      }

      let apolloState;
      try {
        apolloState = JSON.parse(apolloMatch[1]);
      } catch (e) {
        // JSON이 너무 길면 일부만
        return res.status(200).json({ error: 'JSON parse failed', sample: apolloMatch[1].substring(0, 2000) });
      }

      // Apollo State에서 블로그 관련 키 추출
      const keys = Object.keys(apolloState);
      const blogKeys = keys.filter(k => /blog|post|article|search/i.test(k));
      
      // blog URL이 포함된 값들 찾기
      const blogEntries = [];
      for (const key of keys) {
        const val = JSON.stringify(apolloState[key]);
        if (val.includes('blog.naver.com') || val.includes('blogId') || val.includes('logNo')) {
          blogEntries.push({ key, sample: val.substring(0, 300) });
        }
      }

      return res.status(200).json({
        totalKeys: keys.length,
        blogRelatedKeys: blogKeys.length,
        blogKeysSample: blogKeys.slice(0, 20),
        blogEntries: blogEntries.slice(0, 15),
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // 기본: 데스크탑 검색 결과 분석
  try {
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

    // blog URL 추출
    const allPattern = /https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,})/g;
    const allMatches = [];
    const seenAll = new Set();
    let m;
    while ((m = allPattern.exec(html)) !== null) {
      const key = `${m[1]}/${m[2]}`;
      if (seenAll.has(key)) continue;
      seenAll.add(key);
      allMatches.push({ blogId: m[1], postId: m[2] });
    }

    // JSON 데이터 내 블로그 정보 검색 (SSR 데이터에 있을 수 있음)
    const jsonDataPatterns = [
      { name: '__NEXT_DATA__', found: html.includes('__NEXT_DATA__') },
      { name: '__APOLLO_STATE__', found: html.includes('__APOLLO_STATE__') },
      { name: 'window.__initialData', found: html.includes('__initialData') },
      { name: 'window.__PRELOADED', found: html.includes('__PRELOADED') },
      { name: '"blogId"', count: (html.match(/"blogId"/g) || []).length },
      { name: '"postId"', count: (html.match(/"postId"/g) || []).length },
      { name: '"logNo"', count: (html.match(/"logNo"/g) || []).length },
      { name: '"url":', count: (html.match(/"url"\s*:/g) || []).length },
    ];

    return res.status(200).json({
      fetchStatus: resp.status,
      htmlLength: html.length,
      blogUrls: allMatches.length,
      results: allMatches.slice(0, 15),
      jsonDataPatterns,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
