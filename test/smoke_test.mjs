// smoke_test.mjs — core.js 冒烟：契约解析、盖戳、门控 rc、假完成计数、判定边界、指标、摘要
import assert from 'node:assert/strict';
import { runGate, parseContract, contractStamp, treeDigest, falseCompleteRule, judgeExpected, extractMetric, metricKey, CONTRACT_TEMPLATE } from '../lib/core.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkdtemp, ok, echo, metric, stderrThenFail, fileExists, fileNotEmpty, lineCount,
  writeFile, sleep, missingCommand, sequence,
} from './fixtures/shell.mjs';

const dir = mkdtemp('goal-gate-smoke-');
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

const contract = `objective: 产出一份带自检的研究包
AC-1 | a.txt 存在且非空 | check: \`${fileNotEmpty('a.txt')}\` | expected: exit=0
AC-2 | 行数 >= 1 | check: \`${lineCount('a.txt')}\` | expected: >=1
AC-3 | 探针可信 | check: \`${ok()}\` | probe: \`${ok()}\` | expected: exit=0
AC-4 | 这条会失败 | check: \`${fileExists('NOPE')}\` | expected: exit=0
`;

const parsed = parseContract(contract);
assert.equal(parsed.acs.length, 4, 'should parse 4 ACs');
assert.equal(parsed.objective, '产出一份带自检的研究包');
assert.ok(contractStamp(contract).length === 8, 'stamp is 8 chars');
assert.equal(parseContract(`objective: x\nexit: goal-only\nAC-1 | y | check: \`${ok()}\` | expected: exit=0`).exitPolicy, 'goal-only', 'exit policy parsed');
console.log('✓ parse: 4 ACs, objective parsed, stamp =', contractStamp(contract));

// 门控：AC-4 必然失败 → NO-GO
const g = runGate(contract, { cwd: dir });
assert.equal(g.rc, 2, 'NO-GO rc');
assert.equal(g.code, 'no-go');
assert.match(g.reason, /AC-4/);
assert.equal(g.results.filter(r => r.status === 'passed').length, 3, 'AC-1..3 pass');
assert.equal(g.results.filter(r => r.status === 'failed').length, 1, 'AC-4 fails');
assert.equal(g.score, 0.75, 'score = passed/total');
assert.deepEqual(g.totals, { passed: 3, failed: 1, broken: 0, unverifiable: 0 });
console.log('✓ gate: rc=2 no-go, AC-4 caught, score =', g.score);

// judgeExpected 边界
assert.equal(judgeExpected('exit=0', { exitCode: 0, stdout: '' }), 'passed');
assert.equal(judgeExpected('exit=0', { exitCode: 1, stdout: '' }), 'failed');
assert.equal(judgeExpected('exit=2', { exitCode: 2, stdout: '' }), 'passed', 'error-path: must fail WITH code 2');
assert.equal(judgeExpected('exit=3', { exitCode: 1, stdout: '' }), 'failed', 'wrong error code -> failed');
assert.equal(judgeExpected('exit=2', { exitCode: 0, stdout: '' }), 'failed', 'success when failure required -> failed');
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
assert.equal(extractMetric('total=30 ok=30', 'ok=(\\d+)|total=(\\d+)'), 30, 'alternation regex: first DEFINED capture used');
assert.equal(extractMetric('quality=\x1b[32m0.75\x1b[0m', 'quality=([0-9.]+)'), 0.75, 'ANSI color codes stripped before matching');
console.log('✓ extractMetric: regex / fallback / null / alternation / ANSI cases');

