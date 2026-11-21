// 플레이스 순위 일일 증분 백업 + 일별 행 수 감시 (2026-11-22)
// 설계: docs/place-backup-monitor-design-2026-11.md   경위: docs/place-rows-cause-2026-11-14.md
//
//   node --env-file=.env tools/place_backup_watch.mjs                 매일(크론 23:10): 감시 + 증분 백업
//   node --env-file=.env tools/place_backup_watch.mjs --baseline      2026-10-26~11-10 기준 백업(복원 행 포함 확인)
//   node --env-file=.env tools/place_backup_watch.mjs --dates=2026-11-20,2026-11-21   지정 날짜만 백업
//   node --env-file=.env tools/place_backup_watch.mjs --verify=2026-10-26             파일을 다시 풀어 meta·DB 와 대조
//   (공통) --dry : 세기·판정만, 파일을 쓰지 않는다
//
// DB 에는 아무것도 쓰지 않는다(읽기 전용 액션 place_day_counts / export_place_day 만 부른다). 네이버 요청 없음.
// 파일:  /var/backups/blog-rank/daily/place_rankings_<날짜>.jsonl.zst  (+ .meta.json)
// 감시:  /var/log/blog-rank-scraper/place-daycount.jsonl (매 실행 한 줄), place-daycount-alert.json (경보)
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { notify } from '../src/notify.mjs';

const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const DIR = process.env.PLACE_BACKUP_DIR || '/var/backups/blog-rank/daily';
const LOGDIR = '/var/log/blog-rank-scraper';
const COUNT_LOG = path.join(LOGDIR, 'place-daycount.jsonl');
const ALERT = path.join(LOGDIR, 'place-daycount-alert.json');
const KEEP_DAYS = 90;            // 보관·감시 범위
const MAX_NEW_PER_RUN = 10;      // meta 가 아직 없는 옛 날짜는 한 번에 10일씩만 채운다(첫 주에 90일 다 찬다)
const DROP = 0.05;               // 과거 날짜 행·키워드 5% 이상 감소 = 경보
const MIN_FREE_MB = 500;
// 2026-11-21 복원 행 식별(created_at 범위) — 기준 백업에 복원 행이 들어갔는지 세는 데만 쓴다
const RESTORE_AT = ['2026-11-21T13:37:59Z', '2026-11-21T13:40:44Z'];

const arg = (k, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes(`--${k}`);
const DRY = has('dry');
const kst = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(t));
const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
const log = (...a) => console.log(`[${now()} KST]`, ...a);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const fileOf = (d) => path.join(DIR, `place_rankings_${d}.jsonl.zst`);
const metaOf = (d) => path.join(DIR, `place_rankings_${d}.meta.json`);
const readMeta = (d) => { try { return JSON.parse(fs.readFileSync(metaOf(d), 'utf8')); } catch { return null; } };

