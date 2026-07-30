// api/charge-confirm.js
// 토스페이먼츠 결제 승인 검증 후 포인트 적립.
//  1) 로그인 사용자 토큰 검증 → uid(충전 대상 소유자)
//  2) 토스 결제 승인 API(secret 키)로 검증 — 클라이언트 주장만으로 적립 절대 금지
//  3) 승인 성공 + 금액 일치 시 point_transactions(type=충전, amount=+금액) 기록(service_role)
//     paymentKey 중복 적립 방지(memo=toss:{paymentKey} 존재 시 skip)
//  요청: POST { paymentKey, orderId, amount }  헤더: Authorization: Bearer <세션토큰>

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SERVICE = process.env.SUPABASE_SECRET_KEY;
  const TOSS_SECRET = process.env.TOSS_SECRET_KEY;

  const authHeader = (req.headers['authorization'] || '').toString();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });

  const { paymentKey, orderId } = req.body || {};
  const amount = parseInt((req.body || {}).amount, 10);
  if (!paymentKey || !orderId) return res.status(400).json({ ok: false, error: 'paymentKey/orderId 누락' });
  if (!Number.isFinite(amount) || amount < 1000) return res.status(400).json({ ok: false, error: '충전 금액이 올바르지 않습니다. (최소 1,000원)' });
  if (!TOSS_SECRET) return res.status(500).json({ ok: false, error: '토스페이먼츠 키(TOSS_SECRET_KEY)가 아직 설정되지 않았습니다.' });

  try {
    // 1) 토큰 → uid
    const userInfo = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const uid = userInfo && userInfo.id;
    if (!uid) return res.status(401).json({ ok: false, error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });

    // 2) 토스 결제 승인
    const basic = Buffer.from(`${TOSS_SECRET}:`).toString('base64');
    const conf = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    const pay = await conf.json();
    if (!conf.ok || pay.status !== 'DONE') {
      return res.status(400).json({ ok: false, error: (pay && pay.message) || '결제 승인에 실패했습니다.' });
    }
    if (Number(pay.totalAmount) !== amount) {
      return res.status(400).json({ ok: false, error: '결제 금액이 일치하지 않습니다.' });
    }

    // 3) 포인트 적립(service_role) — 중복 방지
    const svc = (path, opt = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...opt, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    const memo = `toss:${paymentKey}`;
    const dup = await svc(`/point_transactions?select=id&memo=eq.${encodeURIComponent(memo)}&limit=1`).then((r) => r.json());
    if (!(Array.isArray(dup) && dup.length)) {
      const ins = await svc('/point_transactions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ owner_id: uid, type: '충전', amount, memo }) });
      if (!ins.ok) { const t = await ins.text(); return res.status(500).json({ ok: false, error: '포인트 적립 실패: ' + t.slice(0, 150) }); }
    }

    // 잔액 = 합산
    const rows = await svc(`/point_transactions?select=amount&owner_id=eq.${uid}`).then((r) => r.json());
    const balance = (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return res.status(200).json({ ok: true, charged: amount, balance });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
