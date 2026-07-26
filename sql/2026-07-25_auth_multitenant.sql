-- ============================================================
-- Phase 1: 회원 시스템 + 계정별 데이터 완전 분리 (스키마 + RLS)
-- 2026-07-25 · Supabase SQL Editor에서 실행
--
-- 원칙: 모든 기능은 회원가입 필수, 각 계정은 자기 데이터만.
-- 범위: 매장/키워드/순위 관련 전부(place_rankings 포함) owner_id + RLS.
--       포스팅 순위 조회(blogs/posts/rank_history)는 이번 라운드 제외.
-- 안전성: DROP 없음. 컬럼추가 + RLS활성만. 앱/크론은 현재 service_role이라
--         RLS를 우회 → 이 SQL 실행 후에도 기존 기능/크론 무중단.
--         (실제 격리 시행은 Phase 2에서 API 토큰검증으로 켬)
-- 기존 데이터: owner_id는 nullable로 추가되어 기존 행은 NULL → Phase 4에서
--             내 계정 가입 직후 백필(맨 아래 마이그레이션 스크립트).
-- ============================================================

-- 1) profiles (아이디·연락이메일·부가정보)
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null,                 -- 아이디(로그인용). 실제 로그인은 합성이메일로 변환
  email        text,                           -- 연락용 실제 이메일(로그인엔 사용 안 함)
  name         text,
  company      text,
  role         text check (role in ('매장주','대행사','직원','기타')),
  phone        text,
  referrer     text,
  terms_agreed boolean not null default false, -- 약관 전체 동의(필수)
  created_at   timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_uniq on profiles (lower(username));

alter table profiles enable row level security;
drop policy if exists "profiles self read"   on profiles;
drop policy if exists "profiles self insert" on profiles;
drop policy if exists "profiles self update" on profiles;
create policy "profiles self read"   on profiles for select to authenticated using (auth.uid() = id);
create policy "profiles self insert" on profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles self update" on profiles for update to authenticated using (auth.uid() = id);

-- 2) owner_id 추가 (nullable 시작 → Phase 4 백필). insert 시 자동으로 로그인 유저 채움.
alter table stores               add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table store_keywords       add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table store_rankings       add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table store_blog_posts     add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table store_place_fetches  add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table store_place_keywords add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table place_keywords       add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();
alter table place_rankings       add column if not exists owner_id uuid references profiles(id) on delete cascade default auth.uid();

create index if not exists idx_stores_owner               on stores(owner_id);
create index if not exists idx_store_keywords_owner        on store_keywords(owner_id);
create index if not exists idx_store_rankings_owner        on store_rankings(owner_id);
create index if not exists idx_store_blog_posts_owner      on store_blog_posts(owner_id);
create index if not exists idx_store_place_fetches_owner   on store_place_fetches(owner_id);
create index if not exists idx_store_place_keywords_owner  on store_place_keywords(owner_id);
create index if not exists idx_place_keywords_owner        on place_keywords(owner_id);
create index if not exists idx_place_rankings_owner        on place_rankings(owner_id);

-- 2-1) place_keywords: 전역 unique(keyword) → 소유자별 unique(owner_id,keyword)
--      (제약 이름이 다르면 이 줄은 무시됨 → 실행 후 알려주면 조정)
alter table place_keywords drop constraint if exists place_keywords_keyword_key;
create unique index if not exists place_keywords_owner_kw_uniq on place_keywords (owner_id, keyword);

-- 3) RLS: 본인 소유(auth.uid()=owner_id)만 조회/수정/삭제.
--    service_role(앱 프록시·크론)은 RLS 우회 → 영향 없음.
do $$
declare t text; tbls text[] := array[
  'stores','store_keywords','store_rankings','store_blog_posts',
  'store_place_fetches','store_place_keywords','place_keywords','place_rankings'];
begin
  foreach t in array tbls loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "owner all" on %I', t);
    execute format('create policy "owner all" on %I for all to authenticated using (auth.uid()=owner_id) with check (auth.uid()=owner_id)', t);
  end loop;
end $$;

-- ============================================================
-- Phase 4 마이그레이션 (⚠️ 지금 실행 X — 내 계정 가입 직후 실행)
-- 기존(주인 없는) 데이터 전부를 "첫 계정"(=내가 실제 쓸 계정) 소유로 이전.
-- 가입 완료 후 아래 블록만 별도로 실행.
-- ============================================================
-- do $$
-- declare me uuid := (select id from profiles order by created_at asc limit 1);  -- 첫 계정
-- begin
--   update stores               set owner_id = me where owner_id is null;
--   update store_keywords       set owner_id = me where owner_id is null;
--   update store_rankings       set owner_id = me where owner_id is null;
--   update store_blog_posts     set owner_id = me where owner_id is null;
--   update store_place_fetches  set owner_id = me where owner_id is null;
--   update store_place_keywords set owner_id = me where owner_id is null;
--   update place_keywords       set owner_id = me where owner_id is null;
--   update place_rankings       set owner_id = me where owner_id is null;
-- end $$;
