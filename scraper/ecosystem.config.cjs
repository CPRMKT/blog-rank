// PM2 프로세스 정의. NCP Micro 1GB RAM 환경에 맞춰 max_memory_restart 800M로 설정.
module.exports = {
  apps: [
    {
      name: 'blog-rank-scraper',
      script: './src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        // SCRAPER_API_KEY 는 .env 또는 export 로 주입
      },
      error_file: '/var/log/blog-rank-scraper/err.log',
      out_file: '/var/log/blog-rank-scraper/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
