// wiring_test.mjs — 用假的 ctx/defineTool 验证 index.js 的注册路径 + 拦截逻辑端到端
// 真实 @deepseek-ai/dsh-tools 在 Host 进程里才有，这里按真实签名 shim 掉
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const registeredTools = [];
const registeredCmds = [];
const preExecuteListeners = [];
const ctx = {
  tools: { register: (t) => registeredTools.push(t) },
  inject: (_deps, fn) => fn({ register: (c) => registeredCmds.push(c) }),
  on: (name, fn) => { if (name === 'tools/pre-execute') preExecuteListeners.push(fn); return () => {}; },
};

const mod = await import('../lib/index.js');
mod.apply(ctx, {});

assert.deepEqual(registeredTools.map(t => t.name).sort(), ['goal_gate_check', 'goal_gate_init', 'goal_loop_at']);
assert.deepEqual(registeredCmds.map(c => c.name), ['goal-gate', 'goal-loop-at']);
assert.equal(preExecuteListeners.length, 1);
console.log('✓ registered:', registeredTools.map(t => t.name).join(', '), '| cmds:', registeredCmds.map(c => c.name).join(', '));

// 命令形状：handler(invocation) + input.hint（真实 commands 服务 API，对齐 dsh-agent-teams）
for (const c of registeredCmds) {
  assert.equal(typeof c.handler, 'function', `${c.name} uses handler(invocation) shape`);
  assert.ok(c.input && typeof c.input.hint === 'string', `${c.name} declares input.hint`);
}
console.log('✓ command shape: handler(invocation) + input.hint');

// 隔离工作区；用 agent.session.header.cwd 指向它（真实插件取 cwd 的方式）
const work = fs.mkdtempSync('/tmp/goal-gate-wiring-');
const agent = { session: { header: { cwd: work } } };
const listen = preExecuteListeners[0];
const next = () => ({ kind: 'allow' });
const exec = (name, args) => ({ name, arguments: args, agent });
const ledger = path.join(work, '.goal-gate');

fs.writeFileSync(path.join(work, 'a.txt'), 'stable content\n');

// [0] 没有契约 → 不拦（好用：装上插件不堵死未配置的会话）
assert.deepEqual(await listen(exec('update_goal', { action: 'complete' }), next), { kind: 'allow' });
console.log('✓ [0] no contract -> pass through (not a hard block)');

// [0b] 契约存在但为空 → 拦（配置错了要暴露，不能静默放行）——用独立目录，不干扰 init 流
const work2 = fs.mkdtempSync('/tmp/goal-gate-wiring2-');
fs.mkdirSync(path.join(work2, '.goal-gate'), { recursive: true });
fs.writeFileSync(path.join(work2, '.goal-gate', 'goal.md'), '');
const d0b = await listen({ name: 'update_goal', arguments: { action: 'complete' }, agent: { session: { header: { cwd: work2 } } } }, next);
assert.equal(d0b.kind, 'deny');
assert.equal(d0b.info.code, 'state-error');
console.log('✓ [0b] empty/malformed contract -> deny (surfaces misconfig)');

// init 生成契约
const initTool = registeredTools.find(t => t.name === 'goal_gate_init');
const initRes = await initTool.execute({}, { agent });
assert.equal(initRes.created, true);
assert.ok(fs.existsSync(path.join(work, '.goal-gate', 'goal.md')));
console.log('✓ [1] goal_gate_init created contract at', initRes.path);

// 写一条会过的契约
fs.writeFileSync(path.join(ledger, 'goal.md'), `objective: 冒烟
AC-1 | 一定通过 | check: \`test -f a.txt\` | expected: exit=0
`);

// [2] 门控通过 → allow，且记录 digest
const d2 = await listen(exec('update_goal', { action: 'complete' }), next);
assert.equal(d2.kind, 'allow');
const st2 = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'));
assert.ok(st2.digests.goal, 'digest recorded on GO');
console.log('✓ [2] gate GO -> allow, digest recorded =', st2.digests.goal);

