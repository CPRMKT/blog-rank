import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword } = req.query;
  const LICENSE = process.env.NAVER_AD_LICENSE;
  const SECRET = process.env.NAVER_AD_SECRET;
  const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;

  try {
    const timestamp = String(Date.now());
    const method = 'GET';
    const path = '/keywordstool';
    const message = timestamp + '.' + method + '.' + path;

    // SECRET을 그대로 문자열로 사용
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(message, 'utf8');
    const signature = hmac.digest('base64');

    const url = `https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': LICENSE,
        'X-Customer': String(CUSTOMER_ID),
        'X-Signature': signature,
      }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }

    if (response.status === 200) {
      const keywordList = data.keywordList || [];
      const matched = keywordList.find(k => k.relKeyword === keyword);
      if (matched) {
        return res.status(200).json({
          keyword,
          monthlyPcQcCnt: matched.monthlyPcQcCnt || 0,
          monthlyMobileQcCnt: matched.monthlyMobileQcCnt || 0,
          total: (matched.monthlyPcQcCnt || 0) + (matched.monthlyMobileQcCnt || 0)
        });
      }
      return res.status(200).json({ keyword, total: 0, debug: { listLength: keywordList.length } });
    }

    return res.status(200).json({
      status: response.status,
      keyword,
      message,
      signature,
      error: data
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
