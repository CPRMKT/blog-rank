// 수집 점검(cron_watchdog) — 크론이 시작조차 안 했거나 멈춘 경우, 그리고 스크래퍼가 예정보다 많이 재시작된 경우만 알린다.
// 네이버를 조회하지 않는다. 서버의 로그 파일 3가지만 읽는다(별도 상태 저장 없음).
//   ① 수집 로그(collect.log / place-collect.log)의 "시작"/"완료" 줄과 마지막 줄 시각
//   ② pm2 로그(~/.pm2/pm2.log)의 스크래퍼 재시작 줄
//   ③ 서버 저장소의 HEAD 이동 기록(.git/logs/HEAD) — 오늘 배포(git pull) 횟수
//
// 크론(2026-11-25 승인 — 12:30 / 22:40):
//   30 12 * * * ... node tools/cron_watchdog.mjs >> /var/log/blog-rank-scraper/watchdog.log 2>&1
//   40 22 * * * ... node tools/cron_watchdog.mjs >> /var/log/blog-rank-scraper/watchdog.log 2>&1
//
// 판단 규칙
//  - 회차가 '시작 기록 없음' → 알림.
//  - 시작했지만 '완료' 줄이 없음: 마지막 로그 줄이 STALE_MIN(기본 50분) 안이면 진행 중(정상),
//    그보다 오래됐으면 멈춤 → 알림. (백오프 대기가 35분이라 그보다 길게 잡는다.)
//  - 플레이스는 18:40 이후 점검이면 저녁 회차까지 PLACE_RUNS(기본 2)회 시작돼 있어야 한다.
//  - 재시작: 오늘 재시작 수가 '정기 1회(05:50) + 오늘 배포 횟수'를 넘거나,
//    명령 없이 죽었다 살아난 재시작이 있으면 알림.
//
// 시험(드라이런): NOTIFY_DRY=1 이면 보내지 않고 보낼 내용만 출력한다(알림 상태 파일도 안 건드림).
//   가짜 입력은 WATCHDOG_LOG_DIR / WATCHDOG_PM2_LOG / WATCHDOG_REFLOG / WATCHDOG_NOW(ISO 시각)로 넣는다.
import fs from 'fs';
import { notify } from '../src/notify.mjs';

const LOG_DIR = process.env.WATCHDOG_LOG_DIR || '/var/log/blog-rank-scraper';
const PM2_LOG = process.env.WATCHDOG_PM2_LOG || `${process.env.PM2_HOME || '/root/.pm2'}/pm2.log`;
const REFLOG = process.env.WATCHDOG_REFLOG || '/opt/blog-rank/.git/logs/HEAD';
const NOW = process.env.WATCHDOG_NOW ? new Date(process.env.WATCHDOG_NOW) : new Date();
const STALE_MIN = parseInt(process.env.WATCHDOG_STALE_MIN || '50', 10);
const PLACE_RUNS = parseInt(process.env.PLACE_RUNS_PER_DAY || '2', 10);   // 하루 플레이스 회차 수
const APP = 'blog-rank-scraper';

const kstDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
const kstMin = (d) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(d).split(':').map(Number);
  return (h % 24) * 60 + m;
};
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// 꼬리만 읽는다(로그가 커도 안전)
function tail(p, max = 400000) {
  try {
    const st = fs.statSync(p);
    const len = Math.min(max, st.size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

const today = kstDate(NOW);
const nowMin = kstMin(NOW);
const stamp = `[${today} ${hm(nowMin)} KST]`;

// 아직 크론이 돌 시간이 아닌데 점검하면 전부 "시작 기록 없음"이 된다 → 오전 11시 전에는 판단하지 않는다.
if (nowMin < 11 * 60) { console.log(`${stamp} 너무 이른 시각 — 판단 생략`); process.exit(0); }

// ── ① 수집 회차 ──
const TS = /^\[(\d{4}-\d\d-\d\d) (\d\d):(\d\d):\d\d KST\]/;
function check(label, file, startPat, donePats, expected) {
  const all = tail(`${LOG_DIR}/${file}`).split('\n');
  const ls = all.filter((l) => l.startsWith(`[${today} `));
  const started = ls.filter((l) => l.includes(startPat)).length;
  const done = ls.filter((l) => donePats.some((p) => l.includes(p))).length;
  let lastMin = null;   // 오늘 마지막 로그 줄 시각(분)
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i].match(TS);
    if (m) { if (m[1] === today) lastMin = Number(m[2]) * 60 + Number(m[3]); break; }
  }
  const idle = lastMin == null ? null : nowMin - lastMin;
  let problem = null, state;
  if (started < expected) {
    problem = started === 0 ? `${label}: 오늘 시작 기록 없음` : `${label}: 오늘 ${started}회만 시작(지금까지 예정 ${expected}회)`;
    state = '미시작';
  } else if (done < started) {
    if (idle != null && idle <= STALE_MIN) state = `진행 중(마지막 기록 ${idle}분 전)`;
    else { problem = `${label}: 끝나지 않은 채 ${idle == null ? '?' : idle}분째 기록 없음 — 멈춘 것으로 보임`; state = '멈춤'; }
  } else state = '완료';
  return { label, started, done, expected, state, problem };
}

const placeExpected = nowMin >= 18 * 60 + 40 ? PLACE_RUNS : 1;
const runs = [
  check('블로그 순위 수집', 'collect.log', '수집 시작', ['완료 — 매장'], 1),
  check('플레이스 순위 수집', 'place-collect.log', '플레이스 순위 수집 시작', ['완료 — 키워드', '카나리 실패'], placeExpected),
];

// ── ② 재시작 ──
// pm2 로그의 "starting in" 1줄 = 재시작 1회. 바로 앞 10초 안에 "Stopping app" 이 있으면 명령에 의한 재시작,
// 없으면 스스로 죽었다가 pm2가 되살린 것(비정상)으로 본다. pm2 로그 시각은 서버 시간(KST).
const restarts = [];
{
  const P = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d): PM2 log: (.*)$/;
  let lastStop = -1e9;
  for (const l of tail(PM2_LOG, 2000000).split('\n')) {
    const m = l.match(P);
    if (!m || m[1] !== today) continue;
    const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    const msg = m[5];
    if (msg.startsWith(`Stopping app:${APP} `)) lastStop = sec;
    else if (msg.startsWith(`App [${APP}:`) && msg.includes('starting in')) {
      const min = Math.floor(sec / 60);
      const commanded = sec - lastStop <= 10;
      restarts.push({ min, commanded, daily: commanded && min >= 5 * 60 + 50 && min <= 5 * 60 + 52 });
    }
  }
}
const deploys = [];
for (const l of tail(REFLOG, 200000).split('\n')) {
  const m = l.match(/> (\d{9,11}) [+-]\d{4}\t(.*)$/);
  if (!m) continue;
  const d = new Date(Number(m[1]) * 1000);
  if (kstDate(d) === today) deploys.push({ min: kstMin(d) });
}
const dailyDone = restarts.some((r) => r.daily) ? 1 : 0;
const allowed = dailyDone + deploys.length;
const crashes = restarts.filter((r) => !r.commanded);
const extra = restarts.filter((r) => !r.daily);
const restartProblems = [];
if (restarts.length > allowed) {
  restartProblems.push(`• 재시작 ${restarts.length}회: 정기 ${dailyDone}회 + 오늘 배포 ${deploys.length}회보다 많음`);
  restartProblems.push(`  정기 외 재시작 시각: ${extra.map((r) => hm(r.min) + (r.commanded ? '' : '(스스로 종료)')).join(', ') || '-'}`
    + ` / 배포 시각: ${deploys.map((d) => hm(d.min)).join(', ') || '없음'}`);
}
if (crashes.length) restartProblems.push(`• 명령 없이 죽었다 다시 뜬 재시작 ${crashes.length}회: ${crashes.map((r) => hm(r.min)).join(', ')}`);

const runProblems = runs.filter((r) => r.problem).map((r) => r.problem);
console.log(`${stamp} 점검 — ${runs.map((r) => `${r.label} ${r.done}/${r.started}(예정 ${r.expected}) ${r.state}`).join(', ')}`
  + ` / 재시작 ${restarts.length}회(허용 ${allowed}: 정기 ${dailyDone}+배포 ${deploys.length}, 비정상 ${crashes.length})`);

const slot = nowMin < 16 * 60 ? 'am' : 'pm';
if (runProblems.length) {
  await notify(`cron-${slot}`, ['⚠️ 수집 크론 점검 필요', ...runProblems.map((p) => '• ' + p),
    '  할 일: 서버 점검을 요청하세요. 기존 순위 기록은 그대로이고, 다음 회차가 미수집분부터 먼저 수집합니다.',
    '', `${today} ${hm(nowMin)} 기준`].join('\n'));
}
if (restartProblems.length) {
  await notify(`restart-${slot}`, ['⚠️ 스크래퍼 재시작 확인 필요', ...restartProblems,
    '  할 일: 반복되면 서버 메모리·크롬 상태 점검을 요청하세요. 수집 기록은 그대로입니다.',
    '', `${today} ${hm(nowMin)} 기준`].join('\n'));
}
if (!runProblems.length && !restartProblems.length) console.log(`${stamp} 정상 — 알림 없음`);