// maximize + baseline：delta=严格改善，abs（缺省）=不回退；无基线 → unverifiable
// 首轮没有水位 ≠ 达标：只建档、不给结论（P1：原来首轮直接 passed，改一次 check
// 文本就换一个指标序列、白拿一轮 PASS）。
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '' }), 'unverifiable', 'maximize w/o metric is NOT passed (Goodhart guard)');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '3\n' }), 'unverifiable', 'first measurement records the baseline but is NOT a pass (no waterline yet)');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '11\n' }, { prev: 10, baseline: 'delta' }), 'passed', 'delta improves');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'delta' }), 'failed', 'delta requires strict improvement during normal rounds');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'delta', claimMode: true }), 'passed', 'claim mode does not require improving again after the last GO');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'delta' }), 'failed', 'delta flat = not improved');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '10\n' }, { prev: 10, baseline: 'abs' }), 'passed', 'abs flat = no regression');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '9\n' }, { prev: 10 }), 'failed', 'default is abs: regression fails');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: 'v=5 x=3\n', }, { prev: 4, metric: 'v=(\\d+)' }), 'passed', 'metric regex feeds maximize');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '5\n' }, { prev: 0, spread: 10 }), 'passed', 'prev=0: absolute noise band 2*spread applies');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '25\n' }, { prev: 0, spread: 10, baseline: 'delta' }), 'passed', 'prev=0: must clear the 2*spread band');
console.log('✓ judgeExpected: maximize/baseline delta/abs/no-baseline all covered');
// tolerance:抗测量噪声(基准类指标的假红防线)
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '95\n' }, { prev: 100, tolerance: 0.08 }), 'passed', 'abs: 噪声带内(-5%)不算回退');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '85\n' }, { prev: 100, tolerance: 0.08 }), 'failed', 'abs: 超出噪声带(-15%)算真回退');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '105\n' }, { prev: 100, baseline: 'delta', tolerance: 0.08 }), 'failed', 'delta: 噪声带内(+5%)不算真改善');
assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '115\n' }, { prev: 100, baseline: 'delta', tolerance: 0.08 }), 'passed', 'delta: 超出噪声带(+15%)算真改善');
console.log('✓ tolerance: abs noise band / abs real regression / delta noise / delta real improvement');
// delta 饱和诊断:指标封顶后原地踏步必须给出可操作提示
const satContract = `objective: sat
AC-1 | 封顶指标 | check: \`${echo('1')}\` | metric: \`([0-9.]+)\` | baseline: delta | expected: maximize
AC-2 | ok | check: \`${ok()}\` | expected: exit=0
AC-3 | ok | check: \`${ok()}\` | expected: exit=0`;
const sat = runGate(satContract, { cwd: dir, baselines: { [metricKey(parseContract(satContract).acs[0])]: 1 } });
assert.equal(sat.results[0].status, 'failed', 'saturated delta -> failed');
assert.match(sat.results[0].why ?? '', /saturated/, 'saturation diagnosed with actionable hint');
console.log('✓ delta-saturation: diagnosed, not silent');

// judged：无判官 → unverifiable；判官（probe）退出码即结论
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }), 'unverifiable', 'judged w/o judge is NOT passed (runGate escalates to broken)');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 0 }), 'passed');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 1 }), 'failed');
assert.equal(judgeExpected('judged', { exitCode: 0, stdout: '' }, { judgeExit: 127 }), 'unverifiable', 'missing judge (127) is unverifiable at the judge layer; runGate marks BROKEN');
console.log('✓ judgeExpected: judged via deterministic judge (probe) covered');

// runGate 基线闭环：首轮只建档（unverifiable，不给结论），次轮按 delta 判定
const metricContract = `objective: 指标闭环
AC-1 | 行数要改善 | check: \`${lineCount('a.txt')}\` | metric: \`\\s*(\\d+)\` | baseline: delta | expected: maximize
`;
const mKey = metricKey(parseContract(metricContract).acs[0]);
const r1 = runGate(metricContract, { cwd: dir });
assert.equal(r1.results[0].status, 'unverifiable', 'first run: baseline recorded, no verdict yet (no waterline)');
assert.equal(r1.rc, 2, 'a contract whose only AC is unverifiable cannot GO (ratio 1 > 1/3)');
assert.equal(r1.code, 'unverifiable');
assert.equal(r1.baselineUpdates[mKey], 1, 'first run records metric value (keyed by metric identity)');
const r2 = runGate(metricContract, { cwd: dir, baselines: { [mKey]: 1 } });
assert.equal(r2.results[0].status, 'failed', 'second run: 1 is not > 1 (delta flat)');
fs.appendFileSync(path.join(dir, 'a.txt'), 'more\nlines\n');
const r3 = runGate(metricContract, { cwd: dir, baselines: { [mKey]: 1 } });
assert.equal(r3.results[0].status, 'passed', 'third run: 3 > 1 (delta improves)');
assert.equal(r3.score, 1);
assert.equal(typeof r3.ms, 'number', 'runGate self-times (defect #15: 账本可归因延迟)');
assert.equal(typeof r3.digestBefore, 'string', 'runGate binds a digest before checks');
assert.equal(typeof r3.digestAfter, 'string', 'runGate binds a digest after checks');
console.log('✓ runGate: baseline cycle (unverifiable -> failed -> passed), score works');

