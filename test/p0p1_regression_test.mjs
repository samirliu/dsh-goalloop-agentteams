// p0p1_regression_test.mjs — 每个 P0/P1 修复点一条可复现的攻击回归。
//
// 这些用例全部来自一次对抗式评估里"亲手打通"的攻击路径；修复后它们必须失败。
// 一条用例一个攻击面，失败信息直接写出"攻击者原本能做到什么"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  runGate, parseContract, metricKey, judgeExpected,
} from '../lib/core.js';
import {
  readState, writeState, acquireLedgerLock, lockPath, readLockInfo,
  contractPath, statePath, forceUnlock, applyStamp, recordRun,
} from '../lib/ledger.js';
import { mkdtemp, ok, echo, sequence, fileExists, showFile } from './fixtures/shell.mjs';

const mod = await import('../lib/index.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'gate.mjs');
const NODE = process.execPath;

function makeCtx() {
  const tools = [];
  const cmds = [];
  const skills = [];
  const listeners = [];
  const skillsService = { register: (s) => skills.push(s), list: async () => skills.map((s) => ({ name: s.name })) };
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    inject: (_deps, fn) => fn({ commands: { register: (c) => cmds.push(c) }, skills: skillsService, get: (k) => (k === 'skills' ? skillsService : undefined) }),
    get: (k) => (k === 'skills' ? skillsService : undefined),
    on: (name, fn) => { if (name === 'tools/pre-execute') listeners.push(fn); return () => {}; },
    logger: { warn: () => {} },
  };
  return { ctx, tools, cmds, skills, listeners };
}
function tool(reg, name) { return reg.tools.find((t) => t.name === name); }
async function call(reg, name, args, exec) { return tool(reg, name).execute(args ?? {}, exec); }
function decide(reg, name, args, exec) {
  return reg.listeners[0]({ name, arguments: args, agent: exec.agent }, () => ({ kind: 'allow' }));
}
function runCli(args, cwd) {
  return spawnSync(NODE, [cli, ...args, '--cwd', cwd], { encoding: 'utf8' });
}
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function workspace(lines) {
  const dir = mkdtemp('p0p1-');
  fs.mkdirSync(path.join(dir, '.goal-gate'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.goal-gate', 'goal.md'), `${lines.join('\n')}\n`);
  return dir;
}
const execAt = (root) => ({ agent: { session: { header: { cwd: root } } } });

// ── P0-1:锁只保护它该保护的临界区 ─────────────────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = workspace([`objective: lock scope`, `AC-1 | 过 | check: \`${fileExists('NOPE')}\` | expected: exit=0`]);
  const exec = execAt(work);

  // 攻击:一次卡住的判定曾经能把整个工具面(read/ls/status)一起 deny 掉。
  const release = acquireLedgerLock(work);
  assert.equal(typeof release, 'function', 'lock acquired');
  assert.deepEqual(await decide(reg, 'read', { file: 'a.txt' }, exec), { kind: 'allow' }, 'P0-1: read-only tool must NOT be blocked by a held ledger lock');
  const blockedClaim = await decide(reg, 'update_goal', { action: 'complete' }, exec);
  assert.equal(blockedClaim.kind, 'deny');
  assert.equal(blockedClaim.info.code, 'busy', 'P0-1: only completion claims contend for the ledger lock');
  release();
  console.log('✓ P0-1 lock scope: non-claim tools pass through, claims get busy (not a workspace-wide deny)');
}

// ── P0-1:释放校验持有者 + pid 存活检测 + 人工解锁 ──────────────────────────
{
  const work = mkdtemp('p0p1-lock-');
  const release = acquireLedgerLock(work);
  assert.equal(typeof release, 'function');
  const info = readLockInfo(lockPath(work));
  assert.ok(info.token, 'P0-1: lock carries a per-acquisition token');
  assert.equal(info.pid, process.pid, 'P0-1: lock records the holder pid');
  // 第二次拿锁:持有者活着 → 不许抢
  assert.equal(acquireLedgerLock(work), null, 'P0-1: a live holder keeps its lock');
  // 伪造一把"持有者已死"的锁:pid 存活检测应当立刻回收(而不是等满 10 分钟 TTL)
  release();
  fs.writeFileSync(lockPath(work), JSON.stringify({ pid: 999999, at: Date.now(), token: 'dead-holder' }));
  const recovered = acquireLedgerLock(work);
  assert.equal(typeof recovered, 'function', 'P0-1: a dead holder is reclaimed immediately, not after the stale TTL');
  recovered();
  // 人工解锁:锁持有者失联时的恢复路径
  fs.writeFileSync(lockPath(work), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'wedged' }));
  const unlocked = forceUnlock(work);
  assert.equal(unlocked.unlocked, true, 'P0-1: forceUnlock clears a wedged lock');
  assert.equal(fs.existsSync(lockPath(work)), false);
  console.log('✓ P0-1 lock hygiene: token-checked release / dead-pid reclaim / force unlock');
}

