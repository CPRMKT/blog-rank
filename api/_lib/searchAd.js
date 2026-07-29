// api/_lib/searchAd.js
// 네이버 검색광고 API(keywordstool)로 키워드 월간 검색량을 조회한다.
// 필요한 환경변수(Vercel):
//   NAVER_AD_LICENSE      - 액세스 라이선스(X-API-KEY)
//   NAVER_AD_SECRET       - 비밀키(시그니처 서명용)
//   NAVER_AD_CUSTOMER_ID  - 고객 ID
//
// 시그니처: HMAC-SHA256( `${timestamp}.${method}.${path}`, SECRET ) → base64
// 문서: https://naver.github.io/searchad-apidoc/

import crypto from 'crypto';

const BASE = 'https://api.naver.com';

function sign(timestamp, method, path, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${method}.${path}`)
    .digest('base64');
}

// 네이버는 공백 없는 형태로 매칭하므로 조회/키 모두 공백 제거해 정규화.
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

/**
 * 키워드들의 월간 검색량(PC/모바일/합계)을 조회한다.
 * - keywordstool 은 hintKeywords 를 한 번에 최대 5개까지 받는다.
 * - 반환 Map 의 키는 "정규화(공백 제거) 키워드". 호출부는 norm(keyword)로 조회.
 *
 * @param {string[]} keywords
 * @returns {Promise<Map<string, {pc:number, mobile:number, total:number}>>}
 */
export async function fetchSearchVolumes(keywords) {
  const apiKey = (process.env.NAVER_AD_LICENSE || '').trim();
  const secret = (process.env.NAVER_AD_SECRET || '').trim();
  const customerId = (process.env.NAVER_AD_CUSTOMER_ID || '').trim();
  const result = new Map();
  if (!apiKey || !secret || !customerId) return result;

  const path = '/keywordstool';
  const uniq = [...new Set(keywords.map(norm))].filter(Boolean);
  const batches = [];
  for (let i = 0; i < uniq.length; i += 5) batches.push(uniq.slice(i, i + 5));

  const toNum = (v) =>
    typeof v === 'string' && v.includes('<') ? 5 : parseInt(v, 10) || 0;

  async function runBatch(batch) {
    const hint = batch.join(',');
    const ts = String(Date.now());
    let json;
    try {
      const resp = await fetch(
        `${BASE}${path}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`,
        {
          headers: {
            'X-Timestamp': ts,
            'X-API-KEY': apiKey,
            'X-Customer': customerId,
            'X-Signature': sign(ts, 'GET', path, secret),
          },
        }
      );
      if (!resp.ok) return;
      json = await resp.json();
    } catch {
      return;
    }
    const list = json?.keywordList || [];
    for (const kw of batch) {
      const target = kw.toUpperCase();
      const row = list.find(
        (r) => norm(r.relKeyword).toUpperCase() === target
      );
      if (!row) continue;
      const pc = toNum(row.monthlyPcQcCnt);
      const mobile = toNum(row.monthlyMobileQcCnt);
      result.set(kw, { pc, mobile, total: pc + mobile, compIdx: row.compIdx || null });
    }
  }

  // 동시성 제한(4)으로 병렬 호출 → 지연/타임아웃 완화
  const CONC = 4;
  for (let i = 0; i < batches.length; i += CONC) {
    await Promise.all(batches.slice(i, i + CONC).map(runBatch));
  }
  return result;
}

// 호출부에서 정규화 키로 조회할 수 있도록 helper 노출
export const normalizeKeyword = norm;