// [3] 契约改成必失败（改 .goal-gate 内文件，摘要排除它，所以摘要稳定）→ NO-GO
fs.writeFileSync(path.join(ledger, 'goal.md'), `objective: 冒烟
AC-1 | 一定通过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 一定失败 | check: \`test -f NOPE\` | expected: exit=0
`);
const d3 = await listen(exec('update_goal', { action: 'complete' }), next);
assert.equal(d3.kind, 'deny');
assert.equal(d3.info.code, 'no-go', 'contract edit without workspace change -> no-go, not stale');
assert.match(d3.reason, /AC-2/);
console.log('✓ [3] contract edit (workspace unchanged) -> no-go (not verdict-stale)');

// [4] 工作区文件改动 + 当前门控不过 → 判为假完成（带 digest moved 说明），不是纯 verdict-stale
fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
const d4 = await listen(exec('update_goal', { action: 'complete' }), next);
assert.equal(d4.kind, 'deny');
assert.match(d4.reason, /tree digest moved/, 'reason notes the digest moved');
assert.match(d4.reason, /AC-2/, 'reason also names the failing AC');
console.log('✓ [4] workspace file changed + gate failing -> deny with digest-moved note:', d4.info.code);

// [5] 无关工具 → allow
assert.deepEqual(await listen(exec('read', {}), next), { kind: 'allow' });
console.log('✓ [5] unrelated tool -> allow');

// [6] 恢复稳定，连拦两次看 R1 计数 → BLOCKED
fs.writeFileSync(path.join(work, 'a.txt'), 'stable content\n');
const d6a = await listen(exec('update_goal', { action: 'complete' }), next);
const d6b = await listen(exec('update_goal', { action: 'complete' }), next);
assert.equal(d6a.kind, 'deny');
assert.equal(d6b.kind, 'deny');
const stEnd = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'));
assert.ok(stEnd.falseCompletes >= 2, `falseCompletes >= 2, got ${stEnd.falseCompletes}`);
console.log('✓ [6] repeated false-completes ->', d6b.info.code, '(falseCompletes=' + stEnd.falseCompletes + ')');

// [7] 完成声明分级治理
// [7a] strict 缺省：任务级声明按全量契约硬拦 + 计数（旧名 update_task 兼容）
const work7a = fs.mkdtempSync('/tmp/goal-gate-wiring7a-');
const agent7a = { session: { header: { cwd: work7a } } };
const exec7a = (name, args) => ({ name, arguments: args, agent: agent7a });
fs.writeFileSync(path.join(work7a, 'a.txt'), 'x\n');
fs.mkdirSync(path.join(work7a, '.goal-gate'), { recursive: true });
fs.writeFileSync(path.join(work7a, '.goal-gate', 'goal.md'), `objective: strict 缺省
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 不过 | check: \`test -f NOPE\` | expected: exit=0
`);
const d7a = await listen(exec7a('update_task', { status: 'completed', task_id: 't1' }), next);
assert.equal(d7a.kind, 'deny', 'legacy update_task gated under default strict policy');
assert.equal(d7a.info.code, 'no-go');
const st7a = JSON.parse(fs.readFileSync(path.join(work7a, '.goal-gate', 'state.json'), 'utf8'));
assert.equal(st7a.falseCompletes, 1, 'strict task claim counts a strike');

// [7b] exit: goal-only：任务级声明放行 + 记账（多任务循环不卡死）
const work7b = fs.mkdtempSync('/tmp/goal-gate-wiring7b-');
const agent7b = { session: { header: { cwd: work7b } } };
const exec7b = (name, args) => ({ name, arguments: args, agent: agent7b });
fs.writeFileSync(path.join(work7b, 'a.txt'), 'x\n');
fs.mkdirSync(path.join(work7b, '.goal-gate'), { recursive: true });
fs.writeFileSync(path.join(work7b, '.goal-gate', 'goal.md'), `objective: goal-only 循环
exit: goal-only
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 不过 | check: \`test -f NOPE\` | expected: exit=0
`);
const d7b = await listen(exec7b('agent_teams_update_task', { status: 'completed', task_id: 't1' }), next);
assert.equal(d7b.kind, 'allow', 'goal-only: mid-loop task completion passes');
const st7b = JSON.parse(fs.readFileSync(path.join(work7b, '.goal-gate', 'state.json'), 'utf8'));
assert.equal(st7b.partialCompletes, 1, 'partial completion recorded');
assert.equal(st7b.falseCompletes, 0, 'no strike for goal-only task claims');

