// 크론이 시작조차 안 했거나 끝나지 않은 경우를 잡아 알린다.
// 로그의 "시작"/"완료" 줄만 본다(별도 상태 저장 없음).
//
// 사용: node tools/cron_watchdog.mjs
// 크론 예시(수집이 끝났어야 할 시각에 점검):
//   30 12 * * * ... node tools/cron_watchdog.mjs >> /var/log/blog-rank-scraper/watchdog.log 2>&1
//   30 22 * * * ... node tools/cron_watchdog.mjs >> /var/log/blog-rank-scraper/watchdog.log 2>&1
import fs from 'fs';
import { notify } from '../src/notify.mjs';

const LOG_DIR = '/var/log/blog-rank-scraper';
const kstDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const kstHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(new Date()));

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

// 아직 크론이 돌 시간이 아닌데 점검하면 전부 "시작 기록 없음"이 된다 → 오전 11시 전에는 판단하지 않는다.
if (kstHour() < 11) { console.log(`[${new Date().toISOString()}] 너무 이른 시각(${kstHour()}시) — 판단 생략`); process.exit(0); }

// 플레이스 수집 예정 횟수(하루 2회 → 분할안 적용 시 4로 바꾼다)
const PLACE_RUNS = parseInt(process.env.PLACE_RUNS_PER_DAY || '2', 10);

const today = kstDate();
const linesToday = (file) => tail(`${LOG_DIR}/${file}`).split('\n').filter((l) => l.includes(today));

function check(label, file, startPat, donePat) {
  const ls = linesToday(file);
  const started = ls.filter((l) => l.includes(startPat)).length;
  const done = ls.filter((l) => l.includes(donePat)).length;
  return { label, started, done };
}

const results = [
  check('블로그 순위 수집', 'collect.log', '수집 시작', '완료 — 매장'),
  check('플레이스 순위 수집', 'place-collect.log', '플레이스 순위 수집 시작', '완료 — 키워드'),
];

// 저녁 점검(18시 이후)이면 그날 예정된 실행이 모두 끝나 있어야 한다.
const evening = kstHour() >= 18;
const problems = [];
for (const r of results) {
  if (r.started === 0) problems.push(`${r.label}: 오늘 시작 기록 없음`);
  else if (r.done < r.started) problems.push(`${r.label}: 시작 ${r.started}회 / 완료 ${r.done}회 — 끝나지 않은 실행 있음`);
  else if (evening && r.label.includes('플레이스') && r.done < PLACE_RUNS) problems.push(`${r.label}: 오늘 ${r.done}회만 완료(예정 ${PLACE_RUNS}회)`);
}

if (!problems.length) {
  console.log(`[${new Date().toISOString()}] 크론 정상 — ${results.map((r) => `${r.label} ${r.done}/${r.started}`).join(', ')}`);
  process.exit(0);
}
console.log(`[${new Date().toISOString()}] 문제: ${problems.join(' / ')}`);
await notify('cron', ['⚠️ 수집 크론 점검 필요', ...problems, '', `${today} 기준`].join('\n'));
