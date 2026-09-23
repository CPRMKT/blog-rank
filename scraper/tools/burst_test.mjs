// 즉시조회(신규 키워드 등록) 페이스 안전 간격 검증용 버스트 테스트.
// 프론트와 같은 경로(Vercel /api/place-search)로 소량 연속 조회만 하고 저장은 하지 않는다(데이터 무영향).
// 사용: node tools/burst_test.mjs --delay=5000 --n=15 --label=burst5
// 로그: /var/log/blog-rank-scraper/burst-test.log  (요약 1줄 + 0곳 발생 시 키워드별 1줄)
import fs from 'fs';
import { execSync } from 'child_process';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const DELAY = parseInt(arg('delay', '5000'), 10);
const N = parseInt(arg('n', '15'), 10);
const LABEL = arg('label', `burst${DELAY / 1000}s`);
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const LOG = '/var/log/blog-rank-scraper/burst-test.log';

const ts = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const log = (m) => { const line = `[${ts()} KST] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 정기 크론이 도는 중인지(겹침 조건 기록용)
const cronRunning = () => { try { execSync('pgrep -f "[c]ollectPlace.mjs"', { stdio: 'ignore' }); return true; } catch { return false; } };

async function main() {
  const res = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
    body: JSON.stringify({ action: 'list_all_place_tracking', data: {} }),
  }).then((r) => r.json());
  const all = [...new Set(((res && res.result) || []).map((p) => p.keyword))].sort();
  if (all.length < N) { log(`${LABEL}: 키워드 부족(${all.length})`); return; }
  // 날짜에 따라 시작 위치를 옮겨 매번 다른 키워드 묶음을 쓴다(특정 키워드 편향 방지)
  const doy = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86400000);
  const off = (doy * N) % all.length;
  const kws = Array.from({ length: N }, (_, i) => all[(off + i) % all.length]);

  const overlap = cronRunning();
  const t0 = Date.now();
  let zero = 0, fail = 0, small = 0;
  for (const kw of kws) {
    const s = Date.now();
    try {
      const d = await fetch(`${BASE}/api/place-search?keyword=${encodeURIComponent(kw)}&count=300`).then((r) => r.json());
      const n = (d.items || []).length;
      if (!d.ok) { fail++; log(`${LABEL} ✗ "${kw}" ${String(d.error).slice(0, 60)}`); }
      else if (n === 0) { zero++; log(`${LABEL} ⚠ "${kw}" 0곳 (${Date.now() - s}ms)`); }
      else if (n < 100) small++;
    } catch (e) { fail++; log(`${LABEL} ✗ "${kw}" ${String(e.message).slice(0, 60)}`); }
    await sleep(DELAY);
  }
  const perKw = ((Date.now() - t0) / 1000 / N).toFixed(1);
  log(`${LABEL} 요약 | 대기 ${DELAY / 1000}초 | ${N}건 | 키워드당 ${perKw}초 | 0곳 ${zero} | 실패 ${fail} | 소량(<100) ${small} | 크론겹침 ${overlap ? 'O' : 'X'}`);
}
main();
