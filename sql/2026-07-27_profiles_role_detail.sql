-- 2026-07-27 · 회원가입 "역할=기타" 직접입력 저장용 컬럼
-- Supabase SQL Editor에서 실행함. idempotent.
alter table profiles add column if not exists role_detail text;
