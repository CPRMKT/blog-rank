-- 2026-07-27 · 발주 기능 1단계 스키마 (orders, point_transactions, is_admin)
-- Supabase SQL Editor에서 1회 실행. DROP 없음, idempotent.
-- 원칙: 조회는 본인(owner_id=auth.uid()) 또는 관리자(is_admin), 쓰기는 service_role 전용.
--       포인트 잔액 = point_transactions 합산(별도 balance 컬럼 없음).

-- 1) 관리자 플래그 + cprmkt 관리자 지정
alter table profiles add column if not exists is_admin boolean not null default false;
update profiles set is_admin = true where lower(username) = 'cprmkt';

-- 관리자 판별 헬퍼(SECURITY DEFINER → RLS 재귀/권한 없이 profiles 조회)
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;
grant execute on function public.is_admin() to authenticated;

-- 2) orders (주문)
create table if not exists orders (
  id            bigint generated always as identity primary key,
  owner_id      uuid not null references profiles(id) on delete cascade default auth.uid(),
  store_id      bigint references stores(id) on delete set null,   -- 매장 무관 상품 가능(nullable)
  category      text,                                              -- 리워드/블로그기자단/체험단/캠페인… (자유값)
  product_name  text,
  options       jsonb,                                             -- 수량/기간/키워드 등 상품별 유연 저장
  unit_price    integer,
  quantity      integer,
  total_price   integer,
  status        text not null default '접수' check (status in ('접수','진행중','완료','취소')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_orders_owner on orders(owner_id);
create index if not exists idx_orders_store on orders(store_id);

-- 3) point_transactions (포인트 원장)
create table if not exists point_transactions (
  id               bigint generated always as identity primary key,
  owner_id         uuid not null references profiles(id) on delete cascade default auth.uid(),
  type             text not null check (type in ('충전','차감','환불')),
  amount           integer not null,                              -- 잔액 변화량(부호 포함): 충전·환불=+, 차감=-
  related_order_id bigint references orders(id) on delete set null,
  memo             text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_ptx_owner on point_transactions(owner_id);

-- 4) RLS: 조회만(본인 또는 관리자). 쓰기 정책 없음 → service_role만 기록.
alter table orders enable row level security;
alter table point_transactions enable row level security;
drop policy if exists "orders select own/admin" on orders;
create policy "orders select own/admin" on orders for select to authenticated
  using (auth.uid() = owner_id or public.is_admin());
drop policy if exists "ptx select own/admin" on point_transactions;
create policy "ptx select own/admin" on point_transactions for select to authenticated
  using (auth.uid() = owner_id or public.is_admin());

-- 5) 권한: authenticated는 조회(RLS 제한), service_role은 전체(백엔드 기록)
grant select on orders, point_transactions to authenticated;
grant all    on orders, point_transactions to service_role;
