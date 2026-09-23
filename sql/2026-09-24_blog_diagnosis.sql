-- 블로그 진단 탭: 진단 결과 + 상위노출 확률 예측 저장.
-- 기존 테이블·정책은 건드리지 않는다. 계정 격리는 기존과 동일하게 owner_id + RLS.

create table if not exists public.blog_diagnoses (
  id          bigserial primary key,
  blog_id     text not null,
  store_id    bigint,
  score       numeric,
  grade       text,
  breakdown   jsonb,   -- 항목별 점수/측정값
  posts       jsonb,   -- 글별 노출 진단 결과
  flags       jsonb,   -- 저품질 의심 등
  owner_id    uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists idx_blog_diagnoses_blog on public.blog_diagnoses (blog_id, created_at desc);
create index if not exists idx_blog_diagnoses_owner on public.blog_diagnoses (owner_id);

create table if not exists public.blog_predictions (
  id             bigserial primary key,
  blog_id        text not null,
  store_id       bigint,
  keyword        text not null,
  probability    numeric,      -- 0~100
  expected_band  text,         -- '1~7위 가능' 등
  inputs         jsonb,        -- 계산에 쓴 값(재현용)
  target_date    date,         -- 검증 예정일(기본 7일 뒤)
  verified_rank  integer,      -- 검증 시 실제 순위(0=미노출)
  verified_at    timestamptz,
  owner_id       uuid not null default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists idx_blog_predictions_verify on public.blog_predictions (target_date, verified_at);
create index if not exists idx_blog_predictions_owner on public.blog_predictions (owner_id);

alter table public.blog_diagnoses  enable row level security;
alter table public.blog_predictions enable row level security;

drop policy if exists own_rows on public.blog_diagnoses;
create policy own_rows on public.blog_diagnoses
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists own_rows on public.blog_predictions;
create policy own_rows on public.blog_predictions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.blog_diagnoses  to authenticated;
grant select, insert, update, delete on public.blog_predictions to authenticated;
grant usage, select on sequence public.blog_diagnoses_id_seq  to authenticated;
grant usage, select on sequence public.blog_predictions_id_seq to authenticated;
