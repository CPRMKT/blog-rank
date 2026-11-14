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
  // 임베드 조회는 토큰 하나로만 호출된다(아래 embed_data에서 토큰을 직접 검증한다).
  // 토큰이 유효해도 그 매장의 읽기 전용 데이터 말고는 아무것도 할 수 없다.
  const TOKEN_ONLY_ACTIONS = new Set(['embed_data']);
  if (!isCron && !userToken && !TOKEN_ONLY_ACTIONS.has(action)) return res.status(401).json({ ok: false, error: '인증이 필요합니다. 다시 로그인해 주세요.' });
  if (String(action || '').startsWith('embed_')) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // 계정분리 제외(공용 레거시: 포스팅 순위 조회)는 service_role로.
  const SHARED_ACTIONS = new Set(['save_blogs', 'get_blogs', 'save_posts', 'save_rank', 'get_rank_history']);
  // 임베드: 토큰 테이블은 service_role 전용이고, 조회도 토큰으로 특정된 매장 것만 돌려준다.
  const useServiceRole = isCron || SHARED_ACTIONS.has(action) || String(action || '').startsWith('embed_');
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

  // Supabase는 한 요청에 1,000행까지만 돌려주고 **잘렸다는 표시를 하지 않는다**.
  // 31일치 300위 키워드는 9,000행이라, 그냥 받으면 최근 3~12일치만 받고도 다 받은 줄 안다
  // (2026-11-14 확인: "부산 사직 맛집" 46일 요청 → 12일치 1,000행만 돌아옴).
  // 많이 나올 수 있는 조회는 전부 이 함수로 끝까지 받는다.
  const supaFetchAll = async (path, pageSize = 1000, maxRows = 60000) => {
    const out = [];
    for (let off = 0; off < maxRows; off += pageSize) {
      const sep = path.includes('?') ? '&' : '?';
      const rows = await supaFetch(`${path}${sep}limit=${pageSize}&offset=${off}`);
      if (!Array.isArray(rows) || !rows.length) break;
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  };

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
    if (action === 'get_store_rankings') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const result = await supaFetchAll(`/store_rankings?store_id=eq.${data.store_id}&checked_date=gte.${since}&order=checked_date.desc`);
      return res.status(200).json({ ok: true, result });
    }

    // ===== 플레이스 키워드 분석 =====
    // 추적 키워드 목록
    if (action === 'list_place_keywords') {
      const result = await supaFetch('/place_keywords?order=created_at.asc');
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    if (action === 'add_place_keyword') {
      if (/카페|커피|디저트|베이커리|빵집|브런치/.test(String(data.keyword || ''))) {
        return res.status(200).json({ ok: false, error: '카페·디저트·베이커리 업종은 플레이스 순위 추적을 아직 지원하지 않습니다(네이버가 이 업종 목록 페이지를 제공하지 않습니다).', unsupported: 'cafe' });
      }
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
    // ── 원자적 저장: DB 함수 1회 호출 = 삭제+삽입 단일 트랜잭션(왕복 1회, 삽입 실패 시 삭제도 롤백) ──
    // sql/2026-09-18_atomic_save.sql. 2026-09-18 속도·롤백·회귀 검증 후 기존 delete+insert 경로를 이걸로 교체.
    // (_v2 이름은 호환용 별칭)
    if (action === 'save_place_rankings' || action === 'save_place_rankings_v2') {
      const checkedDate = data.checked_date || new Date().toISOString().slice(0, 10);
      const rows = (data.rows || []).map((r) => ({
        rank: r.rank,
        place_id: String(r.placeId || r.place_id || ''),
        name: r.name || null,
        category: r.category || null,
        visitor_reviews: r.visitorReviews ?? r.visitor_reviews ?? null,
        blog_reviews: r.blogReviews ?? r.blog_reviews ?? null,
        saves: r.saves ?? r.save ?? null,
      }));
      const saved = await supaFetch('/rpc/save_place_rankings_atomic', {
        method: 'POST',
        body: JSON.stringify({ p_keyword: data.keyword, p_checked_date: checkedDate, p_owner: cronOwner || null, p_rows: rows }),
      });
      return res.status(200).json({ ok: true, saved: typeof saved === 'number' ? saved : rows.length, atomic: true });
    }
    if (action === 'save_store_ranking' || action === 'save_store_ranking_v2') {
      const row = { rank: data.rank, matched_blog_url: data.matched_blog_url || null, matched_title: data.matched_title || null, search_volume: data.search_volume || null, matches: Array.isArray(data.matches) ? data.matches : null };
      await supaFetch('/rpc/save_store_ranking_atomic', {
        method: 'POST',
        body: JSON.stringify({ p_store_id: data.store_id, p_keyword: data.keyword, p_checked_date: data.checked_date || new Date().toISOString().slice(0, 10), p_owner: cronOwner || null, p_row: row }),
      });
      return res.status(200).json({ ok: true, atomic: true });
    }

    // ===== 매장 중심 플레이스 순위 추적 =====
    // 매장별 추적 키워드 목록
    if (action === 'list_store_place_keywords') {
      const result = await supaFetch(`/store_place_keywords?store_id=eq.${data.store_id}&order=created_at.asc`);
      return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] });
    }
    // ===== 블로그 ↔ 플레이스 키워드 양방향 연동 =====
    // 한쪽 탭에 (매장, 키워드)를 등록하면 반대쪽에도 같이 등록한다.
    // 일부러 트랜잭션(RPC)으로 묶지 않는다 — "한쪽이 실패해도 다른 쪽은 유지하고
    // 실패한 쪽만 재시도 대기로 표시"가 요구사항이라, 전부 되돌리면 오히려 어긋난다.
    if (action === 'add_linked_keyword') {
      const BLOG_MAX = 40, PLACE_MAX = 40;   // 두 탭 한도를 같게(2026-11-09)
      // 카페·디저트 업종: m.place.naver.com/cafe/list 가 404라 플레이스 순위를 받아올 방법이 없다
      // (2026-11-14 실측). 등록은 막고 안내 문구로 돌려준다 — 등록해두면 회차마다 에러만 쌓인다.
      const CAFE_RE = /카페|커피|디저트|베이커리|빵집|브런치/;
      const CAFE_MSG = '카페·디저트·베이커리 업종은 플레이스 순위 추적을 아직 지원하지 않습니다(네이버가 이 업종 목록 페이지를 제공하지 않습니다). 블로그 순위 추적은 됩니다.';
      const storeId = data.store_id;
      const keyword = String(data.keyword || '').trim();
      const origin = data.origin === 'place' ? 'place' : 'blog';   // 사용자가 실제로 등록한 쪽
      if (!storeId || !keyword) return res.status(200).json({ ok: false, error: '매장과 키워드가 필요합니다' });

      // 앞뒤 공백 제거 + 연속 공백 1개 + 소문자까지만 비교한다.
      // 공백을 완전히 지우면 "울산 신정동 밥집"과 "울산신정동밥집"이 한 키워드로 뭉쳐
      // 일부러 따로 추적하던 키워드가 조용히 누락된다(네이버는 띄어쓰기가 다르면 다른 검색).
      const norm = (x) => String(x || '').trim().toLowerCase().split(/\s+/).join(' ');
      const nk = norm(keyword);

      const [bRows, pRows] = await Promise.all([
        supaFetch(`/store_keywords?store_id=eq.${storeId}&select=keyword`).catch(() => []),
        supaFetch(`/store_place_keywords?store_id=eq.${storeId}&select=keyword`).catch(() => []),
      ]);
      const blogKws = (Array.isArray(bRows) ? bRows : []).map((r) => r.keyword).filter(Boolean);
      const placeKws = (Array.isArray(pRows) ? pRows : []).map((r) => r.keyword).filter(Boolean);
      const hasBlog = blogKws.some((k) => norm(k) === nk);
      const hasPlace = placeKws.some((k) => norm(k) === nk);

      const out = { blog: hasBlog ? 'exists' : null, place: hasPlace ? 'exists' : null };
      if (CAFE_RE.test(keyword)) {
        if (origin === 'place') return res.status(200).json({ ok: false, error: CAFE_MSG, unsupported: 'cafe' });
        out.place = 'unsupported';   // 블로그 쪽만 등록하고 플레이스 연동은 건너뛴다
      }

      const addBlog = async () => {
        if (hasBlog) return;
        if (blogKws.length >= BLOG_MAX) { out.blog = `limit:${BLOG_MAX}`; return; }
        await supaFetch('/store_keywords', { method: 'POST', body: JSON.stringify({ store_id: storeId, keyword }) });
        out.blog = 'added';
      };
      const addPlace = async () => {
        if (hasPlace || out.place === 'unsupported') return;
        if (placeKws.length >= PLACE_MAX) { out.place = `limit:${PLACE_MAX}`; return; }
        await supaFetch('/store_place_keywords', {
          method: 'POST',
          body: JSON.stringify({ store_id: storeId, keyword }),
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        });
        out.place = 'added';
      };

      // 사용자가 등록한 쪽을 먼저 확정한다. 이쪽이 실패하면 등록 자체가 실패다.
      try {
        if (origin === 'blog') await addBlog(); else await addPlace();
      } catch (e) {
        return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 120) });
      }
      // 반대쪽은 실패해도 등록을 되돌리지 않고 "연동 실패"로만 알린다.
      let linkError = null;
      try {
        if (origin === 'blog') await addPlace(); else await addBlog();
      } catch (e) {
        linkError = String(e.message || e).slice(0, 120);
        out[origin === 'blog' ? 'place' : 'blog'] = 'failed';
      }

      // 상대 탭에 매장이 없으면 키워드를 넣어도 화면에 안 보인다 → 그 탭 소속 플래그를 켠다.
      try {
        const patch = {};
        if (out.blog === 'added') patch.in_blog = true;
        if (out.place === 'added') patch.in_place = true;
        if (Object.keys(patch).length) {
          await supaFetch(`/stores?id=eq.${storeId}`, { method: 'PATCH', body: JSON.stringify(patch) });
        }
      } catch (e) { /* 플래그 실패는 등록을 막지 않는다 */ }

      return res.status(200).json({ ok: true, result: out, link_error: linkError });
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

    // 날짜 칸 구분용: 키워드별로 "그날 수집이 실제로 있었는지"를 돌려준다(rank 1 행 존재 여부).
    // 우리 매장 행이 없는 날이 '정상 미노출'인지 '수집 기록 없음'인지 화면에서 가릴 수 없어서 필요하다.
    // 0곳 응답으로 보류된 날도 저장 자체가 없으므로 "수집 기록 없음"으로 잡힌다(의도된 동작).
    if (action === 'get_place_collected_dates') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const kws = Array.isArray(data.keywords) ? data.keywords : [];
      if (kws.length === 0) return res.status(200).json({ ok: true, result: {} });
      const all = await Promise.all(
        kws.map((k) =>
          supaFetch(
            `/place_rankings?keyword=eq.${encodeURIComponent(k)}&rank=eq.1&checked_date=gte.${since}&select=checked_date`
          ).catch(() => [])
        )
      );
      const out = {};
      kws.forEach((k, i) => { out[k] = [...new Set((all[i] || []).map((r) => r.checked_date))]; });
      return res.status(200).json({ ok: true, result: out });
    }

    // 키워드의 최근 N일 순위 이력
    if (action === 'get_place_rankings') {
      const days = data.days || 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const result = await supaFetchAll(
        `/place_rankings?keyword=eq.${encodeURIComponent(data.keyword)}&checked_date=gte.${since}&order=checked_date.desc,rank.asc`
      );
      return res.status(200).json({ ok: true, result });
    }

    // [관리] 오염 행 삭제 — '신규 오픈' 캡처 버그(2026-10-30~11-09)로 저장된 (키워드, 날짜) 쌍만 지운다.
    // 크론 시크릿 전용. dry=true면 세기만 한다. 날짜 하나당 DELETE 한 문장이라 그 날짜 안에서는 원자적이다.
    // PostgREST에는 여러 문장을 묶는 트랜잭션이 없으므로 '쌍 단위·날짜별 한 문장'이 가능한 최소 단위다.
    if (action === 'purge_place_rankings') {
      if (!isCron) return res.status(403).json({ ok: false, error: '관리 전용 액션입니다.' });
      const pairs = Array.isArray(data.pairs) ? data.pairs : [];
      if (!pairs.length) return res.status(200).json({ ok: true, pairs: 0, rows: 0, per: [] });
      const byDate = {};
      for (const p of pairs) {
        const d = String(p.date || '').slice(0, 10);
        if (d.length !== 10 || d[4] !== '-' || d[7] !== '-' || !p.keyword) continue;
        (byDate[d] = byDate[d] || new Set()).add(String(p.keyword));
      }
      const inList = (ks) => '(' + ks.map((k) => '"' + encodeURIComponent(k) + '"').join(',') + ')';
      const count = async (d, ks) => {
        let c = 0;
        // 10개씩: 한 요청의 결과 행이 Supabase 기본 상한(1,000행)에 닿으면 조용히 잘려 과소 계산된다.
        for (let i = 0; i < ks.length; i += 10) {
          const r = await supaFetch(`/place_rankings?checked_date=eq.${d}&keyword=in.${inList(ks.slice(i, i + 10))}&select=id&limit=5000`);
          c += Array.isArray(r) ? r.length : 0;
        }
        return c;
      };
      // export: 삭제 전 백업용. 날짜 하나씩, 삭제와 똑같은 필터로 행을 그대로 돌려준다.
      // (get_place_rankings는 키워드당 기본 1,000행에서 조용히 잘려 백업이 비는 일이 있었다.)
      if (data.export) {
        const d = String(data.export).slice(0, 10);
        const ks = byDate[d] ? [...byDate[d]] : [];
        const out = [];
        for (let i = 0; i < ks.length; i += 5) {
          const r = await supaFetch(`/place_rankings?checked_date=eq.${d}&keyword=in.${inList(ks.slice(i, i + 5))}&limit=5000`);
          if (Array.isArray(r)) out.push(...r);
        }
        return res.status(200).json({ ok: true, date: d, keywords: ks.length, rows: out.length, result: out });
      }
      const per = [];
      let rows = 0, npair = 0;
      for (const d of Object.keys(byDate).sort()) {
        const ks = [...byDate[d]];
        npair += ks.length;
        if (data.dry) {
          const c = await count(d, ks);
          per.push({ date: d, keywords: ks.length, rows: c });
          rows += c;
        } else {
          const r = await supaFetch(`/place_rankings?checked_date=eq.${d}&keyword=in.${inList(ks)}&select=id`, { method: 'DELETE' });
          const c = Array.isArray(r) ? r.length : 0;
          per.push({ date: d, keywords: ks.length, rows: c, left: await count(d, ks) });
          rows += c;
        }
      }
      return res.status(200).json({ ok: true, dry: !!data.dry, pairs: npair, rows, per });
    }

    // ===== 블로그 진단 =====
    // 블로그 공개정보(RSS+본문 통계) — NCP /blog-profile 프록시. 새 서버리스 함수 없이 db.js 안에서 처리.
    if (action === 'blog_profile') {
      const base = process.env.KOREAN_SCRAPER_URL, key = process.env.KOREAN_SCRAPER_KEY;
      if (!base || !key) return res.status(200).json({ ok: false, error: '스크래퍼 미설정' });
      const id = encodeURIComponent(String(data.blog_id || '').trim());
      const bodies = Math.min(15, Math.max(0, parseInt(data.bodies, 10) || 10));
      const r = await fetch(`${base.replace(/\/$/, '')}/blog-profile?id=${id}&bodies=${bodies}`, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok === false) return res.status(200).json({ ok: false, error: (j && j.error) || `스크래퍼 ${r.status}` });
      return res.status(200).json({ ok: true, ...j });
    }
    // 진단/예측 테이블은 나중에 생성될 수 있다 → 없으면 에러 대신 missing_table 플래그로 알린다.
    const MISSING = (e) => /does not exist|schema cache|relation .* does not exist|Could not find the table/i.test(String(e && e.message));
    if (action === 'save_blog_diagnosis') {
      const body = { blog_id: data.blog_id, store_id: data.store_id || null, score: data.score, grade: data.grade || null, breakdown: data.breakdown || null, posts: data.posts || null, flags: data.flags || null };
      if (cronOwner) body.owner_id = cronOwner;
      try { const result = await supaFetch('/blog_diagnoses', { method: 'POST', body: JSON.stringify(body) }); return res.status(200).json({ ok: true, result }); }
      catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true }); throw e; }
    }
    if (action === 'list_blog_diagnoses') {
      // 백분위 계산용: 블로그별 최신 점수만 필요하므로 최근 500건만
      try { const result = await supaFetch('/blog_diagnoses?select=blog_id,score,created_at&order=created_at.desc&limit=500'); return res.status(200).json({ ok: true, result: Array.isArray(result) ? result : [] }); }
      catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true, result: [] }); throw e; }
    }
    if (action === 'save_blog_prediction') {
      const body = { blog_id: data.blog_id, store_id: data.store_id || null, keyword: data.keyword, probability: data.probability, expected_band: data.expected_band || null, inputs: data.inputs || null, target_date: data.target_date || null };
      if (cronOwner) body.owner_id = cronOwner;
      try { const result = await supaFetch('/blog_predictions', { method: 'POST', body: JSON.stringify(body) }); return res.status(200).json({ ok: true, result }); }
      catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true }); throw e; }
    }
    // 심사한 블로거가 실제로 그 키워드로 글을 써서 순위에 잡혔는지 찾는다(예측 검증 자동 연결).
    // store_rankings.matches 안의 blog URL에서 블로거 아이디를 대조 — 사장님이 따로 입력할 것 없음.
    if (action === 'find_blog_keyword_rank') {
      const kw = encodeURIComponent(String(data.keyword || ''));
      const since = String(data.since || '').slice(0, 10);
      const rows = await supaFetch(`/store_rankings?keyword=eq.${kw}&checked_date=gte.${since}&select=keyword,checked_date,rank,matched_blog_url,matches&order=checked_date.desc&limit=200`);
      const id = String(data.blog_id || '').toLowerCase();
      let best = null;
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const list = Array.isArray(r.matches) ? r.matches : (r.matched_blog_url ? [{ rank: r.rank, url: r.matched_blog_url }] : []);
        for (const m of list) {
          const bid = ((String(m && m.url || '').match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/) || [])[1] || '').toLowerCase();
          if (bid && bid === id && m.rank > 0 && (!best || m.rank < best.rank)) best = { rank: m.rank, checked_date: r.checked_date, url: m.url };
        }
      }
      return res.status(200).json({ ok: true, found: !!best, ...(best || {}) });
    }
    if (action === 'list_pending_predictions') {
      // 검증일이 지났는데 아직 검증 안 된 예측(주간 검증 배치용)
      const today = new Date().toISOString().slice(0, 10);
      try { const rows = await supaFetch(`/blog_predictions?select=id,blog_id,store_id,keyword,probability,target_date&verified_at=is.null&target_date=lte.${today}&limit=500`);
        return res.status(200).json({ ok: true, result: Array.isArray(rows) ? rows : [] }); }
      catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true, result: [] }); throw e; }
    }
    if (action === 'set_prediction_verified') {
      try { const r = await supaFetch(`/blog_predictions?id=eq.${parseInt(data.id, 10)}`, { method: 'PATCH', body: JSON.stringify({ verified_rank: data.verified_rank, verified_at: new Date().toISOString() }) });
        return res.status(200).json({ ok: true, result: r }); }
      catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true }); throw e; }
    }
    if (action === 'get_prediction_accuracy') {
      // 최근 30일 중 검증 완료(verified_rank 채워짐)분으로 적중률 계산
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      try {
        const rows = await supaFetch(`/blog_predictions?select=probability,verified_rank,verified_at&verified_at=not.is.null&created_at=gte.${since}&limit=1000`);
        const list = Array.isArray(rows) ? rows : [];
        const high = list.filter((r) => Number(r.probability) >= 60);
        const hit = high.filter((r) => r.verified_rank != null && r.verified_rank > 0 && r.verified_rank <= 7).length;
        return res.status(200).json({ ok: true, sample: high.length, total: list.length, accuracy: high.length ? Math.round((hit / high.length) * 100) : null });
      } catch (e) { if (MISSING(e)) return res.status(200).json({ ok: false, missing_table: true }); throw e; }
    }

    // 진단: Vercel이 실제로 어떤 스크래퍼 주소를 보고 있는지 확인(크론 시크릿 필요).
    // IP 교체 후 "환경변수가 반영됐는지"를 추측 대신 사실로 확인하려고 둔다.
    if (action === 'scraper_diag') {
      if (!isCron) return res.status(403).json({ ok: false, error: '권한 없음' });
      const base = (process.env.KOREAN_SCRAPER_URL || '').trim();
      if (!base) return res.status(200).json({ ok: false, error: 'KOREAN_SCRAPER_URL 미설정' });
      const t0 = Date.now();
      let reach = null, err = null;
      try {
        const r = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
        reach = `HTTP ${r.status}`;
      } catch (e) { err = String(e && e.message || e); }
      return res.status(200).json({
        ok: true,
        url_raw: JSON.stringify(process.env.KOREAN_SCRAPER_URL || null),  // 앞뒤 공백·줄바꿈까지 보이게
        reach, err, ms: Date.now() - t0,
      });
    }

    // 수집 실패 현황(NCP failures.log 프록시) — 대시보드 배너용. 스크래퍼 키는 서버에만.
    if (action === 'get_collect_failures') {
      const base = process.env.KOREAN_SCRAPER_URL;
      const key = process.env.KOREAN_SCRAPER_KEY;
      if (!base || !key) return res.status(200).json({ ok: false, error: '스크래퍼 미설정' });
      const r = await fetch(`${base.replace(/\/$/, '')}/failures`, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return res.status(200).json({ ok: false, error: `스크래퍼 ${r.status}` });
      return res.status(200).json({ ok: true, failures: j.failures || [], held: j.held || null, heldCount: j.heldCount || 0, notRunCount: j.notRunCount || 0, lastPlace: j.lastPlace || null, lastBlog: j.lastBlog || null });
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

    // ===== 임베드(끼워 넣기) =====
    // 토큰 하나로 호출되는 읽기 전용 액션. 로그인도 크론 시크릿도 필요 없고, 대신
    //  - 토큰으로 매장을 정한다(요청에 store_id가 와도 무시한다),
    //  - 없는 토큰과 꺼진 토큰에 같은 응답을 준다(존재 여부를 알려주지 않는다),
    //  - 그 매장 화면에 필요한 값만 담는다.
    if (action === 'embed_data') {
      const token = String((data && data.token) || '').trim();
      const DENY = { ok: false, error: '표시할 수 없는 링크입니다.' };
      if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return res.status(200).json(DENY);
      let hit;
      try {
        hit = await supaFetch(`/embed_tokens?token=eq.${encodeURIComponent(token)}&enabled=is.true&select=store_id`);
      } catch (e) {
        // 테이블이 아직 없어도 밖에서는 똑같이 보여야 한다(설정 상태를 알려주지 않는다).
        // 준비가 안 됐다는 안내는 로그인한 관리자에게만(embed_admin) 보여준다.
        if (MISSING(e)) return res.status(200).json(DENY);
        throw e;
      }
      if (!Array.isArray(hit) || !hit.length) return res.status(200).json(DENY);
      const sid = hit[0].store_id;
      const days = 31;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const [stRows, pkRows, bkRows, blogRank] = await Promise.all([
        supaFetch(`/stores?id=eq.${sid}&select=id,name,place_id,category,address`).catch(() => []),
        supaFetch(`/store_place_keywords?store_id=eq.${sid}&select=keyword,created_at&order=created_at.asc`).catch(() => []),
        supaFetch(`/store_keywords?store_id=eq.${sid}&select=keyword&order=created_at.asc`).catch(() => []),
        supaFetchAll(`/store_rankings?store_id=eq.${sid}&checked_date=gte.${since}&order=checked_date.desc`).catch(() => []),
      ]);
      const store = (Array.isArray(stRows) && stRows[0]) || null;
      if (!store) return res.status(200).json(DENY);
      const placeKws = (Array.isArray(pkRows) ? pkRows : []).map((r) => r.keyword);
      const pid = encodeURIComponent(String(store.place_id || ''));
      let placeRows = [], collected = {};
      if (pid && placeKws.length) {
        const got = await Promise.all(placeKws.map((k) => supaFetch(
          `/place_rankings?place_id=eq.${pid}&keyword=eq.${encodeURIComponent(k)}&checked_date=gte.${since}&select=keyword,checked_date,rank,saves,visitor_reviews,blog_reviews&order=checked_date.desc`
        ).catch(() => [])));
        placeRows = got.flat().filter(Boolean);
        const dates = await Promise.all(placeKws.map((k) => supaFetch(
          `/place_rankings?keyword=eq.${encodeURIComponent(k)}&rank=eq.1&checked_date=gte.${since}&select=checked_date`
        ).catch(() => [])));
        placeKws.forEach((k, i) => { collected[k] = [...new Set((dates[i] || []).map((r) => r.checked_date))]; });
      }
      return res.status(200).json({
        ok: true,
        store: { name: store.name, category: store.category || '', address: store.address || '' },
        placeKeywords: (Array.isArray(pkRows) ? pkRows : []).map((r) => ({ keyword: r.keyword, created_at: r.created_at })),
        placeRows,
        collected,
        blogKeywords: (Array.isArray(bkRows) ? bkRows : []).map((r) => r.keyword),
        blogRows: (Array.isArray(blogRank) ? blogRank : []).map((r) => ({ keyword: r.keyword, checked_date: r.checked_date, rank: r.rank, matches: r.matches })),
      });
    }

    // 임베드 링크 관리(발급·재발급·끄기) — 관리자만. 관리자 여부는 사용자 JWT로 본인 profiles를
    // 읽어 서버에서 확인한다(서명 검증은 Supabase가 한다). 토큰 테이블 자체는 service_role로만 만진다.
    if (action === 'embed_admin') {
      // 크론 시크릿(서버 자신)도 관리자로 본다 — 점검 도구(tools/embed_test.mjs)가 쓰는 길이다.
      // 사용자가 보내는 경로는 아래처럼 JWT로 본인 profiles.is_admin을 확인해야만 통과한다.
      if (!userToken && !isCron) return res.status(403).json({ ok: false, error: '관리자만 쓸 수 있습니다.' });
      let admin = isCron;
      try {
        if (admin) throw { skip: true };
        const me = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,is_admin&limit=1`, {
          headers: { apikey: ANON_KEY, Authorization: `Bearer ${userToken}` },
        }).then((r) => (r.ok ? r.json() : null));
        admin = Array.isArray(me) && me[0] && me[0].is_admin === true;
      } catch (e) { if (!(e && e.skip)) admin = false; }
      if (!admin) return res.status(403).json({ ok: false, error: '관리자만 쓸 수 있습니다.' });
      const op = String(data.op || 'get');
      const sid = parseInt(data.store_id, 10);
      if (!sid) return res.status(200).json({ ok: false, error: '매장을 고르세요.' });
      const newToken = () => { const b = new Uint8Array(24); globalThis.crypto.getRandomValues(b); return Buffer.from(b).toString('base64url'); };
      try {
        if (op === 'get') {
          const rows = await supaFetch(`/embed_tokens?store_id=eq.${sid}&enabled=is.true&select=token,created_at,rotated_at`);
          return res.status(200).json({ ok: true, result: (Array.isArray(rows) && rows[0]) || null });
        }
        if (op === 'issue' || op === 'rotate') {
          await supaFetch(`/embed_tokens?store_id=eq.${sid}&enabled=is.true`, { method: 'PATCH', body: JSON.stringify({ enabled: false, rotated_at: new Date().toISOString() }) });
          const row = await supaFetch('/embed_tokens', { method: 'POST', body: JSON.stringify({ store_id: sid, token: newToken(), owner_id: data.owner_id || null }) });
          return res.status(200).json({ ok: true, result: Array.isArray(row) ? row[0] : row });
        }
        if (op === 'disable') {
          await supaFetch(`/embed_tokens?store_id=eq.${sid}&enabled=is.true`, { method: 'PATCH', body: JSON.stringify({ enabled: false, rotated_at: new Date().toISOString() }) });
          return res.status(200).json({ ok: true, result: null });
        }
      } catch (e) {
        if (MISSING(e)) return res.status(200).json({ ok: false, error: 'embed_tokens 테이블이 아직 없습니다. sql/2026-11-14_embed_tokens.sql을 한 번 실행해 주세요.', setup_needed: true });
        throw e;
      }
      return res.status(200).json({ ok: false, error: '알 수 없는 작업' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
