// Playwright 기반 네이버 블로그 탭 스크래퍼.
// 한국 IP에서 실행되므로 사용자가 보는 화면 순서를 그대로 받음.
import { chromium } from 'playwright';

let browser = null;
let launching = null; // 동시 호출 시 중복 launch 방지

// 크롬이 죽으면(크래시·강제종료) 죽은 싱글턴을 계속 돌려주며 전 요청이 실패하던 문제 →
// isConnected() 헬스체크 후 죽어 있으면 즉시 재기동한다(자가복구).
export async function initBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    if (browser) {
      console.log('Chromium dead — relaunching');
      await browser.close().catch(() => {});
      browser = null;
    }
    const b = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    b.on('disconnected', () => { if (browser === b) browser = null; });
    browser = b;
    console.log('Chromium launched');
    return b;
  })();
  try { return await launching; } finally { launching = null; }
}

export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// sort: 'date'(최신순, 매장 블로그 순위 기본) | 'rel'(관련도순, 포스팅 순위 조회)
export async function scrapeBlogTab(keyword, count = 15, sort = 'date') {
  const b = await initBrowser();
  // 모바일 컨텍스트로 접속한다. 데스크톱 검색 페이지는 이 서버 환경에서
  // 최신순 조직 결과 대신 "인기글"(인기순) 모듈만 렌더되는 경우가 있어
  // 순위가 어긋난다. 모바일 블로그탭은 최신순 목록을 안정적으로 내려준다.
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });

  // 리소스 차단: 이미지/미디어/폰트/CSS + 트래킹 요청을 막아 로딩 시간과
  // 메모리 사용을 크게 줄인다(1GB 서버에서 domcontentloaded 60초 타임아웃 방지).
  // 순위 추출에 필요한 건 HTML/DOM 뿐이라 렌더 리소스는 불필요.
  // stylesheet는 남긴다(무한스크롤이 레이아웃 높이에 의존할 수 있으므로).
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    const u = route.request().url();
    if (/(nlog\.naver|wcs\.naver|ad\.naver|adcr\.naver|siadge|googletagmanager|google-analytics|doubleclick)/.test(u)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  try {
    // 모바일 블로그탭. 데스크톱 URL은 이 서버에서 인기글 모듈만 렌더되는
    // 문제가 있어 모바일을 쓴다. sort=date(최신순) / nso=so:r(관련도순).
    const sortParam = sort === 'rel' ? '&nso=so%3Ar%2Cp%3Aall' : '&sort=date';
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all` +
      `&query=${encodeURIComponent(keyword)}${sortParam}`;

    // waitUntil:'commit'은 최초 응답 직후 반환되므로, 무거운 페이지 전체
    // 파싱을 기다리다 나는 타임아웃을 피한다. 결과는 아래 selector 대기로 확인.
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    // 결과 앵커가 렌더될 때까지 대기(commit 이후 ~15초 내 로딩되는 것을 실측 확인).
    await page
      .waitForSelector('a[href*="blog.naver.com/"]', { timeout: 30000 })
      .catch(() => {});

    // 무한스크롤로 추가 결과 로딩.
    // 한 페이지당 약 7~8개 보여주므로 count 채우려면 (count/7 + 여유) 회 스크롤.
    const scrollIterations = Math.max(2, Math.ceil(count / 7) + 2);
    let prevCount = 0;
    let stableLoops = 0;
    for (let i = 0; i < scrollIterations + 5; i++) {
      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="blog.naver.com/"]').length;
      });

      // 더 이상 늘지 않으면 2회 더 시도하고 중단
      if (currentCount === prevCount) {
        stableLoops++;
        if (stableLoops >= 2) break;
      } else {
        stableLoops = 0;
      }
      prevCount = currentCount;
      // 충분히 모았으면 조기 종료 (count는 고유 게시물 기준이라 약간 여유)
      if (currentCount >= count * 2) break;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(900);
    }

    // DOM에서 결과를 출현 순서로 추출 (네이버 화면 그대로의 순위)
    const items = await page.evaluate((maxCount) => {
      // 조직(최신순) 결과 링크만 후보로 수집.
      const matched = Array.from(
        document.querySelectorAll('a[href*="blog.naver.com/"]')
      ).filter((a) => /blog\.naver\.com\/[a-zA-Z0-9_]+\/\d{10,}/.test(a.href || ''));
      const total = matched.length;

      // 네이버는 결과 상단/중간에 "○○ 인기글", 인플루언서, 파워링크(광고) 같은
      // 비조직 모듈을 끼워 넣는다. 이 모듈의 게시물 링크가 조직 결과보다 먼저
      // 잡히면 실제 1위가 2위로 밀린다(rank 밀림 버그). 해당 모듈 영역의 링크는 제외.
      // 섹션 헤더(h2/h3)만 검사해 게시물 제목 오탐을 피한다.
      const NON_ORGANIC = /(인기글|인플루언서|파워링크|비즈사이트|광고|스폰서|추천)/;
      const badRoots = [];
      document.querySelectorAll('h2, h3').forEach((h) => {
        const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 30 || !NON_ORGANIC.test(t)) return;
        // 헤더에서 위로 올라가며 모듈 카드 컨테이너를 찾는다(최대 4단계).
        let root = h;
        for (let i = 0; i < 4 && root.parentElement; i++) {
          root = root.parentElement;
          if (
            /api_subject_bx|sds-comps-vertical-layout|sc_new|_svp_/i.test(
              (root.className || '').toString()
            )
          )
            break;
        }
        // 안전밸브: root가 전체 링크의 절반 이상을 포함하면 조직 목록까지
        // 삼킨 것이므로 무시한다(조직 결과 유실 방지).
        const covered = matched.filter((a) => root.contains(a)).length;
        if (root !== document.body && covered > 0 && covered <= total / 2) {
          badRoots.push(root);
        }
      });
      const inNonOrganic = (a) => badRoots.some((r) => r.contains(a));

      const seen = new Set();
      const out = [];
      const anchors = matched;

      for (const a of anchors) {
        const href = a.href || '';
        const m = href.match(/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/);
        if (!m) continue;
        if (inNonOrganic(a)) continue; // 광고/인기글 등 비조직 모듈 링크 스킵
        const blogId = m[1];
        const postId = m[2];
        const key = `${blogId}/${postId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // 제목: 해당 a 태그의 텍스트 또는 가까운 title 요소
        let title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || title.length < 5) {
          // 부모 element 안에서 의미있는 텍스트 찾기
          const parent = a.closest('div, li, article') || a.parentElement;
          if (parent) {
            const titleEl = parent.querySelector(
              '[class*="title"], [class*="Title"], strong, h3, h2'
            );
            if (titleEl) title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          }
        }

        out.push({
          rank: out.length + 1,
          link: `https://blog.naver.com/${blogId}/${postId}`,
          title: title.substring(0, 200),
          blogId,
          postId,
        });
        if (out.length >= maxCount) break;
      }
      return out;
    }, count);

    return items;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── 매장 순위 딜스캔(최대 maxRank위) + 매칭 조기종료 ──────────
