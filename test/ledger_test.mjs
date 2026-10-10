// ledger_test.mjs — 账本层与 eval 加固测试:预检 lint / 永真式告警 / bash 驱动门控 CLI
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflightChecks, neverFailedAcs, recordRun, readHistory } from '../lib/ledger.js';

// ── 预检 lint ─────────────────────────────────────────────────────────
const warnings = preflightChecks(`objective: x
AC-1 | 裸 node | check: \`node foo.mjs\` | expected: exit=0
AC-2 | 相对解释器 | check: \`./tools/verify.sh\` | expected: exit=0
AC-3 | 永真嫌疑 | check: \`echo done\` | expected: exit=0
AC-4 | 健康 | check: \`test -f a.txt\` | expected: exit=0
`);
const kinds = (id) => warnings.filter((w) => w.id === id).map((w) => w.kind);
assert.ok(kinds('AC-1').includes('bare-runtime'), 'bare node flagged');
assert.ok(kinds('AC-2').includes('relative-interpreter'), 'relative interpreter flagged');
assert.ok(kinds('AC-3').includes('tautology-suspect'), 'echo-only check flagged');
assert.deepEqual(kinds('AC-4'), [], 'healthy check has no warnings');
console.log('✓ preflightChecks: bare-runtime / relative-interpreter / tautology-suspect / clean');

// ── 永真式告警(从未失败过的 AC)────────────────────────────────────────
const acs = [{ id: 'AC-1' }, { id: 'AC-2' }, { id: 'AC-3' }];
const hist = [
  { trigger: 'check', failed: ['AC-2'], unverifiable: [] },
  { trigger: 'check', failed: ['AC-2', 'AC-3'], unverifiable: [] },
];
assert.deepEqual(neverFailedAcs(hist, acs), ['AC-1'], 'AC-1 never failed across 2 runs');
assert.deepEqual(neverFailedAcs(hist.slice(1), acs), [], 'below minRuns -> no warning');
console.log('✓ neverFailedAcs: catches never-failed ACs, respects minRuns');

// 交付物覆盖 / 运行时面 / judged 绑定提醒
const w2 = preflightChecks(`objective: x
deliverable: dist/app.html
AC-1 | 静态 | check: \`test -f dist/app.html\` | expected: exit=0
AC-2 | 评审 | check: \`echo ok\` | probe: \`test -f dist/app.html\` | expected: judged
`);
assert.ok(w2.some((w) => w.kind === 'no-runtime-ac'), 'all-static contract flagged (no runtime acceptance)');
const w3 = preflightChecks(`objective: x
AC-1 | 评审 | check: \`echo ok\` | probe: \`test -f x\` | expected: judged
`);
assert.ok(w3.some((w) => w.kind === 'judged-without-deliverable'), 'judged without deliverable declaration flagged');
const w4 = preflightChecks(`objective: x
deliverable: dist/app.html
AC-1 | 不碰本体 | check: \`test -f other.txt\` | expected: exit=0
AC-2 | 运行时 | check: \`node run-app.mjs\` | expected: exit=0
`);
assert.ok(w4.some((w) => w.kind === 'deliverable-unverified'), 'deliverable never touched by any check flagged');
console.log('✓ preflight coverage: no-runtime-ac / judged-without-deliverable / deliverable-unverified');

// ── bash 驱动门控 CLI(恢复会话的循环兜底入口)──────────────────────────
const root = fs.mkdtempSync('/tmp/gate-cli-');
fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
fs.mkdirSync(path.join(root, '.goal-gate'));
fs.writeFileSync(path.join(root, '.goal-gate', 'goal.md'), `objective: CLI 驱动
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 不过 | check: \`test -f NOPE\` | expected: exit=0
`);
const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'gate.mjs');
const run = (args) => spawnSync(process.execPath, [cli, ...args, '--cwd', root], { encoding: 'utf8' });

const pf = run(['preflight']);
assert.equal(pf.status, 1, 'all-static fixture contract is correctly flagged by the new discipline');
const pfWarnings = JSON.parse(pf.stdout).warnings;
assert.ok(pfWarnings.some((w) => w.kind === 'no-runtime-ac'), 'fixture (fs checks only) gets no-runtime-ac warning');

const c1 = JSON.parse(run(['check']).stdout);
assert.equal(c1.code, 'no-go');
assert.equal(c1.round, 1);
assert.equal(c1.failedActions.length, 1);
assert.equal(c1.failedActions[0].id, 'AC-2');
assert.deepEqual(c1.neverFailed, undefined, 'first run: no never-failed warning yet');

