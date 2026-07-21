// api/suggest-keywords.js
// 플레이스 URL → 매장 정보 크롤 → Claude로 키워드 요소 추출 → 조합 생성
// → 네이버 검색광고 API로 월 검색량 부여 → 검색량순 TOP 80.
//
// 조합 공식(모두 붙여쓰기):
//   1열(지역) × 2열(메뉴/상황) × 3열(맛집) / 4열(추천) 고정
//   - 1×2        : 지역+메뉴/상황            (울산솥밥, 삼산한정식)
//   - 1×3 / 1×4  : 지역+맛집 / 지역+추천       (울산맛집, 삼산추천)
//   - 1×2×3/1×2×4: 지역+메뉴/상황+맛집/추천    (울산솥밥맛집, 삼산한정식추천)
//
// GET/POST /api/suggest-keywords?url=<네이버 플레이스/지도 URL>  (또는 placeId=)
//
// 필요한 환경변수(Vercel):
//   ANTHROPIC_API_KEY                          - Claude API
//   NAVER_AD_LICENSE/SECRET/CUSTOMER_ID        - 검색량(선택; 없으면 검색량 null)

import { parsePlaceUrl, fetchPlaceForKeywords } from './_lib/naverPlace.js';
import { fetchSearchVolumes, normalizeKeyword as norm } from './_lib/searchAd.js';

const CLAUDE_MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001';
const TARGET_MAX = 80; // 최종 키워드 상한(검색량 상위)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.method === 'POST' ? req.body || {} : req.query;
    let placeId = q.placeId;
    if (!placeId && q.url) placeId = (await parsePlaceUrl(q.url)).placeId;
    if (!placeId) {
      return res.status(400).json({ ok: false, error: 'url 또는 placeId가 필요합니다' });
    }
    const result = await runSuggest(placeId);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/** 키워드 제안 핵심 파이프라인(테스트에서 직접 호출 가능). */
export async function runSuggest(placeId) {
  const place = await fetchPlaceForKeywords(placeId);
  const elements = await extractElements(place);

  // 1) 조합(붙여쓰기) 후보 생성
  const candidates = buildCandidates(place, elements);
  // 2) 월 검색량 부여
  const volumes = await fetchSearchVolumes(candidates.map((c) => c.keyword));
  for (const c of candidates) {
    const v = volumes.get(norm(c.keyword));
    c.volume = v ? v.total : null;
    c.pc = v ? v.pc : null;
    c.mobile = v ? v.mobile : null;
  }
  // 3) 검색량순 TOP 80
  const keywords = selectTop(candidates);

  return {
    ok: true,
    place: {
      placeId,
      name: place.name,
      category: place.category,
      address: place.roadAddress || place.address,
      reviewCount: place.visitorReviewsTotal || 0,
    },
    elements,
    hasVolume: volumes.size > 0,
    keywords,
  };
}

