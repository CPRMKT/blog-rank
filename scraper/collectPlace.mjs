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
// 백오프 횟수는 제한하지 않는다. 횟수로 끊으면(기존 3회) 키워드가 늘어난 만큼
// 매번 뒤쪽이 통째로 굶는다(2026-11 기준 358개 중 143개 미수집).
// 대신 총 실행 시간에 상한을 두고, 넘으면 안전하게 멈춘다.
const RUN_LIMIT_BASE = parseInt(process.env.PLACE_RUN_LIMIT_MS || String(10 * 60 * 60 * 1000), 10);
// 저녁 회차 자동 상향: '오늘 미수집'이 이틀 연속 생기면 하루 1회 갱신이 깨지는 중이므로
// 저녁 상한을 4시간 → 6시간으로 늘린다(아침 8시간 회차는 건드리지 않는다).
const EVENING_LIMIT_MS = 4 * 60 * 60 * 1000;
const EVENING_RAISED_MS = 6 * 60 * 60 * 1000;
let RUN_LIMIT_MS = RUN_LIMIT_BASE;
// 카나리: 회차 시작 전에 대조 키워드를 조회해 '네이버가 정상 목록을 주는지'를 먼저 확인한다.
// 2026-10-30~11-09에 잘못된 GraphQL을 잡아 11일 동안 아무도 모르게 오염된 값이 저장됐다.
// 기준 미달이면 그 회차는 시작하지 않는다(저장 없음 — 한 건도 건드리지 않고 멈추는 게 안전하다).
const CANARY_KWS = String(process.env.PLACE_CANARY_KEYWORDS || '동래 맛집,해운대 맛집').split(',').map((x) => x.trim()).filter(Boolean);
const CANARY_MIN = parseInt(process.env.PLACE_CANARY_MIN || '10', 10);
const backoffMin = () => Math.max(1, Math.round(BACKOFF_MS / 60000));
const LOG_DIR = '/var/log/blog-rank-scraper';
const FAIL_LOG = `${LOG_DIR}/failures.log`; // 실패 전용 로그(스크립트 공통)
const LAST_FILE = `${LOG_DIR}/place-last-collected.json`;   // 키워드 -> 마지막 수집일(KST)

// 키워드별 마지막 수집일. 파일이 없으면 기존 로그에서 복원한다(첫 실행에도 정렬이 되도록).
function loadLastCollected() {
  try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch {}
  const map = {};
  try {
    const txt = fs.readFileSync(`${LOG_DIR}/place-collect.log`, 'utf8');
    for (const line of txt.split('\n')) {
      // 예: [2026-11-09 08:12:03 KST]   • "부산 사직 맛집" -> 300곳 x 계정 1개 저장
      const d = line.match(/^\[(\d{4}-\d{2}-\d{2}) /);
      const k = line.match(/\u2022 "([^"]+)"/);
      if (d && k) map[k[1]] = d[1];
    }
  } catch {}
  return map;
}
// held-<date>.json: 그 날짜 '마지막' 회차의 결과. 없으면 null(모름)을 돌려준다.
function readHeld(date) {
  try { return JSON.parse(fs.readFileSync(`${LOG_DIR}/held-${date}.json`, 'utf8')); } catch { return null; }
}
function notRunCount(date) {
  const j = readHeld(date);
  if (!j) return null;
  return Array.isArray(j.notRun) ? j.notRun.length : 0;
}
const shiftDate = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

