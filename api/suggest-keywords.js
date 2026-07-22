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

// 업종별 연관 키워드 사전 — 업종을 food/beauty/health/retail/etc로 분류하고 관련 키워드 확장
const CATEGORY_DICT = `# food (식음료 — 맛집/추천/회식/데이트 등 식음료 키워드 사용)
[한식/밥집] 핵심: 한식,밥집,한정식,정식,가정식,집밥,백반 | 연관: 솥밥,고기집,육류,구이,보쌈,족발,순대국
[고기/구이] 핵심: 고기집,삼겹살,구이,숯불,참숯 | 연관: 돼지갈비,소갈비,갈비집,막창,곱창,대창,오돌뼈 | 상황: 회식,단체,고기맛집
[해산물/횟집] 핵심: 횟집,회,해산물,수산 | 연관: 활어,모둠회,광어,우럭,해물,조개,굴,낙지,꼴뚜기 | 상황: 회포장,회식
[술집/포차] 핵심: 술집,포차,이자카야,선술집,호프 | 연관: 안주,맥주,소주,막걸리,와인바,칵테일 | 특이(야간): 심야,새벽,24시,늦게까지,야식 | 주의: 낮장사 안하면 점심/런치 제외
[카페/디저트] 핵심: 카페,커피,디저트,케이크 | 연관: 아메리카노,라떼,브런치,베이커리,빵집 | 상황: 공부카페,데이트카페,감성카페
[분식/패스트푸드] 핵심: 분식,떡볶이,김밥,라면,순대 | 연관: 튀김,어묵,찌개,우동,냉면
[중식] 핵심: 중국집,중식,짜장면,짬뽕 | 연관: 탕수육,볶음밥,마파두부,양꼬치
[일식] 핵심: 일식,초밥,스시,돈까스,라멘 | 연관: 우동,소바,덮밥,가츠동,오야코동,텐동
[양식] 핵심: 양식,파스타,피자,스테이크 | 연관: 리조또,샐러드,브런치,버거,샌드위치
[치킨/배달] 핵심: 치킨,닭강정,순살,양념치킨 | 연관: 반반,후라이드,닭발,닭볶음탕
[찜/탕/국물] 핵심: 찜,탕,국밥,해장국,설렁탕 | 연관: 갈비찜,아구찜,꽃게찜,순대국,뼈해장국,감자탕
[냉면/국수] 핵심: 냉면,국수,막국수,칼국수 | 연관: 물냉면,비빔냉면,수육,편육

# beauty (미용/뷰티 — 맛집/회식/데이트 금지. 추천/잘하는곳/가격/후기/예약/시술 사용)
[미용/헤어샵] 핵심: 미용실,헤어샵,헤어살롱,헤어,미용 | 연관: 커트,염색,펌,매직,탈색,클리닉,두피케어 | 상황: 여성커트,남성커트,웨딩헤어,가격,예약,후기,잘하는곳,시술
[네일/뷰티] 핵심: 네일,네일샵,속눈썹,왁싱,피부관리,에스테틱,반영구 | 상황: 예약,가격,후기,잘하는곳

# health (병원/헬스 — 맛집 금지. 추천/잘하는곳/후기/비용 사용)
[병원/의원] 핵심: 병원,의원,클리닉,한의원,치과,피부과,정형외과,이비인후과 | 상황: 잘하는곳,추천,후기,비용,예약
[헬스/운동] 핵심: 헬스장,피트니스,요가,필라테스,PT,크로스핏,복싱 | 상황: 가격,등록,후기,추천

# retail (판매/쇼핑 — 맛집 금지. 추천/매장 사용)
[판매/쇼핑] 핵심: 매장,샵,스토어,판매점,편집샵 | 상황: 추천,가격,후기

# etc (위에 없는 기타 업종 — 맛집 금지. 추천 사용)`;

// 식음료(food) 상황 키워드
const SITUATION_FOOD =
  '식사시간: 점심,런치,저녁,디너,야식,심야 | 모임: 회식,단체,가족모임,생일,기념일,상견례 | ' +
  '관계: 데이트,부모님,친구,직장동료 | 특성: 혼밥,혼술,가성비,웨이팅,예약필수 | 포장: 포장,테이크아웃,배달';
// 서비스 업종(beauty/health/retail/etc) 상황 키워드
const SITUATION_SERVICE = '예약,가격,비용,후기,잘하는곳,추천,전문,유명한곳,시술,상담';

// 업종별 고정 접미어(3열/4열). food만 맛집 사용, 나머지는 맛집 금지.
const TYPE_SUFFIX = {
  food: ['맛집', '추천'],
  beauty: ['추천', '잘하는곳'],
  health: ['추천', '잘하는곳'],
  retail: ['추천', '매장'],
  etc: ['추천'],
};
const VALID_TYPES = Object.keys(TYPE_SUFFIX);

// food 전용(비food에서 배제할) 상황/수식 토큰 — Claude가 실수로 넣어도 걸러냄
const FOOD_ONLY = new Set([
  '맛집', '회식', '데이트', '데이트맛집', '야식', '점심', '런치', '디너', '저녁',
  '심야', '혼밥', '혼술', '브런치', '가족모임', '상견례', '고기맛집', '회포장',
  '공부카페', '데이트카페', '감성카페', '단체', '포장', '테이크아웃', '배달',
]);

