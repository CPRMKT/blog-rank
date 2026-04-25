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

export async function scrapeBlogTab(keyword, count = 15) {
  const b = await initBrowser();
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    const url =
      `https://search.naver.com/search.naver?where=blog` +
      `&query=${encodeURIComponent(keyword)}` +
      `&sm=tab_opt&nso=so:r,p:all`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 첫 결과들이 SSR 또는 initial fetch로 로딩되기까지 대기
    await page
      .waitForSelector('a[href*="blog.naver.com/"]', { timeout: 10000 })
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
      const seen = new Set();
      const out = [];
      const anchors = Array.from(
        document.querySelectorAll('a[href*="blog.naver.com/"]')
      );

      for (const a of anchors) {
        const href = a.href || '';
        const m = href.match(/blog\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{10,})/);
        if (!m) continue;
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
