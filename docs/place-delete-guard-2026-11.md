# 원인 조사 결과와 삭제 안전장치 설계 (2026-11-21)

## 1. 원인 조사 — pg_stat_statements 가 통째로 남아 있었다

지난번에 "DB 로그를 볼 수 없다"고 보고했는데, **볼 수 있는 기록이 따로 있었다.**

| 항목 | 값 | 뜻 |
|---|---|---|
| `pg_stat_statements` | **1.11 설치됨** | 문장별 누적 기록 |
| 기록된 문장 수 / 상한 | **750 / 5,000** | 축출(evict)된 문장이 **없다** |
| 가장 오래된 항목 | **2026-07-20 14:56:17 UTC** | = 서버 기동 시각. **한 번도 초기화 안 됨** |
| `track` / `track_utility` | `top` / `on` | 최상위 문장 + DDL까지 기록 |
| `log_statement` / `log_min_duration_statement` | `ddl` / `-1` | **DML 은 Postgres 로그에 안 남는다** (그래서 로그로는 못 찾았다) |
| `pg_cron` | **미설치** | DB 안에 예약 작업 없음 |

→ **7월 20일 이후 실행된 모든 문장 "모양"이 빠짐없이 남아 있다.**

### 없는 것 (= 일어나지 않은 것)

| 가설 | 판정 |
|---|---|
| 날짜 범위 `delete ... between` | **기록에 없다** |
| `truncate place_rankings` | **없다** (truncate 기록은 `realtime.subscription` 뿐) |
| 표 drop·재생성 | **없다** |
| 함수 안에 숨은 범위 삭제 | **없다.** place_rankings 를 지우는 함수는 `save_place_rankings_atomic` 하나뿐이고 `keyword + checked_date + owner_id` 쌍 한정 |
| 예약 작업(pg_cron) | **없다** |
| FK cascade | **불가** (앞 보고의 근거 3개) |

### 있는 것 — place_rankings 를 지우는 문장 전부

| 처음 나타난 시각(KST) | 역할 | 호출 | 문장 모양 |
|---|---|---:|---|
| 2026-07-27 00:35 | service_role | 12,191 | keyword + date + owner_id (저장 경로) |
| 2026-07-27 02:45 | authenticated | 389 | keyword + date (관리 화면) |
| **2026-11-14 04:02** | **service_role** | **55** | **date + keyword = ANY(배열)** ← 오염 삭제 도구 |
| 2026-07-23 04:53 | service_role | 31 | keyword + date |
| 2026-11-16 23:30 | postgres | 1 | **keyword 만** (모든 날짜) — 5.2초 |
| 2026-11-16 23:31 | postgres | 1 | date + place_id |

## 2. ⚠ 앞 보고 정정 — "우리 코드로는 이 모양이 안 나온다"는 틀렸다

`purge_place_rankings` 는 **날짜 하나당 DELETE 한 문장**을 쏜다([api/db.js](../api/db.js) `for (const d of Object.keys(byDate).sort())`).
필터는 늘 `checked_date=eq.날짜 & keyword=in.(목록)` 이 맞다 — 그건 사실이다.
**하지만 그 목록에 그 날짜의 키워드가 전부 들어 있으면, 한 번의 호출로 그 날짜가 통째로 사라진다.**

내가 "쌍 단위라서 날짜 전체를 지울 수 없다"고 한 것은 **필터 모양만 보고 목록 내용을 보지 않은 판단**이었다.
도구 자체가 이 사고를 낼 수 있는 경로다.

### 호출 횟수가 17 맞지 않는다

이 문장 모양은 **2026-11-14 04:02 에 처음 생겼다** = 1차 오염 삭제가 돈 시각(11/13 19:00 UTC).
그 전엔 존재하지 않았으므로 **55회 전부가 그 뒤의 우리 작업**이다.

