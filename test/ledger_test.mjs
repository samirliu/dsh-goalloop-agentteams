// ledger_test.mjs — 账本层与 eval 加固测试:预检 lint / 永真式告警 / bash 驱动门控 CLI
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflightChecks, neverFailedAcs } from '../lib/ledger.js';

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
assert.equal(pf.status, 0, 'healthy contract passes preflight');
assert.deepEqual(JSON.parse(pf.stdout).warnings, []);

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

console.log('\nAll ledger tests passed.');