// ── P0-2:账本签名 —— 改写 state.json 必须暴露,不许静默重建 ─────────────────
{
  const work = workspace([`objective: ledger`, `AC-1 | 过 | check: \`${ok()}\` | expected: exit=0`]);
  const first = runCli(['check'], work);
  assert.equal(first.status, 0, 'baseline: the fresh ledger passes');
  const raw = JSON.parse(fs.readFileSync(statePath(work), 'utf8'));
  assert.ok(typeof raw.sig === 'string' && raw.sig.length === 64, 'P0-2: writeState stamps the ledger with an HMAC');

  // 攻击:把水位改低,让 maximize 白过;或删掉 BLOCKED 闩锁。
  raw.baselines = { 'AC-1#deadbeef': 0.01 };
  raw.falseCompletes = 0;
  fs.writeFileSync(statePath(work), JSON.stringify(raw, null, 2));

  const tampered = readState(work);
  assert.equal(tampered.__integrity, 'bad', 'P0-2: a rewritten ledger reads back as untrusted, not as an empty one');
  assert.match(tampered.__reason, /签名不符/);
  assert.throws(() => writeState(work, tampered), /LEDGER_TAMPERED|state-error/, 'P0-2: a tampered ledger cannot be silently overwritten');

  const second = runCli(['check'], work);
  assert.equal(second.status, 4, 'P0-2: CLI reports state-error (4) instead of silently rebuilding the ledger');
  assert.equal(JSON.parse(second.stdout).code, 'state-error');

  // 删掉 state.json 也不能"失忆重置":密钥还在,账本没了 = 账本被删。
  fs.rmSync(statePath(work), { force: true });
  const third = runCli(['check'], work);
  assert.equal(third.status, 4, 'P0-2: deleting state.json in a signed workspace is detected, not treated as first use');
  assert.match(JSON.parse(third.stdout).reason, /账本被删除/);
  console.log('✓ P0-2 ledger integrity: tamper -> state-error(4), delete -> detected, no silent rebuild');
}

// ── P1-6:CLI 退出码按 rc 如实映射(4=state-error,5=busy)────────────────────
{
  const go = workspace([`objective: go`, `AC-1 | 过 | check: \`${ok()}\` | expected: exit=0`]);
  assert.equal(runCli(['check'], go).status, 0, 'P1-6: GO -> exit 0');
  const noGo = workspace([`objective: no-go`, `AC-1 | 不过 | check: \`${fileExists('NOPE')}\` | expected: exit=0`]);
  assert.equal(runCli(['check'], noGo).status, 2, 'P1-6: NO-GO -> exit 2');
  // 畸形契约:门控根本没跑起来,不是"结论 NO-GO"——曾经被压成 2。
  const bad = workspace([`objective: broken contract`, 'AC-1 | 缺反引号 | check: echo | expected: exit=0']);
  const badRun = runCli(['check'], bad);
  assert.equal(badRun.status, 4, 'P1-6: state-error -> exit 4 (used to be squashed into 2)');
  assert.equal(JSON.parse(badRun.stdout).code, 'state-error');
  // busy:别人持锁时是"没跑"而不是"失败结论",单列 5。
  const busyWork = workspace([`objective: busy`, `AC-1 | 过 | check: \`${ok()}\` | expected: exit=0`]);
  const held = acquireLedgerLock(busyWork);
  const busyRun = runCli(['check'], busyWork);
  held();
  assert.equal(busyRun.status, 5, 'P1-6: busy -> exit 5 (distinct from NO-GO and state-error)');
  assert.equal(JSON.parse(busyRun.stdout).code, 'busy');
  console.log('✓ P1-6 CLI exit codes: 0 GO / 2 NO-GO / 4 state-error / 5 busy');
}

