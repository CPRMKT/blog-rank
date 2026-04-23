import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword } = req.query;
  const LICENSE = process.env.NAVER_AD_LICENSE;
  const SECRET = process.env.NAVER_AD_SECRET;
  const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;

  try {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = '/keywordstool';
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(timestamp + '.' + method + '.' + path);
    const signature = hmac.digest('base64');

    const url = `https://api.naver.com/keywordstool?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': LICENSE,
        'X-Customer': CUSTOMER_ID,
        'X-Signature': signature,
      }
    });

    const data = await response.json();
    
    // 전체 응답 디버깅
    return res.status(200).json({
      keyword,
      rawData: data,
      keywordListLength: (data.keywordList||[]).length,
      firstFew: (data.keywordList||[]).slice(0,3)
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