async function api(action, data, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${BASE}/api/db`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error(`${action} HTTP ${r.status} ${j && j.error ? j.error : ''}`);
      return j;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((s) => setTimeout(s, 3000 * i));
    }
  }
}

// 하루씩 센다(차가운 디스크에서 여러 날을 한 번에 세면 8초 제한에 걸린다)
async function countDay(d) {
  const j = await api('place_day_counts', { from: d, to: d });
  const r = (j.result || [])[0];
  return r ? { rows: Number(r.n_rows), keywords: Number(r.n_keywords) } : { rows: 0, keywords: 0 };
}
async function countRange(days) {
  const out = {}; const q = [...days];
  await Promise.all([0, 1, 2].map(async () => { while (q.length) { const d = q.shift(); out[d] = await countDay(d); } }));
  return out;
}

function freeMB() {
  try { const o = execFileSync('df', ['-Pm', DIR]).toString().trim().split('\n').pop().split(/\s+/); return Number(o[3]); } catch { return null; }
}

// 그날 전체 행을 받아 jsonl.zst + meta. 쓰고 나서 다시 풀어 행 수·sha256 을 대조하고, DB 를 다시 세어 비교한다.
async function exportDay(d, source) {
  const t0 = Date.now();
  fs.mkdirSync(DIR, { recursive: true });
  const part = path.join(DIR, `.place_rankings_${d}.jsonl.part`);
  const fd = fs.openSync(part, 'w');
  const hash = crypto.createHash('sha256');
  let after = 0, rows = 0, restored = 0, minId = null, maxId = null, calls = 0;
  const kws = new Set();
  try {
    for (;;) {
      const j = await api('export_place_day', { date: d, after_id: after, limit: 5000 }); calls++;
      for (const r of j.result) {
        const line = JSON.stringify(r) + '\n';
        fs.writeSync(fd, line); hash.update(line);
        rows++; kws.add(r.keyword);
        if (minId == null || r.id < minId) minId = r.id;
        if (maxId == null || r.id > maxId) maxId = r.id;
        const t = r.created_at ? Date.parse(r.created_at) : NaN;
        if (t >= Date.parse(RESTORE_AT[0]) && t <= Date.parse(RESTORE_AT[1])) restored++;
      }
      if (j.done || !j.result.length) break;
      after = j.last_id;
    }
  } finally { fs.closeSync(fd); }
  const sha = hash.digest('hex');
  const zst = fileOf(d);
  execFileSync('zstd', ['-19', '-q', '-f', '-o', zst + '.part', part]);
  // 다시 풀어 확인
  const back = execFileSync('zstd', ['-dc', zst + '.part'], { maxBuffer: 1 << 30 });
  const backSha = crypto.createHash('sha256').update(back).digest('hex');
  const backRows = back.length ? back.toString('utf8').split('\n').filter(Boolean).length : 0;
  const db = await countDay(d);
  const ok = backSha === sha && backRows === rows && db.rows === rows;
  if (!ok) {
    fs.rmSync(zst + '.part', { force: true }); fs.rmSync(part, { force: true });
    return { date: d, ok: false, rows, backRows, db: db.rows, shaOk: backSha === sha };
  }
  fs.renameSync(zst + '.part', zst); fs.rmSync(part, { force: true });
  const meta = {
    date: d, rows, keywords: kws.size, sha256: sha, zst_bytes: fs.statSync(zst).size, min_id: minId, max_id: maxId,
    restored_rows_2026_11_21: restored, db_rows_at_check: db.rows, made_at: new Date().toISOString(), source, api_calls: calls,
  };
  fs.writeFileSync(metaOf(d), JSON.stringify(meta, null, 1));
  return { ...meta, ok: true, sec: ((Date.now() - t0) / 1000).toFixed(1) };
}

async function verify(d) {
  const m = readMeta(d); if (!m) return { date: d, ok: false, error: 'meta 없음' };
  const back = execFileSync('zstd', ['-dc', fileOf(d)], { maxBuffer: 1 << 30 });
  const sha = crypto.createHash('sha256').update(back).digest('hex');
  const rows = back.toString('utf8').split('\n').filter(Boolean).length;
  const db = await countDay(d);
  return { date: d, ok: sha === m.sha256 && rows === m.rows, file_rows: rows, meta_rows: m.rows, db_rows_now: db.rows, sha_ok: sha === m.sha256 };
}

function lastCountRecord() {
  try {
    const lines = fs.readFileSync(COUNT_LOG, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}

// 과거 날짜가 줄었는지(오늘 날짜는 수집 중이라 제외)
function judge(prev, cur, today) {
  const alerts = [];
  if (!prev) return alerts;
  for (const d of Object.keys(cur).sort()) {
    if (d >= today) continue;
    const p = prev.counts[d]; const c = cur[d];
    if (!p || !p[0]) continue;
    if (c.rows === 0) alerts.push({ date: d, kind: 'zero', from: p[0], to: 0 });
    else if (c.rows < p[0] * (1 - DROP)) alerts.push({ date: d, kind: 'rows', from: p[0], to: c.rows });
    else if (p[1] && c.keywords < p[1] * (1 - DROP)) alerts.push({ date: d, kind: 'keywords', from: p[1], to: c.keywords });
  }
  return alerts;
}

async function daily() {
  const today = kst();
  const days = []; for (let i = KEEP_DAYS - 1; i >= 0; i--) days.push(addDays(today, -i));
  const cur = await countRange(days);
  const prev = lastCountRecord();
  const alerts = judge(prev, cur, today);
  const rec = { at: now(), counts: Object.fromEntries(days.map((d) => [d, [cur[d].rows, cur[d].keywords]])) };
  const fewer = Object.entries(cur).filter(([d, c]) => prev && prev.counts[d] && c.rows < prev.counts[d][0]).length;
  log(`행 수 감시: ${days[0]}~${today} ${days.length}일, 이전 기록 ${prev ? prev.at : '없음(첫 실행)'}, 줄어든 날 ${fewer}, 경보 ${alerts.length}`);
  if (!DRY) fs.appendFileSync(COUNT_LOG, JSON.stringify(rec) + '\n');
  if (alerts.length) {
    const head = alerts.slice(0, 5).map((a) => `${a.date.slice(5)} ${a.kind === 'keywords' ? '키워드 ' : ''}${a.from.toLocaleString()}→${a.to.toLocaleString()}`).join(', ');
    const msg = `⚠ 과거 플레이스 순위 기록이 줄었습니다: ${head}${alerts.length > 5 ? ` 외 ${alerts.length - 5}일` : ''} (직전 기록 ${prev.at})`;
    log('🔴', msg);
    if (!DRY) {
      let old = []; try { old = JSON.parse(fs.readFileSync(ALERT, 'utf8')).alerts || []; } catch {}
      fs.writeFileSync(ALERT, JSON.stringify({ updated: now(), acknowledged: false, alerts: [...old, { at: now(), msg, items: alerts }] }, null, 1));
      try { await notify('place-rows-drop', msg); } catch {}
    }
  }

  // 백업: 오늘 + meta 와 행 수가 달라진 날 + meta 없는 날(최근 것부터 하루 10일까지)
  const free = freeMB();
  if (free != null && free < MIN_FREE_MB) {
    log(`🔴 디스크 여유 ${free}MB < ${MIN_FREE_MB}MB — 백업을 건너뜁니다(감시는 했음)`);
    if (!DRY) try { await notify('backup-disk', `blog-rank 서버 디스크 여유 ${free}MB — 플레이스 백업 중단`); } catch {}
    return;
  }
  const changed = [], missing = [];
  for (const d of [...days].reverse()) {
    if (!cur[d].rows) continue;
    const m = readMeta(d);
    if (!m) missing.push(d); else if (m.rows !== cur[d].rows) changed.push(d);
  }
  const todo = [...new Set([today, ...changed, ...missing.slice(0, MAX_NEW_PER_RUN)])].filter((d) => cur[d] && cur[d].rows);
  log(`백업 대상 ${todo.length}일 (행 수 바뀜 ${changed.length}, 아직 없음 ${missing.length}중 ${Math.min(missing.length, MAX_NEW_PER_RUN)}), 디스크 여유 ${free}MB`);
  await runExports(todo, 'daily');
  retention(today);
}

async function runExports(dates, source) {
  let fail = 0;
  for (const d of dates) {
    if (DRY) { const c = await countDay(d); log(`  (dry) ${d} DB ${c.rows}행 ${c.keywords}키워드`); continue; }
    try {
      const r = await exportDay(d, source);
      if (r.ok) log(`  ✅ ${d} ${r.rows}행 ${r.keywords}키워드 (복원 행 ${r.restored_rows_2026_11_21}) → ${(r.zst_bytes / 1024).toFixed(0)}KB, sha ${r.sha256.slice(0, 12)}…, ${r.sec}초`);
      else { fail++; log(`  ❌ ${d} 대조 실패 — 받은 ${r.rows} / 다시 푼 ${r.backRows} / DB ${r.db} / sha ${r.shaOk ? '일치' : '불일치'} (파일 안 남김)`); }
    } catch (e) { fail++; log(`  ❌ ${d} ${e.message}`); }
  }
  if (fail && !DRY) try { await notify('backup-fail', `플레이스 백업 실패 ${fail}일 — /var/log/blog-rank-scraper/place-backup.log`); } catch {}
  return fail;
}

// 90일 지난 파일: meta sha256 을 다시 대조한 뒤에만 지운다(맞지 않으면 남기고 알린다)
function retention(today) {
  const cut = addDays(today, -KEEP_DAYS);
  let n = 0;
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^place_rankings_(\d{4}-\d{2}-\d{2})\.jsonl\.zst$/);
    if (!m || m[1] >= cut) continue;
    const meta = readMeta(m[1]);
    const back = execFileSync('zstd', ['-dc', fileOf(m[1])], { maxBuffer: 1 << 30 });
    const ok = meta && crypto.createHash('sha256').update(back).digest('hex') === meta.sha256;
    if (!ok) { log(`  ⚠ ${m[1]} 보관 기한 지났지만 sha 불일치 — 지우지 않음`); continue; }
    if (!DRY) { fs.rmSync(fileOf(m[1])); fs.rmSync(metaOf(m[1])); }
    n++;
  }
  if (n) log(`보관 기한(${KEEP_DAYS}일) 지난 파일 ${n}일 정리(sha 대조 후)`);
}

(async () => {
  if (!process.env.CRON_SECRET) { log('CRON_SECRET 없음 — --env-file=.env 로 실행'); process.exit(1); }
  if (has('baseline')) {
    const ds = []; for (let d = '2026-10-26'; d <= '2026-11-10'; d = addDays(d, 1)) ds.push(d);
    log(`기준 백업 2026-10-26~11-10 (${ds.length}일)`);
    process.exitCode = await runExports(ds, 'baseline-2026-11-10') ? 1 : 0;
  } else if (arg('dates')) {
    process.exitCode = await runExports(arg('dates').split(','), 'manual') ? 1 : 0;
  } else if (arg('verify')) {
    for (const d of arg('verify').split(',')) log(JSON.stringify(await verify(d)));
  } else {
    await daily();
  }
})().catch((e) => { log('❌', e.message); process.exit(1); });
