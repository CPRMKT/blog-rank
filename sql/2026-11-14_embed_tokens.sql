-- 임베드(끼워 넣기) 토큰 — 2026-11-14
-- Supabase SQL Editor에서 1회 실행. idempotent(재실행 안전).
--
-- 다른 테이블과 달리 anon/authenticated 정책을 두지 않는다(service_role 전용).
-- 토큰이 곧 열쇠라, 로그인한 사용자가 남의 토큰을 읽을 수 있으면 안 된다.
create table if not exists embed_tokens (
  id         bigint generated always as identity primary key,
  store_id   bigint not null references stores(id) on delete cascade,
  token      text   not null unique,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  owner_id   uuid
);
create index if not exists idx_embed_tokens_store on embed_tokens (store_id);
-- 매장당 켜져 있는 토큰은 하나만(재발급하면 옛 토큰은 enabled=false로 내려간다)
create unique index if not exists idx_embed_tokens_active on embed_tokens (store_id) where enabled;

alter table embed_tokens enable row level security;
-- 정책을 만들지 않는다 = anon/authenticated는 RLS에 막혀 한 행도 못 읽는다.
revoke all on embed_tokens from anon, authenticated;
grant all on embed_tokens to service_role;
