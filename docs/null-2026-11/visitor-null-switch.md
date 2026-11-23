# 방문자리뷰 '값 없음' → NULL 저장 전환 (2026-11-24 승인·배포)

## 무엇을 바꿨나
- `scraper/src/placeSearch.js` 한 줄: `visitorReviewCount` 가 null·없음·빈 값이면 **NULL**, 아니면 지금처럼 숫자.
- 근거: 11/22 오전 수집 형태 계수 — 방문자리뷰 null 580·"0" 0·숫자 37,331 (네이버는 리뷰 없음을 null 로 보낸다).
- **바꾸지 않은 것:** 블로그리뷰(네이버가 진짜 0 을 보냄 → 0 유지), 저장수(이미 NULL), 과거에 저장된 0(일괄 변경 금지 — 그대로 둔다).
- 저장 경로는 이미 NULL 을 통과시킨다: `api/db.js save_place_rankings` → `visitor_reviews: r.visitorReviews ?? … ?? null`,
  DB 함수 `save_place_rankings_atomic` 은 `jsonb_populate_recordset` 그대로 넣는다(coalesce 없음).

## 배포 전 렌더 확인 (실제 index.html + 실제 DB 값, 값 없음을 섞어 넣음)
시뮬: 우리 매장(서울쭈꾸미쌈겹) 최신일 방문자리뷰 NULL, 경쟁 스냅샷·비교표의 2·5위 방문자리뷰 NULL.
| 화면 | 결과 |
|---|---|
| SEO 1절 우리 방문자리뷰 | 값 있는 가장 최근 행 "2,040개 (11/22 기준)" |
| SEO 5절 점검표 | "방문자리뷰 30개 이상 통과"(값 있는 최근 행 기준) |
| SEO 6절 7일·30일 증가 | +8개 / +37개(값 있는 행끼리만 계산) |
| **SEO 6절 상위 10위 평균** | **1,105개 = 값 있는 8곳 평균(NULL 2곳은 분자·분모 모두 제외)**. NULL 을 0 으로 셌다면 884개 |
| SEO 7절 경쟁 표 | NULL → "-", 블로그·저장수 정상 |
| 순위 추적 카드(지표 상세) | 11/23 "리뷰 -", 화살표 없음(앞뒤 비교 안 함), NaN·undefined 없음 |
| 날짜 비교 표 | NULL → "-", 순위 변동 ▲▼ 정상 |
| 실시간 랭킹 표 | 방문자리뷰 NULL → "-", 블로그 0 → "0" |
| 임베드 | 순위만 표시 — 리뷰 값 안 씀, 정상 |
| 내보내기·정렬 | 플레이스 리뷰를 내보내거나 리뷰로 정렬하는 곳 없음(코드 확인: CSV·엑셀은 키워드 조합·검색량·블로그 순위뿐) |
→ 6절 평균은 원래 NULL 을 빼고 있어 `proposal/seo6-avg-v0` 는 넣지 않았다.
캡처: render-seo67-null.jpg, render-card-null.jpg, render-compare-null.jpg

알아 둘 점: 방문자리뷰가 원래 없는 매장은 과거 0 행을 지우지 않으므로, SEO 1절이 "0개 (11/23 기준)"처럼
마지막 0 행 날짜를 계속 보여 준다(우리 매장 중 해당 0곳).

## 되돌리는 법
1. 로컬: `git revert <이 배포 커밋>` → `git push` (Vercel 은 index.html 변화 없음).
2. 서버: `ssh blogrank 'cd /opt/blog-rank && git pull --ff-only && pm2 restart blog-rank-scraper'` — **크론 시간대 밖에**.
3. 확인: `curl http://127.0.0.1:8080/health` 200, 다음 회차 형태 로그는 그대로 쌓이고 DB 방문자리뷰 NULL 신규 행이 멈춘다.
- 되돌려도 그 사이에 들어온 NULL 행은 NULL 로 남는다(화면은 '-' 로 정상 표시). 0 으로 바꾸려면 따로 승인 받은 뒤 날짜 범위를 정해서.
