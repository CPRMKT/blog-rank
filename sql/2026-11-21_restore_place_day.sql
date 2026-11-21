-- 10/26~11/10 플레이스 순위 복원용 (2026-11-21, 일회용 — 복원이 끝나면 drop)
-- 근거: docs/place-snapshot-recovery-2026-11.md (n8n 스냅샷 대조 16/16, 충실도 4/4 + 16/16)
-- 적용 순서: 삭제 가드(sql/2026-11-21_place_rankings_delete_guard.sql) 적용·시험 성공 뒤에만.
-- 되돌림: 아래 맨 끝 주석.
--
-- 1) 이름·업종 채움표: place_id 별로 구간 직전(checked_date <= 10/25, 가장 늦은 non-null) 값과
--    직후(>= 11/11, 가장 이른 non-null) 값이 **같을 때만** 그 값. 다르거나 한쪽만 있거나 없으면 NULL.
--    이름·업종을 따로 판정한다. 복원 행은 이 표만 본다(복원 도중 DB 가 늘어도 결과가 바뀌지 않게 한 번만 만든다).
-- 2) restore_place_day(날짜, 소유자, 행들, 예상 행 수, 사유): 날짜 하나 = 트랜잭션 하나.
--    - 구간(10/26~11/10) 밖 날짜 거부
--    - 행 수 ≠ 예상 → 거부, rank 없음·범위 밖(1~300)·place_id 없음·(키워드,place_id) 중복 → 거부
--    - 그 날짜에 같은 키워드 행이 하나라도 이미 있으면 거부(덮어쓰기·중복 방지)
--    - 넣은 행 수 ≠ 예상 → 예외 → 그 날짜 전체 롤백
--    - 리뷰·저장수 NULL, created_at = 이 호출의 시각(복원 행 식별표)

create table if not exists public.restore_2026_11_fill (
  place_id text primary key,
  name     text,
  category text
);
alter table public.restore_2026_11_fill enable row level security;
revoke all on public.restore_2026_11_fill from anon, authenticated;

insert into public.restore_2026_11_fill (place_id, name, category)
with b as (
  select place_id,
         (array_agg(name     order by checked_date desc, id desc) filter (where name     is not null))[1] bn,
         (array_agg(category order by checked_date desc, id desc) filter (where category is not null))[1] bc
  from public.place_rankings where checked_date <= '2026-10-25' group by place_id
), a as (
  select place_id,
         (array_agg(name     order by checked_date, id) filter (where name     is not null))[1] an,
         (array_agg(category order by checked_date, id) filter (where category is not null))[1] ac
  from public.place_rankings where checked_date >= '2026-11-11' group by place_id
)
select place_id,
       case when bn = an then bn end,
       case when bc = ac then bc end
from b join a using (place_id)
where bn = an or bc = ac
on conflict (place_id) do nothing;

