-- place_rankings 삭제 가드 (2026-11-21)
-- 경위: docs/place-rows-cause-2026-11-14.md  /  설계: docs/place-delete-guard-2026-11.md
-- 되돌림: sql/2026-11-21_place_rankings_delete_guard_rollback.sql
--
-- 1) 감사 기록 표
-- 2) 문장 단위 가드: 한 DELETE 문장이 5,000행을 넘으면 차단. 어떤 설정으로도 30,000행은 못 넘는다.
-- 3) TRUNCATE 차단
-- 4) 대량 삭제 전용 함수 purge_place_pairs(날짜, 키워드배열, 예상행수, 사유)

-- ───────── 1) 감사 기록 표 ─────────
create table if not exists public.place_rankings_delete_audit (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  session_role   text,          -- session_user (PostgREST 면 authenticator)
  set_role       text,          -- SET ROLE 값 (service_role / authenticated / none)
  jwt_role       text,          -- request.jwt.claims 의 role (API 경유일 때)
  via            text not null, -- 'direct' | 'purge_place_pairs'
  reason         text,
  rows_deleted   bigint not null,
  date_count     int not null,
  keyword_count  int not null,
  dates          date[],
  keywords_sample text[],
  cap            int not null,
  top_query      text
);
alter table public.place_rankings_delete_audit enable row level security;
revoke all on public.place_rankings_delete_audit from anon, authenticated;
grant select on public.place_rankings_delete_audit to service_role;

-- ───────── 2) 문장 단위 가드 ─────────
-- AFTER DELETE ... FOR EACH STATEMENT + 전이 테이블: 문장 한 번에 한 번 돌고, 그 문장이 지운 행 전체를 본다.
-- 상한을 넘으면 예외 → 그 문장(과 트랜잭션)이 통째로 롤백된다.
-- security definer: authenticated 처럼 감사 표 권한이 없는 역할의 삭제도 기록하기 위해서다.
create or replace function public.guard_place_rankings_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n   bigint;
  nd  int;
  nk  int;
  hard_cap constant int := 30000;   -- 어떤 설정으로도 넘을 수 없는 절대 상한
  cap int := 5000;                  -- 기본 상한
  cap_raw text := nullif(current_setting('app.delete_cap', true), '');
  v_via   text := coalesce(nullif(current_setting('app.delete_via', true), ''), 'direct');
  v_reason text := nullif(current_setting('app.delete_reason', true), '');
  v_jwt   text;
begin
  select count(*), count(distinct checked_date), count(distinct keyword) into n, nd, nk from deleted;
  if n = 0 then return null; end if;

  if cap_raw is not null then
    begin cap := cap_raw::int; exception when others then cap := 5000; end;
  end if;
  cap := least(cap, hard_cap);

  if n > cap then
    raise exception
      'place_rankings: 한 문장이 %행(날짜 %개, 키워드 %개)을 지우려 했습니다 — 상한 %행. 한 행도 지우지 않았습니다. 승인된 대량 삭제는 purge_place_pairs() 로만 하세요.',
      n, nd, nk, cap
      using errcode = 'P0001';
  end if;

  -- 평소의 저장 경로(save_place_rankings_atomic)는 (키워드, 날짜) 한 쌍만 지운다. 그건 기록하지 않는다.
  -- 한 쌍을 벗어나는 삭제(여러 날짜/여러 키워드), 1,000행 이상, 전용 함수 경유는 전부 기록한다.
  if nd > 1 or nk > 1 or n >= 1000 or v_via <> 'direct' then
    begin v_jwt := nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role';
    exception when others then v_jwt := null; end;
    insert into public.place_rankings_delete_audit
      (session_role, set_role, jwt_role, via, reason, rows_deleted, date_count, keyword_count, dates, keywords_sample, cap, top_query)
    select session_user, current_setting('role', true), v_jwt, v_via, v_reason, n, nd, nk,
           (select array_agg(d order by d) from (select distinct checked_date d from deleted order by 1 limit 40) x),
           (select array_agg(k) from (select distinct keyword k from deleted limit 20) y),
           cap, left(current_query(), 500);
  end if;
  return null;
end $$;

revoke all on function public.guard_place_rankings_delete() from public, anon, authenticated;

drop trigger if exists trg_guard_place_rankings_delete on public.place_rankings;
create trigger trg_guard_place_rankings_delete
  after delete on public.place_rankings
  referencing old table as deleted
  for each statement execute function public.guard_place_rankings_delete();

-- ───────── 3) TRUNCATE 차단 ─────────
-- DELETE 트리거는 TRUNCATE 에 돌지 않는다. 따로 막는다.
create or replace function public.block_truncate()
returns trigger language plpgsql as $$
begin
  raise exception '%: TRUNCATE 는 막혀 있습니다. (docs/place-delete-guard-2026-11.md)', tg_table_name
    using errcode = 'P0001';
end $$;

drop trigger if exists trg_block_truncate on public.place_rankings;
create trigger trg_block_truncate
  before truncate on public.place_rankings
  for each statement execute function public.block_truncate();

-- ───────── 4) 대량 삭제 전용 함수 ─────────
-- 예상 행 수를 선언해야 하고, 실제와 다르면 한 행도 지우지 않는다.
-- 상한은 이 트랜잭션 안에서만 올라간다(set_config(..., true) = set local).
create or replace function public.purge_place_pairs(
  p_date date, p_keywords text[], p_expected_rows int, p_reason text
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int;
  d int;
begin
  if p_date is null or p_keywords is null or coalesce(array_length(p_keywords, 1), 0) = 0 then
    raise exception 'purge_place_pairs: 날짜와 키워드 배열이 필요합니다.';
  end if;
  if p_expected_rows is null or p_expected_rows < 0 then
    raise exception 'purge_place_pairs: 예상 행 수(p_expected_rows)를 선언해야 합니다.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'purge_place_pairs: 사유(5자 이상)를 적어야 합니다.';
  end if;

  select count(*) into n from place_rankings where checked_date = p_date and keyword = any(p_keywords);
  if n <> p_expected_rows then
    raise exception 'purge_place_pairs: 예상 %행 ≠ 실제 %행 — 한 행도 지우지 않았습니다.', p_expected_rows, n;
  end if;
  if n > 30000 then
    raise exception 'purge_place_pairs: 한 호출 상한 30000행 초과(%행) — 나눠서 하세요.', n;
  end if;
  if n = 0 then return 0; end if;

  perform set_config('app.delete_cap', n::text, true);
  perform set_config('app.delete_via', 'purge_place_pairs', true);
  perform set_config('app.delete_reason', left(btrim(p_reason), 300), true);

  delete from place_rankings where checked_date = p_date and keyword = any(p_keywords);
  get diagnostics d = row_count;

  -- 같은 트랜잭션의 다음 문장이 올라간 상한을 물려받지 않게 바로 되돌린다
  perform set_config('app.delete_cap', '', true);
  perform set_config('app.delete_via', '', true);
  perform set_config('app.delete_reason', '', true);
  return d;
end $$;

revoke all on function public.purge_place_pairs(date, text[], int, text) from public, anon, authenticated;
grant execute on function public.purge_place_pairs(date, text[], int, text) to service_role;
