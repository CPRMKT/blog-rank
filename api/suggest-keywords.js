// api/suggest-keywords.js
// 플레이스 URL → 매장 정보 크롤 → Claude로 키워드 요소 추출 → 조합 생성
// → 네이버 검색광고 API로 검색량 부여 → 결과 반환.
//
// GET/POST /api/suggest-keywords?url=<네이버 플레이스/지도 URL>  (또는 placeId=)
//
// 필요한 환경변수(Vercel):
//   ANTHROPIC_API_KEY                          - Claude API
//   NAVER_AD_API_KEY/SECRET_KEY/CUSTOMER_ID    - 검색량(선택; 없으면 트렌드 null)

import { parsePlaceUrl, fetchPlaceForKeywords } from './_lib/naverPlace.js';
import { fetchSearchVolumes } from './_lib/searchAd.js';

const CLAUDE_MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.method === 'POST' ? req.body || {} : req.query;
    let placeId = q.placeId;
    if (!placeId && q.url) {
      placeId = (await parsePlaceUrl(q.url)).placeId;
    }
    if (!placeId) {
      return res.status(400).json({ ok: false, error: 'url 또는 placeId가 필요합니다' });
    }

    // 1) 매장 정보 크롤
    const place = await fetchPlaceForKeywords(placeId);

    // 2) Claude로 지역/메뉴/상황 요소 추출
    const elements = await extractElements(place);

    // 3) 키워드 조합 생성 + 태깅
    const rows = buildKeywords(place, elements);

    // 4) 검색량 부여(트렌드)
    const volumes = await fetchSearchVolumes(rows.map((r) => r.keyword));
    for (const r of rows) {
      const v = volumes.get(r.keyword);
      r.trend = v ? v.total : null;
    }
    rows.sort((a, b) => (b.trend ?? -1) - (a.trend ?? -1));

    return res.status(200).json({
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
      keywords: rows,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
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
    'regions: 검색량이 높을 법한 순서로. 시/구/동/역/랜드마크를 폭넓게(넓은 지역명과 좁은 동/역 모두). 최대 6개.\n' +
    'menus: 대표 메뉴명과 업종 일반명(예: 칼국수, 조개칼국수, 보쌈). 최대 6개.\n' +
    'situations: 방문 상황/목적(예: 점심, 가족식사, 단체모임, 회식, 데이트). 편의·메뉴·업종에서 유추. 최대 5개.\n' +
    '모든 값은 한국어 명사, 공백 없는 단일 토큰 위주.';

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

// ── 키워드 조합 생성 + 태깅 ────────────────────────────────────────────
function buildKeywords(place, el) {
  const regions = el.regions.slice(0, 5);
  const menus = el.menus.slice(0, 5);
  const situations = el.situations.slice(0, 4);
  const addr = `${place.roadAddress || ''} ${place.address || ''}`;
  const cat = place.category || '';
  const catTokens = cat.split(/[,\s]+/).filter(Boolean);

  const seen = new Set();
  const rows = [];
  const add = (parts, meta) => {
    const keyword = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!keyword || seen.has(keyword)) return;
    seen.add(keyword);
    const region = meta.region || '';
    const menu = meta.menu || '';
    rows.push({
      keyword,
      region,
      menu,
      situation: meta.situation || '',
      // 주소노출여부: 지역명이 매장 주소에 실제 포함되는가
      addrMatch: region ? addr.includes(region) : false,
      // 업종노출여부: 키워드에 업종/메뉴 성격 토큰이 들어갔는가
      catMatch:
        !!menu ||
        catTokens.some((t) => keyword.includes(t)),
    });
  };

  for (const r of regions) {
    // 지역 × 맛집 / 추천
    add([r, '맛집'], { region: r });
    add([r, '추천'], { region: r });
    // 지역 × 메뉴 (+ 맛집/추천)
    for (const m of menus) {
      add([r, m], { region: r, menu: m });
      add([r, m, '맛집'], { region: r, menu: m });
      add([r, m, '추천'], { region: r, menu: m });
    }
    // 지역 × 상황 (+ 맛집)
    for (const s of situations) {
      add([r, s], { region: r, situation: s });
      add([r, s, '맛집'], { region: r, situation: s });
    }
  }
  return rows;
}