// ── P1-6:reset / unlock 也走同一把锁 ──────────────────────────────────────
{
  const work = workspace([`objective: reset`, `AC-1 | 过 | check: \`${ok()}\` | expected: exit=0`]);
  runCli(['check'], work);
  const held = acquireLedgerLock(work);
  const resetBusy = runCli(['reset'], work);
  const unlockRun = runCli(['unlock'], work);
  held();
  assert.equal(resetBusy.status, 5, 'P1-6: reset contends for the ledger lock like check does');
  assert.equal(unlockRun.status, 0, 'P1-6: unlock is the documented recovery path');
  assert.equal(fs.existsSync(lockPath(work)), false);
  const after = runCli(['reset', '--new-loop'], work);
  assert.equal(after.status, 0, 'P1-6: reset works once the lock is free');
  console.log('✓ P1-6 reset/unlock: reset is locked, unlock recovers a wedged lock');
}

// ── P1-3:指标身份锚在语句上,不是 check 命令上 ─────────────────────────────
{
  const base = { id: 'AC-1', statement: '吞吐要改善', check: 'bench.sh', expected: 'maximize' };
  const reformatted = { ...base, check: 'bench.sh  # 加个注释' };
  const retargeted = { ...base, statement: '延迟要下降' };
  assert.equal(metricKey(base), metricKey(reformatted), 'P1-3: editing the instrument must NOT start a fresh metric series');
  assert.notEqual(metricKey(base), metricKey(retargeted), 'P1-3: changing the measured statement DOES start a fresh series');
  // 首轮没有水位 = 无从判断改善 → unverifiable,不许白拿 PASS。
  assert.equal(judgeExpected('maximize', { exitCode: 0, stdout: '3\n' }), 'unverifiable', 'P1-3: first measurement establishes a baseline, it does not pass');
  console.log('✓ P1-3 metric identity: statement-anchored key + first round is unverifiable');
}

// ── P1-4:质量分只能来自判官,不能来自被评产物 ──────────────────────────────
{
  const work = mkdtemp('p0p1-score-');
  fs.writeFileSync(path.join(work, 'ev.txt'), 'evidence body\n');
  const digest = sha256(path.join(work, 'ev.txt'));
  const text = `objective: 质量分
AC-1 | 质量评审 | check: \`${sequence(echo('score: 10'), echo('artifact: ev.txt'), echo(`digest: sha256:${digest}`))}\` | probe: \`${echo('score: 6')}\` | expected: judged
`;
  const g = runGate(text, { cwd: work });
  assert.equal(g.results[0].status, 'passed');
  assert.equal(g.results[0].value, 0.6, 'P1-4: score comes from the judge (6 -> 0.6), not the artifact self-report (10)');
  const key = metricKey(parseContract(text).acs[0]);
  assert.equal(g.baselineUpdates[key], 0.6, 'P1-4: the judge-reported score is what enters the metric pipeline');
  console.log('✓ P1-4 judge-reported score: artifact self-report ignored');
}

