// n8n 실행 기록에 남은 place_rankings 스냅샷으로 10/26~11/10 을 되살릴 수 있는지 "읽기만" 대조한다.
// DB 에는 한 건도 쓰지 않는다. 네이버로도 요청하지 않는다. (경위: docs/place-rows-cause-2026-11-14.md)
//
//   node tools/snapshot_recover_check.mjs --in=<파일 또는 폴더> [--truth=<DB 집계 json>] [--out=<복원 대상 jsonl>]
//
// 입력 형식은 가리지 않는다:
//   - 폴더: 파일 하나 = 스냅샷 하나(파일 이름 순서 = 시간 순서로 본다. 이름에 날짜가 있으면 그 날짜를 스냅샷 날짜로 쓴다)
//   - 파일: JSON(배열/객체, n8n 의 {json:{...}} 포장 포함) 또는 JSONL. 행마다 스냅샷 표시 필드가 있으면 그걸 쓴다.
// 행으로 인정하는 것: place_id, keyword, checked_date 를 가진 객체(rank_type 이 있으면 'place' 만).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const arg = (k, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const IN = arg('in'); const OUT = arg('out'); const TRUTH = arg('truth');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RDIR = arg('lists', path.resolve(HERE, '../../docs/restore-2026-11'));
if (!IN) { console.log('--in=<파일 또는 폴더> 가 필요하다'); process.exit(1); }

const WIN_FROM = '2026-10-26', WIN_TO = '2026-11-10';
const inWin = (d) => d >= WIN_FROM && d <= WIN_TO;
// 2026-11-14 11:16/11:23 UTC 에 지워진 행 수(삭제 호출의 출력 그대로)에서, 2026-11-21 에 되살린 16쌍 214행을 뺀 값.
const EXPECT = {
  '2026-10-26': 25752, '2026-10-27': 24035, '2026-10-28': 24844, '2026-10-29': 19690,
  '2026-10-30': 1303, '2026-10-31': 1450, '2026-11-01': 1050, '2026-11-02': 1184,
  '2026-11-03': 986, '2026-11-04': 1033, '2026-11-05': 1413, '2026-11-06': 1236,
  '2026-11-07': 1029, '2026-11-08': 1029, '2026-11-09': 1699, '2026-11-10': 25193,
};
const EXPECT_SUM = Object.values(EXPECT).reduce((a, b) => a + b, 0);   // 132,926

