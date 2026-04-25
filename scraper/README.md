# Blog Rank Scraper (한국 서버)

NCP Micro Server 1GB RAM 위에서 PM2로 Express + Playwright(Chromium) 운영.
한국 IP에서 네이버 블로그 탭을 직접 보고 1~30위까지 정확한 순위를 추출,
Vercel API에 JSON으로 응답한다.

```
[Vercel] ─ HTTPS + Bearer ─▶ [NCP 서버 :8080]
                                    │
                                    ▼ (Playwright)
                            search.naver.com
```

## 1. NCP 서버 만들기 (5분)

1. https://console.ncloud.com/server 접속 → **Server > 서버 생성**
2. 이미지: **Ubuntu Server 22.04 (g3)**
3. 서버 타입: **Micro (1 vCPU / 1GB RAM)**
4. 리전/존: **KR-1 (서울)**
5. 인증키: 새로 생성 후 `.pem` 파일 다운로드
6. **공인 IP 신청 → 서버에 연결** (서버 생성 후 좌측 "Public IP" 메뉴)
7. **ACG (방화벽)** 인바운드 규칙 추가:
   - 22 / TCP / `내 PC IP/32` (SSH, 본인 IP만)
   - 8080 / TCP / `0.0.0.0/0` (Vercel 호출 — 일단 모든 IP 허용)

> 공인 IP 비용: 시간당 ~25원, 24×30 = 약 18,000원/월. 사용 안 할 때는 반납 가능.
> 줄이려면 추후 NCP의 ALB(load balancer) 또는 VPC NAT 통해 도메인 + HTTPS 구성.

## 2. SSH 접속 + 패키지 설치 (10분)

```bash
# Windows PowerShell / Git Bash 에서:
ssh -i path\to\your_key.pem root@<공인IP>

# === 이하 NCP 서버 안에서 실행 ===

# 1) Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2) Playwright (Chromium) 의존성 — Ubuntu 22.04
apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  libpangocairo-1.0-0 libxshmfence1 libwoff1 libharfbuzz-icu0

# 3) PM2
npm install -g pm2

# 4) 로그 디렉토리
mkdir -p /var/log/blog-rank-scraper
```

## 3. 코드 배포 + 환경변수 (5분)

```bash
# blog-rank repo clone (private이면 deploy key 또는 PAT)
mkdir -p /opt && cd /opt
git clone https://github.com/CPRMKT/blog-rank.git
cd blog-rank/scraper

# 의존성
npm install
npx playwright install chromium

# API 키 발급 + .env 작성 (한 번만)
KEY=$(openssl rand -hex 32)
cat > .env <<EOF
SCRAPER_API_KEY=$KEY
PORT=8080
EOF
echo
echo "=== 이 키를 Vercel 환경변수 KOREAN_SCRAPER_KEY 에 추가 ==="
echo "$KEY"
echo "==========================================================="
```

## 4. PM2로 실행

```bash
# .env 를 PM2 환경에 주입
export $(cat .env | xargs)

pm2 start ecosystem.config.cjs --update-env
pm2 logs blog-rank-scraper --lines 30   # 정상 시작 확인 → "Listening on :8080"
pm2 startup                              # 출력되는 명령 그대로 다시 실행
pm2 save
```

## 5. 검증

서버 안에서:

```bash
# health
curl http://localhost:8080/health
# {"ok":true,"time":"..."}

# scrape (KEY 는 .env 에 저장된 값)
curl -H "Authorization: Bearer $SCRAPER_API_KEY" \
  "http://localhost:8080/scrape?keyword=%EC%88%98%EC%98%81+%EA%B5%B4%EB%B3%B4%EC%8C%88&count=15"
```

PC에서:

```bash
curl -H "Authorization: Bearer <위 KEY>" \
  "http://<공인IP>:8080/scrape?keyword=%EC%88%98%EC%98%81+%EA%B5%B4%EB%B3%B4%EC%8C%88&count=15"
```

## 6. Vercel 환경변수 변경

Vercel 대시보드 → blog-rank → Settings → Environment Variables:

```
SEARCH_METHOD       = korean
KOREAN_SCRAPER_URL  = http://<공인IP>:8080
KOREAN_SCRAPER_KEY  = <위 KEY>
APIFY_TOKEN         = (삭제 또는 비움)
SERPAPI_KEY         = (삭제 또는 비움)
```

저장 후 Deployments → Redeploy.

## 운영 명령

```bash
pm2 status                 # 프로세스 상태
pm2 logs blog-rank-scraper # 실시간 로그
pm2 restart blog-rank-scraper
pm2 stop blog-rank-scraper

# 코드 업데이트
cd /opt/blog-rank
git pull
cd scraper
npm install                # package.json 변경됐을 때만
pm2 restart blog-rank-scraper --update-env
```

## 메모리/리소스 메모

- Chromium 1 인스턴스 = 약 200~400MB
- Node + Express = 약 50~100MB
- max_memory_restart 800M 로 자동 재시작
- 일 50회 호출, 동시 1요청 가정

## HTTPS 업그레이드 (나중)

도메인 확보 시 Caddy 추가:
```bash
apt-get install -y caddy
# /etc/caddy/Caddyfile 에:
# scraper.example.com {
#   reverse_proxy localhost:8080
# }
systemctl restart caddy
```
ACG 80, 443 인바운드 추가, 8080은 닫기.