function saveLastCollected(map) {
  try { fs.writeFileSync(LAST_FILE, JSON.stringify(map)); } catch {}
}

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
  // 앞 회차가 아직 돌고 있으면 시작하지 않는다. 다만 프로세스가 죽어 락만 남은 경우
  // (OOM·재부팅·강제종료) 그대로 두면 이후 모든 회차가 영구히 종료되므로 확인 후 정리한다.
  if (fs.existsSync(LOCK)) {
    let alive = false;
    try {
      const pid = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    } catch {}
    // 락이 12시간보다 오래됐으면 살아 있어도 비정상으로 본다(상한 8h/4h보다 길다)
    let tooOld = false;
    try { tooOld = Date.now() - fs.statSync(LOCK).mtimeMs > 12 * 60 * 60 * 1000; } catch {}
    if (alive && !tooOld) { log(`이미 실행 중(lock). 종료.`); process.exit(0); }
    log(`남아 있던 락 정리 (${alive ? '12시간 초과' : '프로세스 없음'})`);
    logFail('place', '[락]', `스테일 락 정리 — ${alive ? '12시간 초과' : '프로세스 없음'}`);
    try { fs.unlinkSync(LOCK); } catch {}
  }
  fs.writeFileSync(LOCK, String(process.pid));

  // 실행 날짜는 시작 시점으로 고정한다. 6시간 상향 시 자정을 넘길 수 있고,
  // 그때 kstDate()를 다시 부르면 다음 날 파일을 덮어써 화면 표시가 어긋난다.
  const runDate = kstDate();
  if (RUN_LIMIT_BASE === EVENING_LIMIT_MS) {
    const a = notRunCount(runDate);               // 오늘 아침 회차
    const b = notRunCount(shiftDate(runDate, 1)); // 어제 마지막 회차
    if (a > 0 && b > 0) {
      RUN_LIMIT_MS = EVENING_RAISED_MS;
      log(`미수집 2일 연속(오늘 ${a}건 / 어제 ${b}건) -> 저녁 실행 상한 4시간 -> 6시간 자동 상향`);
      logFail('place', '[상한]', `미수집 2일 연속(오늘 ${a} / 어제 ${b}) — 저녁 상한 4h→6h 자동 상향`);
    }
  }

  let lastMapRef = null;
  const summary = { keywords: 0, saved: 0, errors: 0, failed: [], zeroHeld: 0, heldKws: [], backoffs: 0, aborted: false, remaining: 0, notRun: [], canary: null, canaryFail: false };
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
    const lastMapPeek = loadLastCollected();   // 카나리 실패 시 '오늘 미수집' 판정에 쓴다
    const scrapeOnce = async (keyword) => {
      const endpoint = `${SCRAPER}/place-search?keyword=${encodeURIComponent(keyword)}&count=300`;
      const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${SCRAPER_KEY}` } });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `스크래퍼 ${resp.status}`);
      return data.items || [];
    };
    // ── 카나리 ── 저장하지 않는다. 한 건이라도 기준을 넘으면 통과.
    const canary = [];
    for (const ck of CANARY_KWS) {
      try { const r = await scrapeOnce(ck); canary.push({ keyword: ck, n: r.length }); }
      catch (e) { canary.push({ keyword: ck, n: -1, error: e.message.slice(0, 120) }); }
      await sleep(KEYWORD_DELAY_MS);
    }
    summary.canary = canary;
    const canaryText = canary.map((c) => `"${c.keyword}" ${c.n < 0 ? '에러(' + c.error + ')' : c.n + '곳'}`).join(' / ');
    if (!canary.some((c) => c.n >= CANARY_MIN)) {
      summary.canaryFail = true;
      summary.aborted = true;
      summary.notRun = [...byKeyword.keys()].filter((k) => lastMapPeek[k] !== today);
      summary.remaining = summary.notRun.length;
      log(`🚨 카나리 실패 — ${canaryText} (기준 ${CANARY_MIN}곳 이상). 이번 회차는 시작하지 않는다(저장 0건).`);
      logFail('place', '[카나리]', `회차 중단 — ${canaryText} / 기준 ${CANARY_MIN}곳 (date=${today})`);
      return;   // finally에서 held 파일·알림 처리
    }
    log(`카나리 통과 — ${canaryText}`);

    let zeroStreak = 0;            // 연속 0곳 카운터(정상 응답 1건이면 0으로 리셋)
    const totalKw = byKeyword.size;
    const startedAt = Date.now();

    // 마지막 수집일이 오래된 키워드부터 돈다. 중간에 멈춰도 다음 회차에서 그 뒤가 먼저 처리돼
    // 같은 키워드가 계속 굶지 않는다(한 번도 수집 안 된 키워드가 맨 앞).
    const lastMap = lastMapPeek;
    lastMapRef = lastMap;
    const ordered = [...byKeyword.entries()].sort((a, b) => {
      const la = lastMap[a[0]] || '';
      const lb = lastMap[b[0]] || '';
      if (la !== lb) return la < lb ? -1 : 1;
      return a[0] < b[0] ? -1 : 1;
    });
    const queue = ordered.map(([k]) => k);
    log(`처리 순서: 마지막 수집일 오래된 순 (한 번도 수집 안 된 키워드 ${queue.filter((k) => !lastMap[k]).length}개 우선)`);
    let idx = -1;
    for (const [keyword, owners] of ordered) {
      idx++;
      // 총 실행 시간 상한: 넘으면 남은 키워드는 다음 회차(오래된 순이라 다음에 먼저 처리됨)
      if (Date.now() - startedAt > RUN_LIMIT_MS) {
        summary.aborted = true;
        // 이번 회차에서 처리 못 했어도 오늘 아침 회차가 이미 수집했으면 '오늘 미수집'이 아니다.
        // (저녁 회차는 매일 60~70개를 못 돌지만 아침이 전부 돌았으므로 하루 1회 갱신은 지켜진다)
        const rest = queue.slice(idx);
        summary.notRun = rest.filter((k) => lastMap[k] !== today);
        summary.remaining = summary.notRun.length;
        log(`  \u25a0 총 실행 시간 ${Math.round(RUN_LIMIT_MS / 3600000)}시간 초과 -> 안전 중단(이번 회차 미처리 ${rest.length}개 중 오늘 한 번도 수집 안 된 것 ${summary.remaining}개)`);
        logFail('place', '[중단]', `실행 시간 상한 초과 — 미처리 ${rest.length}개(오늘 미수집 ${summary.remaining}개) (date=${today})`);
        break;
      }
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
            // 쉬고 나면 남은 시간이 있어야 의미가 있다. 상한을 넘길 것 같으면 지금 멈춘다.
            if (Date.now() - startedAt + BACKOFF_MS > RUN_LIMIT_MS) {
              summary.aborted = true;
              summary.keywords--;   // 이 키워드는 처리하지 못했으므로 진행 수에서 뺀다(다음 크론 몫)
              summary.notRun = queue.slice(idx);
              summary.remaining = summary.notRun.length;
              log(`  \u25a0 대기하면 실행 시간 상한을 넘김 -> 안전 중단(남은 ${summary.remaining}개는 다음 수집에서 먼저 처리)`);
              logFail('place', '[중단]', `대기 시 실행 시간 상한 초과 — 남은 ${summary.remaining}개 다음 크론으로 (date=${today})`);
              break;
            }
            summary.backoffs++;
            const leftMin = Math.round((RUN_LIMIT_MS - (Date.now() - startedAt)) / 60000);
            log(`  \u23f8 0곳 ${zeroStreak}건 연속 -> ${backoffMin()}분 대기 후 이어서 진행 (백오프 ${summary.backoffs}회째, 진행 ${summary.keywords}/${totalKw}, 남은 시간 ${leftMin}분)`);
            logFail('place', '[백오프]', `0곳 ${zeroStreak}건 연속 — ${backoffMin()}분 대기 (${summary.backoffs}회째, 진행 ${summary.keywords}/${totalKw}, date=${today})`);
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
        lastMap[keyword] = today;   // 다음 회차 정렬 기준
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
      + (summary.aborted ? `, 중단(미수집 ${summary.remaining}개)` : ''));
    if (summary.zeroHeld > 0) {
      log(`⚠ 0곳 보류(${summary.zeroHeld}): ${summary.heldKws.slice(0, 15).join(', ')}${summary.heldKws.length > 15 ? ' 외 ' + (summary.heldKws.length - 15) + '개' : ''} — 기존 스냅샷 보존됨`);
      logFail('place', '[요약]', `0곳 보류 ${summary.zeroHeld}건 (date=${today}) — 연속 다발 시 차단 의심`);
    }
    if (summary.errors > 0) {
      log(`⚠ 실패 키워드(${summary.errors}): ${summary.failed.slice(0, 20).join(', ')}${summary.failed.length > 20 ? ' 외 ' + (summary.failed.length - 20) + '개' : ''}`);
      logFail('place', `[요약]`, `실패 ${summary.errors}/${summary.keywords}건 (date=${today})`);
    }
    if (summary.remaining > 0) {
      logFail('place', '[요약]', `오늘 미수집 ${summary.remaining}건 (date=${runDate}) — 다음 회차에서 먼저 처리`);
    }
    // 미수집 연속 일수(오늘 = 이번 회차 결과, 그 전은 파일). 알림·상향 판단의 근거.
    {
      let streak = summary.remaining > 0 ? 1 : 0;
      if (streak) {
        for (let i = 1; i <= 7; i++) {
          const n = notRunCount(shiftDate(runDate, i));
          if (n == null || n === 0) break;
          streak++;
        }
      }
      summary.notRunStreak = streak;
      if (streak >= 2) log(`⚠ 미수집 ${streak}일 연속 — 하루 1회 갱신이 깨지는 중`);
    }
    // [백필 게이트] 플레이스 백필 시작 조건을 매 회차 한 줄로 남긴다 — 사장님이 충족 시점을 한눈에 보도록.
    {
      const need = 3;   // 2026-11-14 결정: 7일 → 3일로 완화
      const days = [];
      for (let i = 0; i < need; i++) {
        const d = shiftDate(runDate, i);
        const j = i === 0
          ? { notRun: summary.notRun, total: summary.keywords, held: summary.heldKws.length }
          : readHeld(d);
        if (!j) { days.push({ d, ok: false, why: '기록 없음' }); continue; }
        const nr = Array.isArray(j.notRun) ? j.notRun.length : (j.remaining || 0);
        const total = j.total || 0;
        const held = j.held != null ? j.held : (Array.isArray(j.keywords) ? j.keywords.length : 0);
        const pct = total ? (held / total) * 100 : null;
        days.push({ d, ok: nr === 0 && pct != null && pct < 5, nr, pct });
      }
      const okDays = days.filter((x) => x.ok).length;
      const todayPct = summary.keywords ? Math.round((summary.heldKws.length / summary.keywords) * 1000) / 10 : 0;
      const line = `백필 게이트 — 조건 충족 ${okDays}/${need}일 (오늘: 미수집 ${summary.remaining}건, 보류율 ${todayPct}%) => ${okDays >= need ? '충족 — 플레이스 백필 시작 가능' : '미충족'}`;
      log(line);
      logFail('place', '[게이트]', line);
    }
    if (summary.keywords > 0 && summary.errors >= Math.max(5, summary.keywords * 0.3)) {
      log(`🚨 실패율 ${Math.round((summary.errors / summary.keywords) * 100)}% — 스크래퍼/네트워크 점검 필요 (${FAIL_LOG} 참고)`);
    }
  } catch (e) {
    log(`치명적 오류: ${e.message}`);
    process.exitCode = 1;
  } finally {
    // 정상 종료·예외 모두에서 한 번 판단한다(조건에 안 걸리면 조용히 넘어간다).
    try { await notifyBatchResult('플레이스 순위 수집', summary); } catch {}
    // 오늘 보류된 키워드 목록을 파일로 남긴다 — 화면에서 '-'(미노출)와 구분해 "보류"로 표시하는 근거.
    // failures.log는 꼬리 80줄만 읽히므로 186건 같은 대량 보류를 담지 못한다 → 날짜별 파일로 따로 둔다.
    try {
      fs.writeFileSync(`${LOG_DIR}/held-${runDate}.json`,
        JSON.stringify({ date: runDate, at: new Date().toISOString(), keywords: summary.heldKws,
          aborted: summary.aborted, remaining: summary.remaining, notRun: summary.notRun,
          total: summary.keywords, saved: summary.saved, held: summary.heldKws.length,
          canary: summary.canary, canaryFail: summary.canaryFail,
          limitMs: RUN_LIMIT_MS, raised: RUN_LIMIT_MS !== RUN_LIMIT_BASE }));
    } catch {}
    try { if (lastMapRef) saveLastCollected(lastMapRef); } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main();
