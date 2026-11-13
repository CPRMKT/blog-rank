// placeSearch.js가 captureSelect.js의 이름을 import 없이 쓰고 있지 않은지 본다.
// playwright 없이 돌아야 하므로 모듈을 실제로 불러오지 않고 소스만 읽는다.
//
// 왜 있는가: 캡처 로직을 captureSelect.js로 분리할 때 listPath·PAGE_DELAY_MS·findInput이
// 딸려가서 즉시조회가 전부 "0곳 (… is not defined)"이 됐다. node --check로는 안 잡힌다.
//   node scraper/tools/check_module_refs.mjs
import fs from 'fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const src = read('scraper/src/placeSearch.js');
const cap = read('scraper/src/captureSelect.js');

const declared = new Set();
for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
  for (const n of m[1].split(',')) declared.add(n.trim().split(/\s+as\s+/).pop());
}
for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);

const capNames = new Set();
// 최상위 선언만 본다. 함수 안의 지역 변수(name 등)까지 세면 멀쩡한 이름이 잡힌다.
for (const line of cap.split(/\r?\n/)) {
  const m = line.match(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) capNames.add(m[1]);
}

const used = new Set();
for (const m of src.matchAll(/[A-Za-z_$][\w$]*/g)) used.add(m[0]);

const missing = [...capNames].filter((n) => used.has(n) && !declared.has(n));
if (missing.length) {
  console.log('❌ placeSearch.js에서 선언도 import도 없이 쓰이는 이름: ' + missing.join(', '));
  process.exit(1);
}
console.log(`✅ captureSelect.js의 이름 ${capNames.size}종 중 placeSearch.js에서 쓰는 것은 전부 import 되어 있다`);
