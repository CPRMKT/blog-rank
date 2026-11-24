// 텔레그램 알림 — 배너를 아무도 보지 않아 며칠간 문제가 방치된 일(2026-09-24~28) 재발 방지.
//
// 토큰이 없으면 로그만 남기고 조용히 넘어간다(설정 전에도 코드가 안전하게 돌아야 한다).
// .env 에 아래 두 줄이 들어오면 그때부터 실제 발송된다:
//   TELEGRAM_BOT_TOKEN=...   (BotFather에서 발급)
//   TELEGRAM_CHAT_ID=...     (봇에게 아무 말이나 보낸 뒤 tools/telegram_setup.mjs 로 확인)
//
// 규칙
//  - 정상일 때는 아무것도 보내지 않는다.
//  - 하루 최대 3통. 같은 종류(kind)는 하루 1통만(브라우저 재기동 반복 시 도배 방지).
//  - 종류: place-held(0곳 30%↑) / place-notrun(미수집 2일 연속) / errors / browser / cron / weekly
//  - 주간 요약(월요일)은 상한과 별개로 1통 보낸다(kind='weekly', force).
import fs from 'fs';

const STATE = '/var/log/blog-rank-scraper/notify-state.json';
const DAILY_MAX = 3;

const kst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s.date === kst()) return s;
  } catch {}
  return { date: kst(), sent: 0, kinds: [] };
}
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }

/**
 * @param {string} kind  알림 종류(같은 종류는 하루 1통). 예: 'place-held', 'errors', 'browser', 'cron'
 * @param {string} text  본문
 * @param {{force?: boolean}} opt  force=true 면 상한·중복 규칙을 무시(주간 요약용)
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function notify(kind, text, opt = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const st = readState();

  let skip = null;
  if (!opt.force) {
    if (st.kinds.includes(kind)) skip = '오늘 같은 종류 이미 발송';
    else if (st.sent >= DAILY_MAX) skip = `하루 상한 ${DAILY_MAX}통 도달`;
  }
  // 드라이런(NOTIFY_DRY=1): 실제로 보내지 않고, 보낼 내용과 '보냈을지'만 출력한다. 상태 파일도 안 건드린다.
  if (process.env.NOTIFY_DRY === '1') {
    console.log(`[notify:dry] ${skip ? '보내지 않음(' + skip + ')' : '보낼 것'} kind=${kind}\n${text}`);
    return { sent: false, dry: true, wouldSend: !skip, reason: skip || undefined, kind, text };
  }
  if (skip) return { sent: false, reason: skip };
  if (!token || !chat) {
    console.log(`[notify] (토큰 미설정 — 발송 생략) ${kind}: ${text.split('\n')[0]}`);
    return { sent: false, reason: '토큰 미설정' };
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      console.log(`[notify] 발송 실패(${r.status}) ${j && j.description ? j.description : ''}`);
      return { sent: false, reason: `발송 실패 ${r.status}` };
    }
    if (!opt.force) { st.sent++; st.kinds.push(kind); writeState(st); }
    console.log(`[notify] 발송 ${kind}`);
    return { sent: true };
  } catch (e) {
    console.log(`[notify] 발송 오류: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

/** 수집 배치 1회분 결과를 보고 보낼지 판단한다(조건에 안 걸리면 조용히 넘어간다). */
export const HELD_PCT_ALERT = parseInt(process.env.HELD_PCT_ALERT || '10', 10);

