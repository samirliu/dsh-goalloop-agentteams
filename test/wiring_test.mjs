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

assert.deepEqual(registeredTools.map(t => t.name).sort(), ['goal_gate_check', 'goal_gate_init']);
assert.deepEqual(registeredCmds.map(c => c.name), ['goal-gate']);
assert.equal(preExecuteListeners.length, 1);
console.log('✓ registered:', registeredTools.map(t => t.name).join(', '), '| cmd:', registeredCmds.map(c => c.name).join(', '));

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

// [7] update_task(status:completed) 也被拦
const d7 = await listen(exec('update_task', { status: 'completed', task_id: 't1' }), next);
assert.equal(d7.kind, 'deny');
console.log('✓ [7] update_task(completed) also gated ->', d7.info.code);

// [8] 工作区根目录取的是 agent.session.header.cwd，不是 process.cwd()
assert.notEqual(work, process.cwd(), 'test uses agent cwd, not process.cwd');
console.log('✓ [8] workspace root resolved from agent.session.header.cwd');

console.log('\nAll wiring smoke tests passed.');
