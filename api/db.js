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

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
