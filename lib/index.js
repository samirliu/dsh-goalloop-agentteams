// index.js — cordis bundle 入口：goal_loop_at / goal_gate_init / goal_gate_check 工具
//   + /goal-loop-at /goal-gate 命令 + tools/pre-execute 完成声明拦截
// API 形状来自真实插件 @nanmicoder/dsh-agent-teams/lib/tools.js（defineTool({...}) 单对象签名）
// 工作区根目录取 agent.session.header.cwd（与真实插件一致），不是 process.cwd()
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   1. waterfall 先到先拦：reason 自带 code，用户能分清是谁拦的
//   2. 一律 {kind:'deny'}，绝不 throw（throw 会和 quality-gate 的异常路径混淆）
//   3. 完成声明拦截目标（真实工具名，实测核对过 dsh-agent-teams tool-names.js）：
//      update_goal(action:'complete') / agent_teams_update_task(status:'completed')
//      / team_task_update(action:'complete')；update_task(status:'completed') 为旧名兼容
import { runGate, treeDigest, falseCompleteRule, contractStamp, parseContract, CONTRACT_TEMPLATE } from './core.js';
import {
  DEFAULT_MAX_ROUNDS, ledgerDir, contractPath, statePath, loopPath, historyPath,
  readState, writeState, readLoop, readHistory, recordRun, preflightChecks, neverFailedAcs,
} from './ledger.js';

// ── defineTool 解析链 ─────────────────────────────────────────────────────
// 首选宿主模块路由的裸包名（注册表安装的正常路径）；link: 本地安装在部分宿主里
// 拿不到 @deepseek-ai/* 模块路由（实测：原生解析找不到包、模块图失败、apply 不执行），
// 退回安装目录的物理路径；都不可用时用同形 shim 保底（与测试环境一致）。
let defineTool;
{
  const attempts = ['@deepseek-ai/dsh-tools'];
  const res = typeof process !== 'undefined' ? process.resourcesPath : undefined;
  if (res) attempts.push(res + '/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  for (const spec of attempts) {
    try { ({ defineTool } = await import(spec)); break; } catch { /* 尝试下一个 */ }
  }
  if (!defineTool) defineTool = (s) => s;
}
import fs from 'node:fs';
import path from 'node:path';

// cordis 插件入口契约：name 必须导出，且等于 cordis.patch.yml 的 id ——
// 缺了它 Host 静默不装载（loadsafe 的 shim 测不出，实测踩坑）。
export const name = 'goal-gate';
export const inject = ['tools'];

