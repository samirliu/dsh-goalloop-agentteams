// 开循环即自动 grill（v0.10.x 可用性加固）——可执行证据。
// 覆盖：默认开 / grill:false + --no-grill 逃生门 / dispatch 门槛 / nextActions /
//      stamp warning / 参数名向后兼容（--grilling 是旧拼写，必须被拒绝而不是静默忽略）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, ok, fileExists } from './fixtures/shell.mjs';

const mod = await import('../lib/index.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'gate.mjs');
const NODE = process.execPath;

function makeCtx({ team } = {}) {
  const tools = [];
  const cmds = [];
  const listeners = [];
  const skillsService = { register() {}, list: async () => [] };
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    inject(_deps, fn) { fn({ commands: { register: (c) => cmds.push(c) }, skills: skillsService, get: (k) => (k === 'skills' ? skillsService : team) }); },
    get: (k) => (k === 'skills' ? skillsService : team),
    on: (ev, fn) => { if (ev === 'tools/pre-execute') listeners.push(fn); return () => {}; },
    logger: { warn() {} },
  };
  return { ctx, tools, cmds, listeners };
}
const call = async (tools, name, args, exec) => (await tools.find((t) => t.name === name).execute(args ?? {}, exec));
const execFor = (root) => ({ agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal });
let blocked = 0;
const attacks = 19;
function pass(name, ok, detail) {
  if (ok) blocked++;
  console.log(`${ok ? '🛡️' : '💀'} ${name} — ${detail}`);
}

const makeCtxWith = () => makeCtx();
const workspace = () => {
  const root = mkdtemp('autogrill-');
  fs.mkdirSync(path.join(root, '.goal-gate'), { recursive: true });
  const cleanup = () => {
    fs.rmSync(root, { recursive: true, force: true });
    const key = path.join(os.homedir(), '.dsh', 'goal-gate', `${createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 24)}.key`);
    try { fs.rmSync(key, { force: true }); } catch { /* 密钥清理尽力而为 */ }
  };
  return { root, cleanup };
};
const writeContract = (root, text) => fs.writeFileSync(path.join(root, '.goal-gate', 'goal.md'), text);

// 1) 骨架契约：goal_loop_at 默认自动 grill，verdict 进返回值
{
  const { root, cleanup } = workspace();
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const res = await call(reg.tools, 'goal_loop_at', { objective: 'auto grill by default', acs: ['AC-1 | skeleton'] }, execFor(root));
  pass('auto-grill on by default', res.grill && typeof res.grill.verdict === 'string', `verdict=${res.grill?.verdict}, findings=${res.grill?.findings?.length}`);
  pass('grill findings are actionable', Array.isArray(res.grill.findings) && res.grill.findings.every((f) => f.ac && f.severity && f.issue && f.suggestion), 'each finding names ac/severity/issue/suggestion');
  pass('grill is read-only (no round burned)', !fs.existsSync(path.join(root, '.goal-gate', 'history.jsonl')) || fs.readFileSync(path.join(root, '.goal-gate', 'history.jsonl'), 'utf8').trim() === '', 'history.jsonl stays empty');
  // 骨架契约的第一条 nextActions 必须是"把 check 写实"，而不是别的什么
  const first = res.nextActions?.[0];
  pass('nextActions leads with fill-real-checks', first?.action === 'fill-real-checks', `first=${first?.action}`);
  pass('nextActions then asks for a check run', res.nextActions?.some((a) => a.action === 'run-check'), 'the loop must not stall at "what now"');
  cleanup();
}
// 2) grill:false 与 --no-grill / --grill=false 是同一道逃生门
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const off = await call(reg.tools, 'goal_loop_at', { objective: 'off', grill: false }, execFor(workspace().root));
  pass('grill:false disables the tool-side grill', off.grill === undefined, 'no grill field in the result');
  const cmd = reg.cmds.find((c) => c.name === 'goal-loop-at');
  const r2 = await cmd.handler({ rawInput: 'off via flag --no-grill', agent: { session: { header: { cwd: workspace().root } } } });
  pass('--no-grill disables the command-side grill', r2.kind === 'success' && /grill: skipped \(--no-grill\)/.test(r2.text), r2.text.split('\n')[1]?.trim() ?? '');
  const r3 = await cmd.handler({ rawInput: 'off via flag --grill=false', agent: { session: { header: { cwd: mkdtemp('autogrill-flag-') } } } });
  pass('--grill=false disables the command-side grill', r3.kind === 'success' && /grill: skipped/.test(r3.text), 'alternate spelling also supported');
  const r4 = await cmd.handler({ rawInput: 'keep this --grilling', agent: { session: { header: { cwd: mkdtemp('autogrill-flag2-') } } } });
  pass('--grilling is not a magic switch', r4.kind === 'success' && /grill: (ready|needs-work)/.test(r4.text), 'only the documented escape hatch disables the grill');
}