// ── P1-4:calib 由门控自跑 —— 只会说 PASS 的判读席必须被拆穿 ────────────────
{
  const work = mkdtemp('p0p1-calib-');
  fs.mkdirSync(path.join(work, '.goal-gate', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(work, 'good.txt'), 'known good\n');
  fs.writeFileSync(path.join(work, 'bad.txt'), 'known bad\n');
  const digest = sha256(path.join(work, 'good.txt'));
  const evidence = sequence(echo('artifact: good.txt'), echo(`digest: sha256:${digest}`));

  // (a) 没有 {file} 占位符 → 门控没法拿同一把尺子量两个夹具 → broken
  const noPlaceholder = `objective: calib
AC-1 | 评审 | check: \`${evidence}\` | probe: \`${ok()}\` | calib: good=good.txt bad=bad.txt | expected: judged
`;
  const g1 = runGate(noPlaceholder, { cwd: work });
  assert.equal(g1.results[0].status, 'broken');
  assert.match(g1.results[0].why, /calibration unbound/, 'P1-4: calib without a {file} placeholder cannot be self-certified');

  // (b) 判读席对任何输入都 exit 0 → 把已知坏夹具判成通过 → broken
  const alwaysPass = `objective: calib
AC-1 | 评审 | check: \`${evidence}\` | probe: \`"${NODE}" -e "" {file}\` | calib: good=good.txt bad=bad.txt | expected: judged
`;
  const g2 = runGate(alwaysPass, { cwd: work });
  assert.equal(g2.results[0].status, 'broken');
  assert.match(g2.results[0].why, /已知坏夹具判成通过/, 'P1-4: a judge that passes the known-bad fixture is not a judge');

  // (c) 真判读席(按内容判) → 通过
  const judge = path.join(work, 'judge.mjs');
  fs.writeFileSync(judge, `import fs from 'node:fs';\nconst t = fs.readFileSync(process.argv[2], 'utf8');\nprocess.exit(/known good/.test(t) ? 0 : 1);\n`);
  const honest = `objective: calib
AC-1 | 评审 | check: \`${evidence}\` | probe: \`"${NODE}" judge.mjs {file}\` | calib: good=good.txt bad=bad.txt | expected: judged
`;
  const g3 = runGate(honest, { cwd: work });
  assert.equal(g3.results[0].status, 'passed', 'P1-4: a judge that separates good from bad clears calibration');
  console.log('✓ P1-4 calibration: gate runs the judge against both fixtures; self-reported calib lines are ignored');
}

// ── P1-5:证据必须落在工作区内 ─────────────────────────────────────────────
{
  const work = mkdtemp('p0p1-escape-');
  const outside = path.join(path.dirname(work), `outside-${path.basename(work)}.txt`);
  fs.writeFileSync(outside, 'outside the workspace\n');
  const digest = sha256(outside);
  const text = `objective: 逃逸
AC-1 | 评审 | check: \`${sequence(echo('artifact: ../' + path.basename(outside)), echo(`digest: sha256:${digest}`))}\` | probe: \`${ok()}\` | expected: judged
`;
  const g = runGate(text, { cwd: work });
  fs.rmSync(outside, { force: true });
  assert.equal(g.results[0].status, 'broken');
  assert.match(g.results[0].why, /outside workspace/, 'P1-5: evidence outside the workspace is not evidence');
  console.log('✓ P1-5 evidence containment: artifact outside the workspace is rejected even with a correct digest');
}

// ── P1-7:拿不到工作区 → fail-closed;盖章默认要人批 ────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const noCwd = { agent: { session: { header: {} } } };
  // 攻击:宿主没给 cwd 时曾经回退 process.cwd(),去插件安装目录找契约,找不到就放行。
  const claim = await decide(reg, 'update_goal', { action: 'complete' }, noCwd);
  assert.equal(claim.kind, 'deny');
  assert.equal(claim.info.code, 'state-error', 'P1-7: a completion claim without a workspace root fails closed');
  assert.deepEqual(await decide(reg, 'read', {}, noCwd), { kind: 'allow' }, 'P1-7: non-claim tools are not blocked by the missing root');

  const wsErr = await call(reg, 'goal_gate_status', {}, noCwd).catch((e) => ({ threw: e.message }));
  assert.ok(wsErr.rc === 4 || wsErr.threw, 'P1-7: tools report state-error instead of inventing a directory');

  // 盖章 = 冻结"什么叫做完",默认必须是人点的。
  const ask = await decide(reg, 'goal_gate_stamp', {}, execAt(mkdtemp('p0p1-stamp-')));
  assert.equal(ask.kind, 'ask', 'P1-7: stamping the contract requires human approval by default');
  const off = makeCtx();
  mod.apply(off.ctx, { requireHumanApproval: false });
  const askOff = await decide(off, 'goal_gate_stamp', {}, execAt(mkdtemp('p0p1-stamp2-')));
  assert.notEqual(askOff.kind, 'ask', 'P1-7: the default can still be turned off explicitly');
  console.log('✓ P1-7 fail-closed root + human-approved stamping by default');
}

