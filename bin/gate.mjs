#!/usr/bin/env node
// gate.mjs — 门控 CLI(bash 可达的循环驱动兜底入口)
// 背景:恢复会话可能拿不到 goal_gate_* 工具(实测);循环必须始终可驱动。
// 用法(绝对路径 node 执行,坏 PATH 机器安全):
//   node bin/gate.mjs check     [--cwd <dir>] [--strategy <s>] [--note <n>]  跑门控+记账,exit 0 GO / 2 NO-GO / 3 BLOCKED / 4 state-error
//   node bin/gate.mjs status    [--cwd <dir>]   只读状态(不跑 check、不记账)
//   node bin/gate.mjs audit     [--cwd <dir>]   声明前审计(只读),exit 0 ok / 1 violations
//   node bin/gate.mjs stamp     [--cwd <dir>] [--approved-by <who>] [--max-rounds <n>] [--time-budget-minutes <n>] [--restamp]
//   node bin/gate.mjs reset     [--cwd <dir>] [--new-loop]  人类解除 BLOCKED / 轮换实验时钟
//   node bin/gate.mjs preflight [--cwd <dir>]   契约预检(裸解释器/永真式/仪器问题)
import fs from 'node:fs';
import { runGate, parseContract } from '../lib/core.js';
import {
  contractPath, loopPath, readState, writeState, recordRun, readHistory, readLoop,
  preflightChecks, neverFailedAcs, loopIdleStatus, idleWarning, duplicateEvalNote,
  applyStamp, timeBudgetStatus, efficiencyOf, statusReport, auditReport,
} from '../lib/ledger.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const root = flag('--cwd') ?? process.cwd();

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

if (cmd === 'reset') {
  const state = readState(root);
  const before = { falseCompletes: state.falseCompletes ?? 0, partialCompletes: state.partialCompletes ?? 0 };
  state.falseCompletes = 0;
  state.partialCompletes = 0;
  writeState(root, state);
  let loop = readLoop(root);
  if (has('--new-loop') && loop) {
    loop = { ...loop, createdAt: new Date().toISOString(), status: 'active' };
    fs.writeFileSync(loopPath(root), JSON.stringify(loop, null, 2));
  }
  out({ reset: true, before, after: { falseCompletes: 0, partialCompletes: 0 }, newLoop: has('--new-loop'), loop });
  process.exit(0);
}

const cp = contractPath(root);
if (cmd === 'stamp') {
  if (!fs.existsSync(cp)) fail(4, { rc: 4, code: 'state-error', reason: 'no contract', contract: cp });
  const res = applyStamp(root, fs.readFileSync(cp, 'utf8'), {
    approvedBy: flag('--approved-by'),
    maxRounds: flag('--max-rounds') !== undefined ? Number(flag('--max-rounds')) : undefined,
    timeBudgetMinutes: flag('--time-budget-minutes') !== undefined ? Number(flag('--time-budget-minutes')) : undefined,
    restamp: has('--restamp'),
  });
  out(res);
  process.exit(res.ok ? 0 : 2);
}

if (!fs.existsSync(cp)) fail(4, { rc: 4, code: 'state-error', reason: 'no contract', contract: cp });

const text = fs.readFileSync(cp, 'utf8');
const state = readState(root);
const contract = parseContract(text);

if (cmd === 'preflight') {
  const warnings = preflightChecks(text, root);
  out({ contract: cp, acs: contract.acs.length, warnings });
  process.exit(warnings.length ? 1 : 0);
}

if (cmd === 'check') {
  const strategy = flag('--strategy');
  const note = flag('--note');
  const historyBefore = readHistory(root); // 重评检测/效率归因(recordRun 追加前的历史)
  const g = runGate(text, { cwd: root, baselines: { ...(state.baselines ?? {}) } });
  const { baselineUpdates: _b, ...gOut } = g;
  const loopBefore = readLoop(root);
  const fin = recordRun(root, state, g, 'check', { strategy, note });
  const history = readHistory(root);
  const never = neverFailedAcs(history, contract.acs, 2, g.stamp);
  const failedActions = (g.results ?? []).filter((r) => r.status !== 'passed').map((r) => {
    const ac = contract.acs.find((x) => x.id === r.id);
    return ac ? { id: ac.id, statement: ac.statement, check: ac.check, expected: ac.expected, why: r.why } : { id: r.id };
  });
  const loopNow = readLoop(root);
  const warnings = preflightChecks(text, root);
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
    fail(3, { ...base, rc: 3, code: 'blocked', reason: `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。(${g.reason})` });
  }
  out(base);
  process.exit(g.rc === 0 ? 0 : 2);
}

fail(4, { rc: 4, code: 'state-error', reason: `unknown command ${cmd}; use check|status|audit|stamp|reset|preflight` });
