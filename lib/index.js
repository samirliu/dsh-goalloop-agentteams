// index.js — cordis bundle 入口：注册 goal_gate_check 工具 + goal_gate_init 工具 + tools/pre-execute 拦截
// API 形状来自真实插件 @nanmicoder/dsh-agent-teams/lib/tools.js（defineTool({...}) 单对象签名）
// 工作区根目录取 agent.session.header.cwd（与真实插件一致），不是 process.cwd()
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   1. waterfall 先到先拦：reason 自带 code，用户能分清是谁拦的
//   2. 一律 {kind:'deny'}，绝不 throw（throw 会和 quality-gate 的异常路径混淆）
//   3. 目标：拦 update_goal(action:'complete') 与 update_task(status:'completed')
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runGate, treeDigest, falseCompleteRule, contractStamp, CONTRACT_TEMPLATE } from './core.js';
import fs from 'node:fs';
import path from 'node:path';

export const inject = ['tools'];

// 工作区根目录：真实插件用 agent.session.header.cwd ?? process.cwd()
function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
function ledgerDir(root) { return path.join(root, '.goal-gate'); }
function contractPath(root) { return path.join(ledgerDir(root), 'goal.md'); }
function statePath(root) { return path.join(ledgerDir(root), 'state.json'); }

function readState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return { falseCompletes: 0, digests: {} }; }
}
function writeState(root, s) {
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(s, null, 2));
}

function deny(code, reason) {
  return { kind: 'deny', reason: `[goal-gate:${code}] ${reason}`, info: { name: 'GoalGate', code, reason } };
}

function runGateNow(root) {
  const cp = contractPath(root);
  if (!fs.existsSync(cp)) return { rc: 4, reason: 'no contract', code: 'state-error', contract: cp };
  return runGate(fs.readFileSync(cp, 'utf8'), { cwd: root });
}

// ── 拦截器：双枝，绝不 throw ─────────────────────────────────────────────
async function intercept(exec, next) {
  const a = exec.arguments ?? {};
  const isGoalComplete = exec.name === 'update_goal' && a.action === 'complete';
  const isTaskComplete = exec.name === 'update_task' && a.status === 'completed';
  if (!isGoalComplete && !isTaskComplete) return next();

  const root = workspaceRoot(exec);
  const g = runGateNow(root);

  // 没有契约 = 用户根本没启用门控。此时**不拦**，只在 status 里说明，不把 goal 完成堵死。
  // 这是"好用"的关键：装上插件不应该让没配契约的会话完全无法完成目标。
  if (g.code === 'state-error' && g.reason === 'no contract') {
    return next();
  }

  const state = readState(root);
  const key = a.task_id ?? 'goal';

  // R7 等价：verdict 绑定 tree digest —— 摘要变了，之前的 verdict 作废。
  // 注意：摘要变化 ≠ 假完成。它只是"已过审结论失效、需重验"，不计入 R1 假完成计数
  // （只有真的在门控未通过时声称完成才算假完成）。这里作废旧 digest、重新走门控。
  const currentDigest = treeDigest(root);
  const saved = state.digests?.[key];
  const digestMoved = saved !== undefined && saved !== currentDigest;
  if (digestMoved) {
    delete state.digests[key]; // 作废旧 verdict 绑定，下方重新判定
    writeState(root, state);
    const g2 = runGateNow(root); // 用当前树状态重新跑门控
    if (g2.rc === 0) {
      state.digests = { ...state.digests, [key]: currentDigest };
      writeState(root, state);
      return next();
    }
    // 摘要变了且当前门控不过 → 假完成（用户在没重验通过时声称完成）
    state.falseCompletes = (state.falseCompletes ?? 0) + 1;
    writeState(root, state);
    const staleNote = ` (tree digest moved ${saved} → ${currentDigest}, prior verdicts voided)`;
    if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
      return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2${staleNote}; gate blocked. 等人介入。reason: ${g2.reason}`);
    }
    return deny(g2.code, `${g2.reason}${staleNote}`);
  }

  if (g.rc === 0) {
    state.digests = { ...state.digests, [key]: currentDigest };
    writeState(root, state);
    return next(); // 门控通过，交给后面的层（任务板判官等）
  }

  // R1 假完成计数：2 次被抓住 → BLOCKED
  state.falseCompletes = (state.falseCompletes ?? 0) + 1;
  writeState(root, state);
  if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
    return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。reason: ${g.reason}`);
  }
  return deny(g.code, g.reason);
}

export function apply(ctx, config) {
  // 工具：goal_gate_init —— 生成契约骨架（好用：用户不用自己记格式）
  ctx.tools.register(defineTool({
    name: 'goal_gate_init',
    description: 'Create the goal-gate contract skeleton at .goal-gate/goal.md in the workspace. Edit it with your real objective and failable AC checks, then the gate starts enforcing.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      created: { type: 'boolean', required: true }, path: { type: 'string', required: true }, alreadyExisted: { type: 'boolean' },
    } } },
    async execute(_args, exec) {
      const root = workspaceRoot(exec);
      const cp = contractPath(root);
      const existed = fs.existsSync(cp);
      if (!existed) {
        fs.mkdirSync(ledgerDir(root), { recursive: true });
        fs.writeFileSync(cp, CONTRACT_TEMPLATE);
      }
      return { created: !existed, path: cp, alreadyExisted: existed };
    },
  }));

  // 工具：goal_gate_check —— 确定性门控的 JSON 版
  ctx.tools.register(defineTool({
    name: 'goal_gate_check',
    description: 'Run the deterministic goal gate: re-run every AC check itself and return GO/NO-GO/BLOCKED. Zero model trust.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rc: { type: 'number', required: true },
          code: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          stamp: { type: 'string' },
          note: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            exitCode: { type: 'number' },
            stdout: { type: 'string' },
            why: { type: 'string' },
          } } },
        },
      },
    },
    async execute(_args, exec) { return runGateNow(workspaceRoot(exec)); },
  }));

  ctx.inject(['commands'], (c) => {
    c.register({
      name: 'goal-gate',
      description: 'Show goal-gate status: contract path, digest, false-complete count, and the last gate result',
      async execute(_args, exec) {
        const root = workspaceRoot(exec);
        const s = readState(root);
        const g = runGateNow(root);
        return JSON.stringify({
          workspace: root, contract: contractPath(root),
          contractExists: fs.existsSync(contractPath(root)),
          stamp: fs.existsSync(contractPath(root)) ? contractStamp(fs.readFileSync(contractPath(root), 'utf8')) : null,
          falseCompletes: s.falseCompletes ?? 0, digests: s.digests,
          gate: { rc: g.rc, code: g.code, reason: g.reason },
        }, null, 2);
      },
    });
  });

  // 拦截器：tools/pre-execute（update_goal complete / update_task completed）
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      return await intercept(exec, next);
    } catch (e) {
      // 门控自身出错 → fail-closed，但用 deny 不用 throw
      return deny('internal-error', `goal-gate failed closed: ${e.message}`);
    }
  });
}
