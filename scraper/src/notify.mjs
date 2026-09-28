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

  if (!opt.force) {
    if (st.kinds.includes(kind)) return { sent: false, reason: '오늘 같은 종류 이미 발송' };
    if (st.sent >= DAILY_MAX) return { sent: false, reason: `하루 상한 ${DAILY_MAX}통 도달` };
  }
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
export async function notifyBatchResult(label, summary) {
  const total = summary.keywords || 0;
  const held = summary.zeroHeld || 0;
  const errors = summary.errors || 0;
  if (!total) return;

  const heldPct = Math.round((held / total) * 100);
  const lines = [];
  if (held && heldPct >= 30) lines.push(`0곳 보류 ${held}/${total}건 (${heldPct}%) — 네이버 응답 없음`);
  if (errors >= 10) lines.push(`수집 실패 ${errors}/${total}건`);
  if (summary.aborted) lines.push(`백오프 소진으로 중단 — 남은 ${summary.remaining}개는 다음 수집`);
  if (!lines.length) return;

  await notify(held && heldPct >= 30 ? 'place-held' : 'errors',
    [`⚠️ ${label} 점검 필요`, ...lines, '', `저장 ${summary.saved || 0}건 · ${kst()}`].join('\n'));
}
