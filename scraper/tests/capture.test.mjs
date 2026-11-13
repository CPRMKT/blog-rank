// GraphQL 캡처 선택 로직 테스트 — 네트워크 없이 녹화본(fixture)만으로 돈다.
//   node scraper/tests/capture.test.mjs
//
// 왜 있는가: 2026-10-30~11-09에 '신규 오픈' 모듈 쿼리를 순위 목록으로 잘못 채택해
// 1,199건이 오염됐다. 캡처 선택 로직을 건드리면 반드시 이 테스트를 돌릴 것.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { inspectCapture, isListOp, LIST_OPS } from '../src/captureSelect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'graphql-requests.json'), 'utf8'));

let fail = 0;
const check = (cond, msg) => { if (!cond) fail++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };
const body = (k) => JSON.stringify(F[k]);

console.log('■ 정상 목록 쿼리는 채택한다');
for (const k of ['정상_restaurant', '정상_hairshop', '정상_hospital']) {
  const r = inspectCapture(body(k));
  check(r.accept === true, `${k} → 채택 (본 쿼리: ${r.ops.join(', ')})`);
}

console.log('\n■ 신규 오픈 모듈은 채택하지 않는다 (오염의 원인)');
for (const k of ['신규오픈_변종1_입력없음', '신규오픈_변종2_입력있음']) {
  const r = inspectCapture(body(k));
  check(r.accept === false, `${k} → 거부 (본 쿼리: ${r.ops.join(', ')})`);
}

console.log('\n■ 허용 목록 밖 이름은 모양이 비슷해도 거부');
{
  const r = inspectCapture(body('이름만바뀐가짜_오픈모듈'));
  check(r.accept === false, `모르는 쿼리 이름 → 거부 (${r.ops.join(', ')})`);
  check(r.ops.length === 1 && r.ops[0] === 'getSomethingElse', '거부해도 본 쿼리 이름은 돌려준다(로그용)');
}

console.log('\n■ 한 요청에 여러 op이 섞여 오면 목록 op 하나만 있어도 채택');
{
  const r = inspectCapture(body('배치요청_오픈먼저_목록뒤'));
  check(r.accept === true, `오픈+목록 배치 → 채택 (${r.ops.join(', ')})`);
}

console.log('\n■ 망가진 입력에도 죽지 않는다');
check(inspectCapture('{이건 JSON이 아님').accept === false, '깨진 JSON → 거부');
check(inspectCapture(body('변수없음')).accept === false, 'variables 없음 → 거부');
check(isListOp(null) === false, 'null → 거부');

console.log('\n■ 허용 목록은 환경변수로 넓힐 수 있다');
check(LIST_OPS.has('getRestaurants') && LIST_OPS.has('getPlaceListBeauty') && LIST_OPS.has('getNxList'),
  `기본 허용 목록 3종 포함 (${[...LIST_OPS].join(', ')})`);

console.log(`\n=== ${fail ? fail + '건 실패' : '전부 통과'} ===`);
process.exit(fail ? 1 : 0);
