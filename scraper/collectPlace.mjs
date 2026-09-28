// collectPlace.mjs — 매일 새벽 플레이스 키워드 순위 자동 수집기 (NCP 크론용)
// 추적 키워드(place_keywords)별로 로컬 스크래퍼(/place-search)로 1~50위를 받아
// Vercel /api/db(save_place_rankings)로 Supabase에 저장한다.
//
// 환경변수:
//   COLLECTOR_BASE_URL  Vercel 배포 주소(기본 아래)
//   SCRAPER_API_KEY     로컬 스크래퍼 Bearer 키 (.env)
import fs from 'fs';
import { notifyBatchResult } from './src/notify.mjs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const SCRAPER = 'http://127.0.0.1:8080';
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const LOCK = '/tmp/blog-rank-place-collect.lock';
// 키워드 사이 대기 11초. 네이버는 키워드당 간격이 ~17초 이하로 30분 넘게 이어지면 빈 목록을 돌려준다
// (9/13~17 간격 19.5~24.4초 → 0곳보류 0건 / 9/18~19 16~17초 → 10~56건). 9/17까지는 DB 저장이
// 10초씩 걸려 자연 간격이 됐지만 인덱스 추가로 1초가 되면서 간격이 사라졌다 → 그 몫을 여기서 명시적으로 준다.
// 목표: 키워드당 ~24초(9/17 검증값). 줄이려면 전체 크론 1회분 규모로 검증할 것.
const KEYWORD_DELAY_MS = 11000;
const RETRY_DELAY_MS = 8000;   // 키워드 "에러"(예외) 시 1회 재시도 전 대기 — 0곳에는 쓰지 않는다
// 0곳 백오프: 네이버 허용량을 소진하면 그 뒤로는 계속 빈 응답이 온다(2026-09-24 사건).
// 이때 즉시 재수집은 요청량만 2배로 늘려 회복을 막으므로, 연속 0곳 3건이면 35분 쉬었다 이어간다.
const ZERO_STREAK_LIMIT = 3;        // 연속 0곳 몇 건이면 백오프할지
const BACKOFF_MS = 35 * 60 * 1000;  // 회복 대기(과거 관측상 약 35분이면 응답 재개)
const BACKOFF_MAX = 3;              // 백오프 최대 횟수. 그 뒤에도 0곳이 이어지면 이번 실행은 중단
const backoffMin = () => Math.max(1, Math.round(BACKOFF_MS / 60000));
const LOG_DIR = '/var/log/blog-rank-scraper';
const FAIL_LOG = `${LOG_DIR}/failures.log`; // 실패 전용 로그(스크립트 공통)

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
    signal: AbortSignal.timeout(45000), // 저장 호출이 매달려 런 전체를 멈추지 않게
  });
  const t = await resp.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!resp.ok) throw new Error(`db ${action} HTTP ${resp.status}: ${t.slice(0, 150)}`);
  return j;
}

// DB 저장 재시도(경량): Supabase 게이트웨이 타임아웃 등 꼬리 지연을 흡수한다.
// 스크랩 결과는 메모리에 있으므로 재스캔 없이 저장 호출만 5초·15초 간격으로 다시 시도.
async function dbSaveWithRetry(action, data, label) {
  const delays = [5000, 15000];
  for (let attempt = 0; ; attempt++) {
    try { return await dbCall(action, data); }
    catch (e) {
      if (attempt >= delays.length) throw e;
      log(`  ↻ ${label} 저장 실패(${String(e.message).slice(0, 60)}) → ${delays[attempt] / 1000}초 후 저장 재시도(${attempt + 1}/${delays.length})`);
      await sleep(delays[attempt]);
    }
  }
}