const c2 = JSON.parse(run(['check']).stdout);
assert.deepEqual(c2.neverFailed, ['AC-1'], 'AC-1 flagged after two runs without failure');
const lines = fs.readFileSync(path.join(root, '.goal-gate', 'history.jsonl'), 'utf8').trim().split('\n');
assert.equal(lines.length, 2, 'CLI check records history');
assert.equal(JSON.parse(lines[0]).trigger, 'check');

const st = JSON.parse(run(['status']).stdout);
assert.equal(st.falseCompletes, 0);
assert.equal(st.history.length, 2);
console.log('✓ gate.mjs CLI: preflight / check(记账+failedActions+neverFailed) / status');

// ── 度量纪律:基线不许被失败观测拉低 / 契约盖戳隔离 ───────────────────────
const root2 = fs.mkdtempSync('/tmp/ledger-discipline-');
const mk = (over = {}) => ({ falseCompletes: 0, digests: {}, baselines: {}, bestScore: null, ...over });

// 1) 失败观测不推进基线;通过才推进;首次观测建档
let md = mk();
recordRun(root2, md, { code: 'no-go', score: 0.5, stamp: 'S1', results: [{ id: 'AC-1', status: 'failed' }], baselineUpdates: { 'AC-1': 5 } }, 'check');
assert.equal(md.baselines['AC-1'], 5, 'first observation establishes baseline');
recordRun(root2, md, { code: 'no-go', score: 0.5, stamp: 'S1', results: [{ id: 'AC-1', status: 'failed' }], baselineUpdates: { 'AC-1': 2 } }, 'check');
assert.equal(md.baselines['AC-1'], 5, 'failed observation must NOT slide baseline down (Goodhart)');
recordRun(root2, md, { code: 'go', score: 1, stamp: 'S1', results: [{ id: 'AC-1', status: 'passed' }], baselineUpdates: { 'AC-1': 8 } }, 'check');
assert.equal(md.baselines['AC-1'], 8, 'passed observation advances baseline');
console.log('✓ baseline discipline: establish / no-slide-on-fail / advance-on-pass');

// 2) case 边界 = loop 换代才重置 bestScore;契约微调不清史
recordRun(root2, md, { code: 'no-go', score: 0.25, stamp: 'S2', results: [{ id: 'AC-1', status: 'failed' }], baselineUpdates: {} }, 'check');
assert.equal(md.baselines['AC-1'], 8, 'contract edit must NOT wipe baselines (refinement keeps history)');
assert.equal(md.bestScore, 1, 'bestScore (max score) persists across contract edits');
console.log('✓ metric continuity: contract edits keep history');

// 3) 轮次按实验(loop)计;neverFailed 按契约盖戳隔离
const root3 = fs.mkdtempSync('/tmp/ledger-rounds-');
fs.mkdirSync(path.join(root3, '.goal-gate'));
fs.writeFileSync(path.join(root3, '.goal-gate', 'loop.json'), JSON.stringify({ createdAt: 'T1', maxRounds: 1 }));
let st3 = mk();
const run1 = recordRun(root3, st3, { code: 'no-go', score: 0.5, stamp: 'S1', results: [] }, 'check');
assert.equal(run1.round, 1, 'loop T1 round 1');
const run2 = recordRun(root3, st3, { code: 'no-go', score: 0.5, stamp: 'S1', results: [] }, 'check');
assert.equal(run2.round, 2, 'loop T1 round 2');
assert.equal(run2.roundsExhausted, true, 'T1 budget 1 exhausted at round 2');
fs.writeFileSync(path.join(root3, '.goal-gate', 'loop.json'), JSON.stringify({ createdAt: 'T2', maxRounds: 3 }));
const run3 = recordRun(root3, st3, { code: 'go', score: 1, stamp: 'S2', results: [] }, 'check');
assert.equal(run3.round, 1, 'NEW loop T2 restarts round counting');
assert.equal(run3.roundsExhausted, false, 'T2 budget fresh');
const h3 = readHistory(root3);
assert.deepEqual(neverFailedAcs(h3, [{ id: 'AC-1' }, { id: 'AC-2' }], 2, 'S2'), [], 'stamp S2 has <2 runs -> no never-failed report');
console.log('✓ loop-scoped rounds + stamp-scoped neverFailed');

console.log('\nAll ledger tests passed.');
