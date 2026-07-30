-- 2026-07-31 · 발주 4단계 - 관리자 주문 조회/상태변경 RPC
-- Supabase SQL Editor에서 1회 실행. idempotent(create or replace).
-- 두 함수 모두 SECURITY DEFINER + 내부 public.is_admin() 검증 → 관리자만 전체 주문 접근.
-- 일반 사용자가 호출해도 admin_list_orders는 0행, admin_set_order_status는 예외.

-- 1) 전체 주문 조회(주문자 username/company + 매장명 조인)
create or replace function public.admin_list_orders()
returns table (
  id           bigint,
  owner_id     uuid,
  username     text,
  company      text,
  store_id     bigint,
  store_name   text,
  category     text,
  product_name text,
  options      jsonb,
  unit_price   integer,
  quantity     integer,
  total_price  integer,
  status       text,
  created_at   timestamptz,
  updated_at   timestamptz
)
language sql security definer set search_path = public stable
as $$
  select o.id, o.owner_id, p.username, p.company,
         o.store_id, s.name as store_name,
         o.category, o.product_name, o.options,
         o.unit_price, o.quantity, o.total_price, o.status,
         o.created_at, o.updated_at
  from orders o
  left join profiles p on p.id = o.owner_id
  left join stores   s on s.id = o.store_id
  where public.is_admin()
  order by o.created_at desc
$$;
grant execute on function public.admin_list_orders() to authenticated;

-- 2) 주문 상태 변경(관리자 전용)
create or replace function public.admin_set_order_status(p_order_id bigint, p_status text)
returns orders
language plpgsql security definer set search_path = public
as $$
declare
  v_order orders;
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;
  if p_status not in ('접수','진행중','완료','취소') then raise exception '잘못된 상태값입니다.'; end if;
  update orders set status = p_status, updated_at = now()
  where id = p_order_id
  returning * into v_order;
  if v_order.id is null then raise exception '주문을 찾을 수 없습니다.'; end if;
  return v_order;
end;
$$;
grant execute on function public.admin_set_order_status(bigint, text) to authenticated;