// judged 行端到端：probe 即判官
const judgedContract = `objective: judged 闭环
AC-1 | 判官说行 | check: \`${echo('evidence')}\` | probe: \`${fileExists('a.txt')}\` | expected: judged
AC-2 | 判官说不行 | check: \`${echo('evidence')}\` | probe: \`${fileExists('NOPE')}\` | expected: judged
AC-3 | 无判官 | check: \`${echo('x')}\` | expected: judged
AC-4 | 判官缺失 | check: \`${echo('evidence')}\` | probe: \`${missingCommand()}\` | expected: judged
`;
const j = runGate(judgedContract, { cwd: dir });
const byId = Object.fromEntries(j.results.map(r => [r.id, r.status]));
assert.equal(byId['AC-1'], 'broken', 'judge ok but NO evidence binding -> BROKEN (decisive)');
assert.equal(byId['AC-2'], 'failed', 'judge probe fails -> failed');
assert.equal(byId['AC-3'], 'broken', 'judged without judge -> BROKEN (a missing verifier is not a soft unverifiable)');
assert.equal(byId['AC-4'], 'broken', 'missing judge command -> BROKEN');
// 缺陷 #13:unverifiable 不许哑巴——每条都必须说清为什么无法验证
const whyById = Object.fromEntries(j.results.map(r => [r.id, r.why ?? '']));
assert.match(whyById['AC-1'], /artifact: /, 'void verdict names the required evidence lines');
assert.match(whyById['AC-3'], /probe/, 'judged without judge points at the missing judge');
assert.match(whyById['AC-4'], /127/, 'unreachable judge explains exit 127 (validator broken != review failed)');
console.log('✓ runGate: judged rows use probe as deterministic judge; evidence binding mandatory');

// judged 证据摘要绑定:评审引用的 artifact+digest 与现状不一致 → 作废(unverifiable)
import { createHash } from 'node:crypto';
const evFile = path.join(dir, 'ev.txt');
fs.writeFileSync(evFile, 'evidence body\n');
const goodDigest = createHash('sha256').update(fs.readFileSync(evFile)).digest('hex');
const evContract = (digest) => `objective: 证据绑定
AC-1 | 评审 | check: \`${sequence(echo('artifact: ev.txt'), echo(`digest: sha256:${digest}`))}\` | probe: \`${fileExists('ev.txt')}\` | expected: judged
`;
const ev1 = runGate(evContract(goodDigest), { cwd: dir });
assert.equal(ev1.results[0].status, 'passed', 'matching digest keeps the verdict');
const ev2 = runGate(evContract('0'.repeat(64)), { cwd: dir });
assert.equal(ev2.results[0].status, 'broken', 'stale/mismatched evidence digest voids the verdict (BROKEN)');
assert.match(ev2.results[0].why ?? '', /stale/, 'stale digest says why (defect #13: 哑巴作废已成历史)');
const ev3 = runGate(`objective: 证据绑定
AC-1 | 评审 | check: \`${echo('verdict ok')}\` | probe: \`${fileExists('ev.txt')}\` | expected: judged
`, { cwd: dir });
assert.equal(ev3.results[0].status, 'broken', 'verdict without evidence binding is BROKEN (mandatory discipline)');
assert.match(ev3.results[0].why ?? '', /artifact: /, 'unbound verdict states what the conclusion must contain');
const parsed2 = parseContract(`objective: x\ndeliverable: dist/app.html\nAC-1 | y | check: \`${ok()}\` | expected: exit=0`);
assert.equal(parsed2.deliverable, 'dist/app.html', 'deliverable declaration parsed');
console.log('✓ evidence binding: digest match / mismatch voided / back-compat / deliverable parsed');

// judged 质量分进指标管道:score 行由判读席(probe)给出、归一,可配 delta 逐轮逼优。
// P1:分数只能来自判官,被评产物自己印的 score 不被采信(否则自己给自己打分)。
const qs = `objective: 质量分
AC-1 | 质量评审 | check: \`${sequence(echo('VERDICT: PASS'), echo('score: 9'), echo('artifact: ev.txt'), echo(`digest: sha256:${goodDigest}`))}\` | probe: \`${echo('score: 7')}\` | expected: judged
`;
const q1 = runGate(qs, { cwd: dir });
const qKey = metricKey(parseContract(qs).acs[0]);
assert.equal(q1.results[0].status, 'passed', 'judged with evidence passes');
assert.equal(q1.baselineUpdates[qKey], 0.7, 'judge-reported score extracted & normalized (7 -> 0.7); the artifact self-report (9) is ignored');
assert.equal(q1.results[0].value, 0.7, 'score surfaces as the AC value');
console.log('✓ judged quality score enters the metric pipeline (judge-reported only, delta-able)');

