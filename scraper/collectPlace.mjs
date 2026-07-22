// collectPlace.mjs — 매일 새벽 플레이스 키워드 순위 자동 수집기 (NCP 크론용)
// 추적 키워드(place_keywords)별로 로컬 스크래퍼(/place-search)로 1~50위를 받아
// Vercel /api/db(save_place_rankings)로 Supabase에 저장한다.
//
// 환경변수:
//   COLLECTOR_BASE_URL  Vercel 배포 주소(기본 아래)
//   SCRAPER_API_KEY     로컬 스크래퍼 Bearer 키 (.env)
import fs from 'fs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const SCRAPER = 'http://127.0.0.1:8080';
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const LOCK = '/tmp/blog-rank-place-collect.lock';
const KEYWORD_DELAY_MS = 4000; // 플레이스 스크래핑은 무겁다(브라우저). 간격 여유.

function log(msg) {
  const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  console.log(`[${ts} KST] ${msg}`);
}
function kstDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbCall(action, data = {}) {
  const resp = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
  const t = await resp.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!resp.ok) throw new Error(`db ${action} HTTP ${resp.status}: ${t.slice(0, 150)}`);
  return j;
}

async function main() {
  if (!SCRAPER_KEY) { log('SCRAPER_API_KEY 없음. 종료.'); process.exit(1); }
  if (fs.existsSync(LOCK)) { log(`이미 실행 중(lock). 종료.`); process.exit(0); }
  fs.writeFileSync(LOCK, String(process.pid));

  const summary = { keywords: 0, saved: 0, errors: 0 };
  try {
    log(`플레이스 순위 수집 시작 (date=${kstDate()})`);
    // 전역 추적 키워드(place_keywords) + 매장별 추적 키워드(store_place_keywords) 합집합
    const [globalRes, storeRes] = await Promise.all([
      dbCall('list_place_keywords').catch(() => null),
      dbCall('list_all_store_place_keywords').catch(() => null),
    ]);
    const globalKws = ((globalRes && globalRes.result) || []).map((k) => k.keyword);
    const storeKws = (storeRes && storeRes.result) || []; // 이미 distinct keyword 문자열 배열
    const keywords = [...new Set([...globalKws, ...storeKws].map((s) => String(s || '').trim()).filter(Boolean))];
    log(`추적 키워드 ${keywords.length}개 (전역 ${globalKws.length} + 매장 ${storeKws.length})`);

    for (const keyword of keywords) {
      summary.keywords++;
      try {
        const endpoint = `${SCRAPER}/place-search?keyword=${encodeURIComponent(keyword)}&count=50`;
        const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${SCRAPER_KEY}` } });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `스크래퍼 ${resp.status}`);
        const items = data.items || [];
        await dbCall('save_place_rankings', { keyword, checked_date: kstDate(), rows: items });
        summary.saved++;
        log(`  • "${keyword}" → ${items.length}곳 저장`);
      } catch (e) {
        summary.errors++;
        log(`  ✗ "${keyword}" 에러: ${e.message}`);
      }
      await sleep(KEYWORD_DELAY_MS);
    }
    log(`완료 — 키워드 ${summary.keywords}, 저장 ${summary.saved}, 에러 ${summary.errors}`);
  } catch (e) {
    log(`치명적 오류: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main();