| 작업 | 날짜 수 = DELETE 문장 수 |
|---|---:|
| 1차 오염 삭제 (1,199쌍) | 11 |
| 2차 오염 삭제 (599쌍) | 14 |
| 9/24~9/28 (195쌍) | 5 |
| C등급 5쌍 × 2회 실행 | 8 |
| **설명되는 합** | **38** |
| **실제 호출** | **55** |
| **설명 안 되는 호출** | **17** |

복원(`--restore`)은 `save_place_rankings_atomic` RPC 를 쓰므로 이 55에 들어가지 않고,
백업(`--export`)과 dry 는 SELECT 라 들어가지 않는다. 확인했다.

**사라진 날짜는 16일이다.** 17 ≈ 16 이다.

이건 **단서이지 증거가 아니다.** 근거를 분명히 해 둔다:
- 실행 횟수를 **당시 기록이 아니라 내 재구성으로** 셌다. 중간에 끊긴 실행이나 재시도가 있었으면 38이 늘어난다.
- `/tmp` 에 남은 쌍 파일을 전부 훑었지만 **전체 키워드 목록을 담은 파일은 없었다**(가장 큰 게 1,199쌍/118키워드, 599쌍/126키워드). 즉 "전체 목록을 넘긴 실행"의 흔적 파일은 못 찾았다.
- `pg_stat_statements` 는 호출 **횟수**만 남기고 **시각과 인수**는 남기지 않는다. 그래서 17회가 언제, 어떤 목록으로 돌았는지는 알 수 없다.

### 삭제 권한 (역할별)

| 역할 | place_rankings 권한 | 비고 |
|---|---|---|
| `postgres` | ALL | 대시보드 SQL 편집기 |
| `service_role` | ALL | RLS 통과(BYPASSRLS) — 우리 API 키 |
| `authenticated` | ALL | RLS 정책 `owner all` 로 자기 행만 |
| **`anon`** | **DELETE·TRUNCATE 포함 ALL** | **정책이 없어 DELETE 는 RLS 가 막는다. 그런데 TRUNCATE 는 RLS 대상이 아니다** |
| `cprmkt_readonly_sync` | SELECT | 정책도 SELECT 전용 |

**`anon` 의 TRUNCATE 권한은 실제 구멍이다.** 공개 anon 키만 있으면 RLS를 거치지 않고 표를 비울 수 있다.
이번 사고의 원인은 아니다(TRUNCATE 기록이 없고, 그랬다면 297만 행이 다 날아갔다). **그래도 닫아야 한다.**

## 3. 안전장치 설계 (적용은 승인 후)

### 3-1. 문장 단위 상한 가드

`AFTER DELETE ... FOR EACH STATEMENT` + **전이 테이블(transition table)** 을 쓴다.
행 단위 트리거가 아니라 **문장 한 번에 한 번만** 돌고, 그 문장이 지운 행 전체를 셀 수 있다.

```sql
create or replace function public.guard_place_rankings_delete()
returns trigger language plpgsql as $$
declare
  n   bigint;
  cap int := coalesce(nullif(current_setting('app.delete_cap', true), '')::int, 5000);
begin
  select count(*) into n from deleted;
  if n > cap then
    raise exception
      'place_rankings: 한 문장이 %행을 지우려 했습니다 (상한 %행). 승인된 대량 삭제는 전용 함수로만 하세요.',
      n, cap using errcode = 'P0001';
  end if;
  if n > 0 then
    insert into public.place_rankings_delete_audit (rows_deleted, dates, keywords_sample, top_query, db_user, app_role)
    select n,
           (select array_agg(distinct checked_date) from deleted),
           (select array_agg(distinct keyword) from (select keyword from deleted limit 20) z),
           left(current_query(), 500), current_user,
           nullif(current_setting('request.jwt.claims', true), '');
  end if;
  return null;
end $$;

create trigger trg_guard_place_rankings_delete
after delete on public.place_rankings
referencing old table as deleted
for each statement execute function public.guard_place_rankings_delete();
```

