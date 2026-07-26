# blog-rank — 인프라 · 구조 인벤토리

> 다른 AI/개발자에게 프로젝트 컨텍스트를 넘기기 위한 핸드오프 문서.
> **실제 키·비밀번호·토큰 값은 포함하지 않음.** "무엇이 존재하는지"와 "환경변수 이름"만 정리.
> 기준일: 2026-07-25 · 저장소: `github.com/CPRMKT/blog-rank` · 라이브: `https://blog-rank-phi.vercel.app`

프로젝트 한 줄 요약: **네이버 블로그/플레이스 검색 순위를 매장별로 자동 추적하는 소상공인용 셀프 마케팅 도구.** 정적 HTML 프론트 + Vercel 서버리스 API + 한국(NCP) Playwright 스크래퍼 + Supabase(Postgres).

---

## 1. 사용 중인 서비스 계정 / 티어

| 서비스 | 용도 | 티어/사양 | 비고 |
|---|---|---|---|
| **Vercel** | 프론트(정적 HTML) + `/api/*` 서버리스 함수 호스팅 | 코드로는 확인 불가 — **Hobby/Free 추정** | 프로젝트명 `blog-rank-phi`, GitHub 연동 자동배포 |
| **Supabase** | Postgres DB + PostgREST(REST) + RLS | 코드로는 확인 불가 — **Free 추정** | 프로젝트 ref는 `SUPABASE_URL`에 포함. service_role 키로 접근 |
| **NCP (네이버 클라우드)** | Playwright 스크래퍼 + 수집 크론 상시 구동 | **Micro급 VM(약 1GB RAM/1 vCPU), Ubuntu** | IP `175.45.200.77`, root, 2GB 스왑 추가됨. pm2로 상시 실행 |
| **Anthropic (Claude API)** | "키워드 제안" 탭에서 지역/메뉴/상황 요소 추출 | 사용량 기반 | 기본 모델 `claude-haiku-4-5-20251001`(env로 override) |
| **네이버 검색광고 API** | 키워드 월 검색량·경쟁지수 (keywordstool) | 무료 API(사업자 계정) | HMAC 서명(license/secret/customer id) |
| **네이버 검색 OpenAPI** | 블로그 검색 폴백(sort=sim) | 무료 API | 스크래퍼 실패 시 폴백 경로 |
| **GitHub** | 소스 저장소 `CPRMKT/blog-rank` | - | NCP 서버에 배포키(SSH) 등록 → 서버에서 `git push`로 배포 |

> ⚠️ **티어(요금제)는 코드에서 알 수 없음.** Vercel/Supabase 대시보드에서 직접 확인 필요.

---

## 2. Supabase 구조 (테이블 · 주요 컬럼 · 관계)

모든 접근은 Vercel `api/db.js`가 PostgREST로 프록시. RLS 활성 + permissive 정책(앱은 service_role 키라 우회).

### 포스팅 순위 조회 계열
- **`blogs`** — 등록된 블로그 목록. `blog_id`, `created_at` (bulk 등록, merge-duplicates).
- **`posts`** — 블로그 포스트 캐시. merge-duplicates.
- **`rank_history`** — 포스트별 순위 이력. `post_url`, `rank`, `checked_at` (post_url별 최근 30건 조회).

### 매장(마스터) + 블로그 순위 계열
- **`stores`** ⭐마스터 — `id`(PK), `place_id`, `name`, `place_url`, `category`, `address`, `phone`, `created_at`, `updated_at`, **`in_blog` bool**, **`in_place` bool**.
  - `in_blog`/`in_place` = 탭별 소속 플래그(2026-07-25 추가). "매장 블로그 순위"는 `in_blog`, "플레이스 순위 추적"은 `in_place`로 필터 → 두 탭 매장 목록 독립.
- **`store_keywords`** — 매장별 **블로그** 추적 키워드. `id`, `store_id`→stores, `keyword`, `created_at`.
- **`store_rankings`** — 매장 블로그 순위 일별 스냅샷. `store_id`, `keyword`, `checked_date`, `rank`, `matched_blog_url`, `matched_title`, `search_volume`, **`matches` jsonb**(우리 매장 블로그 전부 `[{rank,url,title}]`), `created_at`.
- **`store_blog_posts`** — 매장 네이버 플레이스 등록 블로그 리뷰 캐시. `store_id`, `blog_url`, `blog_id`, `post_id`, `title`.
- **`store_place_fetches`** — 위 캐시 갱신 메타. `store_id`, `fetched_at`, `post_count`, `success`, `error_msg`.

