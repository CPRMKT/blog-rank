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
  const cache = new Map();
  let done = 0, skip = 0;
  for (const p of rows) {
    if (!p.store_id) { skip++; continue; }
    if (!cache.has(p.store_id)) {
      const rr = await db('get_store_rankings', { store_id: p.store_id, days: 14 });
      cache.set(p.store_id, (rr && rr.result) || []);
    }
    // 검증일 이후 가장 최근 수집분에서 그 키워드의 실제 순위(없으면 0=미노출)
    const hit = cache.get(p.store_id)
      .filter((r) => r.keyword === p.keyword && r.checked_date >= p.target_date)
      .sort((a, b) => (a.checked_date < b.checked_date ? 1 : -1))[0];
    if (!hit) { skip++; continue; }
    await db('set_prediction_verified', { id: p.id, verified_rank: hit.rank || 0 });
    done++;
    log(`  #${p.id} "${p.keyword}" 예측 ${p.probability}% → 실제 ${hit.rank > 0 ? hit.rank + '위' : '미노출'} (${hit.checked_date})`);
  }
  const acc = await db('get_prediction_accuracy');
  log(`검증 완료 ${done}건 / 보류 ${skip}건` + (acc && acc.ok && acc.sample ? ` | 최근 30일 적중률 ${acc.accuracy}% (표본 ${acc.sample})` : ''));
}
main().catch((e) => { log('오류: ' + e.message); process.exit(1); });
