// index.js — cordis bundle 入口：注册 goal_gate_check 工具 + tools/pre-execute 双枝拦截器
// API 形状来自真实插件 @nanmicoder/dsh-agent-teams/lib/tools.js:572（defineTool({...}) 单对象签名）
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   1. waterfall 先到先拦：reason 自带 code，用户能分清是谁拦的
//   2. 一律 {kind:'deny'}，绝不 throw（throw 会和 quality-gate 的异常路径混淆）
//   3. 目标：拦 update_goal(action:'complete') 与 update_task(status:'completed')
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runGate, treeDigest, falseCompleteRule } from './core.js';
import fs from 'node:fs';
import path from 'node:path';

export const inject = ['tools', 'commands'];

function ledgerDir() { return path.join(process.cwd(), '.goal-gate'); }
function contractPath() { return path.join(ledgerDir(), 'goal.md'); }
function statePath() { return path.join(ledgerDir(), 'state.json'); }

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return { falseCompletes: 0, digests: {} }; }
}
function writeState(s) {
  fs.mkdirSync(ledgerDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

function deny(code, reason) {
  return { kind: 'deny', reason: `[goal-gate:${code}] ${reason}`, info: { name: 'GoalGate', code, reason } };
}

function runGateNow() {
  const cp = contractPath();
  if (!fs.existsSync(cp)) return { rc: 4, reason: 'no contract at .goal-gate/goal.md', code: 'state-error' };
  return runGate(fs.readFileSync(cp, 'utf8'), { cwd: process.cwd() });
}

// ── 拦截器：双枝，绝不 throw（实测约束 #2）────────────────────────────────
async function intercept(exec, next) {
  const a = exec.arguments ?? {};
  const isGoalComplete = exec.name === 'update_goal' && a.action === 'complete';
  const isTaskComplete = exec.name === 'update_task' && a.status === 'completed';
  if (!isGoalComplete && !isTaskComplete) return next();

  const g = runGateNow();
  const state = readState();
  const key = a.task_id ?? 'goal';

  // R7 等价：verdict 绑定 tree digest —— 摘要变了，之前的 verdict 作废
  // 摘要只扫工作区根，排除账本目录本身（否则写账本→摘要变→误判 verdict 作废）
  const currentDigest = treeDigest(process.cwd(), { exclude: ['.goal-gate', 'node_modules', '.git'] });
  const saved = state.digests?.[key];
  if (saved && saved !== currentDigest) {
    return deny('verdict-stale', `tree digest moved (${saved} → ${currentDigest}); prior verdicts voided, re-verify`);
  }

  if (g.rc === 0) {
    state.digests = { ...state.digests, [key]: currentDigest };
    writeState(state);
    return next(); // 门控通过，交给后面的层（任务板判官等）
  }

  // R1 假完成计数：2 次被抓住 → BLOCKED
  state.falseCompletes = (state.falseCompletes ?? 0) + 1;
  writeState(state);
  if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
    return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。reason: ${g.reason}`);
  }
  return deny(g.code, g.reason);
}

export function apply(ctx, config) {
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
          results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            exitCode: { type: 'number' },
            stdout: { type: 'string' },
          } } },
        },
      },
    },
    async execute() { return runGateNow(); },
  }));

  ctx.inject(['commands'], (c) => {
    c.register({
      name: 'goal-gate',
      description: 'Show goal-gate contract, digest and false-complete count',
      async execute() {
        const s = readState();
        return JSON.stringify({ contract: contractPath(), falseCompletes: s.falseCompletes ?? 0, digests: s.digests }, null, 2);
      },
    });
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      return await intercept(exec, next);
    } catch (e) {
      return deny('internal-error', `goal-gate failed closed: ${e.message}`);
    }
  });
}
