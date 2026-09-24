-- 주간 예측 검증 배치(크론=service_role)가 두 테이블을 읽고 쓸 수 있게 권한 부여.
-- 9/24 스크립트에서 authenticated 에만 부여해 크론이 permission denied 로 막혔다.
grant select, insert, update, delete on public.blog_diagnoses  to service_role;
grant select, insert, update, delete on public.blog_predictions to service_role;
grant usage, select on sequence public.blog_diagnoses_id_seq  to service_role;
grant usage, select on sequence public.blog_predictions_id_seq to service_role;