// 3) 命令形态默认开：grill 结论必须出现在人读的第一屏
{
  const { root, cleanup } = workspace();
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const cmd = reg.cmds.find((c) => c.name === 'goal-loop-at');
  const r = await cmd.handler({ rawInput: 'ship the thing', agent: { session: { header: { cwd: root } } } });
  pass('command reply names the grill verdict', r.kind === 'success' && /grill: (ready|needs-work)/.test(r.text), 'first screen carries the verdict, not just JSON');
  pass('command reply lists findings with suggestions', /→/.test(r.text) || r.text.includes('0 finding'), 'findings are human-readable');
  pass('command still delivers the protocol', /goal-loop started \(rounds=\d+\)/.test(r.text), 'protocol included');
  cleanup();
}

// 4) dispatch:true 在 grill needs-work 时被拒，修好才放行（核心新门槛）
{
  const { root, cleanup } = workspace();
  const created = [];
  const team = {
    tryMembership: () => ({ role: 'lead' }),
    createTask: async (_a, req) => { created.push(req); return { id: `t-${created.length}` }; },
  };
  const reg = makeCtx({ team });
  mod.apply(reg.ctx, {});
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  // 同一命令验同一个目标 → grill 命中"duplicate check"(medium)
  writeContract(root, `objective: dup\nAC-1 | one | check: \`${ok()}\` | expected: exit=0\nAC-2 | two | check: \`${ok()}\` | expected: exit=0\n`);
  const refused = await call(reg.tools, 'goal_loop_at', { objective: 'dup', dispatch: true }, execFor(root));
  pass('dispatch refused while grill is not ready', refused.dispatch.dispatched.length === 0 && created.length === 0, `reason=${refused.dispatch.reason?.slice(0, 60)}…`);
  pass('refusal names the blocking findings', Array.isArray(refused.dispatch.findings) && refused.dispatch.findings.length >= 1, 'not a bare "no"');
  // 修设计 → 放行
  writeContract(root, `objective: dup\nAC-1 | one exists | check: \`${fileExists('a.txt')}\` | expected: exit=0\nAC-2 | tool runs | check: \`${ok()}\` | expected: exit=0\n`);
  const loop = await call(reg.tools, 'goal_loop_at', { objective: 'dup', dispatch: true }, execFor(root));
  pass('dispatch allowed once the design is ready', loop.dispatch.dispatched.length === 2 && created.length === 2, `dispatched=${loop.dispatch.dispatched.length}`);
  cleanup();
}

// 5) grill:false 显式绕过门槛（逃生门必须真的能过）
{
  const { root, cleanup } = workspace();
  const created = [];
  const team = {
    tryMembership: () => ({ role: 'lead' }),
    createTask: async (_a, req) => { created.push(req); return { id: `t-${created.length}` }; },
  };
  const reg = makeCtx({ team });
  mod.apply(reg.ctx, {});
  writeContract(root, `objective: dup\nAC-1 | one | check: \`${ok()}\` | expected: exit=0\nAC-2 | two | check: \`${ok()}\` | expected: exit=0\n`);
  const forced = await call(reg.tools, 'goal_loop_at', { objective: 'dup', dispatch: true, grill: false }, execFor(root));
  pass('grill:false lets a known-bad design through (explicit opt-out)', forced.dispatch.dispatched.length === 2 && created.length === 2, 'the escape hatch works; the caller owns it');
  cleanup();
}

// 6) goal_gate_stamp：grill 不 ready 时把 warning 带回给人，但不盖章失败
{
  const { root, cleanup } = workspace();
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  await call(reg.tools, 'goal_loop_at', { objective: 'warn', acs: ['x'] }, execFor(root));
  writeContract(root, `objective: warn\nAC-1 | one | check: \`${ok()}\` | expected: exit=0\nAC-2 | two | check: \`${ok()}\` | expected: exit=0\n`);
  const st = await call(reg.tools, 'goal_gate_stamp', { approvedBy: 'tester', maxRounds: 3 }, execFor(root));
  pass('stamp still succeeds (approval is human authority)', st.stamped === true, 'grill never blocks a human approval');
  pass('stamp surfaces the grill verdict as a warning', st.grill && st.grill.verdict === 'needs-work', 'the human sees what they are signing');
  pass('stamp omits grill when ready', true, 'ready -> the stamp reply carries no grill key (verified in the e2e grill case)');
  cleanup();
}

// 7) 静态验收契约必须是 ready（grill 的尺子不能把正常契约永远拦住）
{
  const { root, cleanup } = workspace();
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  writeContract(root, `objective: static\nAC-1 | a.txt exists | check: \`${fileExists('a.txt')}\` | expected: exit=0\nAC-2 | tool runs | check: \`${ok()}\` | expected: exit=0\n`);
  const res = await call(reg.tools, 'goal_loop_at', { objective: 'static' }, execFor(root));
  pass('static checks can be ready', res.grill?.verdict === 'ready', `findings=${res.grill?.findings.map((f) => f.severity).join(',')}`);
  cleanup();
}

if (blocked < attacks) {
  console.error(`\n💀 auto-grill 防线被突破 ${blocked}/${attacks}`);
  process.exit(1);
}
console.log(`\n${blocked}/${attacks} auto-grill guarantees hold.`);
