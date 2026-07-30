// api/auth.js — 인증·설정·결제 통합 엔드포인트 (Vercel 서버리스 함수 수 절감용)
//   op=config          : 클라 설정(SUPABASE_URL/anon/tossClientKey)
//   op=check-username  : 아이디 중복확인
//   op=signup          : 아이디 기반 회원가입(합성이메일 Auth + profiles)
//   op=charge-confirm  : 토스 결제 승인검증 → 포인트 적립
// dispatch: req.query.op 또는 req.body.op

const EMAIL_DOMAIN = 'users.blogrank.internal';
const synthEmail = (id) => `${String(id || '').toLowerCase()}@${EMAIL_DOMAIN}`;

// check-username 소프트 레이트리밋(워밍 인스턴스 한정)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const op = ((req.query && req.query.op) || (req.body && req.body.op) || '').toString();
  try {
    if (op === 'config') return handleConfig(res);
    if (op === 'check-username') return handleCheckUsername(req, res);
    if (op === 'signup') return handleSignup(req, res);
    if (op === 'charge-confirm') return handleChargeConfirm(req, res);
    return res.status(400).json({ ok: false, error: 'unknown op' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function handleConfig(res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    tossClientKey: process.env.TOSS_CLIENT_KEY || '',
  });
}

async function handleCheckUsername(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  const username = ((req.query && req.query.username) || (req.body && req.body.username) || '').toString().trim();
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) return res.status(200).json({ ok: true, available: false, reason: '영문·숫자·밑줄 4~20자로 입력하세요.' });
  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SECRET_KEY;
  const rows = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&username=ilike.${encodeURIComponent(username)}&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then((r) => r.json());
  const taken = Array.isArray(rows) && rows.length > 0;
  return res.status(200).json({ ok: true, available: !taken, reason: taken ? '이미 사용 중인 아이디입니다.' : '' });
}

async function handleSignup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const b = req.body || {};
  const username = (b.username || '').toString().trim();
  const password = (b.password || '').toString();
  const email = (b.email || '').toString().trim();
  const role = (b.role || '').toString();
  const roleDetail = (b.role_detail || '').toString().trim();
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) return res.status(400).json({ ok: false, error: '아이디는 영문·숫자·밑줄 4~20자입니다.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: '비밀번호는 6자 이상이어야 합니다.' });
  if (!b.terms_agreed) return res.status(400).json({ ok: false, error: '약관에 동의해야 가입할 수 있습니다.' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: '올바른 이메일을 입력하세요.' });
  if (role && !['매장주', '대행사', '직원', '기타'].includes(role)) return res.status(400).json({ ok: false, error: '역할 값이 올바르지 않습니다.' });
  if (role === '기타' && !roleDetail) return res.status(400).json({ ok: false, error: '역할을 직접 입력해 주세요.' });

  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SECRET_KEY;
  const admin = (path, options = {}) => fetch(`${SUPABASE_URL}${path}`, { ...options, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });

  const chk = await admin(`/rest/v1/profiles?select=id&username=ilike.${encodeURIComponent(username)}&limit=1`).then((r) => r.json());
  if (Array.isArray(chk) && chk.length > 0) return res.status(409).json({ ok: false, error: '이미 사용 중인 아이디입니다.' });

  const cr = await admin('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: synthEmail(username), password, email_confirm: true }) });
  const user = await cr.json();
  if (!cr.ok || !user || !user.id) {
    const msg = (user && (user.msg || user.message || user.error_description || user.error)) || `가입 실패 (${cr.status})`;
    return res.status(400).json({ ok: false, error: /already|exist|registered/i.test(msg) ? '이미 사용 중인 아이디입니다.' : msg });
  }
  const pr = await admin('/rest/v1/profiles', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ id: user.id, username, email, name: b.name || null, company: b.company || null, role: role || null, role_detail: role === '기타' ? (roleDetail || null) : null, phone: b.phone || null, referrer: b.referrer || null, terms_agreed: true }),
  });
  if (!pr.ok) {
    const perr = await pr.text();
    await admin(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }).catch(() => {});
    return res.status(500).json({ ok: false, error: '프로필 저장 실패: ' + perr.slice(0, 150) });
  }
  return res.status(200).json({ ok: true });
}

async function handleChargeConfirm(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const SUPABASE_URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SECRET_KEY, TOSS_SECRET = process.env.TOSS_SECRET_KEY;
  const authHeader = (req.headers['authorization'] || '').toString();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
  const b = req.body || {};
  const paymentKey = b.paymentKey, orderId = b.orderId;
  const amount = parseInt(b.amount, 10);
  if (!paymentKey || !orderId) return res.status(400).json({ ok: false, error: 'paymentKey/orderId 누락' });
  if (!Number.isFinite(amount) || amount < 1000) return res.status(400).json({ ok: false, error: '충전 금액이 올바르지 않습니다. (최소 1,000원)' });
  if (!TOSS_SECRET) return res.status(500).json({ ok: false, error: '토스페이먼츠 키(TOSS_SECRET_KEY)가 아직 설정되지 않았습니다.' });

  const userInfo = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const uid = userInfo && userInfo.id;
  if (!uid) return res.status(401).json({ ok: false, error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });

  const basic = Buffer.from(`${TOSS_SECRET}:`).toString('base64');
  const conf = await fetch('https://api.tosspayments.com/v1/payments/confirm', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentKey, orderId, amount }) });
  const pay = await conf.json();
  if (!conf.ok || pay.status !== 'DONE') return res.status(400).json({ ok: false, error: (pay && pay.message) || '결제 승인에 실패했습니다.' });
  if (Number(pay.totalAmount) !== amount) return res.status(400).json({ ok: false, error: '결제 금액이 일치하지 않습니다.' });

  const svc = (path, opt = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...opt, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const memo = `toss:${paymentKey}`;
  const dup = await svc(`/point_transactions?select=id&memo=eq.${encodeURIComponent(memo)}&limit=1`).then((r) => r.json());
  if (!(Array.isArray(dup) && dup.length)) {
    const ins = await svc('/point_transactions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ owner_id: uid, type: '충전', amount, memo }) });
    if (!ins.ok) { const t = await ins.text(); return res.status(500).json({ ok: false, error: '포인트 적립 실패: ' + t.slice(0, 150) }); }
  }
  const rows = await svc(`/point_transactions?select=amount&owner_id=eq.${uid}`).then((r) => r.json());
  const balance = (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return res.status(200).json({ ok: true, charged: amount, balance });
}
