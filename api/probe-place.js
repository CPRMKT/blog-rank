// api/probe-place.js
// [진단 전용 - 정식 구현 후 삭제 예정]
// 여러 플레이스 엔드포인트를 호출해서 어떤 게 살아있는지, 어떤 응답이 오는지 확인

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const placeId = req.query.placeId || '2005368682';

  // 탐색할 엔드포인트 후보들
  const endpoints = [
    // A. HTML 페이지 (Apollo State / __NEXT_DATA__ 확인용)
    { name: 'm_place_home',         url: `https://m.place.naver.com/place/${placeId}/home` },
    { name: 'm_restaurant_home',    url: `https://m.place.naver.com/restaurant/${placeId}/home` },
    { name: 'pcmap_place_home',     url: `https://pcmap.place.naver.com/place/${placeId}/home` },
    { name: 'pcmap_restaurant_home',url: `https://pcmap.place.naver.com/restaurant/${placeId}/home` },

    // B. 리뷰 UGC (블로그 리뷰) 페이지
    { name: 'pcmap_restaurant_ugc', url: `https://pcmap.place.naver.com/restaurant/${placeId}/review/ugc` },
    { name: 'm_place_ugc',          url: `https://m.place.naver.com/place/${placeId}/review/ugc` },
    { name: 'm_restaurant_ugc',     url: `https://m.place.naver.com/restaurant/${placeId}/review/ugc` },

    // C. 상세 페이지 (/detail)
    { name: 'pcmap_restaurant_detail', url: `https://pcmap.place.naver.com/restaurant/${placeId}/detail` },
  ];

  const userAgents = {
    mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  const results = [];

  for (const { name, url } of endpoints) {
    const ua = url.includes('m.place') ? userAgents.mobile : userAgents.desktop;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Referer': 'https://map.naver.com/',
        },
      });

      const text = await resp.text();

      // 응답에서 유용한 시그널 검사
      const sig = {
        length: text.length,
        hasApolloState: /__APOLLO_STATE__|window\.__APOLLO_STATE__/.test(text),
        hasNextData: /__NEXT_DATA__/.test(text),
        hasGraphQL: /graphql/i.test(text),
        hasBlogReview: /블로그\s*리뷰|blogReview|blog-review/.test(text),

        // 매장명으로 추정되는 단서
        titleTag: (text.match(/<title>([^<]+)<\/title>/) || [])[1] || null,
        ogTitle: (text.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1] || null,
        ogDescription: (text.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) || [])[1] || null,

        // 응답 앞부분 샘플 (디버깅용)
        snippet: text.slice(0, 500),
      };

      // JSON 데이터 추출 시도
      let nextDataPreview = null;
      if (sig.hasNextData) {
        const m = text.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            nextDataPreview = {
              keys_top: Object.keys(parsed),
              keys_props: parsed.props ? Object.keys(parsed.props) : null,
              keys_pageProps: parsed.props?.pageProps ? Object.keys(parsed.props.pageProps) : null,
              keys_apolloState: parsed.props?.apolloState ? Object.keys(parsed.props.apolloState).slice(0, 20) : null,
            };
          } catch {}
        }
      }

      let apolloStatePreview = null;
      if (sig.hasApolloState) {
        const m = text.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            apolloStatePreview = {
              keys: Object.keys(parsed).slice(0, 30),
            };
          } catch {}
        }
      }

      results.push({
        endpoint: name,
        url,
        status: resp.status,
        finalUrl: resp.url,
        contentType: resp.headers.get('content-type'),
        signals: sig,
        nextDataPreview,
        apolloStatePreview,
      });
    } catch (e) {
      results.push({
        endpoint: name,
        url,
        status: 'FETCH_ERROR',
        error: e.message,
      });
    }
  }

  // 요약 - 어떤 엔드포인트가 매장명을 포함하는지
  const summary = results.map(r => ({
    endpoint: r.endpoint,
    status: r.status,
    length: r.signals?.length,
    hasApolloState: r.signals?.hasApolloState,
    hasNextData: r.signals?.hasNextData,
    title: r.signals?.titleTag || r.signals?.ogTitle,
  }));

  return res.status(200).json({
    placeId,
    timestamp: new Date().toISOString(),
    summary,
    details: results,
  });
}
