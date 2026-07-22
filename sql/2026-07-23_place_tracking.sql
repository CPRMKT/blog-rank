-- 플레이스 순위 추적 (매장 중심) — 2026-07-23
-- Supabase SQL Editor에서 1회 실행. 모두 idempotent (재실행 안전).
-- 기존 place_keywords/place_rankings와 동일하게 RLS 활성 + permissive 정책(using true).

-- 1) 매장별 플레이스 추적 키워드
create table if not exists store_place_keywords (
  id         bigint generated always as identity primary key,
  store_id   bigint not null references stores(id) on delete cascade,
  keyword    text   not null,
  created_at timestamptz not null default now(),
  unique (store_id, keyword)
);
create index if not exists idx_store_place_keywords_store on store_place_keywords (store_id);

-- RLS: 앱 서버는 service_role(SUPABASE_SECRET_KEY)로 접근해 RLS를 우회하지만,
-- 기존 테이블과 동일하게 RLS를 켜고 anon/authenticated permissive 정책을 둔다.
alter table store_place_keywords enable row level security;

drop policy if exists "spk anon all" on store_place_keywords;
create policy "spk anon all" on store_place_keywords
  for all to anon using (true) with check (true);

drop policy if exists "spk auth all" on store_place_keywords;
create policy "spk auth all" on store_place_keywords
  for all to authenticated using (true) with check (true);

grant all on store_place_keywords to anon, authenticated;

-- 2) 플레이스 순위 스냅샷(place_rankings)에 저장수(북마크) 컬럼 추가
--    네이버 표기 기준(100·1,000 단위 반올림) 정수. 미수집이면 null.
alter table place_rankings add column if not exists saves integer;
