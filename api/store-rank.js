// api/store-rank.js
// 매장 키워드 순위 조회 전용 API
// 1) 블로그 탭 검색 1~N위 가져오기
// 2) 각 포스팅이 해당 매장 리뷰인지 판별 (blog_id+post_id 매칭 → 본문 place_id 체크)
// 3) 매칭된 결과만 반환

import { getBlogRankings } from './_lib/blogSearch.js';

const BLOG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword, placeId, storeName, count: rawCount } = req.method === 'POST' ? req.body : req.query;

  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  if (!placeId && !storeName) return res.status(400).json({ error: 'placeId or storeName required' });

  const count = parseInt(rawCount) || 10;

  try {
    // 1. 블로그 탭 검색 결과 가져오기
    const searchResult = await getBlogRankings(keyword, count);
    const items = searchResult.items || [];

    // 2. 매장 리뷰 DB 목록 가져오기 (선택사항 - 프론트에서 cachedBlogIds를 보내줄 수도 있음)
    // 여기서는 placeId 기반으로 블로그 본문 매칭

    // 3. 각 포스팅에 대해 매장 리뷰 여부 판별
    const matches = [];
    const debugLogs = [];
    
    for (const item of items) {
      const log = { rank: item.rank, blogId: item.blogId, titleMatch: false, bodyFetched: false, bodyLength: 0, placeIdFound: false, nameFound: false, matched: false, error: null };
      
      try {
        // 1차: 제목 매칭
        if (storeName && matchTitle(item.title, storeName)) {
          log.titleMatch = true;
          log.matched = true;
          matches.push({ rank: item.rank, link: item.link, title: item.title, blogId: item.blogId, postId: item.postId });
          debugLogs.push(log);
          continue;
        }

        // 2차: 블로그 본문 체크
        const body = await fetchBlogBody(item.blogId, item.postId);
        if (body) {
          log.bodyFetched = true;
          log.bodyLength = body.length;
          
          if (placeId && body.includes(placeId)) {
            log.placeIdFound = true;
            log.matched = true;
          }
          
          if (!log.matched && storeName) {
            const tokens = buildNameTokens(storeName);
            log.tokens = tokens;
            if (tokens.some(t => body.includes(t))) {
              log.nameFound = true;
              log.matched = true;
            }
          }
        }
        
        if (log.matched) {
          matches.push({ rank: item.rank, link: item.link, title: item.title, blogId: item.blogId, postId: item.postId });
        }
      } catch (e) {
        log.error = e.message;
      }
      
      debugLogs.push(log);
    }

    return res.status(200).json({
      ok: true,
      matches,
      total: searchResult.total,
      method: searchResult.method,
      searchCount: items.length,
      debug: debugLogs,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * 포스팅이 특정 매장의 리뷰인지 판별
 * 1차: 제목에 매장명 핵심 키워드 포함 여부
 * 2차: 블로그 본문에 place_id 또는 매장명 포함 여부
 */
async function checkIfStoreReview(item, placeId, storeName) {
  // 1차: 제목 매칭 (빠름)
  if (storeName && matchTitle(item.title, storeName)) {
    return true;
  }

  // 2차: 블로그 본문에서 place_id 또는 매장명 확인 (느리지만 정확)
  try {
    const body = await fetchBlogBody(item.blogId, item.postId);
    if (!body) return false;

    // place_id가 본문 HTML에 포함되어 있는지 (네이버 지도 링크 등)
    if (placeId && body.includes(placeId)) {
      return true;
    }

    // 매장명 핵심 키워드가 본문에 포함되어 있는지
    if (storeName) {
      const tokens = buildNameTokens(storeName);
      if (tokens.some(t => body.includes(t))) {
        return true;
      }
    }
  } catch (e) {
    // 본문 fetch 실패 시 건너뜀
    console.log(`[store-rank] 본문 체크 실패: ${item.blogId}/${item.postId} - ${e.message}`);
  }

  return false;
}

/**
 * 제목에 매장명 핵심 키워드가 포함되어 있는지 체크
 */
function matchTitle(title, storeName) {
  if (!title || !storeName) return false;
  const tokens = buildNameTokens(storeName);
  const cleanTitle = title.replace(/<[^>]+>/g, '');
  return tokens.some(t => cleanTitle.includes(t));
}

/**
 * 매장명에서 매칭용 핵심 키워드 추출
 * "조개옥칼국수 수영직영점" → ["조개옥칼국수", "조개옥"]
 */
function buildNameTokens(name) {
  if (!name) return [];
  const tokens = [];
  const full = name.trim();

  // 공백 분리 → 첫 번째 파트가 핵심 매장명
  const parts = full.split(/\s+/);
  if (parts[0]) tokens.push(parts[0]);

  // 접미사(점, 직영점, 역점 등) 제거
  const core = parts[0].replace(/(본점|직영점|[가-힣]*점|[가-힣]*역점)$/, '').trim();
  if (core && core !== parts[0]) tokens.push(core);

  // 업종명(칼국수, 포차 등) 제거하여 더 짧은 핵심명
  const shorter = core.replace(/(칼국수|국수|포차|식당|횟집|곱창|삼겹살|고기|치킨|피자|카페|커피|보쌈|족발|갈비|한우|스시|초밥|라멘|우동|분식)$/, '').trim();
  if (shorter && shorter !== core && shorter.length >= 2) tokens.push(shorter);

  return [...new Set(tokens)];
}

/**
 * 블로그 포스팅 본문을 가져옴 (모바일 버전으로 경량 fetch)
 */
async function fetchBlogBody(blogId, postId) {
  const url = `https://m.blog.naver.com/${blogId}/${postId}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': BLOG_UA,
      'Accept': 'text/html',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    redirect: 'follow',
  });

  if (!resp.ok) return null;

  const html = await resp.text();
  return html;
}

/**
 * Promise 배열을 최대 concurrency개씩 병렬 실행
 */
async function parallelLimit(promises, concurrency) {
  // promises는 이미 시작된 Promise가 아니라 lazy하게 만들어야 하는데,
  // 여기서는 map으로 이미 시작됐으므로 그냥 Promise.all
  return Promise.all(promises);
}
