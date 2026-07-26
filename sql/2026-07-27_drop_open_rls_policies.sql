-- 2026-07-27 · 개방형 RLS 정책 전부 삭제 (계정 격리 강제)
-- Supabase SQL Editor에서 실행함. idempotent.
-- 이전 세션에서 만든 using(true)/anon·public 대상 개방정책이 owner_id 격리를 무력화하고 있었음.
-- 삭제 후 각 테이블은 owner 정책("owner all", auth.uid()=owner_id) 하나로만 보호됨.
-- (service_role은 RLS 자동 우회라 백엔드/크론엔 영향 없음)

drop policy if exists "place_keywords all"        on place_keywords;
drop policy if exists "place_rankings all"        on place_rankings;
drop policy if exists "Allow all for service key" on stores;
drop policy if exists "Allow all for service key" on store_keywords;
drop policy if exists "Allow all for service key" on store_rankings;
drop policy if exists "Allow all for service key" on store_blog_posts;
drop policy if exists "Allow all for service key" on store_place_fetches;
drop policy if exists "spk anon all" on store_place_keywords;
drop policy if exists "spk auth all" on store_place_keywords;
