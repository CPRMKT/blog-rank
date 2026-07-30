-- 2026-07-31 · (테스트용) cprmkt 계정에 포인트 수기 충전
-- 토스 키 세팅 전 발주 흐름 검증용. 실서비스 데이터 아님.
-- username으로 owner_id 조회 → 1,000,000P 충전 원장 1건 추가.

insert into point_transactions(owner_id, type, amount, memo)
select id, '충전', 1000000, '테스트 충전(수기)'
from profiles where lower(username) = 'cprmkt';
