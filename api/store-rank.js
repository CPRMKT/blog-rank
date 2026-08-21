// api/store-rank.js
// 매장 키워드 순위 조회 — 얇은 프록시.
// 무거운 딥스캔·매칭(최대 300위, 본문 확인, 조기종료)은 NCP 스크래퍼(/blog-rank)에서
// 수행한다. 이 Vercel 함수는 스크래퍼 호출·응답 전달만 담당한다.
// 스크래퍼 딥스캔이 최대 ~55초까지 걸릴 수 있어 함수 실행시간을 60초로 늘린다.
import { getStoreRank } from './_lib/blogSearch.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const src = req.method === 'POST' ? (req.body || {}) : req.query;
  const keyword = (src.keyword || '').toString().trim();
  const placeId = (src.placeId || '').toString().trim();
  const storeName = (src.storeName || '').toString().trim();
  const maxRank = Math.min(300, Math.max(1, parseInt(src.count, 10) || 300));

  if (!keyword) return res.status(400).json({ ok: false, error: 'keyword required' });
  if (!placeId && !storeName) return res.status(400).json({ ok: false, error: 'placeId or storeName required' });

  try {
    const r = await getStoreRank(keyword, { placeId, storeName, maxRank });
    return res.status(200).json({
      ok: true,
      matched: r.matched,
      matches: r.items || [],   // [{rank,link,title,blogId,postId}] — 매칭 시 1건(가장 높은 순위), 없으면 []
      total: r.scanned || 0,    // 스캔한 최대 순위(대략적 규모)
      searchCount: r.scanned || 0,
      method: 'playwright',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
