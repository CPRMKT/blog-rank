// api/probe-place2.js
// [2차 진단] FsasReview 실제 값 구조 + 페이지네이션 방식 확인

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const placeId = req.query.placeId || '2005368682';
  const url = `https://m.place.naver.com/restaurant/${placeId}/home`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://map.naver.com/',
      },
    });

    const html = await resp.text();

    // __APOLLO_STATE__ 추출
    // 여러 패턴 시도 (네이버가 minify 방식을 바꾸는 경우가 있음)
    let apolloState = null;
    let extractMethod = null;

    // 패턴 1: window.__APOLLO_STATE__ = {...};
    let m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (m) {
      try {
        apolloState = JSON.parse(m[1]);
        extractMethod = 'window.__APOLLO_STATE__';
      } catch (e) {}
    }

    // 패턴 2: JSON.parse(...)로 감싸진 경우
    if (!apolloState) {
      m = html.match(/window\.__APOLLO_STATE__\s*=\s*JSON\.parse\(['"`]([\s\S]*?)['"`]\)/);
      if (m) {
        try {
          // 이스케이프 문자 처리
          const unescaped = m[1].replace(/\\(.)/g, (_, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
          apolloState = JSON.parse(unescaped);
          extractMethod = 'JSON.parse(window.__APOLLO_STATE__)';
        } catch (e) {}
      }
    }

    if (!apolloState) {
      return res.status(200).json({
        error: '__APOLLO_STATE__ 파싱 실패',
        htmlLength: html.length,
        // 디버깅용 - 어떤 형태로 들어있는지 스니펫
        apolloMatch: (html.match(/__APOLLO_STATE__[\s\S]{0,200}/) || [])[0] || null,
      });
    }

    // 분석 결과
    const allKeys = Object.keys(apolloState);
    const fsasKeys = allKeys.filter(k => k.startsWith('FsasReview:'));
    const placeDetailBase = apolloState[`PlaceDetailBase:${placeId}`];

    // FsasReview 샘플 (블로그 타입 첫 2개만)
    const blogReviews = fsasKeys
      .filter(k => k.includes(':blog_'))
      .slice(0, 3)
      .map(k => ({
        key: k,
        value: apolloState[k],
      }));

    const cafeReviews = fsasKeys
      .filter(k => k.includes(':cafe_'))
      .slice(0, 2)
      .map(k => ({
        key: k,
        value: apolloState[k],
      }));

    // ROOT_QUERY 에서 블로그 리뷰 목록을 어떻게 참조하는지 보기
    const rootQuery = apolloState.ROOT_QUERY || null;
    let rootQueryReviewRefs = null;
    if (rootQuery) {
      const rootKeys = Object.keys(rootQuery);
      // review, ugc, fsas 관련 키 찾기
      const reviewKeys = rootKeys.filter(k => 
        /fsas|ugc|review|blog|cafe/i.test(k)
      );
      rootQueryReviewRefs = {};
      for (const k of reviewKeys) {
        const v = rootQuery[k];
        // 값이 너무 크면 요약만
        rootQueryReviewRefs[k] = typeof v === 'object' 
          ? { __type: Array.isArray(v) ? 'array' : 'object', keys: Array.isArray(v) ? v.length : Object.keys(v || {}).slice(0, 10), sample: JSON.stringify(v).slice(0, 500) }
          : v;
      }
    }

    return res.status(200).json({
      placeId,
      extractMethod,
      apolloStateStats: {
        totalKeys: allKeys.length,
        fsasReviewCount: fsasKeys.length,
        blogReviewCount: fsasKeys.filter(k => k.includes(':blog_')).length,
        cafeReviewCount: fsasKeys.filter(k => k.includes(':cafe_')).length,
        sampleKeyTypes: [...new Set(allKeys.map(k => k.split(':')[0]))].slice(0, 30),
      },
      // 매장 기본 정보
      placeDetailBase,
      // 블로그 리뷰 샘플 (풀 데이터)
      blogReviewSamples: blogReviews,
      // 카페 리뷰 샘플 (풀 데이터)  
      cafeReviewSamples: cafeReviews,
      // ROOT_QUERY 에 어떤 리뷰 관련 쿼리들이 있는지
      rootQueryReviewRefs,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
