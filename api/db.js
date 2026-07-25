// api/db.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
  const { action, data } = req.body || {};

  const supaFetch = (path, options = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
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
      }));
      try { await supaFetch(`/place_rankings?keyword=eq.${encodeURIComponent(data.keyword)}&checked_date=eq.${checkedDate}`, { method: 'DELETE' }); } catch {}
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

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
