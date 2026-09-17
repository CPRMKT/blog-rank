-- 순위 저장을 "삭제→삽입 2회 왕복"에서 "DB 함수 1회 호출(단일 트랜잭션)"로 통합.
-- 삽입이 실패하면 삭제까지 통째로 롤백되어 "삭제만 되고 삽입 실패 → 데이터 소실" 경로가 사라진다.
-- security invoker: 사용자 JWT로 호출하면 RLS(owner_id=auth.uid())가 그대로 적용, service_role은 우회.

create or replace function public.save_place_rankings_atomic(
  p_keyword text, p_checked_date date, p_owner uuid, p_rows jsonb
) returns integer
language plpgsql security invoker as $$
declare
  v_owner uuid := coalesce(p_owner, auth.uid());
  v_n integer;
begin
  if v_owner is null then raise exception 'owner required'; end if;
  delete from public.place_rankings
   where keyword = p_keyword and checked_date = p_checked_date and owner_id = v_owner;
  insert into public.place_rankings
    (keyword, checked_date, rank, place_id, name, category, visitor_reviews, blog_reviews, saves, owner_id)
  select p_keyword, p_checked_date, r.rank, r.place_id, r.name, r.category,
         r.visitor_reviews, r.blog_reviews, r.saves, v_owner
    from jsonb_populate_recordset(null::public.place_rankings, coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.save_store_ranking_atomic(
  p_store_id bigint, p_keyword text, p_checked_date date, p_owner uuid, p_row jsonb
) returns integer
language plpgsql security invoker as $$
declare
  v_owner uuid := coalesce(p_owner, auth.uid());
begin
  if v_owner is null then raise exception 'owner required'; end if;
  delete from public.store_rankings
   where store_id = p_store_id and keyword = p_keyword and checked_date = p_checked_date and owner_id = v_owner;
  insert into public.store_rankings
    (store_id, keyword, checked_date, rank, matched_blog_url, matched_title, search_volume, matches, owner_id)
  select p_store_id, p_keyword, p_checked_date, r.rank, r.matched_blog_url, r.matched_title,
         r.search_volume, r.matches, v_owner
    from jsonb_populate_record(null::public.store_rankings, p_row) r;
  return 1;
end $$;

grant execute on function public.save_place_rankings_atomic(text, date, uuid, jsonb) to authenticated, service_role;
grant execute on function public.save_store_ranking_atomic(bigint, text, date, uuid, jsonb) to authenticated, service_role;
