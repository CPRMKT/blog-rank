-- 매장 탭별 소속 플래그 — 2026-07-25
-- "매장 블로그 순위"(in_blog)와 "플레이스 순위 추적"(in_place)의 매장 목록을 독립 관리.
-- Supabase SQL Editor에서 1회 실행. idempotent(재실행 안전).
-- 기존 매장은 둘 다 true로 채워져 현행(양쪽 탭 모두 노출) 그대로 유지됨.

alter table stores add column if not exists in_blog  boolean not null default true;
alter table stores add column if not exists in_place boolean not null default true;
