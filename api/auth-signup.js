// api/auth-signup.js
// 아이디 기반 회원가입.
//  1) 아이디를 합성 이메일 {username}@users.blogrank.internal 로 변환해 Supabase Auth 유저 생성
//     (admin API, email_confirm:true → 확인메일 없이 즉시 사용 가능)
//  2) 실제 이메일·부가정보는 profiles 테이블에 저장
//  실패 시 유령 계정 방지를 위해 auth 유저를 정리(delete)한다.

const EMAIL_DOMAIN = 'users.blogrank.internal';
const synthEmail = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const b = req.body || {};
  const username = (b.username || '').toString().trim();
  const password = (b.password || '').toString();
  const email = (b.email || '').toString().trim();
  const role = (b.role || '').toString();

  // 검증
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) return res.status(400).json({ ok: false, error: '아이디는 영문·숫자·밑줄 4~20자입니다.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: '비밀번호는 6자 이상이어야 합니다.' });
  if (!b.terms_agreed) return res.status(400).json({ ok: false, error: '약관에 동의해야 가입할 수 있습니다.' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: '올바른 이메일을 입력하세요.' });
  if (role && !['매장주', '대행사', '직원', '기타'].includes(role)) return res.status(400).json({ ok: false, error: '역할 값이 올바르지 않습니다.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SECRET_KEY;
  const admin = (path, options = {}) =>
    fetch(`${SUPABASE_URL}${path}`, { ...options, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });

  try {
    // 아이디 중복 재확인
    const chk = await admin(`/rest/v1/profiles?select=id&username=ilike.${encodeURIComponent(username)}&limit=1`).then((r) => r.json());
    if (Array.isArray(chk) && chk.length > 0) return res.status(409).json({ ok: false, error: '이미 사용 중인 아이디입니다.' });

    // 1) Auth 유저 생성 (확인됨 상태)
    const cr = await admin('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: synthEmail(username), password, email_confirm: true }) });
    const user = await cr.json();
    if (!cr.ok || !user || !user.id) {
      const msg = (user && (user.msg || user.message || user.error_description || user.error)) || `가입 실패 (${cr.status})`;
      return res.status(400).json({ ok: false, error: /already|exist|registered/i.test(msg) ? '이미 사용 중인 아이디입니다.' : msg });
    }

    // 2) profiles 저장
    const pr = await admin('/rest/v1/profiles', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: user.id, username, email,
        name: b.name || null, company: b.company || null, role: role || null,
        phone: b.phone || null, referrer: b.referrer || null, terms_agreed: true,
      }),
    });
    if (!pr.ok) {
      const perr = await pr.text();
      // 유령 계정 정리
      await admin(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }).catch(() => {});
      return res.status(500).json({ ok: false, error: '프로필 저장 실패: ' + perr.slice(0, 150) });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