**어디까지 적용되나**

| 경로 | 적용 | 근거 |
|---|---|---|
| 대시보드 SQL 편집기 (`postgres`) | ✅ | 트리거는 역할과 무관하게 돈다. Supabase 의 `postgres` 는 슈퍼유저가 아니라 `session_replication_role=replica` 로 끌 수 없다 |
| API / PostgREST (`service_role`, `authenticated`, `anon`) | ✅ | 같음. RLS 와 별개로 돈다 |
| 함수 안의 DELETE (`save_place_rankings_atomic`) | ✅ | 중첩이어도 문장 트리거는 돈다 |
| **TRUNCATE** | ❌ **DELETE 트리거는 안 돈다** | → 아래 3-3 별도 처리 |
| 표 소유자가 `alter table ... disable trigger` | ❌ 끌 수 있다 | 단 **DDL 이라 Postgres 로그에 남는다**(`log_statement=ddl`). 흔적이 생긴다 |

**정상 경로는 어떻게 통과하나**

| 경로 | 한 문장당 행 | 상한 5,000 | 조치 |
|---|---:|---|---|
| `save_place_rankings_atomic` (키워드·날짜) | 50~300 | 통과 | 없음 |
| 관리 화면 키워드+날짜 삭제 | 50~300 | 통과 | 없음 |
| **키워드 전체 삭제** (`where keyword=$1`, 모든 날짜) | **약 7,000~8,000** | **막힘** | 아래 ⚠ |
| **오염 삭제 도구** (날짜 단위) | 최대 **약 25,000** | **막힘** | 전용 함수로 이전 |

⚠ **"키워드 하나를 통째로 삭제"가 상한에 걸립니다.** 동래배네스트cc 맛집을 사장님이 직접 지우실 때 걸립니다.
두 가지 중 하나를 고르시면 됩니다 — ① 관리 화면의 키워드 삭제를 **날짜별 반복**으로 바꾼다(권함, 상한 안 건드림),
② 그 경로도 전용 함수로 보낸다.

### 3-2. 대량 삭제 전용 함수 (도구를 여기로 옮긴다)

```sql
create or replace function public.purge_place_pairs(
  p_date date, p_keywords text[], p_expected_rows int, p_reason text
) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- 1) 먼저 센다. 선언한 수와 다르면 아무것도 지우지 않는다.
  select count(*) into n from place_rankings where checked_date = p_date and keyword = any(p_keywords);
  if n <> p_expected_rows then
    raise exception '예상 %행 ≠ 실제 %행 — 목록이 바뀌었습니다. 지우지 않았습니다.', p_expected_rows, n;
  end if;
  -- 2) 이 문장에 한해서만 상한을 올린다. 트랜잭션이 끝나면 되돌아간다.
  perform set_config('app.delete_cap', (n + 1)::text, true);
  delete from place_rankings where checked_date = p_date and keyword = any(p_keywords);
  return n;
end $$;

revoke all on function public.purge_place_pairs(date, text[], int, text) from public, anon, authenticated;
grant execute on function public.purge_place_pairs(date, text[], int, text) to service_role;
```

핵심은 **`p_expected_rows`** 다. 도구가 dry 로 센 값을 그대로 선언해야 하고, 다르면 멈춘다.
**이번 사고가 "목록이 전체였다" 때문이라면 이 한 줄이 막았다** — 2,159행을 선언하고 25,852행이 걸리면 즉시 중단된다.
`set_config(..., true)` 는 `set local` 과 같아서 **그 트랜잭션 안에서만** 상한이 올라간다.

### 3-3. TRUNCATE 막기 + 권한 회수

```sql
create or replace function public.block_truncate() returns trigger language plpgsql as $$
begin raise exception '%: TRUNCATE 는 막혀 있습니다.', TG_TABLE_NAME; end $$;

create trigger trg_block_truncate before truncate on public.place_rankings
for each statement execute function public.block_truncate();

revoke truncate, delete on public.place_rankings from anon;
revoke truncate on public.place_rankings from authenticated;
```

