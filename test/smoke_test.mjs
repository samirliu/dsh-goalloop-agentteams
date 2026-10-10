// smoke_test.mjs — core.js 冒烟：契约解析、盖戳、门控 rc、假完成计数、判定边界、指标、摘要
import assert from 'node:assert/strict';
import { runGate, parseContract, contractStamp, treeDigest, falseCompleteRule, judgeExpected, extractMetric, metricKey, CONTRACT_TEMPLATE } from '../lib/core.js';
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
assert.equal(parseContract('objective: x\nexit: goal-only\nAC-1 | y | check: `true` | expected: exit=0').exitPolicy, 'goal-only', 'exit policy parsed');
console.log('✓ parse: 4 ACs, objective parsed, stamp =', contractStamp(contract));

// 门控：AC-4 必然失败 → NO-GO
const g = runGate(contract, { cwd: dir });
assert.equal(g.rc, 2, 'NO-GO rc');
assert.equal(g.code, 'no-go');
assert.match(g.reason, /AC-4/);
assert.equal(g.results.filter(r => r.status === 'passed').length, 3, 'AC-1..3 pass');
assert.equal(g.results.filter(r => r.status === 'failed').length, 1, 'AC-4 fails');
assert.equal(g.score, 0.75, 'score = passed/total');
assert.deepEqual(g.totals, { passed: 3, failed: 1, unverifiable: 0 });
console.log('✓ gate: rc=2 no-go, AC-4 caught, score =', g.score);

// judgeExpected 边界
assert.equal(judgeExpected('exit=0', { exitCode: 0, stdout: '' }), 'passed');
assert.equal(judgeExpected('exit=0', { exitCode: 1, stdout: '' }), 'failed');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: '3\n' }), 'passed');
assert.equal(judgeExpected('>10', { exitCode: 0, stdout: '3\n' }), 'failed');
assert.equal(judgeExpected('>=1', { exitCode: 0, stdout: '       1\n' }), 'passed', 'tolerates wc indentation');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: 'total: 3\n' }), 'passed', 'tolerates numeric prefix');
assert.equal(judgeExpected('<=5', { exitCode: 0, stdout: 'no number here\n' }), 'unverifiable', 'missing number = unverifiable');
console.log('✓ judgeExpected: exit/op/prefix/missing-number all covered');

// 指标提取：metric 正则优先于"最后一个数字"
assert.equal(extractMetric('elapsed 7\nscore: 42\n', 'score: (\\d+)'), 42, 'metric regex wins over last-number');
assert.equal(extractMetric('7\nscore: none\n', 'score: (\\d+)'), null, 'regex mismatch -> null (not the stray 7)');
assert.equal(extractMetric('total: 3\n'), 3, 'fallback last-number');
assert.equal(extractMetric('nothing', 'score: (\\d+)'), null);
console.log('✓ extractMetric: regex / fallback / null cases');

// maximize + baseline：delta=严格改善，abs（缺省）=不回退；无基线 → unverifiable
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '' }), 'unverifiable', 'maximize w/o metric is NOT passed (Goodhart guard)');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '3\n' }), 'unverifiable', 'baseline not established -> unverifiable');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '11\n' }, { prev: 10, baseline: 'delta' }), 'passed', 'delta improves');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'delta' }), 'failed', 'delta flat = not improved');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'abs' }), 'passed', 'abs flat = no regression');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '9\n' }, { prev: 10 }), 'failed', 'default is abs: regression fails');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: 'v=5 x=3\n', }, { prev: 4, metric: 'v=(\\d+)' }), 'passed', 'metric regex feeds maximize');
console.log('✓ judgeExpected: maximize/baseline delta/abs/no-baseline all covered');

// judged：无判官 → unverifiable；判官（probe）退出码即结论
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }), 'unverifiable', 'judged w/o judge is NOT passed');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 0 }), 'passed');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 1 }), 'failed');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 127 }), 'unverifiable', 'missing judge (127) = unverifiable, not failed');
console.log('✓ judgeExpected: judged via deterministic judge (probe) covered');

