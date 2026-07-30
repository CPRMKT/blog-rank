-- 2026-07-27 · 발주 2단계 - 세금계산서 신청 접수 테이블
-- Supabase SQL Editor에서 1회 실행. DROP 없음, idempotent.
-- 조회=본인/관리자, 신청(insert)=본인, 수정/삭제=service_role. 자동발행 없이 "접수"만 저장.

create table if not exists tax_invoice_requests (
  id                     bigint generated always as identity primary key,
  owner_id               uuid not null references profiles(id) on delete cascade default auth.uid(),
  business_number        text not null,                                  -- 사업자등록번호
  email                  text not null,                                  -- 세금계산서 수신 이메일
  company_name           text,                                           -- 상호(선택)
  related_transaction_id bigint references point_transactions(id) on delete set null,  -- 연결 충전건(선택)
  status                 text not null default '접수' check (status in ('접수','발행완료','취소')),
  created_at             timestamptz not null default now()
);
create index if not exists idx_tax_req_owner on tax_invoice_requests(owner_id);

alter table tax_invoice_requests enable row level security;
drop policy if exists "tax_req select own/admin" on tax_invoice_requests;
create policy "tax_req select own/admin" on tax_invoice_requests for select to authenticated
  using (auth.uid() = owner_id or public.is_admin());
drop policy if exists "tax_req insert own" on tax_invoice_requests;
create policy "tax_req insert own" on tax_invoice_requests for insert to authenticated
  with check (auth.uid() = owner_id);

grant select, insert on tax_invoice_requests to authenticated;
grant all on tax_invoice_requests to service_role;