// ── Claude 호출: 매장 정보 → {regions, menus, situations} ──────────────
async function extractElements(place) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다');

  const menuNames = (place.menus || [])
    .map((m) => m.name)
    .filter(Boolean)
    .slice(0, 25);

  const context = {
    이름: place.name,
    업종: place.category,
    도로명주소: place.roadAddress,
    지번주소: place.address,
    연관키워드: place.keywordList || [],
    편의: place.conveniences || [],
    한줄리뷰: place.microReviews || [],
    메뉴: menuNames,
  };

  const system =
    '너는 네이버 플레이스/블로그 검색을 위한 지역 키워드 전략가다. ' +
    '매장 정보를 보고 블로그 검색에 실제로 쓰일 법한 키워드 요소를 추출한다. ' +
    '반드시 아래 JSON 스키마로만 답하라(설명·마크다운 금지):\n' +
    '{"regions":[문자열],"menus":[문자열],"situations":[문자열]}\n' +
    'regions: 검색량 높을 순서로, 지역을 최대한 다양하게 생성한다. 다음 형태를 모두 포함:\n' +
    ' ① 시/도 (예: 울산)\n' +
    ' ② 구/군 (예: 남구) 및 시+구 (예: 울산남구)\n' +
    ' ③ 동 (예: 삼산동) 및 시+동 (예: 울산삼산동)\n' +
    ' ④ 동네·번화가·랜드마크명 (예: 삼산) 및 시+랜드마크 (예: 울산삼산)\n' +
    ' ⑤ 구청·대학·터미널 등 주요 시설명 (예: 울산남구청)\n' +
    ' ⑥ 매장 인근에 지하철역이 있으면 역명 (예: 삼산역)\n' +
    ' 주소의 행정구역과 연관키워드를 반드시 활용. 최대 10개.\n' +
    'menus: 대표 메뉴명과 업종 일반명을 폭넓게 (예: 한정식, 솥밥, 갈비, 떡갈비, 대통밥). 최대 6개.\n' +
    'situations: 방문 상황/목적 (예: 점심, 저녁, 가족식사, 단체모임, 회식, 데이트). 최대 4개.\n' +
    '모든 값은 한국어 명사, 공백 없는 단일 토큰(복합 지역명 제외) 위주.';

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system,
    messages: [
      { role: 'user', content: '매장 정보:\n' + JSON.stringify(context, null, 1) },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Claude API 오류 (${resp.status}): ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const parsed = parseJson(text);
  return {
    regions: cleanArr(parsed.regions),
    menus: cleanArr(parsed.menus),
    situations: cleanArr(parsed.situations),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return { regions: [], menus: [], situations: [] };
}

function cleanArr(a) {
  if (!Array.isArray(a)) return [];
  return [...new Set(a.map((s) => String(s).trim()).filter(Boolean))];
}

// ── 조합 후보 생성 (붙여쓰기) ────────────────────────────────────────────
// 1열(지역) × 2열(메뉴+상황) × 3열(맛집)/4열(추천)
function buildCandidates(place, el) {
  const regions = el.regions.slice(0, 8);
  const menus = el.menus.slice(0, 5);
  const situations = el.situations.slice(0, 3);
  // 2열 = 메뉴 + 상황
  const col2 = [
    ...menus.map((v) => ({ v, type: 'menu' })),
    ...situations.map((v) => ({ v, type: 'situation' })),
  ];

  const addrNorm = norm(`${place.roadAddress || ''} ${place.address || ''}`);
  const catTokens = (place.category || '').split(/[,\s]+/).filter(Boolean);

  const seen = new Set();
  const cands = [];
  const add = (parts, meta) => {
    const keyword = parts.join('').replace(/\s+/g, '');
    if (!keyword || seen.has(keyword)) return;
    seen.add(keyword);
    const region = meta.region || '';
    cands.push({
      keyword,
      region,
      menu: meta.menu || '',
      situation: meta.situation || '',
      addrMatch: region ? addrNorm.includes(norm(region)) : false,
      catMatch: !!meta.menu || catTokens.some((t) => keyword.includes(t)),
    });
  };

  for (const r of regions) {
    add([r, '맛집'], { region: r }); // 1×3
    add([r, '추천'], { region: r }); // 1×4
    for (const c of col2) {
      const meta = { region: r, [c.type]: c.v };
      add([r, c.v], meta); // 1×2
      add([r, c.v, '맛집'], meta); // 1×2×3
      add([r, c.v, '추천'], meta); // 1×2×4
    }
  }
  return cands;
}

// ── 검색량순 TOP N ──────────────────────────────────────────────────────
function selectTop(cands) {
  const rows = cands.map((c) => ({
    keyword: c.keyword,
    region: c.region,
    menu: c.menu,
    situation: c.situation,
    addrMatch: c.addrMatch,
    catMatch: c.catMatch,
    monthlyVolume: c.volume,
    monthlyPc: c.pc,
    monthlyMobile: c.mobile,
  }));
  rows.sort((a, b) => {
    const d = (b.monthlyVolume ?? -1) - (a.monthlyVolume ?? -1);
    if (d !== 0) return d;
    return a.keyword.localeCompare(b.keyword);
  });
  return rows.slice(0, TARGET_MAX);
}
