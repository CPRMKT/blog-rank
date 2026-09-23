# NCP 서버 크론탭 (blog-rank)

서버의 `crontab -l` 원본. 변경 시 이 문서도 같이 갱신한다. 변경 전 백업: `/root/crontab.backup.*`

```cron
# blog-rank 순위 자동 수집 — 매일 06:00 KST
MAILTO=""
# 새벽: 블로그 → 끝나는 즉시 플레이스(체인). 두 수집이 같은 브라우저를 동시에 쓰던 겹침 제거(9/18 0곳 10건 사건).
#   블로그가 실패해도(;) 플레이스는 실행. 블로그가 매달려도 3시간 뒤 강제 종료하고 플레이스로 넘어감.
#   강제 종료(124)면 남은 락 파일 제거 — 안 치우면 다음 날 블로그 수집이 "이미 실행 중"으로 스스로 종료됨.
0 6 * * * cd /opt/blog-rank/scraper && set -a; . ./.env; set +a; /usr/bin/timeout 3h /usr/bin/node collect.mjs >> /var/log/blog-rank-scraper/collect.log 2>&1; [ $? -eq 124 ] && rm -f /tmp/blog-rank-collect.lock; /usr/bin/node collectPlace.mjs >> /var/log/blog-rank-scraper/place-collect.log 2>&1
# 저녁: 플레이스만(겹칠 상대 없음)
30 18 * * * cd /opt/blog-rank/scraper && set -a; . ./.env; set +a; /usr/bin/node collectPlace.mjs >> /var/log/blog-rank-scraper/place-collect.log 2>&1
# 예방적 브라우저 재시작 — 장기 가동 크롬 크래시(8/30 전멸) 재발 방지
50 5 * * * /usr/bin/pm2 restart blog-rank-scraper >/dev/null 2>&1
```

## 임시: 즉시조회 페이스 검증(2026-09-23~, 데이터 모으면 3줄 삭제)
```cron
10 10 * * * ... node tools/burst_test.mjs --delay=0    --n=20 --label=A-wait0-am
10 15 * * * ... node tools/burst_test.mjs --delay=5000 --n=20 --label=B-wait5-pm
20 19 * * * ... node tools/burst_test.mjs --delay=0    --n=15 --label=C-wait0-overlap   # 저녁 크론과 겹침
```
조회만 하고 저장하지 않으므로 데이터 영향 없음. 결과: `/var/log/blog-rank-scraper/burst-test.log`.
판단 기준: 여러 날 반복해 0곳 0건이면 해당 페이스 안전.

## 이력
- 2026-09-19: 0곳보류 급증의 진짜 원인은 겹침이 아니라 **수집 간격**으로 확정.
  키워드당 19.5~24.4초 간격(9/13~17)이면 0건, 16~17초(9/18~19)면 10~56건.
  DB 인덱스로 저장이 10초→1초가 되며 자연 간격이 사라진 것 + 스캔 가속(9/17, 롤백함).
  collectPlace.mjs 키워드 간 대기 4→11초로 ~24초 간격 복원. 체인 실행은 유지(무해).
  예상 소요: 플레이스 1회 ~128분 → 새벽은 블로그 종료(~07:30) 후 ~09:40 완료.
- 2026-09-18: 새벽 플레이스 크론을 06:30 고정 → 블로그 종료 직후 체인 실행으로 변경.
  근거: 블로그 런이 키워드 증가로 06:00~07:35까지 늘어 06:30 플레이스와 겹쳤고,
  겹친 구간(07:26~07:33)에서 네이버가 빈 목록을 반환해 0곳보류 10건 발생. 블로그 종료 직후 회복.
- 2026-09-01: 05:50 예방적 pm2 재시작 추가.
