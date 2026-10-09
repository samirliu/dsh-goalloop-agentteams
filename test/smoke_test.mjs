// smoke_test.mjs — core.js 冒烟：契约解析、盖戳、门控 rc、假完成计数、判定边界、摘要
import assert from 'node:assert/strict';
import { runGate, parseContract, contractStamp, treeDigest, falseCompleteRule, judgeExpected, CONTRACT_TEMPLATE } from '../lib/core.js';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync('/tmp/goal-gate-smoke-');
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

const contract = `objective: 产出一份带自检的研究包
AC-1 | a.txt 存在且非空 | check: \`test -s a.txt\` | expected: exit=0
AC-2 | 行数 >= 1 | check: \`wc -l < a.txt\` | expected: >=1
AC-3 | 探针可信 | check: \`test -d .\` | probe: \`test -d .\` | expected: exit=0
AC-4 | 这条会失败 | check: \`test -f NOPE\` | expected: exit=0
`;

const parsed = parseContract(contract);
assert.equal(parsed.acs.length, 4, 'should parse 4 ACs');
assert.equal(parsed.objective, '产出一份带自检的研究包');
assert.ok(contractStamp(contract).length === 8, 'stamp is 8 chars');
console.log('✓ parse: 4 ACs, objective parsed, stamp =', contractStamp(contract));

// 门控：AC-4 必然失败 → NO-GO
const g = runGate(contract, { cwd: dir });
assert.equal(g.rc, 2, 'NO-GO rc');
assert.equal(g.code, 'no-go');
assert.match(g.reason, /AC-4/);
assert.equal(g.results.filter(r => r.status === 'passed').length, 3, 'AC-1..3 pass');
assert.equal(g.results.filter(r => r.status === 'failed').length, 1, 'AC-4 fails');
console.log('✓ gate: rc=2 no-go, AC-4 caught');

// judgeExpected 边界
assert.equal(judgeExpected('exit=0', { exitCode: 0, stdout: '' }), 'passed');
assert.equal(judgeExpected('exit=0', { exitCode: 1, stdout: '' }), 'failed');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: '3\n' }), 'passed');
assert.equal(judgeExpected('>10', { exitCode: 0, stdout: '3\n' }), 'failed');
assert.equal(judgeExpected('>=1', { exitCode: 0, stdout: '       1\n' }), 'passed', 'tolerates wc indentation');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: 'total: 3\n' }), 'passed', 'tolerates numeric prefix');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '' }), 'unverifiable', 'maximize is NOT passed (Goodhart guard)');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }), 'unverifiable', 'judged is NOT passed');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: 'no number here\n' }), 'unverifiable', 'missing number = unverifiable');
console.log('✓ judgeExpected: exit/op/prefix/maximize/judged/missing-number all covered');

// 假完成计数
assert.equal(falseCompleteRule(1), 'OK');
assert.equal(falseCompleteRule(2), 'BLOCKED');
console.log('✓ falseCompleteRule: 1=OK, 2=BLOCKED');

// 契约模板可被解析
const tpl = parseContract(CONTRACT_TEMPLATE);
assert.ok(tpl.objective, 'template has objective');
assert.ok(tpl.acs.length >= 1, 'template has at least 1 AC');
console.log('✓ CONTRACT_TEMPLATE parses (objective +', tpl.acs.length, 'ACs)');

// 摘要变化 → verdict 应作废
const d1 = treeDigest(dir);
fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
const d2 = treeDigest(dir);
assert.notEqual(d1, d2, 'digest changes when file content changes');
console.log('✓ treeDigest: changes on file edit (R7 invalidation works)');

// 无 objective / 无 AC → state-error
assert.equal(runGate('AC-1 | x | check: `true` | expected: exit=0', { cwd: dir }).code, 'state-error');
assert.equal(runGate('objective: x', { cwd: dir }).code, 'state-error');
console.log('✓ runGate: missing objective/AC -> state-error');

// 全绿 → GO
const green = `objective: ok
AC-1 | pass | check: \`test -d .\` | expected: exit=0
`;
const gr = runGate(green, { cwd: dir });
assert.equal(gr.rc, 0);
assert.equal(gr.code, 'go');
console.log('✓ runGate: all-pass -> GO');

console.log('\nAll core smoke tests passed.');
