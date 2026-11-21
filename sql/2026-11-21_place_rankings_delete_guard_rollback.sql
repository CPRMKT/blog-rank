-- place_rankings 삭제 가드 되돌림 (2026-11-21)
-- 가드 때문에 정상 수집이 막히는 일이 생기면 (1)만 실행하면 즉시 풀린다.
-- 감사 기록 표는 기록이므로 지우지 않는다(지우려면 맨 아래 주석을 풀 것).

-- (1) 가드만 끄기 — 이것만으로 삭제 상한이 사라진다
drop trigger if exists trg_guard_place_rankings_delete on public.place_rankings;

-- (2) TRUNCATE 차단 끄기
drop trigger if exists trg_block_truncate on public.place_rankings;

-- (3) 함수 제거
drop function if exists public.guard_place_rankings_delete();
drop function if exists public.block_truncate();
drop function if exists public.purge_place_pairs(date, text[], int, text);

-- (4) 감사 기록 표 — 기록 보존을 위해 기본은 남긴다
-- drop table if exists public.place_rankings_delete_audit;
