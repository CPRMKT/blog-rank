-- ============================================================================
-- blog-rank — 신규 플랫폼(cpr-marketing-os) 야간 동기화용 읽기 전용 역할
--
-- 목적: 외부 시스템이 순위 데이터를 "읽기만" 하도록 최소 권한 경로를 연다.
--       기존 앱 동작(anon/authenticated/service_role, RLS 정책)은 건드리지 않는다.
--
-- ⚠️ 이 파일에는 실행 시 비밀번호가 들어간다. 절대 커밋하지 말 것.
--    (아래 __PASSWORD__ 자리표시자를 실제 값으로 바꿔 SQL Editor에서 실행)
--
-- 적용일: 2026-08-01
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. 역할 생성 (LOGIN 가능, 쓰기 권한 없음)
--    NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS 를 명시해
--    나중에 누가 실수로 권한을 넓히기 어렵게 못 박아둔다.
--    connection limit: 하루 1회 동기화용이므로 5면 충분하다(폭주 방지).
-- ----------------------------------------------------------------------------
create role cprmkt_readonly_sync with
  login
  password '__PASSWORD__'
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  nobypassrls
  connection limit 5;

comment on role cprmkt_readonly_sync is
  'cpr-marketing-os 야간 순위 동기화 전용. SELECT 전용이며 4개 테이블에만 접근 가능. 2026-08-01 생성.';

-- ----------------------------------------------------------------------------
-- 2. 스키마 접근 + 4개 테이블 SELECT 권한만
--    INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES 는 부여하지 않는다.
-- ----------------------------------------------------------------------------
grant usage on schema public to cprmkt_readonly_sync;

grant select on public.place_rankings        to cprmkt_readonly_sync;
grant select on public.store_rankings        to cprmkt_readonly_sync;
grant select on public.stores                to cprmkt_readonly_sync;
grant select on public.store_place_keywords  to cprmkt_readonly_sync;

-- 주의: ALTER DEFAULT PRIVILEGES 는 일부러 걸지 않는다.
--       앞으로 만들 테이블이 이 역할에 자동 노출되면 안 되기 때문이다.

-- ----------------------------------------------------------------------------
-- 3. RLS 통과 방법 — BYPASSRLS 대신 "이 역할 전용 SELECT 정책"
--
--    BYPASSRLS를 쓰지 않은 이유:
--      (1) 범위: BYPASSRLS는 역할 속성이라 DB의 '모든' 테이블에 적용된다.
--          profiles·orders·points 등 의도치 않은 테이블과 앞으로 생길 테이블까지
--          전부 뚫린다. 정책 방식은 정확히 아래 4개 테이블에만 적용된다.
--      (2) 명령 범위: 정책은 FOR SELECT로 한정된다. 나중에 누군가 실수로 이 역할에
--          INSERT 권한을 줘도 INSERT용 정책이 없으므로 RLS가 계속 막는다.
--          BYPASSRLS였다면 그 실수가 즉시 쓰기로 이어진다.
--      (3) 현실적 제약: ALTER ROLE ... BYPASSRLS 는 슈퍼유저 권한을 요구하는데
--          Supabase의 postgres 롤은 완전한 슈퍼유저가 아니라 실패할 수 있다.
--      (4) 감사: pg_policies 조회만으로 무엇이 열려 있는지 바로 확인된다.
--
--    permissive 정책은 OR로 합쳐지므로, 기존 owner 정책(auth.uid()=owner_id)은
--    그대로 두고 이 역할에만 전체 조회를 허용한다. 다른 역할 동작에 영향이 없다.
-- ----------------------------------------------------------------------------
create policy cprmkt_readonly_sync_select on public.place_rankings
  for select to cprmkt_readonly_sync using (true);

create policy cprmkt_readonly_sync_select on public.store_rankings
  for select to cprmkt_readonly_sync using (true);

create policy cprmkt_readonly_sync_select on public.stores
  for select to cprmkt_readonly_sync using (true);

create policy cprmkt_readonly_sync_select on public.store_place_keywords
  for select to cprmkt_readonly_sync using (true);

commit;


-- ============================================================================
-- 롤백 (필요 시 아래 블록만 따로 실행)
-- ============================================================================
-- begin;
-- drop policy if exists cprmkt_readonly_sync_select on public.place_rankings;
-- drop policy if exists cprmkt_readonly_sync_select on public.store_rankings;
-- drop policy if exists cprmkt_readonly_sync_select on public.stores;
-- drop policy if exists cprmkt_readonly_sync_select on public.store_place_keywords;
-- revoke all on public.place_rankings, public.store_rankings, public.stores,
--   public.store_place_keywords from cprmkt_readonly_sync;
-- revoke usage on schema public from cprmkt_readonly_sync;
-- drop role cprmkt_readonly_sync;
-- commit;
