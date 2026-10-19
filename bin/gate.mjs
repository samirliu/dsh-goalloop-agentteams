#!/usr/bin/env node
// gate.mjs — 门控 CLI(bash 可达的循环驱动兜底入口)
// 背景:恢复会话可能拿不到 goal_gate_* 工具(实测);循环必须始终可驱动。
// 用法(绝对路径 node 执行,坏 PATH 机器安全):
//   node bin/gate.mjs check     [--cwd <dir>] [--strategy <s>] [--note <n>] [--shell <shell>]  跑门控+记账,exit 0 GO / 2 NO-GO / 3 BLOCKED / 4 state-error / 5 busy
//   node bin/gate.mjs status    [--cwd <dir>]   只读状态(不跑 check、不记账)
//   node bin/gate.mjs audit     [--cwd <dir>]   声明前审计(只读),exit 0 ok / 1 violations
//   node bin/gate.mjs stamp     [--cwd <dir>] [--approved-by <who>] [--max-rounds <n>] [--time-budget-minutes <n>] [--restamp]
//   node bin/gate.mjs reset     [--cwd <dir>] [--new-loop]  人类解除 BLOCKED / 轮换实验时钟
//   node bin/gate.mjs unlock    [--cwd <dir>]   强制回收卡住的账本锁(锁持有者已死/进程失联时的人工恢复路径)
//   node bin/gate.mjs preflight [--cwd <dir>]   契约预检(裸解释器/永真式/仪器问题)
import fs from 'node:fs';
import { runGate, parseContract } from '../lib/core.js';
import {
  contractPath, loopPath, readState, writeState, recordRun, readHistory, readLoop,
  preflightChecks, neverFailedAcs, loopIdleStatus, idleWarning, duplicateEvalNote,
  applyStamp, timeBudgetStatus, efficiencyOf, statusReport, auditReport, withLedgerLock,
  forceUnlock, readLockInfo, lockPath,
} from '../lib/ledger.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const root = flag('--cwd') ?? process.cwd();
// --shell / GOAL_GATE_SHELL:显式指定门控解释器。POSIX 缺省 /bin/sh,
// Windows 缺省 %COMSPEC%(cmd.exe);想跑 POSIX 语法就指向 Git Bash/WSL 的 sh。
const shell = flag('--shell');

function out(obj) { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); }
function fail(code, obj) { out(obj); process.exit(code); }

if (cmd === 'status') {
  out(statusReport(root));
  process.exit(0);
}

if (cmd === 'audit') {
  const report = auditReport(root);
  out(report);
  process.exit(report.ok ? 0 : 1);
}

if (cmd === 'unlock') {
  // 人工恢复:锁持有者崩溃/失联时,不必等满 TTL(或永远卡住)才能继续。
  // 只清锁文件,不动账本——账本由 readState 的签名校验保护。
  const before = readLockInfo(lockPath(root));
  const res = forceUnlock(root);
  out({ ...res, lock: lockPath(root), before: before ?? null });
  process.exit(res.unlocked ? 0 : 4);
}

if (cmd === 'reset') {
  // reset 改账本 → 必须与 check 互斥(原来无锁:两个人同时 reset/check 会互相覆盖)。
  const locked = await withLedgerLock(root, async () => {
    const state = readState(root);
    if (state.__integrity === 'bad') return { tampered: true, reason: state.__reason };
    const before = { falseCompletes: state.falseCompletes ?? 0, partialCompletes: state.partialCompletes ?? 0 };
    state.falseCompletes = 0;
    state.partialCompletes = 0;
    writeState(root, state);
    let loop = readLoop(root);
    if (has('--new-loop') && loop) {
      loop = { ...loop, createdAt: new Date().toISOString(), status: 'active' };
      fs.writeFileSync(loopPath(root), JSON.stringify(loop, null, 2));
    }
    return { reset: true, before, after: { falseCompletes: 0, partialCompletes: 0 }, newLoop: has('--new-loop'), loop };
  }, { waitMs: 2000 });
  if (locked.busy) fail(5, { rc: 5, code: 'busy', reason: 'another goal-gate operation holds the ledger lock; retry after it settles' });
  if (locked.tampered) fail(4, { rc: 4, code: 'state-error', reason: `账本不可信,拒绝 reset:${locked.reason}(账本被改动或密钥不匹配;确认后用 unlock 只解锁,不要静默重建)` });
  out(locked);
  process.exit(0);
}

