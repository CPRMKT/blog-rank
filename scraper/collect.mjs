// collect.mjs — 매일 새벽 순위 자동 수집기 (NCP 크론용)
// index.html 의 checkKeywordRank 로직을 서버 측에서 그대로 재현한다.
//   list_stores → 매장별 list_store_keywords → 키워드별 /api/store-rank
//   → matches[0] 를 save_store_ranking 으로 저장.
// 자격증명(Supabase/스크래퍼)은 이미 Vercel API 가 보유하므로, 이 스크립트는
// 배포된 Vercel API 만 호출한다(서버에 비밀키를 두지 않음).
//
// 환경변수:
//   COLLECTOR_BASE_URL  Vercel 배포 주소 (기본값 아래)
//   DRY_RUN=1           저장하지 않고 결과만 로그 (기본: 저장함)
import fs from 'fs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const LOCK = '/tmp/blog-rank-collect.lock';
const KEYWORD_DELAY_MS = 3000; // store-rank 는 무겁다(스크래퍼+본문). 호출 간 여유.
const STORE_RANK_TIMEOUT_MS = 90000;

function log(msg) {
  const ts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date());
  const line = `[${ts} KST] ${msg}`;
  console.log(line);
}

// Asia/Seoul 기준 오늘 날짜(YYYY-MM-DD) — 서버 TZ 와 무관하게 KST 달력 날짜.
function kstDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(path, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${path}`, { ...options, signal: ctrl.signal });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function dbCall(action, data = {}) {
  return api('/api/db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
    body: JSON.stringify({ action, data }),
  }, 30000);
}

// ── region-check(동명 지역 오탐 판정) ─────────────────────────────
// index.html 의 blogKey 와 동일 규칙(같은 포스트 식별키).
function blogKey(url) {
  const s = String(url || '');
  let m = s.match(/blog\.naver\.com\/([a-zA-Z0-9_-]+)\/(\d+)/);
  if (m) return m[1] + '/' + m[2];
  m = s.match(/blogId=([^&]+).*?logNo=(\d+)/);
  if (m) return m[1] + '/' + m[2];
  return s;
}

const REGION_BATCH = 8; // /api/region-check 배치 크기(서버 concurrency 와 맞춤: 한 요청=한 웨이브)

// 매장 단위 캐시(cache: Map blogKey->verdict)를 채운다. 같은 블로그가 여러 키워드에
// 걸려도 한 번만 판정(중복 본문 fetch 방지). 주소 없으면 판정 불가 → 아무것도 안 채움.
async function fillRegionVerdicts(store, matches, cache) {
  if (!store.address) return;
  const need = [];
  const seen = new Set();
  for (const m of matches) {
    const url = m.link || m.url || '';
    if (!url) continue;
    const k = blogKey(url);
    if (cache.has(k) || seen.has(k)) continue;
    seen.add(k);
    need.push({ key: k, url, title: (m.title || '').replace(/<[^>]+>/g, '') });
  }
  for (let i = 0; i < need.length; i += REGION_BATCH) {
    const batch = need.slice(i, i + REGION_BATCH);
    try {
      const data = await api('/api/region-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeAddress: store.address, storeName: store.name || '', placeId: store.place_id || null, posts: batch }),
      }, 30000);
      if (data && data.ok && Array.isArray(data.results)) {
        for (const r of data.results) {
          if (!r || !r.key) continue;
          if (r.reason === 'fetch_failed') continue; // 일시 실패는 확정 아님 → 캐시 안 함(다음에 재판정)
          cache.set(r.key, r.verdict || 'ok');
        }
      }
    } catch (e) {
      log(`  · region-check 배치 실패: ${e.message}`);
    }
  }
}

async function main() {
  // 중복 실행 방지(락파일)
  if (fs.existsSync(LOCK)) {
    const pid = fs.readFileSync(LOCK, 'utf8').trim();
    log(`이미 실행 중(lock pid=${pid}). 종료.`);
    process.exit(0);
  }
  fs.writeFileSync(LOCK, String(process.pid));

  const summary = { stores: 0, keywords: 0, saved: 0, matched: 0, errors: 0 };
  try {
    log(`수집 시작 (BASE=${BASE}, DRY_RUN=${DRY_RUN}, date=${kstDate()})`);

    const storesRes = await dbCall('list_stores');
    const stores = (storesRes && storesRes.result) || [];
    summary.stores = stores.length;
    log(`매장 ${stores.length}개`);

    for (const store of stores) {
      const kwRes = await dbCall('list_store_keywords', { store_id: store.id });
      const keywords = ((kwRes && kwRes.result) || []).map((k) => k.keyword);
      log(`[매장 ${store.id}] ${store.name} — 키워드 ${keywords.length}개`);
      const rcCache = new Map(); // 매장 내 blogKey->verdict (키워드 간 중복 판정 방지)

      for (const keyword of keywords) {
        summary.keywords++;
        try {
          const params = new URLSearchParams({
            keyword,
            placeId: store.place_id || '',
            storeName: store.name || '',
            count: '30',
          });
          const data = await api(`/api/store-rank?${params.toString()}`, {}, STORE_RANK_TIMEOUT_MS);

          if (!data || !data.ok) {
            summary.errors++;
            log(`  ✗ "${keyword}" 조회 실패: ${data && data.error}`);
            continue;
          }

          const matches = data.matches || [];
          const best = matches.length > 0 ? matches[0] : { rank: 0, link: null, title: null };
          if (best.rank > 0) summary.matched++;
          log(`  • "${keyword}" → ${best.rank > 0 ? best.rank + '위' : '없음'} (검색 ${data.searchCount || data.total || 0}건)`);

          // region-check 판정을 미리 계산해 매장 캐시에 채운다(매장 주소 있을 때).
          await fillRegionVerdicts(store, matches, rcCache);

          if (!DRY_RUN) {
            await dbCall('save_store_ranking', {
              store_id: store.id,
              owner_id: store.owner_id || null,   // 크론: 매장 소유자 지정
              keyword,
              checked_date: kstDate(),
              rank: best.rank,
              matched_blog_url: best.link || null,
              matched_title: (best.title || '').replace(/<[^>]+>/g, '') || null,
              search_volume: data.total || null,
              // 매칭된 블로그 전부 저장 (다중 블로그 추적) + region-check verdict
              matches: matches.map((m) => {
                const url = m.link || m.url || '';
                return {
                  rank: m.rank,
                  url,
                  title: (m.title || '').replace(/<[^>]+>/g, ''),
                  verdict: rcCache.get(blogKey(url)) || null, // 판정 못 하면 null(프론트 폴백)
                };
              }),
            });
            summary.saved++;
          }
        } catch (e) {
          summary.errors++;
          log(`  ✗ "${keyword}" 에러: ${e.message}`);
        }
        await sleep(KEYWORD_DELAY_MS);
      }
    }

    log(`완료 — 매장 ${summary.stores}, 키워드 ${summary.keywords}, 매칭 ${summary.matched}, 저장 ${summary.saved}, 에러 ${summary.errors}${DRY_RUN ? ' (DRY_RUN: 저장 안 함)' : ''}`);
  } catch (e) {
    log(`치명적 오류: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main();
