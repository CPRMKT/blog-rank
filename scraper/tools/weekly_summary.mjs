// 월요일 주간 요약 1통 — 지난 7일 수집이 어땠는지 한눈에.
// 정상이어도 보내는 유일한 알림이다(하루 상한과 별개, force).
//
// 사용: node tools/weekly_summary.mjs
// 크론 예시: 0 10 * * 1 ... node tools/weekly_summary.mjs >> /var/log/blog-rank-scraper/watchdog.log 2>&1
import fs from 'fs';
import { notify } from '../src/notify.mjs';

const LOG_DIR = '/var/log/blog-rank-scraper';
const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);

function tail(p, max = 2000000) {
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

const days = Array.from({ length: 7 }, (_, i) => fmt(new Date(Date.now() - (i + 1) * 86400000))).reverse();

// "완료 — 키워드 347, 저장 161, 에러 0, 0곳보류 186"
const placeLines = tail(`${LOG_DIR}/place-collect.log`).split('\n').filter((l) => l.includes('완료 — 키워드'));
const blogLines = tail(`${LOG_DIR}/collect.log`).split('\n').filter((l) => l.includes('완료 — 매장'));

const num = (line, pat) => { const m = line.match(pat); return m ? Number(m[1]) : 0; };
const ofDay = (lines, d) => lines.filter((l) => l.includes(d));

let pSaved = 0, pHeld = 0, pErr = 0, pRuns = 0;
let bSaved = 0, bErr = 0, bRuns = 0;
const worst = [];
for (const d of days) {
  const ps = ofDay(placeLines, d);
  pRuns += ps.length;
  let dayHeld = 0, dayTotal = 0;
  for (const l of ps) {
    pSaved += num(l, /저장 (\d+)/); pErr += num(l, /에러 (\d+)/);
    const h = num(l, /0곳보류 (\d+)/); pHeld += h; dayHeld += h; dayTotal += num(l, /키워드 (\d+)/);
  }
  if (dayTotal && dayHeld / dayTotal >= 0.3) worst.push(`${d.slice(5)} 보류 ${dayHeld}/${dayTotal}`);
  const bs = ofDay(blogLines, d);
  bRuns += bs.length;
  for (const l of bs) { bSaved += num(l, /저장 (\d+)/); bErr += num(l, /에러 (\d+)/); }
}

const lines = [
  `📊 주간 수집 요약 (${days[0].slice(5)}~${days[6].slice(5)})`,
  '',
  `플레이스: ${pRuns}회 실행 · 저장 ${pSaved.toLocaleString()}건 · 보류 ${pHeld.toLocaleString()}건 · 에러 ${pErr}건`,
  `블로그: ${bRuns}회 실행 · 저장 ${bSaved.toLocaleString()}건 · 에러 ${bErr}건`,
];
if (worst.length) lines.push('', '보류가 많았던 날:', ...worst.map((w) => `  ${w}`));
else lines.push('', '지난 주 보류 30% 넘은 날 없음.');

console.log(lines.join('\n'));
await notify('weekly', lines.join('\n'), { force: true });