### 플레이스 순위 계열
- **`place_keywords`** — **전역** 플레이스 추적 키워드(매장 무관). `id`, `keyword`(unique), `created_at`. ("플레이스 키워드 분석" 탭의 "추적에 추가").
- **`store_place_keywords`** — 매장별 **플레이스** 추적 키워드. `id`, `store_id`→stores(FK, ON DELETE CASCADE), `keyword`, `created_at`, `unique(store_id,keyword)`. ("플레이스 순위 추적" 탭).
- **`place_rankings`** — 키워드×날짜별 플레이스 검색 1~50위 스냅샷(place당 1행). `id`, `keyword`, `checked_date`, `rank`, `place_id`, `name`, `category`, `visitor_reviews`, `blog_reviews`, **`saves`**(저장수, 네이버 반올림), `created_at`.

### 관계 요약
- `store_keywords / store_rankings / store_blog_posts / store_place_fetches / store_place_keywords` → **`stores.id`** (매장 FK).
- `place_rankings.keyword` ↔ `place_keywords.keyword` / `store_place_keywords.keyword` (문자열 매칭, FK 아님). 크론이 두 키워드 소스를 합쳐 수집.
- **"우리 매장 플레이스 순위"** = `place_rankings`에서 `place_id == stores.place_id`인 행으로 파생(별도 metrics 테이블 없음).
- `rank_history.post_url` ↔ `posts`.
- 스키마 마이그레이션 파일: `sql/2026-07-23_place_tracking.sql`, `sql/2026-07-25_store_tab_flags.sql` (수동 실행. 마이그레이션 툴 없음).

---

## 3. Vercel 배포 구조

- **도메인**: `https://blog-rank-phi.vercel.app`
- **연결 저장소**: `github.com/CPRMKT/blog-rank`, **`main` 브랜치 push = 프로덕션 자동배포**.
- **빌드**: 없음(정적 `index.html` + `api/*.js` 서버리스 함수). Next.js/번들러 미사용. 루트 `package.json`·`vercel.json` 없음 → Vercel 기본 감지.
- **API 함수** (`/api/*`, 전부 Node 런타임 · 전역 `fetch` 사용):
  | 엔드포인트 | 역할 |
  |---|---|
  | `db.js` | Supabase REST 프록시(모든 CRUD 액션. `action` 파라미터로 분기) |
  | `place.js` | 네이버 플레이스 조회(URL 파싱/매장정보/리뷰수 detail·리뷰목록 fetch) |
  | `place-search.js` | NCP 스크래퍼 `/place-search` 프록시(플레이스 1~50위) |
  | `store-rank.js` | 매장 키워드 블로그 순위(블로그탭 검색 → 매장 리뷰 매칭) |
  | `search.js` | 블로그 탭 순위 검색(스크래퍼/직접/OpenAPI 폴백) |
  | `search-volume.js` | 키워드 월 검색량(검색광고 API) |
  | `keyword.js` | 키워드 검색량·경쟁지수(검색광고 keywordstool) |
  | `posts.js` | 블로그 RSS로 포스트 목록 수집 |
  | `suggest-keywords.js` | 매장 크롤 → Claude 요소추출 → 조합 → 검색량 → TOP 80 |
  | `_lib/blogSearch.js` | 블로그 검색 통합(korean 스크래퍼 → direct → naver_api) |
  | `_lib/naverPlace.js` | 플레이스 URL 파싱·Apollo state 파싱·리뷰 크롤 |
  | `_lib/searchAd.js` | 네이버 검색광고 HMAC 서명 |