// per-AC timeout:短超时击杀慢检查;放宽后放行(30s 缺省不可配的缺陷回归)
const tSlow = `AC-1 | 慢检查 | check: \`${sleep(2)}\` | timeout: 1 | expected: exit=0`;
const t1 = runGate(`objective: timeout
${tSlow}
AC-2 | 快检查 | check: \`${ok()}\` | expected: exit=0
AC-3 | 快检查 | check: \`${ok()}\` | expected: exit=0`, { cwd: dir });
assert.equal(t1.results[0].status, 'broken', 'timeout:1 kills a 2s check -> BROKEN');
const tOk = `AC-1 | 慢检查 | check: \`${sleep(2)}\` | timeout: 5 | expected: exit=0`;
const t2 = runGate(`objective: timeout
${tOk}
AC-2 | 快检查 | check: \`${ok()}\` | expected: exit=0
AC-3 | 快检查 | check: \`${ok()}\` | expected: exit=0`, { cwd: dir });
assert.equal(t2.results[0].status, 'passed', 'timeout:5 lets a 2s check pass');
assert.equal(parseContract('objective: x\nAC-1 | y | check: `z` | timeout: 45 | expected: exit=0').acs[0].timeout, 45, 'timeout parsed');
console.log('✓ per-AC timeout: kills slow check / releases with headroom / parsed');

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
assert.equal(runGate(`AC-1 | x | check: \`${ok()}\` | expected: exit=0`, { cwd: dir }).code, 'state-error');
assert.equal(runGate('objective: x', { cwd: dir }).code, 'state-error');
console.log('✓ runGate: missing objective/AC -> state-error');
const unp = runGate(`objective: x
AC-1 | ok | check: \`${ok()}\` | expected: exit=0
AC-2 | bad | check: \`echo \`nested\`\` | expected: exit=0
AC-3 | ok | check: \`${ok()}\` | expected: exit=0
AC-4 | ok | check: \`${ok()}\` | expected: exit=0`, { cwd: dir });
assert.equal(unp.code, 'state-error', 'unparseable AC line -> refuse to evaluate (fail-closed)');
assert.match(unp.reason, /AC-2/, 'reason names the offending line');
console.log('✓ runGate: unparsed AC line -> state-error (silent drop is forbidden)');
const diag = runGate(`objective: diag
AC-1 | 报错到 stderr | check: \`${stderrThenFail('reason-on-stderr')}\` | expected: exit=0
AC-2 | ok | check: \`${ok()}\` | expected: exit=0
AC-3 | ok | check: \`${ok()}\` | expected: exit=0`, { cwd: dir });
assert.match(diag.results[0].stderr ?? '', /reason-on-stderr/, 'failure reason on stderr is captured in results');
assert.equal(diag.results[0].status, 'failed');
console.log('✓ runGate: stderr diagnostics captured (fail-loud)');

// 全绿 → GO
const green = `objective: ok
AC-1 | pass | check: \`${ok()}\` | expected: exit=0
`;
const gr = runGate(green, { cwd: dir });
assert.equal(gr.rc, 0);
assert.equal(gr.code, 'go');
assert.equal(gr.score, 1);
console.log('✓ runGate: all-pass -> GO');

// ── 新语义:broken 是决定性的,不许被 unverifiable ≤1/3 的 GO 放行 ──────────
const hole = runGate(`objective: 3 AC hole
AC-1 | floor | check: \`${ok()}\` | expected: exit=0
AC-2 | floor | check: \`${ok()}\` | expected: exit=0
AC-3 | broken instrument | check: \`${missingCommand()}\` | expected: exit=0
`, { cwd: dir });
assert.equal(hole.rc, 2, 'BROKEN row => NO-GO (not GO with <=1/3 unverifiable)');
assert.equal(hole.code, 'broken');
assert.equal(hole.totals.broken, 1);
assert.match(hole.reason, /AC-3/, 'BROKEN reason names the AC');
console.log('✓ broken-vs-unverifiable: missing instrument yields NO-GO (the old GO hole is closed)');

