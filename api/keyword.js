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

    // 네이버 공식 방식: timestamp.METHOD.path
    const message = timestamp + '.' + method + '.' + path;
    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(message)
      .digest('base64');

    const url = `https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;

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

    const text = await response.text();
    
    // 전체 응답 텍스트 확인
    return res.status(200).json({
      status: response.status,
      keyword,
      message,
      responseText: text.slice(0, 500)
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
