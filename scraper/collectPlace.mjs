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
const RETRY_DELAY_MS = 8000;   // 키워드 실패 시 1회 재시도 전 대기
const FAIL_LOG = '/var/log/blog-rank-scraper/failures.log'; // 실패 전용 로그(스크립트 공통)

function log(msg) {
  const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  console.log(`[${ts} KST] ${msg}`);
}
// 실패 전용 로그: 나중에 "이 매장/키워드만 계속 안 됨"을 사람이 스크린샷 없이 파악하는 용도
function logFail(script, keyword, reason) {
  const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  try { fs.appendFileSync(FAIL_LOG, `[${ts} KST] ${script} ✗ "${keyword}" ${String(reason).replace(/\n[\s\S]*/, '')}\n`); } catch {}
}
function kstDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbCall(action, data = {}) {
  const resp = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
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

  const summary = { keywords: 0, saved: 0, errors: 0, failed: [] };
  try {
    log(`플레이스 순위 수집 시작 (date=${kstDate()})`);
    // 전 계정의 (owner_id, keyword) 페어. 계정별로 순위를 별도 저장.
    const trackRes = await dbCall('list_all_place_tracking').catch(() => null);
    const pairs = (trackRes && trackRes.result) || []; // [{owner_id, keyword}]
    // 스크래핑은 키워드 단위로 1번만(같은 키워드를 여러 계정이 추적해도 재사용) → 계정별로 저장만 반복
    const byKeyword = new Map(); // keyword -> [owner_id, ...]
    for (const p of pairs) {
      if (!p || !p.owner_id || !p.keyword) continue;
      const arr = byKeyword.get(p.keyword) || [];
      arr.push(p.owner_id);
      byKeyword.set(p.keyword, arr);
    }
    log(`추적 키워드 ${byKeyword.size}개 / 계정×키워드 ${pairs.length}건`);

    const today = kstDate();
    const scrapeOnce = async (keyword) => {
      const endpoint = `${SCRAPER}/place-search?keyword=${encodeURIComponent(keyword)}&count=300`;
      const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${SCRAPER_KEY}` } });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `스크래퍼 ${resp.status}`);
      return data.items || [];
    };
    for (const [keyword, owners] of byKeyword) {
      summary.keywords++;
      try {
        let items;
        try {
          items = await scrapeOnce(keyword);
        } catch (e1) {
          // 1회 재시도: 일시 오류(브라우저 재기동 직후·네트워크 순단)를 그 자리에서 흡수
          log(`  ↻ "${keyword}" 1차 실패(${e1.message.slice(0, 80)}) → ${RETRY_DELAY_MS / 1000}초 후 재시도`);
          await sleep(RETRY_DELAY_MS);
          items = await scrapeOnce(keyword);
        }
        // 자체점검: 결과가 비정상적으로 적으면(네이버가 가끔 축소 결과셋을 주는 변형 응답,
        // "사직역 맛집" 64곳 사건) 1회 재수집해서 더 큰 쪽을 채택. 진짜 소도시 키워드는 재시도해도 같음.
        if (items.length > 0 && items.length < 100) {
          await sleep(RETRY_DELAY_MS);
          try {
            const again = await scrapeOnce(keyword);
            if (again.length > items.length * 1.5) {
              log(`  ⚠ "${keyword}" 결과 ${items.length}곳 → 재수집 ${again.length}곳 (축소 응답 감지, 큰 쪽 채택)`);
              items = again;
            }
          } catch { /* 재수집 실패 시 1차 결과 유지 */ }
        }
        // 이 키워드를 추적하는 각 계정에 대해 owner별로 저장
        for (const owner_id of owners) {
          await dbCall('save_place_rankings', { keyword, owner_id, checked_date: today, rows: items });
          summary.saved++;
        }
        log(`  • "${keyword}" → ${items.length}곳 × 계정 ${owners.length}개 저장`);
      } catch (e) {
        summary.errors++;
        summary.failed.push(keyword);
        log(`  ✗ "${keyword}" 에러: ${e.message}`);
        logFail('place', keyword, e.message);
      }
      await sleep(KEYWORD_DELAY_MS);
    }
    log(`완료 — 키워드 ${summary.keywords}, 저장 ${summary.saved}, 에러 ${summary.errors}`);
    if (summary.errors > 0) {
      log(`⚠ 실패 키워드(${summary.errors}): ${summary.failed.slice(0, 20).join(', ')}${summary.failed.length > 20 ? ' 외 ' + (summary.failed.length - 20) + '개' : ''}`);
      logFail('place', `[요약]`, `실패 ${summary.errors}/${summary.keywords}건 (date=${today})`);
    }
    if (summary.keywords > 0 && summary.errors >= Math.max(5, summary.keywords * 0.3)) {
      log(`🚨 실패율 ${Math.round((summary.errors / summary.keywords) * 100)}% — 스크래퍼/네트워크 점검 필요 (${FAIL_LOG} 참고)`);
    }
  } catch (e) {
    log(`치명적 오류: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main();
