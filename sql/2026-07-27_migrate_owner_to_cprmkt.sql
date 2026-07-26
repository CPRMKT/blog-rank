-- 2026-07-27 · 기존(owner_id 없던) 데이터 전부를 실계정 cprmkt 소유로 이전
-- Supabase SQL Editor에서 실행함. 총 1,268행 이전
--   stores 11 / store_keywords 109 / store_rankings 483 / store_blog_posts 10 /
--   store_place_fetches 9 / store_place_keywords 3 / place_keywords 1 / place_rankings 642
-- (검증용 임시계정 cprtest_zz01 데이터는 owner_id가 이미 있어 owner_id is null 조건에서 자동 제외)

do $$
declare me uuid := (select id from profiles where lower(username) = 'cprmkt');
begin
  update stores               set owner_id = me where owner_id is null;
  update store_keywords       set owner_id = me where owner_id is null;
  update store_rankings       set owner_id = me where owner_id is null;
  update store_blog_posts     set owner_id = me where owner_id is null;
  update store_place_fetches  set owner_id = me where owner_id is null;
  update store_place_keywords set owner_id = me where owner_id is null;
  update place_keywords       set owner_id = me where owner_id is null;
  update place_rankings       set owner_id = me where owner_id is null;
end $$;
