// index.html 안에서 "존재하지 않는 요소를 코드가 참조하는" 자리를 찾는다.
// 2026-09-25 회귀(화면 재구성 때 지운 #bdDetailSec을 심사 시작 함수가 참조 → 전면 멈춤)를 막기 위한 정적 검사.
// 사용: node tools/check_dom_refs.mjs [index.html 경로]
import fs from 'fs';

const file = process.argv[2] || 'index.html';
const html = fs.readFileSync(file, 'utf8');

// 마크업에 존재하는 id (동적으로 만들어 붙이는 문자열까지 포함)
const declared = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) declared.add(m[1]);
// 템플릿 문자열로 만들어지는 id (예: id="kw-${blogId}-${idx}")도 접두사로 인정
const dynamicPrefixes = [...declared].filter((d) => d.includes('${')).map((d) => d.split('${')[0]);

// 코드에서 참조하는 id
const refs = new Map(); // id -> 줄번호들
const lines = html.split('\n');
lines.forEach((line, i) => {
  for (const m of line.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!refs.has(m[1])) refs.set(m[1], []);
    refs.get(m[1]).push(i + 1);
  }
});

const missing = [];
for (const [id, at] of refs) {
  if (declared.has(id)) continue;
  if (dynamicPrefixes.some((p) => p && id.startsWith(p))) continue;
  missing.push({ id, at });
}

// 참조는 없는데 마크업에만 있는 id는 문제 아님(스타일·링크 대상일 수 있음) → 보고하지 않는다.
if (missing.length) {
  console.log(`❌ 존재하지 않는 요소를 참조하는 곳 ${missing.length}건`);
  for (const m of missing) console.log(`  #${m.id} — ${file}:${m.at.join(', ')}`);
  console.log('\n화면을 재구성하면서 요소를 지웠다면, 그 요소를 쓰던 코드도 같이 고쳐야 합니다.');
  process.exit(1);
}
console.log(`✅ getElementById 참조 ${refs.size}종 전부 마크업에 존재`);