// 스크롤로 결과를 순차 확장하며 각 결과가 우리 매장 글인지 판별한다.
//   · 0~30위(BODY_CHECK_LIMIT): 조기종료 없이 전수 스캔해 매칭 글 전부 수집(다중 매칭 보존)
//   · 30위 밖: 30위 안에서 매칭이 하나도 없을 때만 계속 진행하고, 첫 매칭에서 즉시 종료
// 매칭 신호: (1) 제목/스니펫에 매장명 토큰  (2) 상위 BODY_CHECK_LIMIT위 한정 본문 place_id/매장명.
const RANK_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const BODY_CHECK_LIMIT = 30;   // 이름 매칭 실패 시 본문까지 확인할 최대 순위
const RANK_SCROLL_WAIT = 700;

// region-check식 토큰(업종명 유지, 통짜 상호명) — "태전" 같은 과매칭 방지.
function rankNameTokens(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const squash = (x) => x.replace(/\s+/g, '');
  const out = new Set();
  const full = squash(raw);
  if (full.length >= 3) out.add(full);
  const first = raw.split(/\s+/)[0] || '';
  if (first.length >= 3) out.add(squash(first));
  const noBranch = raw.replace(/\s*[가-힣A-Za-z0-9]*(?:본점|직영점|점)\s*$/, '').trim();
  if (noBranch && squash(noBranch).length >= 3) out.add(squash(noBranch));
  return [...out];
}

