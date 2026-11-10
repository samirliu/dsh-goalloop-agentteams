// v10_test.mjs — v0.10：可证伪性（neg: 反向对照）+ 顺序无关契约文法
// 覆盖精读 Art3 §1「a loop is a check that can fail」与 Art2 §7「gates rot」：
// 门控只有证明"坏产物会让这条 check 红"，才能把 GO 当真。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAcLine, parseContract, runGate, isDecisiveAc } from '../lib/core.js';
import { grillContract } from '../lib/grill.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v10-'));
fs.writeFileSync(path.join(dir, 'artifact.txt'), 'good\n');
const gate = (body, opts = {}) => runGate(`objective: v10\n${body}`, { cwd: dir, ...opts });

// ── 1. 文法：字段顺序自由；neg 可出现在任意位置 ────────────────────────────
{
  const a = parseAcLine('AC-1 | s | check: `true` | neg: `false` | expected: exit=0');
  const b = parseAcLine('AC-1 | s | neg: `false` | expected: exit=0 | check: `true`');
  assert.equal(a.ac.neg, 'false');
  assert.equal(b.ac.neg, 'false', 'field order does not matter');
  assert.equal(a.ac.check, b.ac.check);
  const noNeg = parseAcLine('AC-1 | s | check: `true` | expected: exit=0');
  assert.equal(noNeg.ac.neg, null, 'neg is optional');
  console.log('✓ v0.10 parse: neg: is order-insensitive and optional');
}

// ── 2. 文法：拼错字段 / 重复字段 / 裸命令 → 拒评（不再静默丢弃）─────────────
{
  assert.match(parseAcLine('AC-1 | s | mtric: `x` | check: `true` | expected: exit=0').error, /unknown field/);
  assert.match(parseAcLine('AC-1 | s | check: `a` | check: `b` | expected: exit=0').error, /duplicate field/);
  assert.match(parseAcLine('AC-1 | s | check: true | expected: exit=0').error, /必须用反引号/);
  assert.match(parseAcLine('AC-1 | s | check: `true`').error, /missing expected/);
  assert.match(parseAcLine('AC-1 | s | check: `true` | expected: exit=0 | baseline: nope').error, /baseline/);
  const r = gate('AC-1 | s | mtric: `x` | check: `test -f artifact.txt` | expected: exit=0');
  assert.equal(r.code, 'state-error', 'typo field refuses evaluation instead of dropping the AC');
  console.log('✓ v0.10 parse: typo/duplicate/bare-command/typo-value are fail-closed');
}

// ── 3. 门控：neg 退出非零 = 可证伪性成立 → 正常判定 ────────────────────────
{
  const r = gate('AC-1 | ok | check: `test -f artifact.txt` | neg: `test -f __absent__` | expected: exit=0');
  assert.equal(r.code, 'go', JSON.stringify(r.results));
  assert.equal(r.results[0].status, 'passed');
  assert.equal(r.results[0].negExit, 1, 'negExit is recorded for observability');
  console.log('✓ v0.10 gate: failing negative control => the AC is trustworthy');
}

// ── 4. 门控：neg 退出 0 = 永真式检查 → broken（决定性 NO-GO）───────────────
{
  const r = gate('AC-1 | vacuous | check: `test -f artifact.txt` | neg: `true` | expected: exit=0\nAC-2 | ok | check: `test -f artifact.txt` | expected: exit=0');
  assert.equal(r.code, 'broken');
  assert.equal(r.rc, 2);
  assert.equal(r.results[0].status, 'broken');
  assert.match(r.results[0].why, /vacuous check/);
  assert.match(r.reason, /AC-1/);
  assert.equal(r.results[1].status, 'passed', 'other ACs still evaluated');
  console.log('✓ v0.10 gate: a check that cannot fail is BROKEN, not a pass');
}