### 3-4. 감사 기록 표

```sql
create table public.place_rankings_delete_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  db_user text, app_role text,
  rows_deleted bigint not null,
  dates date[], keywords_sample text[],
  top_query text
);
alter table public.place_rankings_delete_audit enable row level security;
revoke all on public.place_rankings_delete_audit from anon, authenticated;
```

**한계를 적어 둔다:** 상한에 걸려 **막힌** 시도는 예외와 함께 롤백되므로 이 표에 남지 않는다.
막힌 시도는 `raise exception` 메시지가 Postgres 로그(보존 7일)에 남는 것으로 대신한다.
막힌 기록까지 표에 남기려면 `dblink` 같은 별도 연결이 필요해 여기서는 넣지 않았다.

**비용:** 전이 테이블은 지운 행을 임시 저장소에 한 번 쓴다. 정상 경로는 한 문장 300행이라 체감 없다.

## 4. 전송 방식 — A안(dblink)보다 나은 변형을 권한다

사장님 조건은 "접속 문자열을 화면·로그·파일·docs·커밋 어디에도 남기지 말라"였다. 확인해 보니:

| dblink 로 할 때 비밀번호가 남는 곳 | 남나 |
|---|---|
| `create extension dblink` (DDL) | 비밀번호 없음 ✅ |
| `insert ... select from dblink('접속문자열', '...')` | DML 이라 Postgres 로그엔 안 남고(`log_statement=ddl`), `pg_stat_statements` 는 문자열 상수를 `$1` 로 정규화 ✅ |
| **제 도구 호출(= 이 대화 기록)** | **남는다** ❌ |
| postgres_fdw 의 `create user mapping ... password '...'` | **DDL 이라 로그·pgss·카탈로그에 평문으로 남는다** ❌ |

즉 **dblink 를 쓰면 비밀번호가 최소한 이 대화에 남습니다.** 그래서 다음을 권합니다.

### 권하는 방식 — 스크래퍼 서버에서 REST 로 옮긴다

1. 사장님이 서버에 `/opt/blog-rank/scraper/.restore.env` (권한 0600) 를 만들고,
   복원 프로젝트의 **URL 과 service_role 키**만 넣습니다. 제가 그 파일을 열어 내용을 출력하지 않습니다.
2. 제가 만든 스크립트가 그 파일과 기존 `.env`(운영 키)를 읽어,
   복원 프로젝트에서 REST 페이징(1,000행 단위)으로 행을 받아 제외 목록을 걸러내고,
   **운영에 (키워드, 날짜) 쌍 단위로** 넣습니다.

| 항목 | dblink | REST 방식 |
|---|---|---|
| 비밀번호가 대화에 남나 | **남는다** | **안 남는다** |
| 운영에 DDL(`create extension`) | 필요 | **불필요** |
| DB 로그·pgss·카탈로그에 흔적 | 일부 | **없음** |
| 새 의존성 | 없음 | 없음 (`fetch` 만 씀) |
| 쌍 단위 원자성 | 날짜 단위 | **쌍 단위** (한 쌍 = 한 문장) |
| 속도 | 빠름 | 보통 (읽기 약 163회 + 쓰기 약 1,780회) |

운영 DB의 비밀번호는 아예 필요 없습니다(기존 service_role 키로 넣습니다).
사장님이 그래도 dblink 를 원하시면 그대로 하되, 비밀번호가 이 대화에 남는다는 점은 기록해 둡니다.

## 5. 적용 순서 제안

복원이 먼저다. 가드를 먼저 켜면 복원 중 문제가 생겼을 때 되돌리기(날짜 단위 삭제)가 막힌다.
**복원·검증 완료 → 가드 적용(3-1~3-4) → 도구를 `purge_place_pairs` 로 이전 → 도구 재활성화** 순서를 권한다.