// [7c] goal-only 下目标级声明仍硬拦
const d7c = await listen(exec7b('update_goal', { action: 'complete' }), next);
assert.equal(d7c.kind, 'deny', 'goal claim stays hard-gated under goal-only');
assert.equal(d7c.info.code, 'no-go');
const d7c2 = await listen(exec7b('update_goal', { action: 'complete' }), next);
assert.equal(d7c2.kind, 'deny', 'second goal strike');

// [7d] BLOCKED 冻结：目标级假完成 2 次后任务声明也拦
const d7d = await listen(exec7b('team_task_update', { action: 'complete', task_id: 't1' }), next);
assert.equal(d7d.kind, 'deny', 'BLOCKED freezes task claims too');
assert.equal(d7d.info.code, 'blocked');
console.log('✓ [7] claim scoping: strict hard-gate / goal-only pass-through / goal always hard / BLOCKED freeze');

// [8] 工作区根目录取的是 agent.session.header.cwd，不是 process.cwd()
assert.notEqual(work, process.cwd(), 'test uses agent cwd, not process.cwd');
console.log('✓ [8] workspace root resolved from agent.session.header.cwd');

// ── 真实工具名接线（dsh-agent-teams / team task 的完成声明）──────────────────
const work3 = fs.mkdtempSync('/tmp/goal-gate-wiring3-');
const agent3 = { session: { header: { cwd: work3 } } };
fs.writeFileSync(path.join(work3, 'a.txt'), 'x\n');
fs.mkdirSync(path.join(work3, '.goal-gate'), { recursive: true });
fs.writeFileSync(path.join(work3, '.goal-gate', 'goal.md'), `objective: 真名接线
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
`);
const exec3 = (name, args) => ({ name, arguments: args, agent: agent3 });
assert.equal((await listen(exec3('agent_teams_update_task', { status: 'completed', task_id: 't1' }), next)).kind, 'allow', 'agent_teams_update_task is gated (GO passes)');
assert.equal((await listen(exec3('team_task_update', { action: 'complete', task_id: 't1' }), next)).kind, 'allow', 'team_task_update is gated (GO passes)');
fs.writeFileSync(path.join(work3, '.goal-gate', 'goal.md'), `objective: 真名接线
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 不过 | check: \`test -f NOPE\` | expected: exit=0
`);
const d9a = await listen(exec3('agent_teams_update_task', { status: 'completed', task_id: 't1' }), next);
assert.equal(d9a.kind, 'deny', 'agent_teams_update_task completed is denied on NO-GO');
assert.equal(d9a.info.code, 'no-go');
const d9b = await listen(exec3('team_task_update', { action: 'complete', task_id: 't1' }), next);
assert.equal(d9b.kind, 'deny', 'team_task_update complete is denied on NO-GO');
console.log('✓ [9] real tool names wired: agent_teams_update_task / team_task_update gated');

// ── goal_loop_at：契约 + loop.json + 任务 + 协议 ─────────────────────────────
const work4 = fs.mkdtempSync('/tmp/goal-gate-wiring4-');
const agent4 = { session: { header: { cwd: work4 } } };
const loopTool = registeredTools.find(t => t.name === 'goal_loop_at');
const loopRes = await loopTool.execute({ objective: '做一个可验证的报告', acs: ['报告存在', '自检通过'] }, { agent: agent4 });
assert.equal(loopRes.created, true);
const contractText4 = fs.readFileSync(path.join(work4, '.goal-gate', 'goal.md'), 'utf8');
assert.match(contractText4, /objective: 做一个可验证的报告/);
assert.match(contractText4, /AC-1 \| 报告存在/);
assert.match(contractText4, /TODO-REPLACE-ME/, 'placeholder check is fail-closed');
assert.match(contractText4, /exit: goal-only/, 'loop contracts are goal-only (multi-task safe)');
const loopJson = JSON.parse(fs.readFileSync(path.join(work4, '.goal-gate', 'loop.json'), 'utf8'));
assert.equal(loopJson.maxRounds, 8, 'default round budget');
assert.equal(loopJson.status, 'active');
assert.equal(loopRes.tasks.length, 2);
assert.ok(loopRes.protocol.length >= 6, 'loop protocol returned');
console.log('✓ [10] goal_loop_at: contract + loop.json +', loopRes.tasks.length, 'tasks + protocol');