async function fetchBlogBodyNode(blogId, postId, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://m.blog.naver.com/${blogId}/${postId}`, {
      headers: { 'User-Agent': RANK_UA, Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

// 페이지에서 조직(최신순) 결과를 순서대로 추출 (title + 스니펫 text 포함). page.evaluate로 주입.
function extractOrganicWithText(maxCount) {
  const matched = Array.from(document.querySelectorAll('a[href*="blog.naver.com/"]'))
    .filter((a) => /blog\.naver\.com\/[a-zA-Z0-9_]+\/\d{10,}/.test(a.href || ''));
  const total = matched.length;
  const NON_ORGANIC = /(인기글|인플루언서|파워링크|비즈사이트|광고|스폰서|추천)/;
  const badRoots = [];
  document.querySelectorAll('h2, h3').forEach((h) => {
    const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 30 || !NON_ORGANIC.test(t)) return;
    let root = h;
    for (let i = 0; i < 4 && root.parentElement; i++) {
      root = root.parentElement;
      if (/api_subject_bx|sds-comps-vertical-layout|sc_new|_svp_/i.test((root.className || '').toString())) break;
    }
    const covered = matched.filter((a) => root.contains(a)).length;
    if (root !== document.body && covered > 0 && covered <= total / 2) badRoots.push(root);
  });
  const inNonOrganic = (a) => badRoots.some((r) => r.contains(a));
  const seen = new Set();
  const out = [];
  for (const a of matched) {
    const href = a.href || '';
    const m = href.match(/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/);
    if (!m) continue;
    if (inNonOrganic(a)) continue;
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const card = a.closest('li, div, article') || a.parentElement;
    let text = '';
    if (card) text = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!title || title.length < 5) {
      if (card) {
        const te = card.querySelector('[class*="title"], [class*="Title"], strong, h3, h2');
        if (te) title = (te.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    out.push({ rank: out.length + 1, link: `https://blog.naver.com/${m[1]}/${m[2]}`, title: title.slice(0, 200), text, blogId: m[1], postId: m[2] });
    if (out.length >= maxCount) break;
  }
  return out;
}

export async function scrapeBlogRank(keyword, opts = {}) {
  const placeId = (opts.placeId || '').toString();
  const storeName = (opts.storeName || '').toString();
  const maxRank = Math.min(300, Math.max(1, parseInt(opts.maxRank, 10) || 300));
  const tokens = rankNameTokens(storeName);
  const b = await initBrowser();
  const context = await b.newContext({
    userAgent: RANK_UA, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    const url = `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all&query=${encodeURIComponent(keyword)}&sort=date`;
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForSelector('a[href*="blog.naver.com/"]', { timeout: 30000 }).catch(() => {});

    const t0 = Date.now();
    const budgetMs = Math.min(120000, Math.max(10000, parseInt(opts.budgetMs, 10) || 55000));
    const checked = new Set();
    const found = [];          // 매칭된 글 전부(30위 이내 다중 매칭 보존)
    let scanned = 0, lastLen = 0, stable = 0, done = false;
    const maxScrolls = Math.ceil(maxRank / 7) + 12;

    for (let s = 0; s <= maxScrolls && !done; s++) {
      if (Date.now() - t0 > budgetMs) break; // 시간 예산 초과 → 여기까지 스캔한 선에서 종료
      const list = await page.evaluate(extractOrganicWithText, maxRank);

      for (const item of list) {
        if (item.rank > maxRank) { done = true; break; }
        const key = `${item.blogId}/${item.postId}`;
        if (checked.has(key)) continue;
        checked.add(key);
        if (item.rank > scanned) scanned = item.rank;

        // 이미 30위 이내 매칭을 확보했는데 30위를 벗어났다 → 전수 수집 끝(딥 진입 불필요)
        if (found.length > 0 && item.rank > BODY_CHECK_LIMIT) { done = true; break; }

        const hay = `${item.title} ${item.text || ''}`;
        let hit = tokens.length > 0 && tokens.some((t) => hay.includes(t));
        if (!hit && placeId && item.rank <= BODY_CHECK_LIMIT) {
          const body = await fetchBlogBodyNode(item.blogId, item.postId);
          if (body && (body.includes(placeId) || tokens.some((t) => body.includes(t)))) hit = true;
        }
        if (hit) {
          found.push({ rank: item.rank, link: item.link, title: item.title, blogId: item.blogId, postId: item.postId });
          // 30위 밖에서의 첫 매칭 → 즉시 종료(딥 조기종료). 30위 이내면 계속 스캔(전수 수집).
          if (item.rank > BODY_CHECK_LIMIT) { done = true; break; }
        }
      }
      if (done) break;

      // 30위까지 전부 확인됐고 그 안에 매칭이 있으면 → 딥 진입 없이 종료(전수 수집 완료)
      if (scanned >= BODY_CHECK_LIMIT && found.length > 0) break;

      if (list.length >= maxRank) break;
      if (list.length === lastLen) { stable++; if (stable >= 2) break; } else stable = 0;
      lastLen = list.length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(RANK_SCROLL_WAIT);
    }

    found.sort((a, b) => a.rank - b.rank);
    return { matched: found.length > 0, rank: found.length ? found[0].rank : null, scanned, items: found };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