// ── 5. 门控：neg 的仪器故障也是 broken（超时 / 命令缺失 / 信号）────────────
{
  const missing = gate('AC-1 | x | check: `test -f artifact.txt` | neg: `__no_such_command__` | expected: exit=0');
  assert.equal(missing.code, 'broken');
  assert.match(missing.results[0].why, /negative control unavailable/);

  const slow = gate('AC-1 | x | check: `test -f artifact.txt` | neg: `sleep 3` | timeout: 1 | expected: exit=0');
  assert.equal(slow.code, 'broken');
  assert.match(slow.results[0].why, /negative control timed out/);
  console.log('✓ v0.10 gate: broken negative-control instrument is BROKEN (fail-loud, not silent)');
}

// ── 6. GG_NEG=1 注入：同一命令 + 开关切到坏夹具（避免复制断言）──────────────
{
  const r = gate('AC-1 | env switch | check: `test -f artifact.txt` | neg: `test "$GG_NEG" = 1 && exit 3; exit 0` | expected: exit=0');
  assert.equal(r.code, 'go', 'GG_NEG=1 must be exported to the negative control');
  assert.equal(r.results[0].negExit, 3, 'the control exits 3 only when GG_NEG=1 is visible');
  console.log('✓ v0.10 gate: GG_NEG=1 reaches the negative-control command');
}

// ── 7. grill：决定性 AC 缺 neg 是 medium；错误路径 AC 豁免；显式豁免生效 ─────
{
  const text = (body) => `objective: v10\n${body}`;
  const missing = grillContract({ contractText: text('AC-1 | decisive | check: `test -f artifact.txt` | expected: exit=0'), cwd: dir });
  assert.ok(missing.findings.some((f) => f.ac === 'AC-1' && /falsifiability/.test(f.issue)));

  const ok = grillContract({ contractText: text('AC-1 | decisive | check: `test -f artifact.txt` | neg: `test -f __absent__` | expected: exit=0'), cwd: dir });
  assert.ok(!ok.findings.some((f) => /falsifiability/.test(f.issue)), 'declared neg: clears the finding');

  const errPath = grillContract({ contractText: text('AC-1 | refuses bad input | check: `test -f NOPE` | expected: exit=1'), cwd: dir });
  assert.ok(!errPath.findings.some((f) => /falsifiability/.test(f.issue)), 'error-path AC is its own negative control');

  const waived = grillContract({ contractText: `vacuity-waived: 硬件在环\nobjective: v10\nAC-1 | decisive | check: \`test -f artifact.txt\` | expected: exit=0`, cwd: dir });
  assert.ok(!waived.findings.some((f) => /falsifiability/.test(f.issue)), 'vacuity-waived is an explicit, recorded waiver');
  console.log('✓ v0.10 grill: falsifiability is demanded (with error-path exemption + explicit waiver)');
}

// ── 8. isDecisiveAc：只有决定性规格需要 neg ────────────────────────────────
{
  assert.equal(isDecisiveAc({ expected: 'exit=0' }), true);
  assert.equal(isDecisiveAc({ expected: '>=0.9' }), true);
  assert.equal(isDecisiveAc({ expected: 'maximize' }), true);
  assert.equal(isDecisiveAc({ expected: 'exit=2' }), false, 'error-path assertion is exempt');
  assert.equal(isDecisiveAc({ expected: 'judged' }), false, 'judged rows are calibrated by calib: instead');
  console.log('✓ v0.10 isDecisiveAc: neg: applies to decisive specs only');
}

// ── 9. neg 解析失败不影响其它 AC；无 neg 的契约行为不变（向后兼容）──────────
{
  const legacy = gate('AC-1 | legacy | check: `test -f artifact.txt` | expected: exit=0');
  assert.equal(legacy.code, 'go', 'contracts without neg: keep working');
  const parsed = parseContract('objective: x\nAC-1 | a | check: `true` | neg: `false` | expected: exit=0');
  assert.equal(parsed.acs[0].neg, 'false');
  console.log('✓ v0.10 compat: existing contracts (no neg:) are unaffected');
}

console.log('\nAll v0.10 tests passed.');
