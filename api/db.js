// api/db.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const { action, data } = req.body || {};

  // 인증 모드: 크론 시크릿 or 사용자 세션 토큰. 둘 다 없으면 차단.
  const cronSecret = (req.headers['x-cron-secret'] || '').toString();
  const isCron = !!process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET;
  const authHeader = (req.headers['authorization'] || req.headers['Authorization'] || '').toString();
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!isCron && !userToken) return res.status(401).json({ ok: false, error: '인증이 필요합니다. 다시 로그인해 주세요.' });

  // 계정분리 제외(공용 레거시: 포스팅 순위 조회)는 service_role로.
  const SHARED_ACTIONS = new Set(['save_blogs', 'get_blogs', 'save_posts', 'save_rank', 'get_rank_history']);
  const useServiceRole = isCron || SHARED_ACTIONS.has(action);
  // 사용자 모드: anon key + 사용자 JWT → PostgREST가 RLS(owner_id=auth.uid())로 자동 격리.
  //             insert owner_id는 컬럼 default auth.uid()가 채움(직접 지정 안 함).
  // 크론 모드: service_role(RLS 우회) + owner_id 직접 지정.
  const apikey = useServiceRole ? SERVICE_KEY : ANON_KEY;
  const authz = useServiceRole ? SERVICE_KEY : userToken;
  const cronOwner = isCron && data ? data.owner_id : undefined; // 크론이 저장 시 지정하는 소유자

  const supaFetch = (path, options = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'apikey': apikey,
        'Authorization': `Bearer ${authz}`,
        'Prefer': 'return=representation',
        ...options.headers,
      },
    }).then(async r => {
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = text; }
      if (!r.ok) throw new Error(json?.message || json?.error || `HTTP ${r.status}: ${text}`);
      return json;
    });

  try {
    // 기존 액션 (포스팅 순위 조회)
    if (action === 'save_blogs') {
      const result = await supaFetch('/blogs', { method: 'POST', body: JSON.stringify(data.blogs), headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'get_blogs') {
      const result = await supaFetch('/blogs?order=created_at.asc');
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'save_posts') {
      const result = await supaFetch('/posts', { method: 'POST', body: JSON.stringify(data.posts), headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'save_rank') {
      const result = await supaFetch('/rank_history', { method: 'POST', body: JSON.stringify(data) });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'get_rank_history') {
      const encoded = encodeURIComponent(data.post_url);
      const result = await supaFetch(`/rank_history?post_url=eq.${encoded}&order=checked_at.desc&limit=30`);
      return res.status(200).json({ ok: true, result });
    }

    // 매장 CRUD
    if (action === 'list_stores') {
      const result = await supaFetch('/stores?order=created_at.desc');
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    if (action === 'create_store') {
      // 탭별 소속 플래그: in_blog(매장 블로그 순위) / in_place(플레이스 순위 추적)
      const inBlog = data.in_blog !== false;   // 기본 true (블로그/키워드제안 탭)
      const inPlace = data.in_place === true;   // 기본 false
      // 같은 place_id가 이미 있으면 새로 만들지 않고 해당 탭 플래그만 켠다(중복 방지·병합)
      const existing = await supaFetch(`/stores?place_id=eq.${encodeURIComponent(data.place_id)}&select=id,in_blog,in_place`);
      if (Array.isArray(existing) && existing.length) {
        const cur = existing[0];
        const patch = {};
        if (inBlog && cur.in_blog === false) patch.in_blog = true;
        if (inPlace && cur.in_place === false) patch.in_place = true;
        let result = existing;
        if (Object.keys(patch).length) {
          result = await supaFetch(`/stores?id=eq.${cur.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        }
        return res.status(200).json({ ok: true, result, merged: true });
      }
      const result = await supaFetch('/stores', {
        method: 'POST',
        body: JSON.stringify({
          place_id: data.place_id,
          name: data.name,
          place_url: data.place_url,
          category: data.category || null,
          address: data.address || null,
          phone: data.phone || null,
          in_blog: inBlog,
          in_place: inPlace,
        }),
      });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'delete_store') {
      await supaFetch(`/stores?id=eq.${data.store_id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    // 탭에서 매장 제거: 해당 탭 플래그만 내리고, 다른 탭에도 없으면 완전 삭제(연결 데이터 포함)
    if (action === 'remove_store_from_tab') {
      const col = data.tab === 'place' ? 'in_place' : 'in_blog';
      const other = data.tab === 'place' ? 'in_blog' : 'in_place';
      const rows = await supaFetch(`/stores?id=eq.${data.store_id}&select=in_blog,in_place`);
      const s = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!s) return res.status(200).json({ ok: true, deleted: true });
      if (s[other] === false) {
        await supaFetch(`/stores?id=eq.${data.store_id}`, { method: 'DELETE' });
        return res.status(200).json({ ok: true, deleted: true });
      }
      await supaFetch(`/stores?id=eq.${data.store_id}`, { method: 'PATCH', body: JSON.stringify({ [col]: false }) });
      return res.status(200).json({ ok: true, deleted: false });
    }

    // 매장 키워드
    if (action === 'list_store_keywords') {
      const result = await supaFetch(`/store_keywords?store_id=eq.${data.store_id}&order=created_at.asc`);
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    if (action === 'add_store_keyword') {
      const result = await supaFetch('/store_keywords', {
        method: 'POST',
        body: JSON.stringify({ store_id: data.store_id, keyword: data.keyword }),
      });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'delete_store_keyword') {
      await supaFetch(`/store_keywords?store_id=eq.${data.store_id}&keyword=eq.${encodeURIComponent(data.keyword)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // 매장 블로그 포스트 캐시
    if (action === 'get_store_blog_posts') {
      const [posts, fetchMeta] = await Promise.all([
        supaFetch(`/store_blog_posts?store_id=eq.${data.store_id}`),
        supaFetch(`/store_place_fetches?store_id=eq.${data.store_id}&limit=1`),
      ]);
      return res.status(200).json({ ok: true, posts: Array.isArray(posts) ? posts : [], fetch_meta: Array.isArray(fetchMeta) ? fetchMeta[0] || null : null });
    }
    if (action === 'save_store_blog_posts') {
      try { await supaFetch(`/store_blog_posts?store_id=eq.${data.store_id}`, { method: 'DELETE' }); } catch {}
      if (data.posts && data.posts.length > 0) {
        await supaFetch('/store_blog_posts', { method: 'POST', body: JSON.stringify(data.posts.map(p => ({ store_id: data.store_id, blog_url: p.blog_url, blog_id: p.blog_id || null, post_id: p.post_id || null, title: p.title || null }))) });
      }
      try { await supaFetch(`/store_place_fetches?store_id=eq.${data.store_id}`, { method: 'DELETE' }); } catch {}
      await supaFetch('/store_place_fetches', { method: 'POST', body: JSON.stringify({ store_id: data.store_id, fetched_at: new Date().toISOString(), post_count: data.posts?.length || 0, success: data.success !== false, error_msg: data.error_msg || null }) });
      return res.status(200).json({ ok: true });
    }

    // 매장 순위
    if (action === 'save_store_ranking') {
      // matches: 이 키워드에 걸린 우리 매장 블로그 전부 [{rank,url,title}, ...]
      const payload = { store_id: data.store_id, keyword: data.keyword, checked_date: data.checked_date || new Date().toISOString().slice(0, 10), rank: data.rank, matched_blog_url: data.matched_blog_url || null, matched_title: data.matched_title || null, search_volume: data.search_volume || null, matches: Array.isArray(data.matches) ? data.matches : null };
      if (cronOwner) payload.owner_id = cronOwner; // 크론: 소유자 지정(사용자모드는 default auth.uid())
      try { await supaFetch(`/store_rankings?store_id=eq.${payload.store_id}&keyword=eq.${encodeURIComponent(payload.keyword)}&checked_date=eq.${payload.checked_date}`, { method: 'DELETE' }); } catch {}
      const result = await supaFetch('/store_rankings', { method: 'POST', body: JSON.stringify(payload) });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'get_store_rankings') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const result = await supaFetch(`/store_rankings?store_id=eq.${data.store_id}&checked_date=gte.${since}&order=checked_date.desc`);
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }

    // ===== 플레이스 키워드 분석 =====
    // 추적 키워드 목록
    if (action === 'list_place_keywords') {
      const result = await supaFetch('/place_keywords?order=created_at.asc');
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    if (action === 'add_place_keyword') {
      const result = await supaFetch('/place_keywords', {
        method: 'POST',
        body: JSON.stringify({ keyword: data.keyword }),
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'delete_place_keyword') {
      await supaFetch(`/place_keywords?keyword=eq.${encodeURIComponent(data.keyword)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // 플레이스 순위 스냅샷 저장(하루치, 키워드별) — 기존 같은 날짜 삭제 후 일괄 삽입
    if (action === 'save_place_rankings') {
      const checkedDate = data.checked_date || new Date().toISOString().slice(0, 10);
      const rows = (data.rows || []).map((r) => ({
        keyword: data.keyword,
        checked_date: checkedDate,
        rank: r.rank,
        place_id: String(r.placeId || r.place_id || ''),
        name: r.name || null,
        category: r.category || null,
        visitor_reviews: r.visitorReviews ?? r.visitor_reviews ?? null,
        blog_reviews: r.blogReviews ?? r.blog_reviews ?? null,
        saves: r.saves ?? r.save ?? null,
        ...(cronOwner ? { owner_id: cronOwner } : {}), // 크론: 소유자 지정(사용자모드는 default auth.uid())
      }));
      // 크론(service_role)은 owner 범위로 삭제, 사용자모드는 RLS가 자동 범위 제한
      let delPath = `/place_rankings?keyword=eq.${encodeURIComponent(data.keyword)}&checked_date=eq.${checkedDate}`;
      if (cronOwner) delPath += `&owner_id=eq.${cronOwner}`;
      try { await supaFetch(delPath, { method: 'DELETE' }); } catch {}
      if (rows.length) await supaFetch('/place_rankings', { method: 'POST', body: JSON.stringify(rows) });
      return res.status(200).json({ ok: true, saved: rows.length });
    }
    // ===== 매장 중심 플레이스 순위 추적 =====
    // 매장별 추적 키워드 목록
    if (action === 'list_store_place_keywords') {
      const result = await supaFetch(`/store_place_keywords?store_id=eq.${data.store_id}&order=created_at.asc`);
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    if (action === 'add_store_place_keyword') {
      const result = await supaFetch('/store_place_keywords', {
        method: 'POST',
        body: JSON.stringify({ store_id: data.store_id, keyword: data.keyword }),
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'delete_store_place_keyword') {
      await supaFetch(`/store_place_keywords?store_id=eq.${data.store_id}&keyword=eq.${encodeURIComponent(data.keyword)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    // 크론용: 전 매장에서 추적 중인 distinct 키워드 목록
    if (action === 'list_all_store_place_keywords') {
      const result = await supaFetch('/store_place_keywords?select=keyword');
      const kws = [...new Set((Array.isArray(result) ? result : []).map((r) => r.keyword).filter(Boolean))];
      return res.status(200).json({ ok: true, result: kws });
    }
    // 크론용: 전 계정의 플레이스 추적 (owner_id, keyword) 페어 — place_keywords + store_place_keywords 합집합
    if (action === 'list_all_place_tracking') {
      const [pk, spk] = await Promise.all([
        supaFetch('/place_keywords?select=owner_id,keyword').catch(() => []),
        supaFetch('/store_place_keywords?select=owner_id,keyword').catch(() => []),
      ]);
      const seen = new Set();
      const pairs = [];
      for (const r of [...(Array.isArray(pk) ? pk : []), ...(Array.isArray(spk) ? spk : [])]) {
        if (!r || !r.owner_id || !r.keyword) continue;
        const k = r.owner_id + ' ' + r.keyword;
        if (seen.has(k)) continue;
        seen.add(k);
        pairs.push({ owner_id: r.owner_id, keyword: r.keyword });
      }
      return res.status(200).json({ ok: true, result: pairs });
    }
    // 우리 매장 관점: 등록 키워드별 우리 매장 순위 이력(place_rankings에서 place_id 매칭 행만)
    if (action === 'get_store_place_rankings') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const pid = encodeURIComponent(String(data.place_id || ''));
      const kws = Array.isArray(data.keywords) ? data.keywords : [];
      if (!pid || kws.length === 0) return res.status(200).json({ ok: true, result: [] });
      const all = await Promise.all(
        kws.map((k) =>
          supaFetch(
            `/place_rankings?place_id=eq.${pid}&keyword=eq.${encodeURIComponent(k)}&checked_date=gte.${since}&order=checked_date.desc`
          ).catch(() => [])
        )
      );
      const result = all.flat().filter(Boolean);
      return res.status(200).json({ ok: true, result });
    }

    // 키워드의 최근 N일 순위 이력
    if (action === 'get_place_rankings') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const result = await supaFetch(
        `/place_rankings?keyword=eq.${encodeURIComponent(data.keyword)}&checked_date=gte.${since}&order=checked_date.desc,rank.asc`
      );
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }

    // 수집 실패 현황(NCP failures.log 프록시) — 대시보드 배너용. 스크래퍼 키는 서버에만.
    if (action === 'get_collect_failures') {
      const base = process.env.KOREAN_SCRAPER_URL;
      const key = process.env.KOREAN_SCRAPER_KEY;
      if (!base || !key) return res.status(200).json({ ok: false, error: '스크래퍼 미설정' });
      const r = await fetch(`${base.replace(/\/$/, '')}/failures`, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return res.status(200).json({ ok: false, error: `스크래퍼 ${r.status}` });
      return res.status(200).json({ ok: true, failures: j.failures || [], lastPlace: j.lastPlace || null, lastBlog: j.lastBlog || null });
    }

    // 키워드별 최근 수집일(빠름) — "한 번도 수집 안 된" 키워드 판별용(재진입 이어하기).
    // 미노출 키워드도 스냅샷 자체는 있으므로(우리 매장 행만 없음) 이 액션으로 구분한다.
    if (action === 'get_place_collect_status') {
      const kws = Array.isArray(data.keywords) ? data.keywords.slice(0, 60) : [];
      const out = {};
      await Promise.all(kws.map(async (k) => {
        try {
          const r = await supaFetch(`/place_rankings?keyword=eq.${encodeURIComponent(k)}&select=checked_date&order=checked_date.desc&limit=1`);
          out[k] = Array.isArray(r) && r[0] ? r[0].checked_date : null;
        } catch { out[k] = null; }
      }));
      return res.status(200).json({ ok: true, result: out });
    }

    // 키워드의 가장 최근 수집일 전체 스냅샷(상위 300 목록) — SEO 분석용
    if (action === 'get_place_snapshot') {
      const enc = encodeURIComponent(data.keyword);
      const last = await supaFetch(`/place_rankings?keyword=eq.${enc}&select=checked_date&order=checked_date.desc&limit=1`);
      if (!Array.isArray(last) || !last.length) return res.status(200).json({ ok: true, result: [], checked_date: null });
      const d = last[0].checked_date;
      const rows = await supaFetch(`/place_rankings?keyword=eq.${enc}&checked_date=eq.${d}&order=rank.asc&limit=300`);
      return res.status(200).json({ ok: true, result: Array.isArray(rows) ? rows : [], checked_date: d });
    }

    // ===== 포인트(발주) =====
    // 내 포인트 잔액(원장 합산) — RLS로 본인 것만
    if (action === 'get_point_balance') {
      const rows = await supaFetch('/point_transactions?select=amount');
      const balance = (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return res.status(200).json({ ok: true, balance });
    }
    // 내 포인트 내역
    if (action === 'list_point_transactions') {
      const result = await supaFetch('/point_transactions?select=*&order=created_at.desc&limit=100');
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    // 세금계산서 신청 접수(본인) — business_number+email(+상호/충전건)
    if (action === 'create_tax_invoice_request') {
      const body = { business_number: data.business_number, email: data.email, company_name: data.company_name || null, related_transaction_id: data.related_transaction_id || null };
      const result = await supaFetch('/tax_invoice_requests', { method: 'POST', body: JSON.stringify(body) });
      return res.status(200).json({ ok: true, result });
    }
    // 발주 생성 — 원자적 RPC(잔액확인+차감+주문). auth.uid() 기준 본인 소유.
    if (action === 'create_order') {
      const body = {
        p_category: data.category || null,
        p_product_name: data.product_name || null,
        p_options: data.options || null,
        p_unit_price: Number(data.unit_price) || 0,
        p_quantity: Number(data.quantity) || 0,
        p_total_price: Number(data.total_price) || 0,
        p_store_id: data.store_id || null,
      };
      const result = await supaFetch('/rpc/create_order', { method: 'POST', body: JSON.stringify(body) });
      return res.status(200).json({ ok: true, result });
    }
    // 내 주문내역(RLS 본인/관리자)
    if (action === 'list_orders') {
      const result = await supaFetch('/orders?select=*&order=created_at.desc&limit=200');
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    // (관리자) 전체 주문 조회 — RPC 내부 is_admin() 검증, 비관리자는 0행
    if (action === 'admin_list_orders') {
      const result = await supaFetch('/rpc/admin_list_orders', { method: 'POST', body: JSON.stringify({}) });
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    // (관리자) 주문 상태 변경 — RPC 내부 is_admin() 검증
    if (action === 'admin_set_order_status') {
      const result = await supaFetch('/rpc/admin_set_order_status', { method: 'POST', body: JSON.stringify({ p_order_id: data.order_id, p_status: data.status }) });
      return res.status(200).json({ ok: true, result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
