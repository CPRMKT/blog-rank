// 텔레그램 연결 도우미 — 토큰을 넣은 뒤 이 스크립트 하나로 chat_id 확인 + 시험 발송까지.
//
// 순서
//  1) 텔레그램에서 @BotFather 검색 → /newbot → 이름 정하면 토큰이 나온다.
//  2) 서버 .env 에 한 줄 추가:  TELEGRAM_BOT_TOKEN=<받은 토큰>
//  3) 방금 만든 봇을 텔레그램에서 찾아 아무 말이나 한 번 보낸다(이걸 해야 chat_id가 생긴다).
//  4) node tools/telegram_setup.mjs  → 출력된 TELEGRAM_CHAT_ID 를 .env 에 추가
//  5) node tools/telegram_setup.mjs  → 이번엔 시험 메시지가 도착한다.
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;

if (!token) {
  console.log('TELEGRAM_BOT_TOKEN 이 .env 에 없습니다. 1~2단계를 먼저 해주세요.');
  process.exit(1);
}

if (!chat) {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).then((x) => x.json()).catch(() => null);
  if (!r || !r.ok) { console.log('토큰이 잘못된 것 같습니다. BotFather에서 받은 값을 다시 확인해 주세요.'); process.exit(1); }
  const ids = [...new Set((r.result || []).map((u) => u.message && u.message.chat && u.message.chat.id).filter(Boolean))];
  if (!ids.length) { console.log('아직 대화 기록이 없습니다. 봇에게 아무 말이나 한 번 보낸 뒤 다시 실행해 주세요(3단계).'); process.exit(1); }
  console.log('\n.env 에 아래 줄을 추가해 주세요:\n');
  console.log(`TELEGRAM_CHAT_ID=${ids[0]}`);
  if (ids.length > 1) console.log(`(여러 개 발견: ${ids.join(', ')} — 본인 계정 것을 쓰세요)`);
  process.exit(0);
}

const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chat, text: '✅ blog-rank 알림 연결 완료.\n앞으로 수집에 문제가 있을 때만 알림이 옵니다(하루 최대 3통).' }),
}).then((x) => x.json()).catch(() => null);

console.log(r && r.ok ? '시험 메시지를 보냈습니다. 텔레그램을 확인해 주세요.' : `발송 실패: ${r && r.description ? r.description : '알 수 없음'}`);
