// Playwright 기반 네이버 블로그 탭 스크래퍼.
// 한국 IP에서 실행되므로 사용자가 보는 화면 순서를 그대로 받음.
import { chromium } from 'playwright';

let browser = null;

export async function initBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  console.log('Chromium launched');
  return browser;
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