// ── /goal-loop-at 命令（handler 形状 + followup 递协议给 agent）───────────────
const work5 = fs.mkdtempSync('/tmp/goal-gate-wiring5-');
const followups = [];
const invocation = {
  rawInput: ' 从命令启动的目标 ',
  agent: { session: { header: { cwd: work5 } }, followup: (m) => followups.push(m) },
};
const cmdLoop = registeredCmds.find(c => c.name === 'goal-loop-at');
const cmdRes = cmdLoop.handler(invocation);
assert.equal(cmdRes.kind, 'success');
assert.ok(fs.existsSync(path.join(work5, '.goal-gate', 'loop.json')), 'command writes loop.json');
assert.ok(fs.existsSync(path.join(work5, '.goal-gate', 'goal.md')), 'command writes contract');
assert.equal(followups.length, 1, 'protocol delivered to agent via followup');
assert.match(followups[0].content[0].text, /goal-loop activated/);
assert.equal(cmdLoop.handler({ rawInput: '', agent: invocation.agent }).kind, 'error', 'empty objective -> usage error');
console.log('✓ [11] /goal-loop-at: handler shape, init + followup protocol');

// ── goal_gate_check：score/轮次/趋势/failedActions/历史 ─────────────────────
const checkTool = registeredTools.find(t => t.name === 'goal_gate_check');
const c1 = await checkTool.execute({}, { agent: agent4 });
assert.equal(c1.rc, 2, 'TODO placeholder checks fail (fail-closed)');
assert.equal(c1.failedActions.length, 2, 'failedActions names what to repair');
assert.equal(c1.round, 1);
assert.deepEqual(c1.trend, [0]);
const c2 = await checkTool.execute({}, { agent: agent4 });
assert.equal(c2.round, 2, 'round advances per evaluation');
const history4 = fs.readFileSync(path.join(work4, '.goal-gate', 'history.jsonl'), 'utf8').trim().split('\n');
assert.equal(history4.length, 2, 'history.jsonl records every evaluation');
assert.equal(JSON.parse(history4[0]).trigger, 'check');
console.log('✓ [12] goal_gate_check: score/round/trend/failedActions + history.jsonl');

// ── 不回退规则：score 回退 → regression 标记 ────────────────────────────────
const work6 = fs.mkdtempSync('/tmp/goal-gate-wiring6-');
const agent6 = { session: { header: { cwd: work6 } } };
fs.writeFileSync(path.join(work6, 'a.txt'), 'x\n');
fs.mkdirSync(path.join(work6, '.goal-gate'), { recursive: true });
fs.writeFileSync(path.join(work6, '.goal-gate', 'goal.md'), `objective: 回退规则
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
`);
const r6a = await checkTool.execute({}, { agent: agent6 });
assert.equal(r6a.score, 1);
assert.equal(r6a.regression, false);
fs.writeFileSync(path.join(work6, '.goal-gate', 'goal.md'), `objective: 回退规则
AC-1 | 过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 不过 | check: \`test -f NOPE\` | expected: exit=0
`);
const r6b = await checkTool.execute({}, { agent: agent6 });
assert.equal(r6b.score, 0.5);
assert.equal(r6b.regression, true, 'score dropped below bestScore -> regression flagged');
assert.equal(r6b.bestScore, 1, 'bestScore holds the high-water mark');
console.log('✓ [13] no-regression rule: regression flagged, bestScore tracked');

// ── 轮次预算：超过 maxRounds → roundsExhausted ──────────────────────────────
const work7 = fs.mkdtempSync('/tmp/goal-gate-wiring7-');
const agent7 = { session: { header: { cwd: work7 } } };
await loopTool.execute({ objective: '轮次预算', maxRounds: 2 }, { agent: agent7 });
const r7a = await checkTool.execute({}, { agent: agent7 });
const r7b = await checkTool.execute({}, { agent: agent7 });
const r7c = await checkTool.execute({}, { agent: agent7 });
assert.equal(r7c.round, 3);
assert.equal(r7c.roundsExhausted, true, 'round 3 > maxRounds 2 -> exhausted');
assert.equal(r7c.remainingRounds, 0);
assert.equal(r7a.roundsExhausted, false);
console.log('✓ [14] round budget: roundsExhausted after maxRounds');

console.log('\nAll wiring smoke tests passed.');
