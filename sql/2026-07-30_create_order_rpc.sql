-- 2026-07-30 · 발주 3단계 - 원자적 주문생성 RPC(create_order)
-- Supabase SQL Editor에서 1회 실행. idempotent(create or replace).
-- 한 트랜잭션에서: 잔액확인 → 부족 시 예외 → orders insert → point_transactions 차감.
-- SECURITY DEFINER + auth.uid() → authenticated가 직접 호출해도 본인 소유로만 생성.
-- 동시 요청 중복차감은 사용자별 advisory 잠금으로 방지.

create or replace function public.create_order(
  p_category     text,
  p_product_name text,
  p_options      jsonb,
  p_unit_price   integer,
  p_quantity     integer,
  p_total_price  integer,
  p_store_id     bigint default null
) returns orders
language plpgsql security definer set search_path = public
as $$
declare
  v_owner   uuid := auth.uid();
  v_balance integer;
  v_order   orders;
begin
  if v_owner is null then raise exception '로그인이 필요합니다.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception '수량이 올바르지 않습니다.'; end if;
  if coalesce(p_total_price, 0) <= 0 then raise exception '주문 금액이 올바르지 않습니다.'; end if;

  -- 선택 매장이 있으면 본인 매장인지 확인
  if p_store_id is not null and not exists (
    select 1 from stores where id = p_store_id and owner_id = v_owner
  ) then
    raise exception '선택한 매장을 찾을 수 없습니다.';
  end if;

  -- 동시 차감 방지(사용자별 트랜잭션 잠금)
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));

  select coalesce(sum(amount), 0) into v_balance
  from point_transactions where owner_id = v_owner;

  if v_balance < p_total_price then
    raise exception '포인트가 부족합니다. (보유 %P / 필요 %P)', v_balance, p_total_price;
  end if;

  insert into orders(owner_id, store_id, category, product_name, options, unit_price, quantity, total_price, status)
  values (v_owner, p_store_id, p_category, p_product_name, p_options, p_unit_price, p_quantity, p_total_price, '접수')
  returning * into v_order;

  insert into point_transactions(owner_id, type, amount, related_order_id, memo)
  values (v_owner, '차감', -p_total_price, v_order.id, '발주: ' || coalesce(p_product_name, ''));

  return v_order;
end;
$$;

grant execute on function public.create_order(text, text, jsonb, integer, integer, integer, bigint) to authenticated;