// 工作区根目录：真实插件用 agent.session.header.cwd ?? process.cwd()
// （exec 与 command invocation 两种形状都吃）
function workspaceRoot(obj) {
  const cwd = obj?.agent?.session?.header?.cwd ?? obj?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
function deny(code, reason) {
  return { kind: 'deny', reason: `[goal-gate:${code}] ${reason}`, info: { name: 'GoalGate', code, reason } };
}

function roundNote(fin) {
  return ` (round ${fin.round}/${fin.maxRounds}${fin.roundsExhausted ? ', rounds exhausted' : ''}${fin.regression ? ', score regressed' : ''})`;
}

// ── 完成声明拦截：真实工具名 + 旧名兼容 ───────────────────────────────────
// 目标级声明（update_goal complete）永远硬门控；任务级声明按契约 exit 策略分级：
//   exit: strict（缺省）→ 全量契约硬拦 + R1 计数（单工作单元：任务完成=目标完成）
//   exit: goal-only     → 步骤进度放行（步骤判定属 quality-kind），只记账
//     （GO→digest 绑定；NO-GO→partialCompletes 记录；BLOCKED 状态全冻结）
// 不分级会死锁多任务循环：成员完成自己的任务时别人的 AC 必然未过 → 误判假完成。
const TASK_TESTS = [
  ['agent_teams_update_task', (a) => a.status === 'completed'],
  ['team_task_update', (a) => a.action === 'complete'],
  ['update_task', (a) => a.status === 'completed'], // 旧名兼容
];
function isGoalClaim(exec, a) { return exec.name === 'update_goal' && a.action === 'complete'; }
function isTaskClaim(exec, a) { return TASK_TESTS.some(([name, test]) => exec.name === name && test(a)); }

// ── 拦截器：双枝，绝不 throw ─────────────────────────────────────────────
async function intercept(exec, next) {
  const a = exec.arguments ?? {};
  const goalClaim = isGoalClaim(exec, a);
  const taskClaim = isTaskClaim(exec, a);
  if (!goalClaim && !taskClaim) return next();

  const root = workspaceRoot(exec);
  const cp = contractPath(root);
  if (!fs.existsSync(cp)) return next(); // 没契约 = 没启用门控，不堵死

  const state = readState(root);
  const contractText = fs.readFileSync(cp, 'utf8');
  const taskPolicy = String(parseContract(contractText).exitPolicy ?? '').trim().toLowerCase() === 'goal-only' ? 'goal-only' : 'strict';
  const baselineSnapshot = { ...(state.baselines ?? {}) };
  const g = runGate(contractText, { cwd: root, baselines: baselineSnapshot });

  // 契约存在但畸形 → 拦（misconfig 要暴露，不能静默放行）
  if (g.code === 'state-error') {
    recordRun(root, state, g, 'intercept');
    return deny('state-error', `${g.reason} @ ${cp}`);
  }

  // R1 BLOCKED 冻结：目标级假完成 ≥ 2 后，任何完成声明都拦，等人介入
  if ((state.falseCompletes ?? 0) >= 2) {
    recordRun(root, state, g, taskClaim ? 'task-claim' : 'intercept');
    return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。reason: ${g.reason}`);
  }

  // 任务级 + goal-only：步骤进度放行（步骤判定属 quality-kind），只记账
  if (taskClaim && taskPolicy === 'goal-only') {
    recordRun(root, state, g, 'task-claim');
    if (g.rc === 0) {
      const key = a.task_id ?? 'task';
      state.digests = { ...state.digests, [key]: treeDigest(root) };
      writeState(root, state);
      return next();
    }
    state.partialCompletes = (state.partialCompletes ?? 0) + 1;
    writeState(root, state);
    return next();
  }

  const key = a.task_id ?? 'goal';

  // R7 等价：verdict 绑定 tree digest —— 摘要变了，之前的 verdict 作废。
  // 摘要变化 ≠ 假完成：只作废旧 verdict、重新判定，门控真不过才计 R1 假完成。
  const currentDigest = treeDigest(root);
  const saved = state.digests?.[key];
  const digestMoved = saved !== undefined && saved !== currentDigest;
  if (digestMoved) {
    delete state.digests[key]; // 作废旧 verdict 绑定
    // 用同一 baseline 快照重判（prev = 本轮开始前的基线，不能被本轮值污染）
    const g2 = runGate(fs.readFileSync(cp, 'utf8'), { cwd: root, baselines: baselineSnapshot });
    const fin = recordRun(root, state, g2, 'intercept-recheck');
    const staleNote = ` (tree digest moved ${saved} → ${currentDigest}, prior verdicts voided)`;
    if (g2.rc === 0) {
      state.digests = { ...state.digests, [key]: currentDigest };
      writeState(root, state);
      return next();
    }
    state.falseCompletes = (state.falseCompletes ?? 0) + 1; // 没重验通过就声称完成 = 假完成
    writeState(root, state);
    if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
      return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2${staleNote}; gate blocked. 等人介入。reason: ${g2.reason}${roundNote(fin)}`);
    }
    return deny(g2.code, `${g2.reason}${staleNote}${roundNote(fin)}`);
  }

  const fin = recordRun(root, state, g, 'intercept');
  if (g.rc === 0) {
    state.digests = { ...state.digests, [key]: currentDigest };
    writeState(root, state);
    return next(); // 门控通过，交给后面的层（任务板判官等）
  }

  // R1 假完成计数：2 次被抓住 → BLOCKED
  state.falseCompletes = (state.falseCompletes ?? 0) + 1;
  writeState(root, state);
  if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
    return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。reason: ${g.reason}${roundNote(fin)}`);
  }
  return deny(g.code, `${g.reason}${roundNote(fin)}`);
}

// ── goal-loop 启动：契约 + 循环配置 + 协议 + 建议任务 ───────────────────────
function startLoop(root, { objective, acs, maxRounds }) {
  const cp = contractPath(root);
  const lp = loopPath(root);
  const obj = String(objective ?? '').trim();
  if (!obj) throw new Error('objective is required');

  let created = false;
  if (!fs.existsSync(cp)) {
    const lines = [`objective: ${obj}`, 'exit: goal-only'];
    if (Array.isArray(acs) && acs.length > 0) {
      acs.forEach((st, i) => lines.push(`AC-${i + 1} | ${String(st).trim()} | check: \`test -f TODO-REPLACE-ME\` | expected: exit=0`));
    } else {
      lines.push('AC-1 | <可失败的判定语句 1> | check: `test -f TODO-REPLACE-ME` | expected: exit=0');
      lines.push('AC-2 | <可失败的判定语句 2> | check: `test -f TODO-REPLACE-ME` | expected: exit=0');
    }
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(cp, `${lines.join('\n')}\n`);
    created = true;
  }

  const prevLoop = readLoop(root) ?? {};
  const loop = {
    objective: obj,
    createdAt: prevLoop.createdAt ?? new Date().toISOString(),
    maxRounds: maxRounds ?? prevLoop.maxRounds ?? DEFAULT_MAX_ROUNDS,
    status: 'active',
  };
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.writeFileSync(lp, JSON.stringify(loop, null, 2));

  const tasks = parseContract(fs.readFileSync(cp, 'utf8')).acs.map((ac) => ({
    id: ac.id, subject: `${ac.id} ${ac.statement}`, verify: ac.check,
  }));

  const protocol = [
    `1. 契约：${cp}${created ? '（已生成骨架，把 TODO-REPLACE-ME 换成真 check 命令）' : '（已存在，未覆盖；如需改目标请手动编辑）'}`,
    '2. 派工：用 agent_teams_create 建队（approval=required），把 tasks 逐条变成质量任务（objective/acceptance/verify 对齐 AC），write_scopes 不相交。',
    '3. 迭代：每完成一批修复就调 goal_gate_check 看 score 与 failedActions——不要急着声明完成。',
    '4. NO-GO：把 failedActions 变成 repair 任务派下去，修完再查；score 不得回退（regression=true 先修回退）。',
    '5. 完成：goal_gate_check 返回 GO 才调 update_goal(complete) 收尾；任务级完成声明（update_task 类）在 exit: goal-only 下随时可交（只记账），单工作单元契约删掉该行则同样硬拦；目标级假完成 2 次 → BLOCKED 等人。',
    `6. 预算：共 ${loop.maxRounds} 轮（roundsExhausted 后停下等人）；每轮记入 .goal-gate/history.jsonl。`,
  ];

  const preflight = preflightChecks(fs.readFileSync(cp, 'utf8'));
  return { created, contractPath: cp, loopPath: lp, objective: obj, maxRounds: loop.maxRounds, tasks, protocol, preflight: preflight.length ? preflight : undefined };
}