// businessType 미지정/오류 시 업종 문자열로 추정
function inferBusinessType(category) {
  const c = String(category || '');
  if (/미용|헤어|네일|뷰티|피부관리|왁싱|속눈썹|에스테틱|반영구|메이크업/.test(c)) return 'beauty';
  if (/병원|의원|한의원|치과|약국|피부과|정형|이비인후|안과|헬스|피트니스|요가|필라테스|PT|크로스핏/.test(c)) return 'health';
  if (/마트|매장|샵|스토어|판매|편의점|쇼핑|의류|잡화/.test(c)) return 'retail';
  if (/음식|식당|맛집|한식|중식|일식|양식|카페|커피|고기|구이|횟집|회|술집|포차|치킨|분식|국수|냉면|찜|탕|피자|파스타|베이커리|디저트|밥집|칼국수|만두|갈비|족발|보쌈|국밥/.test(c)) return 'food';
  return 'etc';
}

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
    지하철역: (place.subwayStations || []).map((s) => s.displayName),
    영업시간: (place.businessHours || []).map(
      (h) => `${h.day || ''} ${h.start || '?'}~${h.end || '?'}`.trim()
    ),
    오시는길: place.directions || '',
    연관키워드: place.keywordList || [],
    편의: place.conveniences || [],
    한줄리뷰: place.microReviews || [],
    메뉴: menuNames,
  };

  const system =
    '너는 네이버 플레이스/블로그 검색 키워드 전략가다. 아래 [업종 키워드 사전]을 활용해 ' +
    '매장 유형을 분류하고, 그 업종에 맞는 키워드만 확장한다.\n\n' +
    '[업종 키워드 사전]\n' + CATEGORY_DICT + '\n\n' +
    '[food 상황]\n' + SITUATION_FOOD + '\n' +
    '[서비스업 상황(beauty/health/retail/etc)]\n' + SITUATION_SERVICE + '\n\n' +
    '작업:\n' +
    '1) businessType 분류: 매장(업종 필드·메뉴·이름·리뷰)을 food/beauty/health/retail/etc 중 하나로 정확히 판정.\n' +
    '   - 식음료(식당/카페/술집 등)=food, 미용실/네일/피부 등=beauty, 병원/헬스=health, 판매/쇼핑=retail, 그 외=etc.\n' +
    '2) menus = 해당 업종 사전의 핵심·연관 키워드 + 이 매장 실제 서비스/메뉴. 이 매장에 맞는 것만.\n' +
    '   (beauty/health/retail은 "메뉴"가 아니라 서비스명. 예: 미용실→커트,염색,펌)\n' +
    '3) situations = 업종에 맞는 상황만.\n' +
    '   - food면 [food 상황]에서, 그 외면 [서비스업 상황]과 사전의 업종별 상황에서 고른다.\n' +
    '4) 배제 규칙(반드시 지킴):\n' +
    '   ★ businessType이 food가 아니면 맛집·회식·데이트·야식·점심·런치 등 식음료 상황 키워드를 절대 넣지 마라.\n' +
    '   - [영업시간]을 보고 점심시간(대략 11~14시)에 영업하지 않으면 점심·런치·브런치 키워드 제외. ' +
    '저녁/야간만 영업(예: 17시 이후 오픈)이면 저녁·심야·야식 우선.\n' +
    '   - 매장 특성에 안 맞는 키워드 제외(횟집에 삼겹살, 카페에 회식, 미용실에 맛집 등).\n' +
    '5) regions = 검색량 높을 순서로 지역을 다양하게 생성:\n' +
    '   ① 시/도(울산) ② 구/군(남구)·시+구(울산남구) ③ 동(삼산동)·시+동(울산삼산동) ' +
    '④ 동네·랜드마크(삼산)·시+랜드마크(울산삼산) ⑤ 구청·대학·터미널 시설(울산남구청)\n' +
    '   ⑥ [지하철역]에 주어진 역명을 반드시 포함(예: 온천장역, 동래역).\n' +
    '   ⑦ [오시는길]·[연관키워드]에서 주변 랜드마크(백화점·대학교·병원·터미널·시장 등)를 찾아 ' +
    '"랜드마크"와 "랜드마크근처" 두 형태로 포함(예: 롯데백화점, 롯데백화점근처).\n\n' +
    '반드시 아래 JSON만 출력(설명·마크다운 금지):\n' +
    '{"businessType":"food|beauty|health|retail|etc","regions":[...],"menus":[...],"situations":[...]}\n' +
    'regions 최대 10, menus 최대 12, situations 최대 8. ' +
    '모든 값은 한국어 명사, 공백 없는 단일 토큰(복합 지역명 제외).';

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
  let businessType = String(parsed.businessType || '').trim().toLowerCase();
  if (!VALID_TYPES.includes(businessType)) businessType = inferBusinessType(place.category);
  return {
    businessType,
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
  const type = VALID_TYPES.includes(el.businessType) ? el.businessType : 'etc';
  const suffixes = TYPE_SUFFIX[type]; // food만 '맛집' 포함
  const isFood = type === 'food';

  const regions = el.regions.slice(0, 8);
  let menus = el.menus.slice(0, 6);
  let situations = el.situations.slice(0, 4);
  // 비food 업종이면 식음료 전용 토큰을 col2에서 제거(안전망)
  if (!isFood) {
    menus = menus.filter((v) => !FOOD_ONLY.has(v));
    situations = situations.filter((v) => !FOOD_ONLY.has(v));
  }
  // 2열 = 메뉴/서비스 + 상황
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
    for (const suf of suffixes) add([r, suf], { region: r }); // 1×3, 1×4
    for (const c of col2) {
      const meta = { region: r, [c.type]: c.v };
      add([r, c.v], meta); // 1×2
      for (const suf of suffixes) add([r, c.v, suf], meta); // 1×2×3, 1×2×4
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
