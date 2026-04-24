// api/db.js
// 기존 포스팅 페이지용 액션(save_blogs, get_blogs, save_posts, save_rank, get_rank_history) 그대로 유지
// 매장 블로그 순위 페이지용 액션 추가

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
    }).then(r => r.json());

  try {
    // ============================================
    // 기존 액션 (포스팅 순위 조회 페이지용) - 건드리지 않음
    // ============================================
    if (action === 'save_blogs') {
      const result = await supaFetch('/blogs', {
        method: 'POST',
        body: JSON.stringify(data.blogs),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'get_blogs') {
      const result = await supaFetch('/blogs?order=created_at.asc');
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'save_posts') {
      const result = await supaFetch('/posts', {
        method: 'POST',
        body: JSON.stringify(data.posts),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'save_rank') {
      const result = await supaFetch('/rank_history', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'get_rank_history') {
      const encoded = encodeURIComponent(data.post_url);
      const result = await supaFetch(
        `/rank_history?post_url=eq.${encoded}&order=checked_at.desc&limit=30`
      );
      return res.status(200).json({ ok: true, result });
    }

    // ============================================
    // 신규 액션: 매장 블로그 순위 페이지용
    // ============================================

    // --- 매장 CRUD ---
    if (action === 'list_stores') {
      const result = await supaFetch('/stores?order=created_at.desc');
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'create_store') {
      // data: { place_id, name, place_url, category, address, phone }
      const result = await supaFetch('/stores', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'delete_store') {
      // data: { store_id }
      await supaFetch(`/stores?id=eq.${data.store_id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // --- 매장 키워드 CRUD ---
    if (action === 'list_store_keywords') {
      // data: { store_id }
      const result = await supaFetch(
        `/store_keywords?store_id=eq.${data.store_id}&order=created_at.asc`
      );
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'add_store_keyword') {
      // data: { store_id, keyword }
      const result = await supaFetch('/store_keywords', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'delete_store_keyword') {
      // data: { store_id, keyword }
      const kw = encodeURIComponent(data.keyword);
      await supaFetch(
        `/store_keywords?store_id=eq.${data.store_id}&keyword=eq.${kw}`,
        { method: 'DELETE' }
      );
      return res.status(200).json({ ok: true });
    }

    // --- 매장 블로그 포스트 캐시 (플레이스 API 결과 저장) ---
    if (action === 'get_store_blog_posts') {
      // data: { store_id }
      // 캐시 신선도 확인용으로 fetched_at도 같이 반환
      const [posts, fetchMeta] = await Promise.all([
        supaFetch(`/store_blog_posts?store_id=eq.${data.store_id}`),
        supaFetch(`/store_place_fetches?store_id=eq.${data.store_id}&limit=1`),
      ]);
      return res.status(200).json({
        ok: true,
        posts,
        fetch_meta: fetchMeta?.[0] || null,
      });
    }

    if (action === 'save_store_blog_posts') {
      // data: { store_id, posts: [{blog_url, blog_id, post_id, title}], success, error_msg }
      // 1) 기존 캐시 전부 삭제 후 신규 저장 (단순 upsert가 아니라 replace)
      await supaFetch(`/store_blog_posts?store_id=eq.${data.store_id}`, {
        method: 'DELETE'
      });

      let inserted = [];
      if (data.posts && data.posts.length > 0) {
        const rows = data.posts.map(p => ({
          store_id: data.store_id,
          blog_url: p.blog_url,
          blog_id: p.blog_id || null,
          post_id: p.post_id || null,
          title: p.title || null,
        }));
        inserted = await supaFetch('/store_blog_posts', {
          method: 'POST',
          body: JSON.stringify(rows),
        });
      }

      // 2) fetch 메타 upsert
      await supaFetch('/store_place_fetches', {
        method: 'POST',
        body: JSON.stringify({
          store_id: data.store_id,
          fetched_at: new Date().toISOString(),
          post_count: data.posts?.length || 0,
          success: data.success !== false,
          error_msg: data.error_msg || null,
        }),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });

      return res.status(200).json({ ok: true, inserted: inserted.length || 0 });
    }

    // --- 매장 순위 기록 ---
    if (action === 'save_store_ranking') {
      // data: { store_id, keyword, rank, matched_blog_url, matched_title, search_volume }
      const payload = {
        store_id: data.store_id,
        keyword: data.keyword,
        checked_date: data.checked_date || new Date().toISOString().slice(0, 10),
        rank: data.rank,
        matched_blog_url: data.matched_blog_url || null,
        matched_title: data.matched_title || null,
        search_volume: data.search_volume || null,
      };
      const result = await supaFetch('/store_rankings', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
      });
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'get_store_rankings') {
      // data: { store_id, days } - 최근 N일치 순위
      const days = data.days || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const result = await supaFetch(
        `/store_rankings?store_id=eq.${data.store_id}&checked_date=gte.${since}&order=checked_date.desc`
      );
      return res.status(200).json({ ok: true, result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
