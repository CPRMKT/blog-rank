// api/public-config.js
// 클라이언트가 Supabase Auth SDK를 초기화하는 데 필요한 공개 설정.
// (URL + anon/publishable 키는 원래 클라이언트에 노출되는 공개값)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
