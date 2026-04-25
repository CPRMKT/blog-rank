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

  // test=apify: Apify Naver Blog & Cafe Scraper raw 응답 확인 (실행 시간, 결과 수, 순위 검증용)
  if (test === 'apify' && query) {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
      return res.status(200).json({ error: 'APIFY_TOKEN 환경변수 미설정' });
    }
    const actorId = req.query.actor || process.env.APIFY_ACTOR_ID || 'huggable_quote~naver-blog-cafe-scraper';
    const maxResults = parseInt(req.query.max || '15', 10);
    const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&clean=true`;
    const body = {
      searchKeywords: [query],
      searchType: 'blog',
      maxResults,
      sortBy: 'sim',
      scrapeContent: false,
      scrapeComments: false,
    };
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elapsedMs = Date.now() - t0;
      const ct = resp.headers.get('content-type');
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      if (!data) {
        return res.status(200).json({
          status: resp.status,
          contentType: ct,
          elapsedMs,
          body: text.substring(0, 1500),
        });
      }

      const arr = Array.isArray(data) ? data : (data.items || []);
      const sample = arr.slice(0, 3);
      const allItems = arr.map((r, i) => ({
        rank: i + 1,
        url: r.url || r.link || '',
        title: r.title || '',
        type: r.type,
        author: r.author,
        date: r.date,
      }));

      return res.status(200).json({
        status: resp.status,
        elapsedMs,
        actorId,
        itemCount: arr.length,
        firstItemKeys: arr[0] ? Object.keys(arr[0]) : [],
        rawSample: sample,
        items: allItems,
      });
    } catch (e) {
      return res.status(200).json({
        elapsedMs: Date.now() - t0,
        error: e.message,
      });
    }
  }

  // test=serpapi: SerpApi raw 응답 확인 (키 이름, 결과 수, 페이지네이션 검증용)
  if (test === 'serpapi' && query) {
    const apiKey = process.env.SERPAPI_KEY;
    if (!apiKey) {
      return res.status(200).json({ error: 'SERPAPI_KEY 환경변수 미설정' });
    }
    const where = req.query.where || 'nexearch';
    const page = req.query.page || '1';
    const engine = req.query.engine || 'naver';
    const params = new URLSearchParams({
      engine,
      query,
      where,
      page,
      api_key: apiKey,
    });
    try {
      const resp = await fetch(`https://serpapi.com/search.json?${params}`);
      const ct = resp.headers.get('content-type');
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      if (!data) {
        return res.status(200).json({ status: resp.status, contentType: ct, body: text.substring(0, 1000) });
      }

      // 에러면 raw error를 그대로 반환
      if (data.error) {
        return res.status(200).json({
          status: resp.status,
          serpApiError: data.error,
          requestParams: { engine: 'naver', query, where, page },
        });
      }

      // 응답에서 블로그 URL을 가진 항목 카운트
      const allBlogLinks = [];
      function walk(obj, path = '') {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach((item, i) => walk(item, `${path}[${i}]`));
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && /(?:m\.)?blog\.naver\.com\//i.test(v)) {
            allBlogLinks.push({ path: `${path}.${k}`, value: v });
          } else {
            walk(v, `${path}.${k}`);
          }
        }
      }
      walk(data);

      // 응답의 top-level 키들과 각 키의 타입/길이
      const topKeys = {};
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) topKeys[k] = `array[${v.length}]`;
        else if (v && typeof v === 'object') topKeys[k] = `object{${Object.keys(v).join(',')}}`;
        else topKeys[k] = typeof v === 'string' ? `string(${v.length})` : typeof v;
      }

      return res.status(200).json({
        status: resp.status,
        topKeys,
        searchInformation: data.search_information,
        blogLinkCount: allBlogLinks.length,
        blogLinks: allBlogLinks.slice(0, 30),
        firstViewResult: Array.isArray(data.view_results) ? data.view_results[0] : null,
        firstOrganicResult: Array.isArray(data.organic_results) ? data.organic_results[0] : null,
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // test=findnext: HTML 안에서 무한스크롤/AJAX endpoint 단서 찾기
  if (test === 'findnext' && query) {
    try {
      const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}&sm=tab_opt&nso=so%3Ar%2Cp%3Aall`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Accept-Encoding': 'identity',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow',
      });
      const html = await resp.text();

      // 페이지네이션 후보 URL 패턴 모음
      const patterns = {
        's.search.naver.com': /https?:\/\/s\.search\.naver\.com\/[^"'\s<>]+/g,
        'apirender': /https?:\/\/[^"'\s<>]*apirender[^"'\s<>]*/gi,
        'csearch': /https?:\/\/[^"'\s<>]*csearch[^"'\s<>]*/gi,
        'morePage': /"morePage"\s*:\s*"?([^",}]+)/g,
        'next_url': /"next[A-Z_a-z]*"\s*:\s*"([^"]+)"/g,
        'api_url': /["']([^"']*\/api\/[^"']*)["']/g,
        'load_more': /loadMore|moreBtn|next_page/gi,
      };

      const out = {};
      for (const [name, pat] of Object.entries(patterns)) {
        const matches = [...html.matchAll(pat)];
        out[name] = {
          count: matches.length,
          samples: [...new Set(matches.map(m => m[0]))].slice(0, 8),
        };
      }

      // <script> 태그 내 init 데이터 후보 추출
      const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]{50,3000}?)<\/script>/g)];
      const interesting = scriptMatches
        .map(m => m[1])
        .filter(s => /search|blog|page|start|next/i.test(s))
        .slice(0, 5)
        .map(s => s.substring(0, 600));

      return res.status(200).json({
        htmlLength: html.length,
        patterns: out,
        scriptSnippets: interesting,
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // test=ajax: 추측한 AJAX endpoint들을 직접 호출해보기
  if (test === 'ajax' && query) {
    const startParam = parseInt(req.query.start || '11', 10);
    const candidates = [
      // 모바일 검색 변형들
      `https://m.search.naver.com/search.naver?where=m_blog&query=${encodeURIComponent(query)}&start=${startParam}&sm=mtb_opt`,
      `https://m.search.naver.com/search.naver?where=m_blog&query=${encodeURIComponent(query)}&start=${startParam}`,
      `https://m.search.naver.com/p/csa/ondemand/blog/list?query=${encodeURIComponent(query)}&start=${startParam}`,
      // PC start= 변형 (display 추가)
      `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}&start=${startParam}&display=30`,
      // 통합검색 nexearch + blog ssc
      `https://search.naver.com/search.naver?where=nexearch&ssc=tab.blog.all&query=${encodeURIComponent(query)}&start=${startParam}`,
      // 정확히 review 패턴 모방 (p/blog/50)
      `https://s.search.naver.com/p/blog/50/search.naver?api_type=5&query=${encodeURIComponent(query)}&start=${startParam}&page=2&where=blog&sm=tab_opt&ssc=tab.blog.all&nso=so:r,p:all`,
      `https://s.search.naver.com/p/review/50/search.naver?api_type=5&query=${encodeURIComponent(query)}&start=${startParam}&page=2&where=blog&sm=tab_opt&ssc=tab.blog.all&nso=so:r,p:all`,
    ];

    const results = [];
    for (const u of candidates) {
      try {
        const resp = await fetch(u, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Referer': `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}`,
          },
          redirect: 'follow',
        });
        const text = await resp.text();
        // 모바일은 m.blog.naver.com을 쓰므로 m. 옵션
        const pattern = /https?:\/\/(?:m\.)?blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/g;
        const seen = new Set();
        const urls = [];
        let m;
        while ((m = pattern.exec(text)) !== null) {
          const k = `${m[1]}/${m[2]}`;
          if (seen.has(k)) continue;
          seen.add(k);
          urls.push(k);
        }
        results.push({
          url: u,
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          length: text.length,
          urlCount: urls.length,
          urls: urls.slice(0, 15),
          sample: text.substring(0, 400),
        });
      } catch (e) {
        results.push({ url: u, error: e.message });
      }
    }
    return res.status(200).json({ query, start: startParam, results });
  }

  // test=pages: start=1, 11, 21 각각이 다른 결과를 주는지 확인
  if (test === 'pages' && query) {
    try {
      const pages = [];
      for (const start of [1, 11, 21]) {
        const url = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(query)}&sm=tab_opt&nso=so%3Ar%2Cp%3Aall&start=${start}`;
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
        const pattern = /href="https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{12,})/g;
        const seen = new Set();
        const urls = [];
        let m;
        while ((m = pattern.exec(html)) !== null) {
          const key = `${m[1]}/${m[2]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          urls.push(key);
        }
        // 페이징 표시자 (다음 페이지 링크)가 있는지 확인
        const hasNextPage = /start=(\d+)/g.test(html);
        const startParamsInHtml = [...html.matchAll(/[?&]start=(\d+)/g)].map(m => parseInt(m[1])).filter(n => n > 1);
        const uniqueStarts = [...new Set(startParamsInHtml)].sort((a, b) => a - b);
        pages.push({
          start,
          status: resp.status,
          htmlLength: html.length,
          urlCount: urls.length,
          urls,
          hasNextPage,
          startParamsInHtml: uniqueStarts.slice(0, 10),
        });
      }
      // 페이지간 중복/신규 분석
      const allFromPage1 = new Set(pages[0]?.urls || []);
      const newInPage2 = (pages[1]?.urls || []).filter(u => !allFromPage1.has(u));
      pages.forEach((p, i) => { p.uniqueVsFirst = i === 0 ? p.urls.length : (p.urls || []).filter(u => !allFromPage1.has(u)).length; });
      return res.status(200).json({
        query,
        pages,
        totalUnique: new Set(pages.flatMap(p => p.urls || [])).size,
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  if (!query) return res.status(400).json({ error: 'query required. use test=blog|mobile|api2|pages|apollo' });

  // test=apollo: HTML 내 검색결과 구조 상세 분석
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

      // 모든 blog URL 패턴 찾기 (blog.naver.com 뿐 아니라 m.blog도)
      const allBlogPatterns = [
        { name: 'blog.naver.com', pattern: /https?:\/\/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/g },
        { name: 'm.blog.naver.com', pattern: /https?:\/\/m\.blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/g },
        { name: 'PostView', pattern: /https?:\/\/(?:m\.)?blog\.naver\.com\/PostView[^"'\s]*/g },
        { name: 'blogId in JSON', pattern: /"blogId"\s*:\s*"([^"]+)"/g },
        { name: 'logNo in JSON', pattern: /"logNo"\s*:\s*"?(\d+)"?/g },
      ];

      const urlResults = {};
      for (const p of allBlogPatterns) {
        const matches = [...html.matchAll(p.pattern)];
        urlResults[p.name] = { count: matches.length, samples: matches.slice(0, 5).map(m => m[0]) };
      }

      // articleSourceJSX 주변 각각의 블록에서 URL 추출
      const articles = [];
      let searchIdx = 0;
      for (let i = 0; i < 15; i++) {
        const idx = html.indexOf('articleSourceJSX', searchIdx);
        if (idx === -1) break;
        // 앞쪽으로 가서 해당 검색결과 블록의 시작점 찾기
        const blockStart = Math.max(0, idx - 3000);
        const blockEnd = Math.min(html.length, idx + 1000);
        const block = html.substring(blockStart, blockEnd);
        
        // 이 블록에서 모든 URL 추출
        const blogUrls = [...block.matchAll(/href="(https?:\/\/(?:m\.)?blog\.naver\.com\/[^"]+)"/g)].map(m => m[1]);
        const naverUrls = [...block.matchAll(/href="(https?:\/\/[^"]*naver[^"]+)"/g)].map(m => m[1]);
        
        // 제목 추출 시도
        const titleMatch = block.match(/sds-comps-text-title[^>]*>([^<]+)/);
        const title = titleMatch ? titleMatch[1].trim() : '';

        articles.push({
          index: i + 1,
          position: idx,
          blogUrls,
          naverUrlCount: naverUrls.length,
          title: title || '(제목 못 찾음)',
        });

        searchIdx = idx + 1;
      }

      return res.status(200).json({
        htmlLength: html.length,
        urlResults,
        articleCount: articles.length,
        articles,
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