export function apply(ctx, config) {
  // 工具：goal_loop_at —— 触发整个循环（/goal-loop-at 的工具形态）
  ctx.tools.register(defineTool({
    name: 'goal_loop_at',
    description: 'Start the goal-loop for an objective: write the contract skeleton and loop config under .goal-gate/, and return the loop protocol plus suggested Agent Teams tasks derived from each AC. The gate then enforces completion; iterate via goal_gate_check.',
    parameters: {
      objective: { type: 'string', required: true, description: 'One-line objective of the goal.' },
      acs: { type: 'array', items: { type: 'string' }, description: 'Optional acceptance statements; each becomes one AC line with a fail-closed placeholder check to fill in.' },
      maxRounds: { type: 'number', description: `Loop round budget (default ${DEFAULT_MAX_ROUNDS}).` },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      created: { type: 'boolean', required: true },
      contractPath: { type: 'string', required: true },
      loopPath: { type: 'string' },
      objective: { type: 'string' },
      maxRounds: { type: 'number' },
      tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, subject: { type: 'string' }, verify: { type: 'string' },
      } } },
      protocol: { type: 'array', items: { type: 'string' } },
    } } },
    async execute(args, exec) {
      return startLoop(workspaceRoot(exec), args ?? {});
    },
  }));

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

  // 工具：goal_gate_check —— 确定性门控 + 度量（score/轮次/趋势/修复清单）
  ctx.tools.register(defineTool({
    name: 'goal_gate_check',
    description: 'Run the deterministic goal gate: re-run every AC check itself and return GO/NO-GO/BLOCKED with score, round, trend and per-AC repair actions. Zero model trust.',
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
          contract: { type: 'string' },
          score: { type: 'number' },
          totals: { type: 'object', additionalProperties: false, properties: {
            passed: { type: 'number' }, failed: { type: 'number' }, unverifiable: { type: 'number' },
          } },
          round: { type: 'number' },
          maxRounds: { type: 'number' },
          remainingRounds: { type: 'number' },
          roundsExhausted: { type: 'boolean' },
          bestScore: { type: 'number' },
          regression: { type: 'boolean' },
          trend: { type: 'array', items: { type: 'number' } },
          failedActions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string' }, statement: { type: 'string' }, check: { type: 'string' }, expected: { type: 'string' },
          } } },
          neverFailed: { type: 'array', items: { type: 'string' } },
          preflight: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string' }, kind: { type: 'string' }, detail: { type: 'string' },
          } } },
          results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            exitCode: { type: 'number' },
            stdout: { type: 'string' },
            why: { type: 'string' },
            value: { type: 'number' },
          } } },
        },
      },
    },
    async execute(_args, exec) {
      const root = workspaceRoot(exec);
      const cp = contractPath(root);
      const state = readState(root);
      if (!fs.existsSync(cp)) {
        return { rc: 4, code: 'state-error', reason: 'no contract', contract: cp };
      }
      const g = runGate(fs.readFileSync(cp, 'utf8'), { cwd: root, baselines: { ...(state.baselines ?? {}) } });
      const { baselineUpdates: _baselineUpdates, ...gOut } = g; // 内部字段，不进输出 schema
      const fin = recordRun(root, state, g, 'check');
      const acs = parseContract(fs.readFileSync(cp, 'utf8')).acs;
      const failedActions = (g.results ?? [])
        .filter((r) => r.status !== 'passed')
        .map((r) => {
          const ac = acs.find((x) => x.id === r.id);
          return ac ? { id: ac.id, statement: ac.statement, check: ac.check, expected: ac.expected } : { id: r.id };
        });
      const trend = readHistory(root).slice(-5).map((h) => h.score).filter((s) => typeof s === 'number');
      const never = neverFailedAcs(readHistory(root), acs);
      const preflight = preflightChecks(fs.readFileSync(cp, 'utf8'));
      const base = {
        ...gOut,
        contract: cp,
        round: fin.round, maxRounds: fin.maxRounds, remainingRounds: fin.remainingRounds,
        roundsExhausted: fin.roundsExhausted, bestScore: state.bestScore ?? undefined,
        regression: fin.regression, trend, failedActions,
        neverFailed: never.length ? never : undefined,
        preflight: preflight.length ? preflight : undefined,
      };
      // R1 BLOCKED：假完成 ≥ 2 的状态下，检查也如实报 BLOCKED（rc=3，等人介入）
      if ((state.falseCompletes ?? 0) >= 2) {
        return { ...base, rc: 3, code: 'blocked', reason: `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。(${g.reason})` };
      }
      return base;
    },
  }));

  ctx.inject(['commands'], (c) => {
    // /goal-gate —— 状态查询（只读，不记轮次）
    c.register({
      name: 'goal-gate',
      description: 'Show goal-gate status: contract path, stamp, digest, false-complete count, round history and score trend',
      input: { hint: '' },
      handler(invocation) {
        const root = workspaceRoot(invocation);
        const s = readState(root);
        const cp = contractPath(root);
        const exists = fs.existsSync(cp);
        const g = exists
          ? runGate(fs.readFileSync(cp, 'utf8'), { cwd: root, baselines: { ...(s.baselines ?? {}) } })
          : null;
        return { kind: 'success', text: JSON.stringify({
          workspace: root, contract: cp, contractExists: exists,
          stamp: exists ? contractStamp(fs.readFileSync(cp, 'utf8')) : null,
          falseCompletes: s.falseCompletes ?? 0, partialCompletes: s.partialCompletes ?? 0, bestScore: s.bestScore ?? null,
          baselines: s.baselines ?? {}, digests: s.digests,
          loop: readLoop(root),
          history: readHistory(root).slice(-5),
          gate: g ? { rc: g.rc, code: g.code, reason: g.reason, score: g.score } : null,
        }, null, 2) };
      },
    });

    // /goal-loop-at <objective> —— 循环触发入口（命令形态；工具形态是 goal_loop_at）
    c.register({
      name: 'goal-loop-at',
      description: 'Start the goal-loop for an objective: write contract + loop config and activate the agentic loop',
      input: { hint: '<objective>' },
      handler(invocation) {
        const objective = String(invocation.rawInput ?? '').trim();
        if (!objective) return { kind: 'error', text: 'Usage: /goal-loop-at <objective>' };
        const res = startLoop(workspaceRoot(invocation), { objective });
        // 把循环协议递交给 agent（best-effort；形状对齐 dsh-agent-teams 的 followup 用法）
        try {
          invocation.agent?.followup?.({
            content: [{ type: 'text', text: `goal-loop activated for objective: ${objective}\n\n${res.protocol.join('\n')}` }],
            source: { kind: 'user' },
          });
        } catch { /* followup 不可用时命令返回值里已带协议 */ }
        return { kind: 'success', text: `goal-loop started (rounds=${res.maxRounds})\n${res.protocol.join('\n')}` };
      },
    });
  });

  // 拦截器：tools/pre-execute（完成声明）
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      return await intercept(exec, next);
    } catch (e) {
      // 门控自身出错 → fail-closed，但用 deny 不用 throw
      return deny('internal-error', `goal-gate failed closed: ${e.message}`);
    }
  });
}
