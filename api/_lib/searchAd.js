// api/_lib/searchAd.js
// 네이버 검색광고 API(keywordstool)로 키워드 월간 검색량을 조회한다.
// 필요한 환경변수(Vercel):
//   NAVER_AD_LICENSE      - 액세스 라이선스(X-API-KEY)
//   NAVER_AD_SECRET       - 비밀키(시그니처 서명용)
//   NAVER_AD_CUSTOMER_ID  - 고객 ID
//
// 시그니처: HMAC-SHA256( `${timestamp}.${method}.${path}` , SECRET )  → base64
// 문서: https://naver.github.io/searchad-apidoc/

import crypto from 'crypto';

const BASE = 'https://api.naver.com';

function sign(timestamp, method, path, secret) {
  const msg = `${timestamp}.${method}.${path}`;
  return crypto.createHmac('sha256', secret).update(msg).digest('base64');
}

/**
 * 키워드 목록의 월간 검색량(PC+모바일)을 조회한다.
 * keywordstool 은 hintKeywords 를 한 번에 최대 5개까지 받으므로 5개씩 나눠 호출한다.
 * 공백은 네이버 규칙상 제거해서 조회한다(예: "수영 칼국수" → "수영칼국수").
 *
 * @param {string[]} keywords
 * @returns {Promise<Map<string, {pc:number, mobile:number, total:number}>>}
 *          키는 원본 키워드(공백 포함). 조회 실패/없음이면 해당 키 없음.
 */
export async function fetchSearchVolumes(keywords, debug) {
  const push = (m) => { if (debug) debug.push(m); };
  const apiKey = (process.env.NAVER_AD_LICENSE || '').trim();
  const secret = (process.env.NAVER_AD_SECRET || '').trim();
  const customerId = (process.env.NAVER_AD_CUSTOMER_ID || '').trim();
  const result = new Map();
  push(`creds len: LICENSE=${apiKey.length} SECRET=${secret.length} CUSTOMER=${customerId.length}(${customerId})`);
  if (!apiKey || !secret || !customerId) {
    // 자격증명이 없으면 검색량 없이 진행(트렌드 컬럼은 null)
    return result;
  }

  const path = '/keywordstool';
  const uniq = [...new Set(keywords)];

  // 공백 제거한 조회어 → 원본 키워드들 매핑(네이버는 공백 없는 형태로 매칭)
  const norm = (s) => s.replace(/\s+/g, '');

  for (let i = 0; i < uniq.length; i += 5) {
    const batch = uniq.slice(i, i + 5);
    const hint = batch.map(norm).join(',');
    const ts = String(Date.now());
    const url =
      `${BASE}${path}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`;

    let json;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Timestamp': ts,
          'X-API-KEY': apiKey,
          'X-Customer': customerId,
          'X-Signature': sign(ts, 'GET', path, secret),
        },
      });
      if (!resp.ok) {
        push(`HTTP ${resp.status} @batch${i}: ${(await resp.text()).slice(0, 160)}`);
        continue;
      }
      json = await resp.json();
    } catch (e) {
      push(`fetch err @batch${i}: ${e.message}`);
      continue;
    }

    const list = json?.keywordList || [];
    if (i === 0) push(`batch0 hint="${hint}" listLen=${list.length} sample=${JSON.stringify((list[0]||{}).relKeyword||null)}`);
    // 네이버 응답의 relKeyword(공백 없는 대문자)를 batch 원본과 매칭
    for (const kw of batch) {
      const target = norm(kw).toUpperCase();
      const row = list.find(
        (r) => (r.relKeyword || '').replace(/\s+/g, '').toUpperCase() === target
      );
      if (!row) continue;
      const toNum = (v) =>
        typeof v === 'string' && v.includes('<')
          ? 5 // "< 10" 형태는 소량으로 간주
          : parseInt(v, 10) || 0;
      const pc = toNum(row.monthlyPcQcCnt);
      const mobile = toNum(row.monthlyMobileQcCnt);
      result.set(kw, { pc, mobile, total: pc + mobile });
    }
  }

  return result;
}
