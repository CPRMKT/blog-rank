// api/region-check.js
// 동명 지역 오탐 필터
//   같은 이름의 동네가 전국에 여러 곳 있어(예: "태전동" — 경기 광주시 / 대구 북구),
//   매장과 무관한 타 지역 블로그 글이 순위 결과에 섞이는 문제를 걸러낸다.
//
// 판정 (post 하나당):
//   ok        - 우리 매장 글로 확인됨 (플레이스 위젯 일치 / 본문에 매장 상호명 언급) 또는 시스템 오류(제외 방지)
//   excluded  - 우리 글로 확인되지 않음 (위젯 불일치 / 다른 지역명 / 매장명·단서 없음)
//   ambiguous - (현재 정책상 미발생) 과거 회색 처리용 값. 프론트 코드는 재정책 대비 보존.
//
// 정책(2026-07): 체험단 특성상 우리 매장 글은 상호명/플레이스 링크가 거의 항상 포함된다.
//   따라서 매장명 단서가 없는 글은 우리 글일 가능성이 낮다고 보고 excluded 처리한다.
//   단, fetch 실패·매장 정보 없음·API 오류 등 "시스템 오류"는 ok로 통과시켜 오탐 제외를 막는다.

const BLOG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 6000;
// 프런트가 한 번에 보내는 배치 크기(8)와 맞춰, 한 요청이 한 웨이브로 끝나
// Vercel 함수 실행시간(기본 10초) 안에 완료되도록 한다.
const CONCURRENCY = 8;

// ---------------------------------------------------------------- 지역 사전
// 시·도 단위만 판정에 사용한다. "동"이나 "구"는 전국 중복이 심해(예: 북구, 태전동)
// 오히려 오판을 만든다.
const SIDO = [
  { key: '서울', aliases: ['서울특별시', '서울시', '서울'] },
  { key: '부산', aliases: ['부산광역시', '부산시', '부산'] },
  { key: '대구', aliases: ['대구광역시', '대구시', '대구'] },
  { key: '인천', aliases: ['인천광역시', '인천시', '인천'] },
  // "광주"는 광주광역시 / 경기 광주시 두 곳이라 단독 "광주"로는 판정하지 않는다.
  { key: '광주광역시', aliases: ['광주광역시', '광주 광역시'] },
  { key: '대전', aliases: ['대전광역시', '대전시', '대전'] },
  { key: '울산', aliases: ['울산광역시', '울산시', '울산'] },
  { key: '세종', aliases: ['세종특별자치시', '세종시', '세종'] },
  { key: '경기', aliases: ['경기도', '경기'] },
  { key: '강원', aliases: ['강원특별자치도', '강원도', '강원'] },
  { key: '충북', aliases: ['충청북도', '충북'] },
  { key: '충남', aliases: ['충청남도', '충남'] },
  { key: '전북', aliases: ['전북특별자치도', '전라북도', '전북'] },
  { key: '전남', aliases: ['전라남도', '전남'] },
  { key: '경북', aliases: ['경상북도', '경북'] },
  { key: '경남', aliases: ['경상남도', '경남'] },
  { key: '제주', aliases: ['제주특별자치도', '제주도', '제주'] },
];

// 주소 문자열에서 시·도 키 추출
function sidoOf(address) {
  const s = String(address || '');
  for (const sd of SIDO) {
    for (const a of sd.aliases) {
      if (s.includes(a)) return sd.key;
    }
  }
  return null;
}

// 주소에서 시/군/구 추출 (예: "경기도 광주시 태전동..." → "광주시")
function sigunguOf(address) {
  const s = String(address || '');
  // 북구·중구처럼 한 글자 + 구 형태도 잡아야 하므로 {1,10}
  const m = s.match(/([가-힣]{1,10}(?:시|군|구))/g);
  if (!m) return null;
  // 시·도 표기 자체(서울특별시 등)는 제외
  const skip = new Set(SIDO.flatMap((x) => x.aliases));
  for (const t of m) {
    if (!skip.has(t)) return t;
  }
  return null;
}

// 주소 → 정확 비교용 키 (시도|시군구|도로명|건물번호)
//   "경기도 광주시 태봉로 8-4 2층"  → "경기|광주시|태봉로|8-4"
//   "경기 광주시 태봉로 8-4 2층"    → "경기|광주시|태봉로|8-4"  (같은 키)
//   층·호수·상호명이 뒤에 붙어도 무시된다.
// 도로명이 없으면 지번(동+번지)으로 대체. 둘 다 없으면 null(정확 비교 불가).
export function addressKey(address) {
  const s = String(address || '').trim();
  if (!s) return null;
  const sido = sidoOf(s);
  const sigungu = sigunguOf(s);

  const road = s.match(/([가-힣A-Za-z0-9]+(?:대로|로|길))\s*(\d+(?:-\d+)?)/);
  if (road) return [sido || '', sigungu || '', road[1], road[2]].join('|');

  const jibun = s.match(/([가-힣]+(?:동|읍|면|리))\s*(\d+(?:-\d+)?)/);
  if (jibun) return [sido || '', sigungu || '', jibun[1], jibun[2]].join('|');

  return null;
}