// ── 附带:退出码 200 是命令自己的退出码,不是"被信号杀掉" ──────────────────
{
  const work = mkdtemp('p0p1-exit200-');
  const expect200 = `objective: exit200
AC-1 | 200 | check: \`"${NODE}" -e "process.exit(200)"\` | expected: exit=200
`;
  const g = runGate(expect200, { cwd: work });
  assert.equal(g.results[0].status, 'passed', 'exit=200 is an ordinary exit code: expected exit=200 must pass (used to be "killed by signal")');

  const expect0 = `objective: exit200b
AC-1 | 200 as 0 | check: \`"${NODE}" -e "process.exit(200)"\` | expected: exit=0
`;
  const g2 = runGate(expect0, { cwd: work });
  assert.equal(g2.results[0].status, 'failed', 'a wrong exit code is FAILED, not BROKEN: the verifier ran fine');
  assert.doesNotMatch(g2.results[0].why ?? '', /signal/, 'exit 200 must not be reported as a signal');
  console.log('✓ exit codes: 200 is an exit code, not a signal');
}

// ── 附带:盖章与门控对畸形契约必须用同一把尺子 ────────────────────────────
{
  const work = mkdtemp('p0p1-malformed-');
  fs.mkdirSync(path.join(work, '.goal-gate'), { recursive: true });
  const bad = `objective: x\nAC-1 | ok | check: \`${ok()}\` | expected: exit=0\n- AC-2 | malformed\n`;
  fs.writeFileSync(contractPath(work), bad);
  // 攻击:门控会 rc=4 拒掉的契约,盖章曾经照收(先批准一份跑不起来的 done 定义)。
  const st = applyStamp(work, bad, { approvedBy: 'attacker' });
  assert.equal(st.ok, false, 'malformed dashed AC line blocks stamping too');
  assert.equal(st.code, 'contract-malformed');
  assert.equal(runGate(bad, { cwd: work }).rc, 4, 'runGate rejects the same contract (stamp and gate agree)');
  console.log('✓ stamp/gate parity: a malformed dashed AC line is rejected by both');
}

// ── P0-2 附:预算盖章必须落盘(没有 loop.json 时曾经静默丢失)───────────────
{
  const work = workspace([`objective: budget`, `AC-1 | 过 | check: \`${ok()}\` | expected: exit=0`]);
  const res = applyStamp(work, fs.readFileSync(contractPath(work), 'utf8'), { approvedBy: 'tester', maxRounds: 2 });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(work, '.goal-gate', 'loop.json')), 'P0-2: stamping a budget creates loop.json instead of dropping it');
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, '.goal-gate', 'loop.json'), 'utf8')).maxRounds, 2);
  // 轮次耗尽判定:用满最后一轮就算耗尽(原来差一轮,还能多跑一次)
  const st = readState(work);
  const fin = recordRun(work, st, { code: 'no-go', score: 0, stamp: res.stamp, results: [] }, 'check');
  assert.equal(fin.round, 1);
  assert.equal(fin.roundsExhausted, false, 'round 1 of 2 is not exhausted');
  const fin2 = recordRun(work, st, { code: 'no-go', score: 0, stamp: res.stamp, results: [] }, 'check');
  assert.equal(fin2.round, 2);
  assert.equal(fin2.roundsExhausted, true, 'P0-2: the last budgeted round counts as exhausted');
  console.log('✓ P0-2 budget: stamp persists maxRounds, rounds-exhausted fires on the last budgeted round');
}

console.log('\nAll P0/P1 regression cases passed.');
