import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword } = req.query;
  const LICENSE = process.env.NAVER_AD_LICENSE;
  const SECRET = process.env.NAVER_AD_SECRET;
  const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;

  try {
    const timestamp = String(Math.floor(Date.now()));
    const method = 'GET';
    const path = '/keywordstool';

    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(`${timestamp}.${method}.${path}`)
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

    const data = await response.json();
    const keywordList = data.keywordList || [];
    const matched = keywordList.find(k => k.relKeyword === keyword);

    if (matched) {
      return res.status(200).json({
        keyword,
        monthlyPcQcCnt: matched.monthlyPcQcCnt || 0,
        monthlyMobileQcCnt: matched.monthlyMobileQcCnt || 0,
        total: (matched.monthlyPcQcCnt || 0) + (matched.monthlyMobileQcCnt || 0)
      });
    } else {
      return res.status(200).json({
        keyword,
        monthlyPcQcCnt: 0,
        monthlyMobileQcCnt: 0,
        total: 0,
        debug: { status: response.status, listLength: keywordList.length }
      });
    }
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