// 매장명 → 텍스트 매칭용 토큰
//   "태전갈비 경기광주태전점" → ["태전갈비경기광주태전점","태전갈비"]
// ⚠️ 업종명(갈비·칼국수 등)은 절대 떼지 않는다. "태전갈비"에서 "태전"만 남기면
//    "태전동"이 들어간 모든 글이 우리 매장 글로 오인된다.
export function buildStoreNameTokens(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const out = new Set();
  const squash = (x) => x.replace(/\s+/g, '');

  const full = squash(raw);
  if (full.length >= 3) out.add(full);

  // 공백 기준 첫 토큰(핵심 상호명)
  const first = raw.split(/\s+/)[0] || '';
  if (first.length >= 3) out.add(squash(first));

  // 지점 접미사만 제거 (업종명은 유지)
  const noBranch = raw.replace(/\s*[가-힣A-Za-z0-9]*(?:본점|직영점|점)\s*$/, '').trim();
  if (noBranch && squash(noBranch).length >= 3) out.add(squash(noBranch));

  return [...out];
}

// 매장 주소 → 판정 기준
export function parseStoreRegion(address) {
  const sido = sidoOf(address);
  const sigungu = sigunguOf(address);
  // 경기 광주시처럼 시·도 별칭이 애매한 경우를 위해 자체 토큰도 만들어 둔다
  const own = new Set();
  if (sido) {
    const sd = SIDO.find((x) => x.key === sido);
    if (sd) sd.aliases.forEach((a) => own.add(a));
  }
  if (sigungu) {
    own.add(sigungu);
    const bare = sigungu.replace(/(시|군|구)$/, '');
    if (bare.length >= 2) own.add(bare);
  }
  return { sido, sigungu, ownTokens: [...own] };
}

// ---------------------------------------------------------------- 위젯 파싱
// 네이버 스마트에디터 장소(플레이스) 위젯에서 placeId·주소를 뽑는다.
// 두 가지 마크업을 모두 지원:
//   1) <a class="se-map-info" data-linkdata='{"placeId":"...","address":"..."}'>
//   2) <script class="__se_module_data" data-module='{"type":"v2_map","data":{"places":[{...}]}}'>
export function extractPlaceWidgets(html) {
  const out = [];
  const seen = new Set();
  const push = (placeId, address, name) => {
    const key = `${placeId || ''}|${address || ''}`;
    if (!address && !placeId) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ placeId: placeId ? String(placeId) : null, address: address || null, name: name || null });
  };

  // 1) data-linkdata (작은따옴표 속성)
  const linkRe = /data-linktype=["']map["'][^>]*data-linkdata='([^']+)'/g;
  let m;
  while ((m = linkRe.exec(html))) {
    try {
      const d = JSON.parse(decodeEntities(m[1]));
      push(d.placeId, d.address, d.name);
    } catch { /* 무시 */ }
  }

  // 2) __se_module_data 의 v2_map
  const modRe = /class="__se_module_data"[^>]*data-module(?:-v2)?='([^']+)'/g;
  while ((m = modRe.exec(html))) {
    const raw = decodeEntities(m[1]);
    if (!raw.includes('v2_map')) continue;
    try {
      const d = JSON.parse(raw);
      const places = (d && d.data && d.data.places) || [];
      for (const p of places) push(p.placeId, p.address, p.name);
    } catch { /* 무시 */ }
  }

  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x3D;/g, '=')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// HTML → 본문 텍스트(태그·스크립트 제거)
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- 판정 로직
export function judge({ html, title, store }) {
  const widgets = extractPlaceWidgets(html || '');

  // ── 1) 플레이스 위젯 = 확정 신호.
  //    위젯이 우리 매장(place_id 또는 정확 주소)과 일치하면 ok,
  //    일치하지 않으면 같은 시/군/구라도 명백히 다른 사업장이므로 excluded.
  //    ⚠️ "같은 시/군/구면 ok" 같은 완화 폴백은 두지 않는다(경쟁사 오탐의 원인).
  if (widgets.length > 0) {
    // (a) 매장 place_id와 같은 위젯 → 확실히 우리 글
    if (store.placeId && widgets.some((w) => w.placeId && String(w.placeId) === String(store.placeId))) {
      return { verdict: 'ok', reason: 'widget_place_id', address: null };
    }

    // (b) 정확 주소 일치(층·호수·상호 표기 차이는 무시) → 우리 글
    if (store.addressKey) {
      const match = widgets.find((w) => w.address && addressKey(w.address) === store.addressKey);
      if (match) return { verdict: 'ok', reason: 'widget_address_match', address: match.address };
    }

    // (c) 위젯이 있는데 우리 매장으로 확인되지 않음.
    //     우리 매장을 식별할 수단(place_id 또는 파싱된 정확 주소)이 있으면
    //     이 위젯은 다른 사업장 확정 → 같은 시/군/구여도 제외한다.
    if (store.placeId || store.addressKey) {
      const other = widgets.find((w) => w.address) || widgets[0];
      return { verdict: 'excluded', reason: 'widget_store_mismatch', address: (other && other.address) || null };
    }

    // (d) 매장을 식별할 수단이 전혀 없어(주소 파싱 불가 + place_id 없음) 위젯 비교가
    //     불가능한 경우에만, 잘못 제외하지 않도록 아래 텍스트 판정으로 넘어간다.
  }

  // ── 2) 텍스트 판정: 매장명 > 우리 지역 > 다른 지역
  const text = `${title || ''} ${htmlToText(html)}`;
  const squashed = text.replace(/\s+/g, '');

  // (a) 매장 이름이 언급되면 우리 글 (정확 일치·띄어쓰기 변형만 인정)
  const nameHit = (store.nameTokens || []).find((t) => t && squashed.includes(t));
  if (nameHit) {
    return { verdict: 'ok', reason: 'text_store_name', matched: nameHit };
  }

  // (b) 우리 지역명은 있지만 매장 이름이 없음 → 같은 동네 다른 가게로 보고 제외.
  //     (체험단 특성상 우리 매장 글은 상호명/플레이스 링크가 거의 항상 포함되므로,
  //      매장명 단서가 없으면 우리 글일 가능성이 낮다는 정책 변경.)
  if (store.ownTokens.some((t) => t && text.includes(t))) {
    return { verdict: 'excluded', reason: 'own_region_no_store_name' };
  }

  // (c) 다른 시·도명이 명시돼 있으면 확정 불일치
  const others = [];
  for (const sd of SIDO) {
    if (sd.key === store.sido) continue;
    if (sd.aliases.some((a) => text.includes(a))) others.push(sd.key);
  }
  if (others.length > 0) {
    return { verdict: 'excluded', reason: 'text_other_region', regions: others };
  }

  // (d) 아무 단서도 없음 → 매장명/지역 단서가 전혀 없으면 우리 글로 보기 어려워 제외.
  return { verdict: 'excluded', reason: 'no_region_signal' };
}