create or replace function public.restore_place_day(
  p_date date, p_owner uuid, p_rows jsonb, p_expected int, p_reason text, p_dry boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t0 timestamptz := clock_timestamp();
  n_in int; n_bad int; n_dup int; n_exist int; n_ins int;
  r jsonb;
begin
  if p_date is null or p_date < date '2026-10-26' or p_date > date '2026-11-10' then
    raise exception 'restore_place_day: 날짜 % 는 복원 구간(2026-10-26~11-10) 밖입니다.', p_date;
  end if;
  if p_owner is null or not exists (select 1 from profiles where id = p_owner) then
    raise exception 'restore_place_day: 소유자 % 가 없습니다.', p_owner;
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'restore_place_day: 사유(5자 이상)가 필요합니다.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'restore_place_day: 행 배열이 필요합니다.';
  end if;

  drop table if exists pg_temp._rp;   -- 같은 트랜잭션에서 두 번 불려도 안전하게
  create temp table _rp on commit drop as
    select x.keyword, x.place_id, x.rank
    from jsonb_to_recordset(p_rows) as x(keyword text, place_id text, rank int);

  select count(*) into n_in from _rp;
  if n_in <> p_expected then
    raise exception 'restore_place_day: 받은 %행 ≠ 예상 %행 — 넣지 않았습니다.', n_in, p_expected;
  end if;
  select count(*) into n_bad from _rp
   where keyword is null or btrim(keyword) = '' or place_id is null or place_id = '' or rank is null or rank < 1 or rank > 300;
  if n_bad > 0 then raise exception 'restore_place_day: 잘못된 행 %개 — 넣지 않았습니다.', n_bad; end if;
  select count(*) - count(distinct (keyword, place_id)) into n_dup from _rp;
  if n_dup > 0 then raise exception 'restore_place_day: (키워드, place_id) 중복 %개 — 넣지 않았습니다.', n_dup; end if;

  select count(*) into n_exist from place_rankings p
   where p.checked_date = p_date and p.keyword in (select distinct keyword from _rp);
  if n_exist > 0 then
    raise exception 'restore_place_day: % 에 같은 키워드 행이 이미 %행 있습니다 — 넣지 않았습니다.', p_date, n_exist;
  end if;

  -- 요약은 넣은 행(RETURNING)에서 바로 센다 — checked_date 만으로 운영 표를 다시 훑으면
  -- (keyword, checked_date) 인덱스를 못 타서 300만 행을 읽게 된다(8초 제한).
  with ins as (
    insert into place_rankings (keyword, checked_date, rank, place_id, owner_id, name, category,
                                visitor_reviews, blog_reviews, saves, created_at)
    select r.keyword, p_date, r.rank, r.place_id, p_owner, f.name, f.category, null, null, null, t0
    from _rp r left join restore_2026_11_fill f on f.place_id = r.place_id
    order by r.keyword, r.rank
    returning id, keyword, name, category
  )
  select jsonb_build_object(
    'date', p_date, 'inserted', count(*), 'keywords', count(distinct keyword),
    'min_id', min(id), 'max_id', max(id), 'created_at', t0,
    'name_filled', count(name), 'category_filled', count(category), 'reason', left(btrim(p_reason), 200))
  into r
  from ins;
  n_ins := (r->>'inserted')::int;
  if n_ins <> p_expected then
    raise exception 'restore_place_day: 넣은 %행 ≠ 예상 %행 — 이 날짜 전체를 롤백합니다.', n_ins, p_expected;
  end if;
  -- 시험(p_dry): 운영 표에 실제로 넣고 잰 뒤 **예외로 통째로 롤백**한다(남는 행 0). 8초 제한·인덱스 비용을 실제 경로로 재기 위해서다.
  if p_dry then
    raise exception 'DRY_RUN_OK %', (r || jsonb_build_object('elapsed_ms', round(extract(epoch from clock_timestamp() - t0) * 1000)))::text
      using errcode = 'P0001';
  end if;
  return r || jsonb_build_object('elapsed_ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
end $$;

revoke all on function public.restore_place_day(date, uuid, jsonb, int, text, boolean) from public, anon, authenticated;
grant execute on function public.restore_place_day(date, uuid, jsonb, int, text, boolean) to service_role;

-- ───────── 되돌림 ─────────
-- (a) 함수·채움표 치우기(복원이 끝난 뒤 반드시):
--   drop function if exists public.restore_place_day(date, uuid, jsonb, int, text, boolean);
--   drop table if exists public.restore_2026_11_fill;
-- (b) 커밋된 날짜 하나를 되돌려야 하면(가드와 충돌하지 않는 유일한 경로):
--   select public.purge_place_pairs('<날짜>', array[<그 날짜에 복원한 키워드들>], <넣은 행 수>, '<사유>');
--   복원 행은 created_at = 복원 시각, id 범위로 식별한다(docs/place-snapshot-recovery-2026-11.md 의 복원 기록 표).
