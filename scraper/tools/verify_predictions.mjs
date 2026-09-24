// 블로그 진단 예측 검증(주 1회). DB 비교만 하고 네이버 요청은 0건.
// 검증일(target_date)이 지난 예측을 store_rankings의 실제 순위와 대조해 기록한다.
// 매장이 연결되지 않은 예측은 비교 대상이 없어 건너뛴다(로그에 표시).
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' };
const db = (action, data = {}) => fetch(`${BASE}/api/db`, { method: 'POST', headers: H, body: JSON.stringify({ action, data }) }).then((r) => r.json());
const ts = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const log = (m) => console.log(`[${ts()} KST] ${m}`);

async function main() {
  const pend = await db('list_pending_predictions');
  if (!pend || !pend.ok) { log(pend && pend.missing_table ? '예측 테이블 없음 — SQL 실행 전. 종료.' : '예측 목록 조회 실패'); return; }
  const rows = pend.result || [];
  log(`검증 대상 ${rows.length}건`);
  let done = 0, skip = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const p of rows) {
    // 심사한 블로거가 그 키워드로 실제 글을 써서 순위에 잡혔는지 자동 대조
    // (매장 블로그 순위 수집이 이미 매일 그 글의 순위를 기록하고 있다)
    const r = await db('find_blog_keyword_rank', { blog_id: p.blog_id, keyword: p.keyword, since: p.target_date });
    if (r && r.ok && r.found) {
      await db('set_prediction_verified', { id: p.id, verified_rank: r.rank });
      done++;
      log(`  #${p.id} ${p.blog_id} "${p.keyword}" 예측 ${p.probability}% → 실제 ${r.rank}위 (${r.checked_date})`);
      continue;
    }
    // 아직 글이 안 올라온 경우: 검증일 + 21일이 지나면 "글 없음"으로 종결(0 = 미노출)
    const limit = new Date(Date.parse(p.target_date) + 21 * 86400000).toISOString().slice(0, 10);
    if (today > limit) { await db('set_prediction_verified', { id: p.id, verified_rank: 0 }); done++; log(`  #${p.id} ${p.blog_id} "${p.keyword}" 기한 초과 → 미노출로 종결`); }
    else skip++;
  }
  const acc = await db('get_prediction_accuracy');
  log(`검증 완료 ${done}건 / 보류 ${skip}건` + (acc && acc.ok && acc.sample ? ` | 최근 30일 적중률 ${acc.accuracy}% (표본 ${acc.sample})` : ''));
}
main().catch((e) => { log('오류: ' + e.message); process.exit(1); });