// ---------------------------------------------------------------- 본문 fetch
function parseBlogUrl(url) {
  const s = String(url || '');
  let m = s.match(/blog\.naver\.com\/PostView\.n(?:aver|hn)\?.*?blogId=([^&]+).*?logNo=(\d+)/i);
  if (m) return { blogId: m[1], postId: m[2] };
  m = s.match(/(?:m\.)?blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (m) return { blogId: m[1], postId: m[2] };
  return null;
}

async function fetchBlogHtml(blogId, postId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://m.blog.naver.com/${blogId}/${postId}`, {
      headers: { 'User-Agent': BLOG_UA, Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 동시 실행 제한
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- 핸들러
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { storeAddress, storeName, placeId, posts } = body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ ok: false, error: 'posts required' });
    }
    // 매장 주소가 없으면 판정 불가 → 전부 통과시켜 기존 동작 유지
    if (!storeAddress) {
      return res.status(200).json({
        ok: true,
        skipped: 'no_store_address',
        results: posts.map((p) => ({ key: p.key || p.url, verdict: 'ok', reason: 'no_store_address' })),
      });
    }

    const region = parseStoreRegion(storeAddress);
    const store = {
      ...region,
      placeId: placeId || null,
      addressKey: addressKey(storeAddress),
      nameTokens: buildStoreNameTokens(storeName),
    };

    const results = await mapLimit(posts.slice(0, 60), CONCURRENCY, async (p) => {
      const key = p.key || p.url;
      const parsed = parseBlogUrl(p.url);
      if (!parsed) {
        // 네이버 블로그가 아니면 판정 대상 아님 → 통과
        return { key, verdict: 'ok', reason: 'not_naver_blog' };
      }
      const html = await fetchBlogHtml(parsed.blogId, parsed.postId);
      if (html == null) {
        // 본문을 못 읽은 건 시스템 오류 → 오탐 제외 방지 위해 통과(ok) 유지.
        return { key, verdict: 'ok', reason: 'fetch_failed' };
      }
      const v = judge({ html, title: p.title, store });
      return { key, ...v };
    });

    return res.status(200).json({
      ok: true,
      store: {
        sido: region.sido,
        sigungu: region.sigungu,
        addressKey: store.addressKey,
        nameTokens: store.nameTokens,
      },
      results,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
