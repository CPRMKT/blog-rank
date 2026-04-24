// api/probe-place3.js
// [3차 진단] GraphQL 엔드포인트 실제 호출 테스트 + 페이지네이션 확인

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const placeId = req.query.placeId || '2005368682';
  const businessType = req.query.businessType || 'restaurant';
  const page = parseInt(req.query.page || '1', 10);
  const display = parseInt(req.query.display || '10', 10);

  // x-wtm-graphql 헤더 동적 생성
  const wtmPayload = JSON.stringify({
    arg: placeId,
    type: businessType,
    source: 'place',
  });
  const xWtmGraphql = Buffer.from(wtmPayload).toString('base64');

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
    ...FsasReviews
    __typename
  }
}

fragment FsasReviews on FsasReviewsResult {
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
    contents
    thumbnailUrl
    date
    reviewId
    authorName
    createdString
    __typename
  }
  __typename
}`,
    },
  ];

  try {
    const resp = await fetch('https://api.place.naver.com/graphql', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'ko',
        'content-type': 'application/json',
        'origin': 'https://m.place.naver.com',
        'referer': `https://m.place.naver.com/${businessType}/${placeId}/review/ugc`,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'x-wtm-graphql': xWtmGraphql,
        // ncaptcha-token은 일부 요청에서만 필요할 수 있음 - 일단 빼고 시도
      },
      body: JSON.stringify(body),
    });

    const status = resp.status;
    const text = await resp.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    // 응답 구조 분석
    const analysis = {};
    if (Array.isArray(parsed) && parsed[0]?.data?.fsasReviews) {
      const result = parsed[0].data.fsasReviews;
      analysis.total = result.total;
      analysis.maxItemCount = result.maxItemCount;
      analysis.returnedCount = result.items?.length || 0;
      analysis.itemTypes = [...new Set((result.items || []).map(i => i.type))];
      analysis.blogCount = (result.items || []).filter(i => i.type === 'blog').length;
      analysis.cafeCount = (result.items || []).filter(i => i.type === 'cafe').length;
      
      // 처음 3개 아이템의 URL 구조만 간단히
      analysis.urlSamples = (result.items || []).slice(0, 3).map(i => ({
        type: i.type,
        url: i.url,
        title: i.title?.slice(0, 50),
        authorName: i.authorName,
        reviewId: i.reviewId,
      }));
    }

    return res.status(200).json({
      testParams: { placeId, businessType, page, display },
      xWtmGraphqlDecoded: wtmPayload,
      responseStatus: status,
      responseHeaders: {
        'content-type': resp.headers.get('content-type'),
      },
      analysis,
      // 에러가 났거나 이상한 응답일 때 디버깅용
      rawResponsePreview: text.slice(0, 2000),
      // 풀 데이터는 아이템 2개만 (너무 커지지 않게)
      firstTwoFullItems: parsed?.[0]?.data?.fsasReviews?.items?.slice(0, 2) || null,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
    });
  }
}