const cp = contractPath(root);
if (cmd === 'stamp') {
  if (!fs.existsSync(cp)) fail(4, { rc: 4, code: 'state-error', reason: 'no contract', contract: cp });
  const locked = await withLedgerLock(root, async () => applyStamp(root, fs.readFileSync(cp, 'utf8'), {
    approvedBy: flag('--approved-by'),
    maxRounds: flag('--max-rounds') !== undefined ? Number(flag('--max-rounds')) : undefined,
    timeBudgetMinutes: flag('--time-budget-minutes') !== undefined ? Number(flag('--time-budget-minutes')) : undefined,
    restamp: has('--restamp'),
  }), { waitMs: 2000 });
  if (locked.busy) fail(5, { rc: 5, code: 'busy', reason: 'another goal-gate operation holds the ledger lock; retry after it settles' });
  out(locked);
  // 账本被改动/密钥不匹配 = state-error(4),不是"契约需重批"(2)。
  process.exit(locked.ok ? 0 : locked.code === 'state-error' ? 4 : 2);
}

if (!fs.existsSync(cp)) fail(4, { rc: 4, code: 'state-error', reason: 'no contract', contract: cp });

const text = fs.readFileSync(cp, 'utf8');
const contract = parseContract(text);

if (cmd === 'preflight') {
  const warnings = preflightChecks(text, root, shell);
  out({ contract: cp, acs: contract.acs.length, warnings });
  process.exit(warnings.length ? 1 : 0);
}

if (cmd === 'check') {
  const strategy = flag('--strategy');
  const note = flag('--note');
  const locked = await withLedgerLock(root, async () => {
    const state = readState(root);
    // 账本被改动/密钥不匹配:拒绝评估并如实报 state-error。绝不静默重建
    // (那等于把 BLOCKED 闩锁和基线水位一起清零,是最省事的作弊路径)。
    if (state.__integrity === 'bad') {
      return { exitCode: 4, out: { rc: 4, code: 'state-error', reason: `账本不可信:${state.__reason}——拒绝评估,更不会静默重建(确认后人工处理 .goal-gate/state.json)` } };
    }
    const historyBefore = readHistory(root); // 重评检测/效率归因(recordRun 追加前的历史)
    const g = runGate(text, { cwd: root, baselines: { ...(state.baselines ?? {}) }, spreads: { ...(state.spreads ?? {}) }, shell });
    const { baselineUpdates: _b, spreadUpdates: _s, ...gOut } = g;
    const loopBefore = readLoop(root);
    const fin = recordRun(root, state, g, 'check', { strategy, note });
    const history = readHistory(root);
    const never = neverFailedAcs(history, contract.acs, 2, g.stamp);
    const failedActions = (g.results ?? []).filter((r) => r.status !== 'passed').map((r) => {
      const ac = contract.acs.find((x) => x.id === r.id);
      return ac ? { id: ac.id, statement: ac.statement, check: ac.check, expected: ac.expected, why: r.why } : { id: r.id };
    });
    const loopNow = readLoop(root);
    const warnings = preflightChecks(text, root, shell);
    const idleWarn = idleWarning(state, loopNow);
    if (idleWarn) warnings.push(idleWarn);
    const idle = loopIdleStatus(state, loopNow);
    const time = timeBudgetStatus(state, loopNow);
    const dup = duplicateEvalNote(historyBefore, loopBefore, g);
    const efficiency = efficiencyOf(historyBefore, loopNow?.createdAt ?? 'default', g, strategy);
    const base = {
      ...gOut, contract: cp,
      ...(dup ? { note: gOut.note ? `${gOut.note}; ${dup}` : dup } : {}),
      round: fin.round, maxRounds: fin.maxRounds, remainingRounds: fin.remainingRounds,
      roundsExhausted: fin.roundsExhausted, bestScore: state.bestScore ?? undefined,
      regression: fin.regression, failedActions,
      idleHours: idle ? idle.idleHours : undefined,
      neverFailed: never.length ? never : undefined,
      preflight: warnings.length ? warnings : undefined,
      ...(time ? { timeBudgetMinutes: time.budgetMinutes, timeRemainingMinutes: time.remainingMinutes, timeExhausted: time.exhausted } : {}),
      ...(efficiency ? { efficiency } : {}),
    };
    if ((state.falseCompletes ?? 0) >= 2) {
      return { exitCode: 3, out: { ...base, rc: 3, code: 'blocked', reason: `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。(${g.reason})` } };
    }
    // 退出码按 rc 如实映射:rc=4(state-error)曾经被压成 2,调用方分不清
    // "结论是 NO-GO" 和 "门控根本没跑起来"——自动化会把配置错误当成失败结论。
    const exitCode = g.rc === 0 ? 0 : g.rc === 4 ? 4 : 2;
    return { exitCode, out: base };
  }, { waitMs: 2000 });
  if (locked.busy) fail(5, { rc: 5, code: 'busy', reason: 'another goal-gate operation holds the ledger lock; retry after it settles' });
  out(locked.out);
  process.exit(locked.exitCode);
}

fail(4, { rc: 4, code: 'state-error', reason: `unknown command ${cmd}; use check|status|audit|stamp|reset|unlock|preflight` });
