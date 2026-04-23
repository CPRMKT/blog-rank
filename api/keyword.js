import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: '키워드 필요' });

  const LICENSE = process.env.NAVER_AD_LICENSE;
  const SECRET = process.env.NAVER_AD_SECRET;
  const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;

  if (!LICENSE || !SECRET || !CUSTOMER_ID) {
    return res.status(500).json({ error: 'API 키 미설정' });
  }

  try {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = '/keywordstool';
    
    // 네이버 광고 API 서명 방식
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
      return res.status(200).json({ keyword, monthlyPcQcCnt: 0, monthlyMobileQcCnt: 0, total: 0 });
    }
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
