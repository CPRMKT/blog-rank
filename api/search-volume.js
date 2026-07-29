// api/search-volume.js
// 키워드 목록의 월 검색량(PC+모바일 합계)을 반환. 매장 순위 탭에서 사용.
//   GET  /api/search-volume?keywords=수영 굴보쌈,담양 점심 맛집
//   POST /api/search-volume  { keywords: ["...", "..."] }

import { fetchSearchVolumes, normalizeKeyword as norm } from './_lib/searchAd.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const raw =
      req.method === 'POST' ? req.body?.keywords : req.query.keywords;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!list.length) {
      return res.status(400).json({ ok: false, error: 'keywords가 필요합니다' });
    }

    const volumes = await fetchSearchVolumes(list);
    const out = {};
    for (const k of list) {
      const v = volumes.get(norm(k));
      out[k] = v
        ? { total: v.total, pc: v.pc, mobile: v.mobile, compIdx: v.compIdx || null }
        : null;
    }
    return res.status(200).json({ ok: true, hasVolume: volumes.size > 0, volumes: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