// runGate 基线闭环：首轮建基线（unverifiable），次轮按 delta 判定
const metricContract = `objective: 指标闭环
AC-1 | 行数要改善 | check: \`wc -l < a.txt\` | metric: \`\\s*(\\d+)\` | baseline: delta | expected: maximize
`;
const mKey = metricKey(parseContract(metricContract).acs[0]);
const r1 = runGate(metricContract, { cwd: dir });
assert.equal(r1.results[0].status, 'unverifiable', 'first run: baseline not established');
assert.equal(r1.baselineUpdates[mKey], 1, 'first run records metric value (keyed by metric identity)');
const r2 = runGate(metricContract, { cwd: dir, baselines: { [mKey]: 1 } });
assert.equal(r2.results[0].status, 'failed', 'second run: 1 is not > 1 (delta flat)');
fs.appendFileSync(path.join(dir, 'a.txt'), 'more\nlines\n');
const r3 = runGate(metricContract, { cwd: dir, baselines: { [mKey]: 1 } });
assert.equal(r3.results[0].status, 'passed', 'third run: 3 > 1 (delta improves)');
assert.equal(r3.score, 1);
console.log('✓ runGate: baseline cycle (unverifiable -> failed -> passed), score works');

// judged 行端到端：probe 即判官
const judgedContract = `objective: judged 闭环
AC-1 | 判官说行 | check: \`echo evidence\` | probe: \`test -f a.txt\` | expected: judged
AC-2 | 判官说不行 | check: \`echo evidence\` | probe: \`test -f NOPE\` | expected: judged
AC-3 | 无判官 | check: \`echo x\` | expected: judged
AC-4 | 判官缺失 | check: \`echo evidence\` | probe: \`definitely-missing-cmd-xyz\` | expected: judged
`;
const j = runGate(judgedContract, { cwd: dir });
const byId = Object.fromEntries(j.results.map(r => [r.id, r.status]));
assert.equal(byId['AC-1'], 'unverifiable', 'judge ok but NO evidence binding -> void (mandatory)');
assert.equal(byId['AC-2'], 'failed', 'judge probe fails -> failed');
assert.equal(byId['AC-3'], 'unverifiable', 'judged without judge -> unverifiable');
assert.equal(byId['AC-4'], 'unverifiable', 'missing judge command -> unverifiable (not failed)');
console.log('✓ runGate: judged rows use probe as deterministic judge; evidence binding mandatory');

// judged 证据摘要绑定:评审引用的 artifact+digest 与现状不一致 → 作废(unverifiable)
import { createHash } from 'node:crypto';
const evFile = path.join(dir, 'ev.txt');
fs.writeFileSync(evFile, 'evidence body\n');
const goodDigest = createHash('sha256').update(fs.readFileSync(evFile)).digest('hex');
const evContract = (digest) => `objective: 证据绑定
AC-1 | 评审 | check: \`echo artifact: ev.txt; echo digest: sha256:${digest}\` | probe: \`test -f ev.txt\` | expected: judged
`;
const ev1 = runGate(evContract(goodDigest), { cwd: dir });
assert.equal(ev1.results[0].status, 'passed', 'matching digest keeps the verdict');
const ev2 = runGate(evContract('0'.repeat(64)), { cwd: dir });
assert.equal(ev2.results[0].status, 'unverifiable', 'stale/mismatched evidence digest voids the verdict');
const ev3 = runGate(`objective: 证据绑定
AC-1 | 评审 | check: \`echo verdict ok\` | probe: \`test -f ev.txt\` | expected: judged
`, { cwd: dir });
assert.equal(ev3.results[0].status, 'unverifiable', 'verdict without evidence binding is void (mandatory discipline)');
const parsed2 = parseContract('objective: x\ndeliverable: dist/app.html\nAC-1 | y | check: `true` | expected: exit=0');
assert.equal(parsed2.deliverable, 'dist/app.html', 'deliverable declaration parsed');
console.log('✓ evidence binding: digest match / mismatch voided / back-compat / deliverable parsed');

// judged 质量分进指标管道:score 行被提取、归一,可配 delta 逐轮逼优
const qs = `objective: 质量分
AC-1 | 质量评审 | check: \`echo 'VERDICT: PASS'; echo 'score: 7'; echo 'artifact: ev.txt'; echo 'digest: sha256:${goodDigest}'\` | probe: \`true\` | expected: judged
`;
const q1 = runGate(qs, { cwd: dir });
const qKey = metricKey(parseContract(qs).acs[0]);
assert.equal(q1.results[0].status, 'passed', 'judged with evidence passes');
assert.equal(q1.baselineUpdates[qKey], 0.7, 'judged score extracted & normalized (7 -> 0.7) into metrics');
assert.equal(q1.results[0].value, 0.7, 'score surfaces as the AC value');
console.log('✓ judged quality score enters the metric pipeline (delta-able)');

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
assert.equal(gr.score, 1);
console.log('✓ runGate: all-pass -> GO');

console.log('\nAll core smoke tests passed.');