// ── goal-loop 原生 `- AC-N` 行兼容 + 重复编号拒绝 + 摘要覆盖 dashed 行 ──────
const dashed = `objective: dashed
- AC-1 | a | check: \`${ok()}\` | expected: exit=0
- AC-2 | b | check: \`${ok()}\` | expected: exit=0
`;
assert.equal(parseContract(dashed).acs.length, 2, 'dashed AC lines parse');
const dashG = runGate(dashed, { cwd: dir });
assert.equal(dashG.rc, 0, 'dashed contract can GO');
assert.equal(dashG.results.length, 2, 'no silent AC loss on dashed lines');
const dup = runGate(`objective: dup
AC-1 | a | check: \`${ok()}\` | expected: exit=0
AC-1 | b | check: \`${ok()}\` | expected: exit=0
`, { cwd: dir });
assert.equal(dup.code, 'state-error', 'duplicate AC ids refused');
assert.match(dup.reason, /duplicate/);
const s1 = contractStamp(dashed);
const s2 = contractStamp(dashed.replace('| b |', '| b2 |'));
assert.notEqual(s1, s2, 'stamp covers dashed AC bodies (editing one changes the stamp)');
console.log('✓ dashed AC lines / duplicate ids / dashed-stamp coverage');

// ── minimize / != / sd / var ─────────────────────────────────────────────
assert.equal(judgeExpected('minimize', { exitCode: 0, stdout: '8\n' }, { prev: 10, baseline: 'abs' }), 'passed', 'minimize: lower is better');
assert.equal(judgeExpected('minimize', { exitCode: 0, stdout: '12\n' }, { prev: 10, baseline: 'abs' }), 'failed', 'minimize: higher is regression');
assert.equal(judgeExpected('minimize', { exitCode: 0, stdout: '12\n' }, { prev: 10, baseline: 'delta' }), 'failed', 'minimize delta: must strictly improve');
assert.equal(judgeExpected('!=5', { exitCode: 0, stdout: '6\n' }), 'passed', '!= spec supported');
assert.equal(judgeExpected('!=5', { exitCode: 0, stdout: '5\n' }), 'failed', '!= catches the forbidden value');
const sdContract = `objective: sd
AC-1 | noisy | check: \`${metric('m=95 sd=5')}\` | metric: \`m=([0-9.]+)\` | baseline: abs | tolerance: 0.01 | sd: \`sd=([0-9.]+)\` | expected: maximize`;
const sdKey = metricKey(parseContract(sdContract).acs[0]);
const sdG = runGate(sdContract, { cwd: dir, baselines: { [sdKey]: 100 } });
assert.equal(sdG.results[0].status, 'passed', 'sd widens the noise band: 95 within 2*5/100 of 100');
assert.equal(sdG.results[0].spread, 5, 'spread surfaces in the result');
const sdMiss = runGate(`objective: sd miss
AC-1 | noisy | check: \`${metric('m=95')}\` | metric: \`m=([0-9.]+)\` | sd: \`sd=([0-9.]+)\` | expected: maximize`, { cwd: dir, baselines: { [sdKey]: 100 } });
assert.equal(sdMiss.results[0].status, 'broken', 'declared-but-unmatched spread is BROKEN');
console.log('✓ minimize / != / sd noise band / spread-miss BROKEN');

// ── digest: 同尺寸内容改动必须被发现;检查期间改树 -> NO-GO ─────────────────
const dgDir = mkdtemp('goal-gate-digest-');
fs.writeFileSync(path.join(dgDir, 'x.txt'), 'aaaa');
const dg1 = treeDigest(dgDir);
fs.writeFileSync(path.join(dgDir, 'x.txt'), 'bbbb');
const dg2 = treeDigest(dgDir);
assert.notEqual(dg1, dg2, 'same-size content edit changes the digest (no path+size blind spot)');
const mutate = runGate(`objective: mutate
AC-1 | writes tree | check: \`${writeFile('newfile.txt', 'x')}\` | expected: exit=0`, { cwd: dgDir });
assert.equal(mutate.code, 'check-mutated-tree', 'checks that mutate the tree are refused as evaluation');
assert.equal(mutate.treeMoved, true);
console.log('✓ digest: content hashing + check-mutated-tree guard');

console.log('\nAll core smoke tests passed.');
