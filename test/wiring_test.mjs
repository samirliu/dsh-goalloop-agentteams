// wiring_test.mjs — 用假的 ctx/defineTool 验证 index.js 的注册路径 + 拦截逻辑端到端
// 真实 @deepseek-ai/dsh-tools 在 Host 进程里才有，这里按真实签名 shim 掉
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

console.log('注册的工具:', registeredTools.map(t => t.name));
console.log('注册的命令:', registeredCmds.map(c => c.name));
console.log('pre-execute 监听器数:', preExecuteListeners.length);

// 隔离工作区：所有契约/账本/被摘要的内容都放这里，避免测试污染摘要
const work = fs.mkdtempSync('/tmp/goal-gate-wiring-');
process.chdir(work);
const ledger = path.join(work, '.goal-gate');
fs.mkdirSync(ledger, { recursive: true });
fs.writeFileSync(path.join(work, 'a.txt'), 'stable content\n');

fs.writeFileSync(path.join(ledger, 'goal.md'), `objective: 冒烟
AC-1 | 一定通过 | check: \`test -f a.txt\` | expected: exit=0
`);

const exec = { name: 'update_goal', arguments: { action: 'complete' } };
const next = () => ({ kind: 'allow' });
const listen = preExecuteListeners[0];

console.log('\n[1] 门控通过 →', JSON.stringify(await listen(exec, next)));

// 换一条必失败的 AC（改契约本身不改 a.txt，但换 AC 会触发 verdict-stale 仅当摘要变）
// 这里刻意只改契约文本（goal.md 在 .goal-gate 里，被排除在摘要外），所以摘要应稳定
fs.writeFileSync(path.join(ledger, 'goal.md'), `objective: 冒烟
AC-1 | 一定通过 | check: \`test -f a.txt\` | expected: exit=0
AC-2 | 一定失败 | check: \`test -f NOPE\` | expected: exit=0
`);
console.log('[2] 契约改了但工作区未动（摘要应稳定，应触发 NO-GO 而非 stale）→', JSON.stringify(await listen(exec, next)));

// 改工作区文件 → 摘要变 → 触发 verdict-stale
fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
console.log('[3] 工作区改动 →', JSON.stringify(await listen(exec, next)));

console.log('[4] 无关工具 →', JSON.stringify(await listen({ name: 'read', arguments: {} }, next)));

// 恢复稳定，连拦两次看 R1 计数 → BLOCKED
fs.writeFileSync(path.join(work, 'a.txt'), 'stable content\n');
console.log('[5] 恢复稳定再拦（NO-GO，计数1）→', JSON.stringify(await listen(exec, next)));
console.log('[6] 再拦（计数2 → BLOCKED）→', JSON.stringify(await listen(exec, next)));

console.log('\n状态文件:', fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'));