const SNAP_FIELDS = ['snapshot', 'snapshot_at', 'snapshot_date', 'exec', 'execution', 'execution_id', 'executionId', 'startedAt', 'started_at'];
const dateIn = (s) => { const m = String(s).match(/(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
let tzFixed = 0;
const normDate = (v) => {
  const s = String(v);
  if (s.length <= 10) return s;
  // date 타입이 UTC 로 직렬화돼 하루 밀린 꼴(…T15:00:00.000Z)이면 KST 로 되돌린다
  const t = new Date(s); if (isNaN(t)) return s.slice(0, 10);
  tzFixed++; return new Date(t.getTime() + 9 * 3600000).toISOString().slice(0, 10);
};

const rows = [];   // { snap, d, kw, pid, rank }
function walk(node, snap) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, snap); return; }
  let s = snap;
  for (const f of SNAP_FIELDS) if (node[f] != null && typeof node[f] !== 'object') { s = String(node[f]); break; }
  if (node.place_id != null && node.keyword != null && node.checked_date != null) {
    if (node.rank_type == null || node.rank_type === 'place') {
      rows.push({ snap: s, d: normDate(node.checked_date), kw: String(node.keyword), pid: String(node.place_id), rank: node.rank == null ? null : Number(node.rank) });
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') walk(v, dateIn(k) && !Array.isArray(node) ? (s === snap ? k : s) : s);
  }
}
function loadFile(fp, snap) {
  const txt = fs.readFileSync(fp, 'utf8').replace(/^﻿/, '');
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch {}
  if (parsed !== null) { walk(parsed, snap); return; }
  let bad = 0;
  for (const ln of txt.split(/\r?\n/)) { if (!ln.trim()) continue; try { walk(JSON.parse(ln), snap); } catch { bad++; } }
  if (bad) console.log(`  ⚠ ${path.basename(fp)}: 해석 못 한 줄 ${bad}개`);
}
const st = fs.statSync(IN);
if (st.isDirectory()) {
  // 폴더에 *.place.jsonl 이 있으면 그것만 읽는다(*.store.jsonl = 블로그 순위, MANIFEST.json 은 입력이 아니다).
  // 예전엔 rank_type 필드 거름망 하나에만 기댔다 — 필드가 빠진 블로그 행이 섞일 수 있었다.
  const all = fs.readdirSync(IN).filter((f) => /\.(json|jsonl|ndjson)$/i.test(f)).sort();
  const placeOnly = all.filter((f) => /\.place\.jsonl$/i.test(f));
  const files = placeOnly.length ? placeOnly : all.filter((f) => !/^MANIFEST\.json$/i.test(f) && !/\.store\.jsonl$/i.test(f));
  console.log(`입력 파일 선별: 전체 ${all.length}개 중 ${files.length}개 사용${placeOnly.length ? ' (*.place.jsonl 만)' : ''}`);
  for (const f of files) loadFile(path.join(IN, f), f);
  console.log(`입력: 폴더 ${IN} — 파일 ${files.length}개`);
} else { loadFile(IN, path.basename(IN)); console.log(`입력: 파일 ${IN}`); }
console.log(`읽은 플레이스 행: ${rows.length.toLocaleString()}개${tzFixed ? ` (날짜 시간대 보정 ${tzFixed}개)` : ''}`);
if (!rows.length) { console.log('❌ place_id/keyword/checked_date 를 가진 행을 하나도 못 찾았다 — 파일 구조를 확인할 것'); process.exit(1); }

// ── 스냅샷 × 날짜 표 ──
const snaps = [...new Set(rows.map((r) => r.snap))].sort();
const bySnapDate = {};
for (const r of rows) { const k = r.snap + '\u0001' + r.d; (bySnapDate[k] = bySnapDate[k] || []).push(r); }
const datesAll = [...new Set(rows.map((r) => r.d))].sort();
console.log(`\n스냅샷 ${snaps.length}개: ${snaps[0]} … ${snaps[snaps.length - 1]}`);
console.log(`담긴 날짜: ${datesAll[0]} ~ ${datesAll[datesAll.length - 1]} (${datesAll.length}일)`);

// 날짜 D 에 쓸 스냅샷: D 를 담은 것 중 가장 늦은 것. 단 "그날 아침 스냅샷"(수집 도중이라 덜 찼다)은 다른 게 있으면 피한다.
const pick = {};
console.log('\n■ 날짜별 스냅샷 행 수 (같은 날짜가 여러 스냅샷에 있으면 값이 같아야 안정된 것)');
for (const d of datesAll) {
  const have = snaps.filter((s) => bySnapDate[s + '\u0001' + d]);
  const later = have.filter((s) => { const sd = dateIn(s); return !sd || sd > d; });
  const use = (later.length ? later : have).slice(-1)[0];
  pick[d] = use;
  const counts = have.map((s) => `${dateIn(s) ? dateIn(s).slice(5) : s}:${bySnapDate[s + '\u0001' + d].length}`).join('  ');
  const stable = new Set((later.length ? later : have).map((s) => bySnapDate[s + '\u0001' + d].length)).size === 1;
  if (inWin(d) || TRUTH) console.log(`  ${d}  ${stable ? '안정' : '⚠변함'}  고른 것=${dateIn(use) || use}  [${counts}]`);
}

// ── 제외 목록 ──
const excl = new Set(JSON.parse(fs.readFileSync(path.join(RDIR, 'exclude_pairs.json'), 'utf8')).pairs.map((p) => p.date + '|' + p.keyword));
const done16 = new Set(JSON.parse(fs.readFileSync(path.join(RDIR, 'include_16pairs.json'), 'utf8')).pairs.map((p) => p.date + '|' + p.keyword));
let logPairs = {};
try { logPairs = JSON.parse(fs.readFileSync(path.join(RDIR, 'log_pair_counts.json'), 'utf8')).days; } catch {}
console.log(`\n제외: 오염 쌍 ${excl.size}개 + 이미 되살린 쌍 ${done16.size}개`);

// ── 복구 대상 계산 ──
const target = [];
const rep = [];
let nullRank = 0, nullPid = 0, badRank = 0;
for (const d of Object.keys(EXPECT)) {
  const src = pick[d] ? bySnapDate[pick[d] + '\u0001' + d] : [];
  const all = src.length;
  let exA = 0, exB = 0;
  const keep = [];
  for (const r of src) {
    const k = d + '|' + r.kw;
    if (excl.has(k)) { exA++; continue; }
    if (done16.has(k)) { exB++; continue; }
    if (r.rank == null) nullRank++; else if (!(r.rank >= 1 && r.rank <= 300)) badRank++;
    if (!r.pid || r.pid === 'null') nullPid++;
    keep.push(r);
  }
  // 쌍 단위로 수집 로그의 마지막 저장 행 수와 맞춰 본다
  const perKw = {}; for (const r of keep) perKw[r.kw] = (perKw[r.kw] || 0) + 1;
  const lp = logPairs[d] || {};
  const miss = [], extra = [], diff = [];
  for (const [kw, n] of Object.entries(lp)) {
    const k = d + '|' + kw; if (excl.has(k) || done16.has(k)) continue;
    if (!(kw in perKw)) { if (n > 0) miss.push(`${kw}(${n})`); } else if (perKw[kw] !== n) diff.push(`${kw}(로그 ${n}→스냅샷 ${perKw[kw]})`);
  }
  for (const kw of Object.keys(perKw)) if (!(kw in lp)) extra.push(`${kw}(${perKw[kw]})`);
  rep.push({ d, all, exA, exB, keep: keep.length, pairs: Object.keys(perKw).length, expect: EXPECT[d], miss, extra, diff });
  for (const r of keep) target.push(r);
}
console.log('\n■ 복구 대상 대조 (스냅샷 − 제외 쌍 − 되살린 16쌍  vs  2026-11-14 에 지워진 행 수)');
console.log('  날짜        스냅샷   −오염   −16쌍   복구대상   잃은행     차이   쌍수');
let sumKeep = 0, okDays = 0;
for (const r of rep) {
  sumKeep += r.keep; const df = r.keep - r.expect; if (df === 0) okDays++;
  console.log(`  ${r.d}  ${String(r.all).padStart(7)} ${String(r.exA).padStart(7)} ${String(r.exB).padStart(7)} ${String(r.keep).padStart(10)} ${String(r.expect).padStart(8)} ${(df === 0 ? '✅ 0' : (df > 0 ? '+' : '') + df).padStart(8)} ${String(r.pairs).padStart(6)}`);
}
console.log(`  합계 복구대상 ${sumKeep.toLocaleString()} / 잃은 행 ${EXPECT_SUM.toLocaleString()} / 차이 ${sumKeep - EXPECT_SUM} / 일치한 날 ${okDays}/16`);
console.log(sumKeep === EXPECT_SUM && okDays === 16 ? '\n✅ 완전 복구 가능 — 16일 모두 행 수가 정확히 일치' : '\n⚠ 불일치가 있다 — 아래 쌍 단위 내역을 볼 것');
for (const r of rep) {
  if (!r.miss.length && !r.extra.length && !r.diff.length) continue;
  console.log(`\n  [${r.d}] 로그에는 있는데 스냅샷에 없는 쌍 ${r.miss.length} / 스냅샷에만 있는 쌍 ${r.extra.length} / 행 수가 다른 쌍 ${r.diff.length}`);
  if (r.miss.length) console.log('    없음: ' + r.miss.slice(0, 12).join(', ') + (r.miss.length > 12 ? ' …' : ''));
  if (r.extra.length) console.log('    추가: ' + r.extra.slice(0, 12).join(', ') + (r.extra.length > 12 ? ' …' : ''));
  if (r.diff.length) console.log('    다름: ' + r.diff.slice(0, 12).join(', ') + (r.diff.length > 12 ? ' …' : ''));
}
console.log(`\n■ 값 점검(복구 대상): rank 없음 ${nullRank} / rank 범위 밖(1~300) ${badRank} / place_id 없음 ${nullPid}`);
const r1 = new Set(target.filter((r) => r.rank === 1).map((r) => r.d + '|' + r.kw));
const allPairs = new Set(target.map((r) => r.d + '|' + r.kw));
console.log(`  1위 행이 있는 쌍 ${r1.size} / 전체 쌍 ${allPairs.size}  (화면의 '수집됨' 판정은 그날 1위 행 유무로 한다)`);

// ── 스냅샷이 DB 와 같은지: 멀쩡한 날짜로 검증 ──
const fp = (list) => {
  const b = (s) => Buffer.from(s, 'utf8');
  const sorted = list.slice().sort((x, y) => Buffer.compare(b(x.kw), b(y.kw)) || Buffer.compare(b(x.pid), b(y.pid)) || (x.rank - y.rank));
  return crypto.createHash('md5').update(sorted.map((r) => `${r.kw}|${r.pid}|${r.rank}`).join('\n'), 'utf8').digest('hex');
};
if (TRUTH) {
  const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  console.log('\n■ 스냅샷 충실도 검증 — 지금도 DB 에 멀쩡히 있는 날짜를 스냅샷과 비교');
  for (const t of truth) {
    const src = pick[t.d] ? bySnapDate[pick[t.d] + '\u0001' + t.d] : null;
    if (!src) { console.log(`  ${t.d}  스냅샷에 없음`); continue; }
    const sum = src.reduce((a, r) => a + (r.rank || 0), 0);
    const h = fp(src);
    const ok = src.length === Number(t.rows) && sum === Number(t.rank_sum) && h === t.md5;
    console.log(`  ${t.d}  행 ${src.length}/${t.rows}  순위합 ${sum}/${t.rank_sum}  지문 ${h === t.md5 ? '일치' : '불일치'}  ${ok ? '✅' : '❌'}`);
  }
}
if (OUT) {
  fs.writeFileSync(OUT, target.map((r) => JSON.stringify({ checked_date: r.d, keyword: r.kw, rank: r.rank, place_id: r.pid })).join('\n') + '\n');
  console.log(`\n복구 대상 ${target.length.toLocaleString()}행을 ${OUT} 에 썼다 (DB 에는 쓰지 않았다)`);
}
