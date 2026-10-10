#!/usr/bin/env node
// gate.mjs — 门控 CLI(bash 可达的循环驱动兜底入口)
// 背景:恢复会话可能拿不到 goal_gate_* 工具(实测);循环必须始终可驱动。
// 用法(绝对路径 node 执行,坏 PATH 机器安全):
//   node bin/gate.mjs check   [--cwd <dir>]   跑门控 + 记账本 + 输出 JSON
//   node bin/gate.mjs status  [--cwd <dir>]   只读状态(不记账)
//   node bin/gate.mjs preflight [--cwd <dir>] 契约预检(裸解释器/永真式告警)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate, parseContract } from '../lib/core.js';
import {
  contractPath, readState, writeState, recordRun, readHistory, readLoop,
  preflightChecks, neverFailedAcs,
} from '../lib/ledger.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const cwdIdx = args.indexOf('--cwd');
const root = cwdIdx !== -1 ? args[cwdIdx + 1] : process.cwd();

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function fail(code, obj) { out(obj); process.exit(code); }

const cp = contractPath(root);
if (!fs.existsSync(cp)) fail(4, { rc: 4, code: 'state-error', reason: 'no contract', contract: cp });

const text = fs.readFileSync(cp, 'utf8');
const state = readState(root);
const contract = parseContract(text);

if (cmd === 'preflight') {
  const warnings = preflightChecks(text);
  out({ contract: cp, acs: contract.acs.length, warnings });
  process.exit(warnings.length ? 1 : 0);
}

if (cmd === 'status') {
  out({
    contract: cp, stamp: text ? contract.acs.length : 0,
    falseCompletes: state.falseCompletes ?? 0, partialCompletes: state.partialCompletes ?? 0,
    bestScore: state.bestScore ?? null, baselines: state.baselines ?? {},
    loop: readLoop(root), history: readHistory(root).slice(-5),
  });
  process.exit(0);
}

if (cmd === 'check') {
  const g = runGate(text, { cwd: root, baselines: { ...(state.baselines ?? {}) } });
  const { baselineUpdates: _b, ...gOut } = g;
  const fin = recordRun(root, state, g, 'check');
  const history = readHistory(root);
  const never = neverFailedAcs(history, contract.acs);
  const failedActions = (g.results ?? []).filter((r) => r.status !== 'passed').map((r) => {
    const ac = contract.acs.find((x) => x.id === r.id);
    return ac ? { id: ac.id, statement: ac.statement, check: ac.check, expected: ac.expected } : { id: r.id };
  });
  const base = {
    ...gOut, contract: cp,
    round: fin.round, maxRounds: fin.maxRounds, remainingRounds: fin.remainingRounds,
    roundsExhausted: fin.roundsExhausted, bestScore: state.bestScore ?? undefined,
    regression: fin.regression, failedActions,
    neverFailed: never.length ? never : undefined,
    preflight: preflightChecks(text).length ? preflightChecks(text) : undefined,
  };
  if ((state.falseCompletes ?? 0) >= 2) {
    fail(3, { ...base, rc: 3, code: 'blocked', reason: `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。(${g.reason})` });
  }
  out(base);
  process.exit(g.rc === 0 ? 0 : 2);
}

fail(4, { rc: 4, code: 'state-error', reason: `unknown command ${cmd}; use check|status|preflight` });
