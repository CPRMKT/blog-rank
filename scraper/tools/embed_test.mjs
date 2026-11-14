// 임베드 점검 — 네이버로는 한 건도 요청하지 않는다(전부 우리 서버 호출).
//   node tools/embed_test.mjs            점검만
//   node tools/embed_test.mjs --store=34 그 매장으로 발급·재발급까지 실제로 돌려본다(끝나면 원래 상태로 되돌린다)
//
// 확인 항목: 헤더/CSP, 토큰 형식, 없는 토큰과 꺼진 토큰의 응답이 같은지, 토큰으로 쓰기 액션이
// 막히는지, 다른 매장 id를 섞어도 그 매장 데이터만 나오는지, 재발급 직후 옛 토큰이 바로 막히는지.
const BASE = (process.env.COLLECTOR_BASE_URL || 'https://blog-rank-phi.vercel.app').replace(/\/$/, '');
const arg = (k, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const STORE = parseInt(arg('store', '0'), 10);

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}${extra ? ' — ' + extra : ''}`); } };

const db = async (action, data = {}, headers = {}) => {
  const r = await fetch(`${BASE}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(60000),
  });
  let j = null; try { j = JSON.parse(await r.text()); } catch {}
  return { status: r.status, body: j, cache: r.headers.get('cache-control') };
};
const cron = (action, data = {}) => db(action, data, { 'x-cron-secret': process.env.CRON_SECRET || '' });

console.log(`■ 임베드 점검 — ${BASE}\n`);

