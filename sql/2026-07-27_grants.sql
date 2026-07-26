-- 2026-07-27 · 회원/격리 동작에 필요한 테이블 권한
-- Supabase SQL Editor에서 실행함. idempotent.
-- authenticated: 로그인 사용자(RLS로 자기 데이터만). service_role: 백엔드/크론(RLS 우회).
-- (Supabase가 SQL로 만든 테이블에 자동 grant 안 하는 케이스가 있어 명시 부여)

grant select, insert, update, delete on
  stores, store_keywords, store_rankings, store_blog_posts, store_place_fetches,
  store_place_keywords, place_keywords, place_rankings, profiles
to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant all on
  stores, store_keywords, store_rankings, store_blog_posts, store_place_fetches,
  store_place_keywords, place_keywords, place_rankings, profiles
to service_role;
