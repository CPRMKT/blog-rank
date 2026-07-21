// api/suggest-keywords.js
// 플레이스 URL → 매장 정보 크롤 → Claude로 키워드 요소 추출 → 조합 생성
// → 네이버 검색광고 API로 월 검색량 부여 → 검색량순 정렬(핵심 보존).
//
// GET/POST /api/suggest-keywords?url=<네이버 플레이스/지도 URL>  (또는 placeId=)
//
// 필요한 환경변수(Vercel):
//   ANTHROPIC_API_KEY                          - Claude API
//   NAVER_AD_LICENSE/SECRET/CUSTOMER_ID        - 검색량(선택; 없으면 검색량 null)

import { parsePlaceUrl, fetchPlaceForKeywords } from './_lib/naverPlace.js';
import { fetchSearchVolumes, normalizeKeyword as norm } from './_lib/searchAd.js';

const CLAUDE_MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001';
const MAX_LOGICAL = 45; // 논리 키워드(조합) 상한 → 띄어/붙여 2형태로 확장
const TARGET_MAX = 80; // 최종 행 상한

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

  // 1) 후보(논리 조합) 생성
  const candidates = buildCandidates(place, elements);
  // 2) 검색량 부여(정규화 키로 조회 → 띄어/붙여 공통)
  const volumes = await fetchSearchVolumes(candidates.map((c) => c.spaced));
  for (const c of candidates) {
    const v = volumes.get(norm(c.spaced));
    c.volume = v ? v.total : null;
    c.pc = v ? v.pc : null;
    c.mobile = v ? v.mobile : null;
  }
  // 3) 선택(핵심 보존) + 띄어/붙여 두 형태로 행 생성 + 검색량순 정렬
  const keywords = selectRows(candidates);

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
    'regions: 검색량이 높을 법한 순서로, 지역을 폭넓게 세분화한다. 다음을 모두 포함하라 — ' +
    '① 시/도(예: 울산), ② 구/군(예: 남구, 울산남구), ③ 동(예: 삼산동), ' +
    '④ 지하철역·랜드마크(예: 삼산, 공업탑), ⑤ 시+구/시+동을 붙인 복합 지역명(예: 울산삼산). ' +
    '주소의 행정구역을 반드시 활용. 최대 8개.\n' +
    'menus: 대표 메뉴명과 업종 일반명을 폭넓게(예: 한정식, 솥밥, 갈비, 떡갈비, 대통밥). 최대 7개.\n' +
    'situations: 방문 상황/목적(예: 점심, 저녁, 가족식사, 단체모임, 회식, 데이트, 모임). ' +
    '편의(단체 이용 가능 등)·메뉴·업종에서 유추. 최대 5개.\n' +
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

// ── 후보(논리 조합) 생성 ────────────────────────────────────────────────
function buildCandidates(place, el) {
  const regions = el.regions.slice(0, 6);
  const menus = el.menus.slice(0, 6);
  const situations = el.situations.slice(0, 4);
  const addr = `${place.roadAddress || ''} ${place.address || ''}`;
  const catTokens = (place.category || '').split(/[,\s]+/).filter(Boolean);

  const seen = new Set();
  const cands = [];
  const add = (parts, meta) => {
    const clean = parts.filter(Boolean);
    const spaced = clean.join(' ').replace(/\s+/g, ' ').trim();
    if (!spaced || seen.has(spaced)) return;
    seen.add(spaced);
    const region = meta.region || '';
    cands.push({
      spaced,
      parts: clean,
      region,
      menu: meta.menu || '',
      situation: meta.situation || '',
      core: !!meta.core,
      addrMatch: region ? addr.includes(region) : false,
      catMatch: !!meta.menu || catTokens.some((t) => spaced.includes(t)),
    });
  };

  regions.forEach((r, ri) => {
    // 지역 × 맛집 / 추천 (상위 지역은 핵심)
    add([r, '맛집'], { region: r, core: ri < 4 });
    add([r, '추천'], { region: r, core: ri < 3 });
    // 지역 × 메뉴 (+ 맛집/추천) — 대표메뉴(0번)·상위지역은 핵심
    menus.forEach((m, mi) => {
      add([r, m], { region: r, menu: m, core: mi === 0 && ri < 3 });
      add([r, m, '맛집'], { region: r, menu: m, core: mi === 0 && ri < 2 });
      add([r, m, '추천'], { region: r, menu: m });
    });
    // 지역 × 상황 (+ 맛집)
    situations.forEach((s) => {
      add([r, s], { region: r, situation: s });
      add([r, s, '맛집'], { region: r, situation: s });
    });
  });

  return cands;
}

// ── 선택(핵심 보존) + 띄어/붙여 두 형태 + 검색량순 정렬 ──────────────────
function selectRows(cands) {
  const byVol = (a, b) => (b.volume ?? -1) - (a.volume ?? -1);

  // 핵심은 전부, 나머지는 검색량 상위로 논리 상한까지 선택
  const core = cands.filter((c) => c.core).sort(byVol);
  const rest = cands.filter((c) => !c.core).sort(byVol);
  const selected = [...core];
  for (const c of rest) {
    if (selected.length >= MAX_LOGICAL) break;
    selected.push(c);
  }

  // 각 논리 키워드를 띄어쓰기 + 붙여쓰기 두 행으로 확장
  const seenKw = new Set();
  let rows = [];
  const emit = (keyword, c, form) => {
    if (!keyword || seenKw.has(keyword)) return;
    seenKw.add(keyword);
    rows.push({
      keyword,
      form, // 'spaced' | 'joined'
      region: c.region,
      menu: c.menu,
      situation: c.situation,
      core: c.core,
      addrMatch: c.addrMatch,
      catMatch: c.catMatch,
      monthlyVolume: c.volume,
      monthlyPc: c.pc,
      monthlyMobile: c.mobile,
    });
  };
  for (const c of selected) {
    const spaced = c.spaced;
    const joined = c.parts.join('');
    emit(spaced, c, 'spaced');
    if (joined !== spaced) emit(joined, c, 'joined');
  }

  const finalSort = (a, b) => {
    const d = (b.monthlyVolume ?? -1) - (a.monthlyVolume ?? -1);
    if (d !== 0) return d;
    const n = norm(a.keyword).localeCompare(norm(b.keyword));
    if (n !== 0) return n;
    return a.keyword.length - b.keyword.length; // 붙여쓰기(짧음) 먼저
  };
  rows.sort(finalSort);

  // 상한 초과 시 비핵심부터 제거(핵심 키워드는 검색량 낮아도 보존)
  if (rows.length > TARGET_MAX) {
    const coreRows = rows.filter((r) => r.core);
    const nonCore = rows.filter((r) => !r.core);
    const keepNon = nonCore.slice(0, Math.max(0, TARGET_MAX - coreRows.length));
    rows = [...coreRows, ...keepNon].sort(finalSort);
  }
  return rows;
}
