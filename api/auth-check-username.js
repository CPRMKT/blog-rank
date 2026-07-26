// api/auth-check-username.js
// 아이디(username) 실시간 중복 확인. profiles.username 대소문자 무시 조회.
//   GET /api/auth-check-username?username=honggildong123
//   → { ok:true, available:true|false, reason? }

// 워밍된 인스턴스 한정 소프트 레이트리밋(완벽하진 않지만 무차별 조회 완화)
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const win = 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30; // 분당 30회 초과 시 제한
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });

  const username = ((req.query && req.query.username) || (req.body && req.body.username) || '').toString().trim();
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    return res.status(200).json({ ok: true, available: false, reason: '영문·숫자·밑줄 4~20자로 입력하세요.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SECRET_KEY;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id&username=ilike.${encodeURIComponent(username)}&limit=1`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
    );
    const rows = await r.json();
    const taken = Array.isArray(rows) && rows.length > 0;
    return res.status(200).json({ ok: true, available: !taken, reason: taken ? '이미 사용 중인 아이디입니다.' : '' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