- **환경변수 이름(값 제외)** — Vercel 프로젝트에 설정됨:
  - Supabase: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
  - 스크래퍼 연동: `KOREAN_SCRAPER_URL`, `KOREAN_SCRAPER_KEY`
  - Claude: `ANTHROPIC_API_KEY`, `SUGGEST_MODEL`(선택)
  - 네이버 검색광고: `NAVER_AD_LICENSE`, `NAVER_AD_SECRET`, `NAVER_AD_CUSTOMER_ID`
  - 네이버 OpenAPI(폴백): `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
  - 검색 방식 전환(선택): `SEARCH_METHOD` (`korean`(기본)/`direct`/`naver_api`/`auto`)

> 환경변수 변경 후에는 재배포해야 반영(빈 커밋 push로 트리거 가능).

---

## 4. NCP 스크래퍼 서버

- **용도**: 네이버는 IP/지역에 따라 검색 순서가 달라져, **한국 IP에서 실브라우저(Playwright/Chromium)로 직접 스크랩**해야 사용자가 보는 순위와 일치. Vercel 함수가 이 서버를 호출.
- **구동**: `/opt/blog-rank/scraper`, PM2 프로세스 `blog-rank-scraper`(fork, `max_memory_restart 800M`), 포트 `:8080`. 로그 `/var/log/blog-rank-scraper/`.
- **HTTP 라우트**(Bearer `SCRAPER_API_KEY` 인증):
  - `GET /health`
  - `GET /scrape?keyword=&count=` — 블로그 탭 순위(모바일 `m.search`, 최신순 sort=date)
  - `GET /place-search?keyword=&count=` — 플레이스 검색 1~50위(m.place graphql 캡처, 저장수 포함)
- **수집 크론(KST)** — Vercel `/api/*` 호출로 수집 후 Supabase 저장:
  | 시각 | 스크립트 | 대상 |
  |---|---|---|
  | 06:00 | `collect.mjs` | 매장 블로그 순위(list_stores→store_keywords→`/api/store-rank`→save_store_ranking) |
  | 06:30 · 18:30 | `collectPlace.mjs` | 플레이스 순위(place_keywords+store_place_keywords 합집합→`/api/place-search`→save_place_rankings) |
- **데이터 흐름**: `크론(NCP) → Vercel /api/db·/api/store-rank·/api/place-search → (스크래퍼 :8080) → Supabase`. 자격증명은 Vercel만 보유(서버엔 `SCRAPER_API_KEY`, `COLLECTOR_BASE_URL`, `DRY_RUN`만).
- **접근**: 비밀번호 로그인 비활성, **SSH 키 전용**(사용자 PC alias `blogrank`). GitHub push는 서버의 배포키로.

---

## 5. 폴더 / 코드 구조

```
blog-rank/
├─ index.html          # 프론트 전체(단일 파일 SPA풍) — 모든 탭 UI+JS+CSS
├─ store.html          # 구버전(localStorage 기반) — 현재 미사용/레거시
├─ api/                # Vercel 서버리스 함수(플랫, 프레임워크 없음)
│  ├─ db.js            # Supabase REST 프록시(핵심)
│  ├─ place.js / place-search.js / store-rank.js / search.js
│  ├─ search-volume.js / keyword.js / posts.js / suggest-keywords.js
│  └─ _lib/            # blogSearch.js, naverPlace.js, searchAd.js (공용 로직)
├─ scraper/            # NCP 서버용(별도 배포 단위)
│  ├─ src/server.js    # express 진입점(:8080, 인증)
│  ├─ src/scraper.js   # 블로그탭 Playwright 스크래퍼
│  ├─ src/placeSearch.js # 플레이스 검색 스크래퍼
│  ├─ collect.mjs / collectPlace.mjs # 수집 크론 스크립트
│  ├─ ecosystem.config.cjs # PM2 정의
│  └─ package.json     # express, playwright
├─ sql/                # 수동 실행 마이그레이션(.sql)
└─ docs/INFRA-INVENTORY.md # (이 문서)
```

---

## 6. 구현된 기능 (되는 것 / 안 되는 것)

### ✅ 되는 것
- **포스팅 순위 조회**: 블로그 ID 대량 등록 → 포스트별 키워드 순위(상위 100), 검색량·경쟁지수, 엑셀 다운로드.
- **매장 블로그 순위**: 매장 등록(플레이스 URL 크롤) → 키워드별 블로그탭 순위 날짜추적, 다중 블로그 `matches`, 변동(▲▼/NEW/이탈), 매일 06:00 자동수집.
- **플레이스 순위 추적**(매장 중심): 매장별 키워드 등록 → 날짜별 플레이스 순위 카드(6일/줄, 12→30일), 지표 상세(순위/저장/방문자리뷰/블로그), 요일 표시, 즉시수집("조회 중"), 매일 06:30·18:30 자동수집.
- **플레이스 키워드 분석**(키워드 중심): 실시간 랭킹 1~50위 + 우리 매장 하이라이트, 날짜별 비교.
- **키워드 제안**: 플레이스 URL → Claude 분석 → 조합 키워드 + 월검색량 → 추적 추가.
- **매장 목록 탭별 독립**(블로그/플레이스 각각 등록·삭제), 매장 드롭다운 검색.
- **순위 변동 색상** 한국 증시 관례(상승=빨강/하락=파랑).

### ❌ 안 되는 것 / 없는 것
- **로그인·계정·권한 없음** — 누구나 URL로 전체 데이터 열람. 멀티테넌트 아님.
- **알림/통지 없음** — 이메일·푸시·슬랙 등 순위변동 알림 미구현.
- **`/api/db` 등 엔드포인트 인증 없음** — CORS `*` + 무인증. 누구나 호출 가능(서버측 service_role 키 사용)이라 **읽기/쓰기 노출 위험**.
- **자동 테스트/CI 없음**, 에러 모니터링(Sentry 등) 없음.
- 블로그 순위는 **최신순(sort=date)** 기준(관련도순 아님) — 의도된 동작.
- 일부 키워드에서 플레이스 스크래퍼가 간헐적 0건(네이버 측 변동).

---

## 7. 사용 중인 패키지 / 프레임워크

- **프론트엔드**: 프레임워크 **없음**. 단일 정적 `index.html`(바닐라 JS + 인라인 CSS). 폰트만 Pretendard CDN. 빌드 스텝 없음.
- **Vercel API**: **Next.js 아님.** 순수 Node 서버리스 함수(ESM), 외부 npm 의존성 없이 **Node 내장 `fetch`·`crypto`만** 사용. 루트 `package.json` 없음.
- **스크래퍼(NCP)**: Node ≥20(ESM). 의존성 **`express` ^4.18.2, `playwright` ^1.40.0**. 프로세스 매니저 **PM2**. Chromium 헤드리스.
- **DB 접근**: ORM 없음 — Supabase **PostgREST REST** 직접 호출(`api/db.js`).

---

## 8. 없는 것 / 확장이 필요한 부분

1. **인증·보안** (최우선): `/api/*`(특히 `db.js`)에 인증/레이트리밋 없음 → 데이터 무단 읽기/쓰기 가능. 프론트 로그인도 없음. 멀티 매장주 SaaS로 가려면 인증+RLS 실질화 필수.
2. **알림/리포트**: 순위 급변·신규 진입·이탈 시 이메일/카톡/슬랙 알림, 주간 요약 리포트 없음.
3. **관측성**: 에러 모니터링, 크론 실패 알림, 스크래퍼 헬스체크 대시보드 없음.
4. **스크래퍼 이중화**: NCP 단일 서버 = SPOF. 다운 시 전체 순위수집 중단(재시도/폴백 서버 없음). 1GB RAM 메모리 압박 이력.
5. **마이그레이션 관리**: 스키마 변경이 수동 `.sql` 실행 → 버전관리/롤백 체계 없음.
6. **테스트/CI/CD 파이프라인**: 자동 테스트·린트·프리뷰 검증 없음(현재 서버에서 직접 커밋·push).
7. **데이터 보존/집계**: place_rankings 등 무한 누적 → 장기 보관정책·집계 롤업 없음.
8. **레거시 정리**: `store.html`(구버전) 미사용.
9. **검색 정확도 한계**: 개인화/로그인 차이로 스크래퍼 순위가 사용자 실제 화면과 100% 일치하진 않음(특히 관련도순).

---

### 부록: 배포 방법 요약
- 프론트/API: 코드 수정 → `main` push → Vercel 자동배포. (서버 `/opt/blog-rank`에서 `git push origin main` 또는 로컬에서 push)
- 스크래퍼: NCP 서버 `/opt/blog-rank/scraper` 갱신 후 `pm2 reload blog-rank-scraper`.
- 스키마: `sql/*.sql`을 Supabase SQL Editor에서 수동 실행.