async function main() {
  if (!SCRAPER_KEY) { log('SCRAPER_API_KEY 없음. 종료.'); process.exit(1); }
  if (fs.existsSync(LOCK)) { log(`이미 실행 중(lock). 종료.`); process.exit(0); }
  fs.writeFileSync(LOCK, String(process.pid));

  const summary = { keywords: 0, saved: 0, errors: 0, failed: [], zeroHeld: 0, heldKws: [], backoffs: 0, aborted: false, remaining: 0 };
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
    let zeroStreak = 0;            // 연속 0곳 카운터(정상 응답 1건이면 0으로 리셋)
    const totalKw = byKeyword.size;
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
        // 자체점검①: 0곳이 연달아 나오면 네이버 허용량 소진으로 보고 쉬었다 간다.
        // (즉시 재수집은 차단 구간에서 요청량만 2배로 늘려 회복을 막으므로 하지 않는다)
        if (items.length === 0) {
          zeroStreak++;
          if (zeroStreak >= ZERO_STREAK_LIMIT) {
            if (summary.backoffs >= BACKOFF_MAX) {
              // 백오프를 다 쓰고도 0곳이 이어짐 → 이번 실행은 여기서 멈추고 나머지는 다음 크론에 맡긴다
              summary.aborted = true;
              summary.keywords--;   // 이 키워드는 처리하지 못했으므로 진행 수에서 뺀다(다음 크론 몫)
              summary.remaining = totalKw - summary.keywords;
              log(`  ■ 0곳 ${zeroStreak}건 연속 + 백오프 ${BACKOFF_MAX}회 소진 → 이번 실행 중단(남은 ${summary.remaining}개는 다음 수집에서)`);
              logFail('place', '[중단]', `백오프 ${BACKOFF_MAX}회 후에도 0곳 연속 — 남은 ${summary.remaining}개 다음 크론으로 (date=${today})`);
              break;
            }
            summary.backoffs++;
            log(`  ⏸ 0곳 ${zeroStreak}건 연속 → ${backoffMin()}분 대기 후 이어서 진행 (백오프 ${summary.backoffs}/${BACKOFF_MAX}, 진행 ${summary.keywords}/${totalKw})`);
            logFail('place', '[백오프]', `0곳 ${zeroStreak}건 연속 → ${backoffMin()}분 대기 (${summary.backoffs}/${BACKOFF_MAX}, 진행 ${summary.keywords}/${totalKw}, date=${today})`);
            await sleep(BACKOFF_MS);
            log(`  ▶ 대기 종료 — "${keyword}"부터 이어서 진행`);
            zeroStreak = 0;
            try { const again = await scrapeOnce(keyword); if (again.length > 0) { log(`  ↻ "${keyword}" 대기 후 ${again.length}곳(회복)`); items = again; } } catch { /* 유지 */ }
          }
        } else {
          zeroStreak = 0;
        }
        // 자체점검②: 재시도 후에도 0곳인데 과거에 정상 데이터가 있던 키워드면 의심 → 저장 보류(기존 스냅샷 보존).
        // 과거에도 늘 0이던 키워드(동래배네스트cc류)만 진짜 0으로 인정하고 기존대로 처리.
        if (items.length === 0) {
          const prev = await dbCall('get_place_snapshot', { keyword }).catch(() => null);
          const prevRows = (prev && prev.result) || [];
          if (prevRows.length > 0) {
            summary.zeroHeld++;
            summary.heldKws.push(keyword);
            log(`  ⚠ "${keyword}" 0곳 응답(기존 ${prev.checked_date} ${prevRows.length}곳 이력) → 저장 보류·스냅샷 보존`);
            logFail('place', keyword, `0곳 응답 — 저장 보류(기존 ${prev.checked_date} ${prevRows.length}곳 보존)`);
            await sleep(KEYWORD_DELAY_MS);
            continue;
          }
        }
        // 자체점검③: 결과가 비정상적으로 적으면(축소 변형 응답, "사직역 맛집" 64곳 사건) 1회 재수집해서 큰 쪽 채택
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
          await dbSaveWithRetry('save_place_rankings', { keyword, owner_id, checked_date: today, rows: items }, `"${keyword}"`);
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
    log(`완료 — 키워드 ${summary.keywords}, 저장 ${summary.saved}, 에러 ${summary.errors}, 0곳보류 ${summary.zeroHeld}`
      + (summary.backoffs ? `, 백오프 ${summary.backoffs}회` : '')
      + (summary.aborted ? `, 중단(남은 ${summary.remaining}개)` : ''));
    if (summary.zeroHeld > 0) {
      log(`⚠ 0곳 보류(${summary.zeroHeld}): ${summary.heldKws.slice(0, 15).join(', ')}${summary.heldKws.length > 15 ? ' 외 ' + (summary.heldKws.length - 15) + '개' : ''} — 기존 스냅샷 보존됨`);
      logFail('place', '[요약]', `0곳 보류 ${summary.zeroHeld}건 (date=${today}) — 연속 다발 시 차단 의심`);
    }
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
    await notifyBatchResult('플레이스 순위 수집', summary);   // 조건에 걸릴 때만 발송
  } finally {
    // 오늘 보류된 키워드 목록을 파일로 남긴다 — 화면에서 '-'(미노출)와 구분해 "보류"로 표시하는 근거.
    // failures.log는 꼬리 80줄만 읽히므로 186건 같은 대량 보류를 담지 못한다 → 날짜별 파일로 따로 둔다.
    try {
      fs.writeFileSync(`${LOG_DIR}/held-${kstDate()}.json`,
        JSON.stringify({ date: kstDate(), at: new Date().toISOString(), keywords: summary.heldKws, aborted: summary.aborted, remaining: summary.remaining }));
    } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main();
