# blog-rank 핸드오프 요약

> 이 문서 하나로 프로젝트 전체를 파악·인수할 수 있게 정리. 실제 키·비밀번호 값은 없음(이름만).
> 최종 업데이트: 2026-07-27 · 저장소: `github.com/CPRMKT/blog-rank` · 라이브: `https://blog-rank-phi.vercel.app`
> 더 자세한 인프라: `docs/INFRA-INVENTORY.md`, 실행한 DB SQL 기록: `sql/` 폴더.

## 한 줄 소개
네이버 **블로그·플레이스 검색 순위를 매장별로 자동 추적**하는 소상공인용 셀프 마케팅 웹앱. **회원가입(아이디 로그인) + 계정별 데이터 완전 격리(멀티테넌트)** 적용됨.

## 기술 스택
- **프론트**: 단일 정적 `index.html`(바닐라 JS, 빌드 없음). Supabase JS SDK(CDN).
- **API**: Vercel 서버리스 함수(`api/*.js`, 순수 Node, Next.js 아님).
- **DB/인증**: Supabase(Postgres + PostgREST + RLS + Auth).
- **스크래퍼**: NCP 서버(한국 IP) Playwright, PM2 상시구동 `:8080`. 매일 크론 자동수집.

## 주요 기능 (전부 라이브)
- 회원가입/로그인(아이디 기반) + 로그인 필수 게이트 + 계정별 격리
- 포스팅 순위 조회(블로그 글 키워드 순위·검색량·경쟁지수, 엑셀)
- 매장 블로그 순위(매장별 키워드 블로그탭 순위 날짜추적, NEW/▲▼/이탈)
- 플레이스 순위 추적(매장별 키워드 플레이스 1~50위 날짜추적, 저장·리뷰 지표)
- 플레이스 키워드 분석(실시간 랭킹 + 날짜 비교)
- 키워드 제안(플레이스 URL→Claude 분석→조합+검색량)
- 매장 등록/삭제(블로그·플레이스 탭 각각 독립), 매장 드롭다운 검색

## 회원 / 계정 격리 (핵심)
- **로그인 = 아이디+비번.** 내부적으로 아이디를 `{아이디}@users.blogrank.internal` 합성이메일로 변환해 Supabase Auth 사용. 실제 이메일은 연락용으로 `profiles`에만 저장.
- **격리**: 소유 테이블 8개(stores, store_keywords, store_rankings, store_blog_posts, store_place_fetches, store_place_keywords, place_keywords, place_rankings)에 `owner_id` + RLS `owner all`(auth.uid()=owner_id) 하나로만 보호. 개방정책 전부 삭제됨.
- **API 시행**: `api/db.js`가 로그인 사용자는 JWT로 RLS 격리, 크론은 `CRON_SECRET` 헤더로 service_role 우회.
- **현재 계정**: 사장님 실계정 **`cprmkt`** — 기존 데이터 1,268행 전부 이 계정 소유로 이전 완료.

## 인프라 계정 (티어는 대시보드 확인 필요)
| 서비스 | 용도 |
|---|---|
| Vercel(`blog-rank-phi`) | 프론트+API 호스팅. `main` push=자동배포 |
| Supabase | DB·인증. service_role/anon 키 사용 |
| NCP VM(~1GB) | Playwright 스크래퍼 + 수집 크론(SSH키 접속) |
| Anthropic(Claude) | 키워드 제안 |
| 네이버 검색광고/OpenAPI | 검색량·경쟁, 블로그검색 폴백 |

## 운영 방법
- **프론트/API 배포**: 코드 수정 → `main` push → Vercel 자동배포.
- **스크래퍼**: NCP `/opt/blog-rank/scraper` 갱신 후 `pm2 reload blog-rank-scraper`.
- **크론(KST)**: 06:00 블로그(collect.mjs), 06:30·18:30 플레이스(collectPlace.mjs). `/api/db` 호출 시 `CRON_SECRET`로 인증, 계정별 수집.
- **DB 변경**: `sql/*.sql`을 Supabase SQL Editor에서 수동 실행(마이그레이션 툴 없음). 실행한 SQL은 `sql/`에 파일로 보관.

## 환경변수 이름 (값 제외)
- Vercel: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_ANON_KEY`, `CRON_SECRET`, `KOREAN_SCRAPER_URL`, `KOREAN_SCRAPER_KEY`, `ANTHROPIC_API_KEY`(+`SUGGEST_MODEL`), `NAVER_AD_LICENSE`/`NAVER_AD_SECRET`/`NAVER_AD_CUSTOMER_ID`, `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, (`SEARCH_METHOD`)
- NCP 서버 `.env`: `PORT`, `SCRAPER_API_KEY`, `CRON_SECRET`

## 미완 / 후속 과제
1. 크롤·컴퓨트 엔드포인트(place-search 등)는 아직 **무인증 공개**(사용자 데이터는 안전, 쿼터 남용만 우려) → 토큰 게이팅 하드닝 필요.
2. 포스팅 순위 조회(blogs/posts/rank_history)는 **계정 격리 제외**(공용) — 추후 분리.
3. 실제 이메일 인증(확인메일) 미구현.
4. 알림/리포트, 에러 모니터링, 스크래퍼 이중화, 테스트/CI 없음.
5. 검증용 임시계정 `cprtest_zz01`은 Supabase 대시보드에서 삭제 권장(데이터 없음).