// ── 0곳 보류 '평소' 기준(2026-11-24) ──
// 아침·저녁 회차는 키워드 수가 달라 보류 건수도 다르다(아침 9~14 / 저녁 7~11) → 같은 회차끼리 비교한다.
// 기준 = 최근 7일(오늘 제외) 같은 회차 '완료' 줄의 0곳보류 중앙값. 로그에 이미 있는 줄만 읽는다(별도 상태 없음).
// '크게 넘음' = 중앙값의 2배 이상 그리고 10건 이상 많음. 기준 회차가 3개 미만이면 예전 비율 규칙(10%)으로 본다.
export const PLACE_LOG = process.env.PLACE_COLLECT_LOG || '/var/log/blog-rank-scraper/place-collect.log';
export const slotOf = (hhmm) => (Number(String(hhmm).slice(0, 2)) < 16 ? 'am' : 'pm');
export function heldBaselineFrom(text, slot, today, days = 7) {
  const from = new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  const vals = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d):\d\d KST\] 완료 — 키워드 \d+, 저장 \d+, 에러 \d+, 0곳보류 (\d+)/);
    if (!m || m[1] >= today || m[1] < from || slotOf(m[2]) !== slot) continue;
    vals.push(Number(m[3]));
  }
  if (vals.length < 3) return { median: null, n: vals.length };
  const v = vals.sort((a, b) => a - b), h = v.length >> 1;
  return { median: v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2, n: v.length };
}
export function heldBaseline(slot, today = kst()) {
  try {
    const st = fs.statSync(PLACE_LOG); const len = Math.min(st.size, 3000000);
    const buf = Buffer.alloc(len); const fd = fs.openSync(PLACE_LOG, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    return heldBaselineFrom(buf.toString('utf8'), slot, today);
  } catch { return { median: null, n: 0 }; }
}
export const heldIsHigh = (held, base, total) => (base && base.median != null)
  ? held >= base.median * 2 && held - base.median >= 10
  : (total > 0 && held > 0 && Math.round((held / total) * 100) >= HELD_PCT_ALERT);

/**
 * 수집 회차 결과를 보고 알릴지 정한다(2026-11-24 개정 — 사장님 지시).
 * 알리는 경우(이것만): ① 상한에 걸려 '오늘 한 번도 수집 못 한' 키워드가 1개 이상 ② 에러 1건 이상
 *                    ③ 0곳 보류가 평소(최근 7일 같은 회차 중앙값)보다 크게 많음.
 * 실행 상한 도달 자체는 알리지 않는다 — 저녁 회차는 아침에 다 받은 키워드를 다시 도는 회차라 매일 상한에 걸리는 게 정상.
 * (백업 실패·과거 행 수 감소는 place_backup_watch.mjs, 카나리 실패는 아래에서 따로 알린다.)
 * summary: keywords, saved, errors, failed[], zeroHeld, aborted, remaining, notRunStreak, tracked?, limitH?, heldBase?, slot?
 */
export async function notifyBatchResult(label, summary, opt = {}) {
  // 카나리 실패는 처리 건수가 0이라 아래 규칙에 안 걸린다 → 따로 먼저 본다.
  if (summary && summary.canaryFail) {
    const txt = (summary.canary || []).map((c) => `${c.keyword}: ${c.n < 0 ? '에러' : c.n + '곳'}`).join(' / ');
    return await notify('canary', [`🚨 ${label} 중단 — 대조 키워드 점검 실패`, txt,
      '네이버가 정상 목록을 주지 않습니다. 저장은 한 건도 하지 않았습니다.', '할 일: 다음 회차도 실패하면 수집 방식 점검이 필요합니다.', '', kst()].join('\n'), opt);
  }
  const total = summary.keywords || 0;
  const held = summary.zeroHeld || 0;
  const errors = summary.errors || 0;
  const remaining = summary.remaining || 0;
  const streak = summary.notRunStreak || 0;
  if (!total && !remaining) return;
  const pre = /블로그/.test(label) ? 'blog' : 'place';
  const slotName = summary.slot === 'pm' ? '저녁' : '아침';

  const lines = [];
  let kind = null;
  if (summary.aborted && remaining > 0) {
    lines.push(`• 미수집 ${remaining}개: 실행 상한(${summary.limitH || '?'}시간)에 걸려 오늘 한 번도 수집하지 못한 키워드${summary.tracked ? ` (추적 ${summary.tracked}개 중)` : ''}`);
    lines.push(streak >= 2
      ? `  할 일: ${streak}일 연속입니다 — 키워드 수가 하루 수집 용량을 넘었습니다. 상한 상향이나 키워드 정리를 정해 주세요.`
      : `  할 일: 없음 — 다음 회차가 이 ${remaining}개부터 먼저 수집합니다(이틀 연속이면 저녁 상한 자동 상향).`);
    kind = `${pre}-notrun`;
  }
  if (errors > 0) {
    const f = summary.failed || [];
    lines.push(`• 수집 실패 ${errors}/${total}건${f.length ? ` (${f.slice(0, 3).join(', ')}${f.length > 3 ? ' 외 ' + (f.length - 3) + '개' : ''})` : ''}`);
    lines.push('  할 일: 다음 회차에서도 실패하면 서버 점검을 요청하세요. 실패한 키워드의 기존 순위는 그대로 남아 있습니다.');
    kind = kind || `${pre}-errors`;
  }
  const base = summary.heldBase || null;
  if (held && heldIsHigh(held, base, total)) {
    lines.push(base && base.median != null
      ? `• 0곳 보류 ${held}건: 평소(최근 7일 ${slotName} 회차 중앙값 ${base.median}건)보다 크게 많음`
      : `• 0곳 보류 ${held}/${total}건 (${Math.round((held / total) * 100)}%)`);
    lines.push('  할 일: 네이버 응답 제한 의심 — 다음 회차도 많으면 수집 간격 조정을 검토하세요. 보류된 키워드의 기존 순위는 보존됩니다.');
    kind = kind || `${pre}-held`;
  }
  if (!lines.length) return;

  return await notify(kind,
    [`⚠️ ${label} — 확인 필요`, ...lines, '', `처리 ${total}개 · 저장 ${summary.saved || 0}건 · ${kst()}`].join('\n'), opt);
}
