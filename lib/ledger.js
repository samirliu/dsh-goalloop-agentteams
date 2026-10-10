// ledger.js — 账本层(状态/历史/轮次),供 index.js(宿主内)与 bin/gate.mjs(bash 兜底)共用
// 背景:恢复会话可能拿不到 goal_gate_* 工具表(实测),循环必须能被 bash 直接驱动 ——
// 同一份账本、同一个判定内核,只是入口不同。
import fs from 'node:fs';
import path from 'node:path';
import { runGate } from './core.js';

export const DEFAULT_MAX_ROUNDS = 8;

export function ledgerDir(root) { return path.join(root, '.goal-gate'); }
export function contractPath(root) { return path.join(ledgerDir(root), 'goal.md'); }
export function statePath(root) { return path.join(ledgerDir(root), 'state.json'); }
export function loopPath(root) { return path.join(ledgerDir(root), 'loop.json'); }
export function historyPath(root) { return path.join(ledgerDir(root), 'history.jsonl'); }

export function readState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return { falseCompletes: 0, digests: {}, baselines: {}, bestScore: null }; }
}
export function writeState(root, s) {
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(s, null, 2));
}
export function readLoop(root) {
  try { return JSON.parse(fs.readFileSync(loopPath(root), 'utf8')); } catch { return null; }
}
export function readHistory(root) {
  try { return fs.readFileSync(historyPath(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// ── 轮次/度量账本:每次门控评估都记一行 history.jsonl ───────────────────────
// round = 优化迭代数(check / 完成声明评估计入;goal-only 任务里程碑记账不计入预算)。
export function recordRun(root, state, g, trigger) {
  const history = readHistory(root);
  const milestone = trigger === 'task-claim';
  const loop = readLoop(root);
  const loopKey = loop?.createdAt ?? 'default';
  // 轮次属于"实验"(loop)而不是工作区:换 loop 重新计数,否则多实验共享工作区时
  // 轮次预算被历史撑爆(roundsExhausted 假阳性)。
  const round = history.filter((h) => h.trigger !== 'task-claim' && (h.loopKey ?? 'default') === loopKey).length + (milestone ? 0 : 1);
  const maxRounds = loop?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const entry = {
    ts: new Date().toISOString(), trigger, round, loopKey,
    code: g.code, score: g.score ?? null, totals: g.totals ?? null, stamp: g.stamp ?? null,
    failed: (g.results ?? []).filter((r) => r.status === 'failed').map((r) => r.id),
    unverifiable: (g.results ?? []).filter((r) => r.status === 'unverifiable').map((r) => r.id),
  };
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.appendFileSync(historyPath(root), `${JSON.stringify(entry)}\n`);

  // case 边界 = loop.json 换代(新实验):bestScore 重新开始。基线本身按
  // metricKey(=AC 编号+check 哈希)隔离,无需在此清空——契约微调不许清史。
  if (state.loopKey !== undefined && state.loopKey !== loopKey) { state.bestScore = null; }
  state.loopKey = loopKey;

  // 基线推进纪律(不回退规则的牙齿):只有"本轮通过"的 AC 才允许把基线推进到新观测值;
  // 未建基线的 AC 首轮照常建档;失败/不可验证的观测不许把基线拉下来(否则失败一次
  // 基线就滑到低位,下一轮低水平"通过"——不回退规则会被自己的更新策略瓦解)。
  const merged = { ...(state.baselines ?? {}) };
  for (const [id, v] of Object.entries(g.baselineUpdates ?? {})) {
    const status = (g.results ?? []).find((r) => r.id === id)?.status;
    if (merged[id] === undefined || status === 'passed') merged[id] = v;
  }
  state.baselines = merged;

  const regression = g.score !== undefined && state.bestScore !== null && state.bestScore !== undefined && g.score < state.bestScore;
  if (g.score !== undefined) state.bestScore = Math.max(state.bestScore ?? -Infinity, g.score);
  writeState(root, state);

  return { round, maxRounds, remainingRounds: Math.max(0, maxRounds - round), roundsExhausted: round > maxRounds && g.code !== 'go', regression };
}

// ── eval 加固:检查命令预检(静态分析 + 可执行性提示)──────────────────────
// 实测教训(平台事实):check 裸写 node/python 在坏 PATH 机器上会静默失败;永真式 check 从不失败。
export function preflightChecks(contractText) {
  const warnings = [];
  const { parseContract } = require_core();
  const { acs } = parseContract(contractText);
  for (const ac of acs) {
    const cmd = ac.check.trim();
    const head = cmd.split(/\s+/)[0];
    // 裸解释器/裸命令:非绝对路径、非内建 shell 命令
    const builtins = new Set(['test', 'echo', 'cat', 'grep', 'wc', 'ls', 'sh', 'bash', 'true', 'false', 'find', 'sort', 'head', 'tail', 'cut', 'tr', 'sed', 'awk', 'python3', 'node', 'npm', 'npx']);
    if (!head.startsWith('/') && !head.includes('=') && (head.includes('/') || head.includes('.'))) {
      warnings.push({ id: ac.id, kind: 'relative-interpreter', detail: `\`${head}\` 是相对写法;门控用 /bin/sh 执行,坏 PATH 环境会静默失败——建议绝对路径` });
    }
    if (['node', 'python', 'python3', 'npm', 'npx'].includes(head)) {
      warnings.push({ id: ac.id, kind: 'bare-runtime', detail: `\`${head}\` 裸写运行时;机器上 PATH 的 ${head} 可能损坏(实测 SIGKILL)——用绝对路径` });
    }
    // 永真式启发:check 只含 echo/true 等无判定语义
    if (/^(echo|true|:)\b/.test(cmd) && !/[><|]|test |grep |\[\[/.test(cmd)) {
      warnings.push({ id: ac.id, kind: 'tautology-suspect', detail: 'check 只有输出/恒真命令,疑似永真式——check 必须能真失败' });
    }
  }
  // 交付物覆盖:契约声明了 deliverable: 就必须有 AC 真的碰它(judged 证据也应引用它)
  const contract = parseContractFull(contractText);
  if (contract.deliverable) {
    const base = contract.deliverable.split('/').pop();
    const touched = acs.some((a) => a.check.includes(contract.deliverable) || a.check.includes(base));
    if (!touched) {
      warnings.push({ id: '*', kind: 'deliverable-unverified', detail: `没有任何 check 引用交付物 \`${contract.deliverable}\` —— 交付物本体没被验收(检查只验衍生品/数据,未验本体)` });
    }
  } else if (acs.some((a) => a.expected === 'judged')) {
    warnings.push({ id: '*', kind: 'judged-without-deliverable', detail: '有 judged 评审但契约未声明 `deliverable:` —— 评审证据无法绑定交付物,建议补声明' });
  }
  // 运行时验收面:全静态检查的契约(无解释器/运行时执行)提示补运行时 AC
  const runtimeRe = /\b(node|bun|deno|python3?|npx|npm|osascript|chrome|chromium)\b|\.(mjs|cjs|js|py|sh)\b/;
  if (!acs.some((a) => runtimeRe.test(a.check))) {
    warnings.push({ id: '*', kind: 'no-runtime-ac', detail: '所有 check 都是静态/文件检查,没有 AC 在运行时执行过交付物 —— 至少补一条运行时验收(在真实运行环境里跑它)' });
  }
  return warnings;
}
// 避免循环 import 的小桥(core 是纯函数,直接静态导入即可)
import { parseContract as _parseContract } from './core.js';
function require_core() { return { parseContract: _parseContract }; }
function parseContractFull(text) { return _parseContract(text); }

// ── eval 加固:从未失败过的 AC(疑似永真式/未被真实考验)──────────────────
export function neverFailedAcs(history, acs, minRuns = 2, stamp = undefined) {
  // stamp 过滤:只统计同一契约(盖戳)下的运行记录,防止跨实验/跨契约误报
  const runs = history.filter((h) => h.trigger !== 'task-claim' && (stamp === undefined || h.stamp === stamp));
  if (runs.length < minRuns) return [];
  const everFailed = new Set(runs.flatMap((h) => [...(h.failed ?? []), ...(h.unverifiable ?? [])]));
  return acs.map((a) => a.id).filter((id) => !everFailed.has(id));
}