// 1) 페이지 헤더
{
  console.log('1. 임베드 페이지 헤더');
  const r = await fetch(`${BASE}/api/embed?token=x`, { signal: AbortSignal.timeout(30000) });
  const csp = r.headers.get('content-security-policy') || '';
  ok(r.status === 200, `페이지 응답 200 (실제 ${r.status})`);
  ok(/frame-ancestors/.test(csp), `CSP frame-ancestors 있음`, csp.slice(0, 80));
  ok(!/frame-ancestors[^;]*\*/.test(csp), 'frame-ancestors에 와일드카드 없음', csp.slice(0, 80));
  ok((r.headers.get('referrer-policy') || '') === 'no-referrer', 'Referrer-Policy: no-referrer');
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'Cache-Control: no-store');
  ok(/noindex/.test(r.headers.get('x-robots-tag') || ''), 'X-Robots-Tag: noindex');
  ok(!r.headers.get('x-frame-options'), 'X-Frame-Options 없음(있으면 frame-ancestors보다 먼저 막힌다)');
  const html = await r.text();
  ok(!/addEventListener\(\s*['"]message['"]/.test(html), '부모 메시지를 듣는 코드 없음');
  ok(!/postMessage\([^)]*,\s*['"]\*['"]/.test(html), 'postMessage 와일드카드(*) 없음');
  ok(!/place-search|m\.place\.naver|search\.naver/.test(html), '네이버로 가는 호출 없음');
  console.log(`     허용 도메인: ${(csp.match(/frame-ancestors(.*)/) || [,''])[1].trim()}`);
}

// 2) 토큰 없는/형식 틀린/없는 토큰 — 응답이 모두 같아야 한다
{
  console.log('\n2. 잘못된 토큰 응답');
  const short = await db('embed_data', { token: 'abc' });
  const none = await db('embed_data', { token: 'Zz'.repeat(20) });
  ok(short.status === 200 && short.body && short.body.ok === false, '짧은 토큰 → 거부');
  ok(JSON.stringify(short.body) === JSON.stringify(none.body), '짧은 토큰과 없는 토큰의 응답이 완전히 같음(존재 여부 노출 안 함)',
    JSON.stringify(none.body));
  ok(/no-store/.test(short.cache || ''), '임베드 응답에 Cache-Control: no-store');
}

// 3) 임베드 토큰으로 쓰기 액션 — 서버에 닿지 못해야 한다
{
  console.log('\n3. 토큰으로 쓰기 시도');
  for (const a of ['save_place_rankings', 'add_store_place_keyword', 'delete_store_place_keyword', 'create_order']) {
    const r = await db(a, { token: 'Zz'.repeat(20), store_id: 1, keyword: '테스트', rows: [] });
    ok(r.status === 401, `${a} → 401 거부 (실제 ${r.status})`);
  }
  const adm = await db('embed_admin', { op: 'get', store_id: 1 });
  ok(adm.status === 401 || adm.status === 403, `embed_admin(로그인 없이) → 거부 (실제 ${adm.status})`);
}

// 4) 발급·격리·재발급 (--store= 를 준 경우만)
if (STORE) {
  console.log(`\n4. 매장 ${STORE} 발급 → 격리 → 재발급`);
  const before = await cron('embed_admin', { op: 'get', store_id: STORE });
  if (before.body && before.body.setup_needed) {
    console.log('  ⏸ embed_tokens 테이블이 아직 없습니다. sql/2026-11-14_embed_tokens.sql 실행 후 다시 돌리세요.');
  } else {
    const hadToken = before.body && before.body.result ? before.body.result.token : null;
    const iss = await cron('embed_admin', { op: 'issue', store_id: STORE });
    const t1 = iss.body && iss.body.result && iss.body.result.token;
    ok(!!t1 && t1.length >= 32, `토큰 발급 (${t1 ? t1.length : 0}자, 32자 이상)`);
    ok(/^[A-Za-z0-9_-]+$/.test(t1 || ''), '토큰 문자 구성 안전(URL에 그대로 쓸 수 있음)');

    const d1 = await db('embed_data', { token: t1 });
    ok(d1.body && d1.body.ok, '발급한 토큰으로 조회됨');
    const name = d1.body && d1.body.store && d1.body.store.name;
    console.log(`     매장: ${name} / 플레이스 키워드 ${(d1.body.placeKeywords || []).length}개 / 블로그 키워드 ${(d1.body.blogKeywords || []).length}개`);
    const keys = Object.keys(d1.body || {});
    ok(!keys.some((k) => ['owner_id', 'place_id', 'id'].includes(k)), '응답에 내부 식별자(owner_id 등) 없음', keys.join(','));

    // 다른 매장 id를 섞어도 토큰이 가리키는 매장만 나와야 한다
    const d2 = await db('embed_data', { token: t1, store_id: STORE + 1 });
    ok(d2.body && d2.body.ok && d2.body.store.name === name, '요청에 다른 매장 id를 넣어도 같은 매장만 나옴');

    // 재발급 → 옛 토큰 즉시 거부
    const rot = await cron('embed_admin', { op: 'rotate', store_id: STORE });
    const t2 = rot.body && rot.body.result && rot.body.result.token;
    ok(!!t2 && t2 !== t1, '재발급으로 새 토큰 생성');
    const old = await db('embed_data', { token: t1 });
    ok(old.body && old.body.ok === false, '재발급 직후 옛 토큰 즉시 거부');
    ok(JSON.stringify(old.body) === JSON.stringify((await db('embed_data', { token: 'Zz'.repeat(20) })).body),
      '꺼진 토큰과 없는 토큰의 응답이 같음');
    const neo = await db('embed_data', { token: t2 });
    ok(neo.body && neo.body.ok, '새 토큰으로는 조회됨');

    // 끄기
    const off = await cron('embed_admin', { op: 'disable', store_id: STORE });
    ok(off.body && off.body.ok, '끄기 동작');
    const afterOff = await db('embed_data', { token: t2 });
    ok(afterOff.body && afterOff.body.ok === false, '끈 직후 바로 거부');

    if (hadToken) console.log('     (점검 전 켜져 있던 토큰이 있었습니다 — 필요하면 화면에서 다시 발급하세요)');
  }
} else {
  console.log('\n4. 발급·재발급 점검은 건너뜀 (--store=<매장id> 를 주면 실제로 돌려봅니다)');
}

console.log(`\n=== 통과 ${pass} / 실패 ${fail} ===`);
process.exit(fail ? 1 : 0);
