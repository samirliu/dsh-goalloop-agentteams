// index.js — cordis bundle 入口：gaol-loop 的判定面 + 闭环面 + skill 面
//   工具：goal_loop_at / goal_gate_init / goal_gate_stamp / goal_gate_check /
//         goal_gate_status / goal_gate_audit / goal_gate_dispatch
//   命令：/goal-loop-at /goal-gate /goal-stamp /goal-audit
//   skill：goal-loop / goal-loop-contract（运行时注册，模型目录可见）
//   拦截：tools/pre-execute 盯完成声明（一律 {kind:'deny'}，绝不 throw）
// 工作区根目录取 agent.session.header.cwd（与原生插件一致），不是 process.cwd()
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   1. waterfall 先到先拦：reason 自带 code，用户能分清是谁拦的
//   2. 一律 {kind:'deny'}，绝不 throw（throw 会和 quality-gate 的异常路径混淆）
//   3. 完成声明拦截目标：update_goal(action:'complete')
//      / agent_teams_update_task(status:'completed') / team_task_update(action:'complete')
//      / update_task(status:'completed') 旧名兼容
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runGate, treeDigest, falseCompleteRule, contractStamp, parseContract, jsonSafe, CONTRACT_TEMPLATE } from './core.js';
import {
  DEFAULT_MAX_ROUNDS, ledgerDir, contractPath, loopPath,
  readState, writeState, readLoop, readHistory, recordRun, preflightChecks, neverFailedAcs,
  loopIdleStatus, idleWarning, duplicateEvalNote, applyStamp, timeBudgetStatus, efficiencyOf,
  statusReport, auditReport,
} from './ledger.js';

// ── defineTool 解析链 ─────────────────────────────────────────────────────
// 首选宿主模块路由的裸包名（注册表安装的正常路径）；link: 本地安装在部分宿主里
// 拿不到 @deepseek-ai/* 模块路由（实测：原生解析找不到包、模块图失败、apply 不执行），
// 退回安装目录的物理路径；都不可用时用同形 shim 保底（与测试环境一致）。
let defineTool;
{
  const attempts = ['@deepseek-ai/dsh-tools'];
  const res = typeof process !== 'undefined' ? process.resourcesPath : undefined;
  if (res) {
    attempts.push(res + '/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
    attempts.push(res + '/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  }
  for (const spec of attempts) {
    try { ({ defineTool } = await import(spec)); break; } catch { /* 尝试下一个 */ }
  }
  if (!defineTool) defineTool = (s) => s;
}

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

// DSH 0.2.1-rc.2: defineTool 必然安装 output.render 包装器,成功返回时调用它。
// 只声明 schema 不声明 render => 注册能过,每次成功调用都 INVALID_TOOL_OUTPUT。
// 这是实测契约(见 docs/platform-contract.md),所有工具统一走这个 renderer。
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

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
  ['task_board_manage', (a) => a.action === 'move-done'], // 任务板手工宣告完成
];
function isGoalClaim(exec, a) { return exec.name === 'update_goal' && a.action === 'complete'; }
function isTaskClaim(exec, a) { return TASK_TESTS.some(([name, test]) => exec.name === name && test(a)); }

function failedActionsOf(g, acs) {
  return (g.results ?? [])
    .filter((r) => r.status !== 'passed')
    .map((r) => {
      const ac = acs.find((x) => x.id === r.id);
      return ac
        ? { id: ac.id, statement: ac.statement, check: ac.check, expected: ac.expected, why: r.why }
        : { id: r.id };
    });
}

// 预算/时间耗尽时把"为什么停"说清楚：green delivery 不被没收，red 必须停。
function budgetDenial(fin, time) {
  if (fin.roundsExhausted) return { code: 'rounds-exhausted', reason: `轮次预算已用尽(${fin.round}/${fin.maxRounds})——除非门控 GO,否则停下等人` };
  if (time?.exhausted) return { code: 'time-budget', reason: `墙钟预算已用尽(${time.elapsedMinutes}/${time.budgetMinutes} 分钟)——除非门控 GO,否则停下等人` };
  return null;
}

// ── 拦截器：双枝，绝不 throw ─────────────────────────────────────────────
async function intercept(exec, next, config) {
  const a = exec.arguments ?? {};
  const goalClaim = isGoalClaim(exec, a);
  const taskClaim = isTaskClaim(exec, a);
  if (!goalClaim && !taskClaim) return next();

  const root = workspaceRoot(exec);
  const cp = contractPath(root);
  if (!fs.existsSync(cp)) return next(); // 没契约 = 没启用门控，不堵死

  const state = readState(root);
  const contractText = fs.readFileSync(cp, 'utf8');
  const parsed = parseContract(contractText);
  const taskPolicy = String(parsed.exitPolicy ?? '').trim().toLowerCase() === 'goal-only' ? 'goal-only' : 'strict';
  const currentStamp = contractStamp(contractText);

  // R3 批准已失效：契约在盖章后被改过 = 用户批准的不是现在这份 done 定义。
  // 不改门控语义、不烧轮次：直接要求重新盖章（先确认新契约，再 /goal-stamp）。
  if (state.approval && state.approval.stamp !== currentStamp) {
    return deny('contract-revised',
      `契约在上次批准(${state.approval.stamp})后被修改,当前 stamp=${currentStamp}。` +
      '确认新契约后 /goal-stamp(或 goal_gate_stamp restamp:true)重新批准,再声明完成。');
  }
  // 可选严模式：没盖过章不许声明完成（默认关闭——装上插件不堵死未盖章的会话）。
  if (config.requireStamp === true && !state.approval) {
    return deny('unstamped', '契约尚未经用户批准:先展示契约摘要并 /goal-stamp,再声明完成。');
  }

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
      state.digests = { ...(state.digests ?? {}), [key]: treeDigest(root) };
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
      state.digests = { ...(state.digests ?? {}), [key]: currentDigest };
      writeState(root, state);
      return next();
    }
    state.falseCompletes = (state.falseCompletes ?? 0) + 1; // 没重验通过就声称完成 = 假完成
    writeState(root, state);
    if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
      return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2${staleNote}; gate blocked. 等人介入。reason: ${g2.reason}${roundNote(fin)}`);
    }
    const budget = budgetDenial(fin, timeBudgetStatus(state, readLoop(root)));
    return deny(budget?.code ?? g2.code, `${g2.reason}${staleNote}${roundNote(fin)}${budget ? ` — ${budget.reason}` : ''}`);
  }

  const time = timeBudgetStatus(state, readLoop(root));
  const fin = recordRun(root, state, g, 'intercept');
  if (g.rc === 0) {
    state.digests = { ...(state.digests ?? {}), [key]: currentDigest };
    writeState(root, state);
    return next(); // 门控通过，交给后面的层（任务板判官等）
  }

  // R1 假完成计数：2 次被抓住 → BLOCKED
  state.falseCompletes = (state.falseCompletes ?? 0) + 1;
  writeState(root, state);
  if (falseCompleteRule(state.falseCompletes) === 'BLOCKED') {
    return deny('blocked', `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。reason: ${g.reason}${roundNote(fin)}`);
  }
  const budget = budgetDenial(fin, time);
  return deny(budget?.code ?? g.code, `${g.reason}${roundNote(fin)}${budget ? ` — ${budget.reason}` : ''}`);
}

// ── goal-loop 启动：契约 + 循环配置 + 协议 + 建议任务 ───────────────────────
// dispatch 由工具层处理（需要 exec.agent 才能创建 native Agent Teams 任务）：
// 这里只返回 tasks（id/subject/verify），协议里点名两种派工面。
function startLoop(root, { objective, acs, maxRounds }, config = {}) {
  const cp = contractPath(root);
  const lp = loopPath(root);
  const obj = String(objective ?? '').trim();
  if (!obj) throw new Error('objective is required');

  let created = false;
  if (fs.existsSync(cp)) {
    const existingObjective = parseContract(fs.readFileSync(cp, 'utf8')).objective;
    if (existingObjective && obj && existingObjective !== obj) {
      throw new Error(`[goal-gate:objective-drift] 已有契约的目标是「${existingObjective}」,与本次「${obj}」不一致。改目标 = 改 done 的定义:先确认后编辑 .goal-gate/goal.md 并重新 /goal-stamp;或删掉 .goal-gate/goal.md 再开新循环。`);
    }
  }
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
    // 同一契约继续同一实验(rounds/history 连续);新契约才换 loop 时钟。
    createdAt: created ? new Date().toISOString() : (prevLoop.createdAt ?? new Date().toISOString()),
    maxRounds: maxRounds ?? prevLoop.maxRounds ?? config.maxRounds ?? DEFAULT_MAX_ROUNDS,
    status: 'active',
  };
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.writeFileSync(lp, JSON.stringify(loop, null, 2));

  const parsed = parseContract(fs.readFileSync(cp, 'utf8'));
  const tasks = parsed.acs.map((ac) => ({
    id: ac.id, subject: `${ac.id} ${ac.statement}`, verify: ac.check,
  }));

  const protocol = [
    `1. 契约：${cp}${created ? '（已生成骨架，把 TODO-REPLACE-ME 换成真 check 命令）' : '（已存在，未覆盖；改目标请手动编辑，改完必须重新盖章）'}。每条 AC 都要能真的失败；先过 goal-loop-contract skill 的盖章清单。`,
    '2. 批准：把一屏契约摘要（目标 + exit 策略 + 交付物 + AC 表 + 预算 + 基线）给用户，得到明确批准后 /goal-stamp（或 goal_gate_stamp）冻结 done 的定义；契约以后每改一次都要重新批准。',
    '3. 派工：有 native Agent Teams 就用 spawn_teammate/team_task_create（或 goal_loop_at dispatch:true 一键建任务），没有就用 task_board_create 建卡，单干也行。write scope 不相交；接口先冻结。',
    '4. 迭代：每轮修复后调 goal_gate_check 看 score/failedActions/efficiency——不要急着声明完成。只想复查结论请走只读入口（goal_gate_status / /goal-gate / bin/gate.mjs status）：goal_gate_check 每次都是实验，同结论重评同样计一轮。',
    '5. NO-GO：把 failedActions 变成 repair 任务派下去（goal_gate_dispatch 可一键创建），修完再查；score 不得回退（regression=true 先修回退）；声明完成前先跑 goal_gate_audit。',
    '6. 完成：goal_gate_audit ok 且 goal_gate_check 返回 GO 才调 update_goal(complete) 收尾；任务级完成声明（update_task 类）在 exit: goal-only 下随时可交（只记账），单工作单元契约删掉该行则同样硬拦；目标级假完成 2 次 → BLOCKED 等人。',
    `7. 预算：共 ${loop.maxRounds} 轮（roundsExhausted 后停下等人；预算可在盖章时用 maxRounds/timeBudgetMinutes 绑定）；每轮记入 .goal-gate/history.jsonl。契约解析失败（state-error）不算实验、不烧轮；超过 ${loop.idleWarnHours ?? 4} 小时没有评估会被标记 loop-idle——长期离开请把 loop.json 的 "status" 改成 "suspended"。`,
  ];

  const preflight = preflightChecks(fs.readFileSync(cp, 'utf8'), root);
  return jsonSafe({ created, contractPath: cp, loopPath: lp, objective: obj, maxRounds: loop.maxRounds, tasks, protocol, preflight: preflight.length ? preflight : undefined });
}

// ── native Agent Teams 派工（可选服务；不 mounted 时给建议清单）───────────
// ctx.get('agentTeams') 是 experimental agent-team 的服务；tryMembership 对非
// Team 成员返回 undefined（不抛错）。只有 Lead 能建任务——不在 team 里就退回
// suggestions，让模型改用 task_board_create / 单干。
async function dispatchItems(ctx, exec, items, kind) {
  const suggestions = items.map((x) => ({ id: x.id, subject: x.subject, description: x.description }));
  const svc = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined;
  if (!svc?.tryMembership || !svc?.createTask) {
    return { kind, dispatched: [], failed: [], reason: 'Agent Teams service is not mounted in this deployment; create these with task_board_create or work solo', suggestions };
  }
  let membership;
  try { membership = svc.tryMembership(exec.agent); } catch { membership = undefined; }
  if (!membership || membership.role !== 'lead') {
    return { kind, dispatched: [], failed: [], reason: 'caller is not an Agent Teams Lead; returning suggestions instead', suggestions };
  }
  const dispatched = [];
  const failed = [];
  for (const item of items) {
    try {
      const view = await svc.createTask(exec.agent, { subject: item.subject, description: item.description });
      dispatched.push({ id: item.id, taskId: String(view.id), subject: item.subject });
    } catch (e) {
      failed.push({ id: item.id, error: e?.message ?? String(e) });
    }
  }
  return { kind, dispatched, failed, ...(suggestions.length && !dispatched.length && failed.length ? { suggestions } : {}) };
}
function taskDescription(ac, extra) {
  return [
    `${ac.id} | ${ac.statement}`,
    `check: \`${ac.check}\``,
    `expected: ${ac.expected}`,
    extra,
    '验收: 运行上面的 check 并让它按 expected 通过;不要只声明完成——目标级完成由 goal_gate_check 裁决。',
  ].filter(Boolean).join('\n');
}

// ── 运行时 skill 注册（模型可见的 goal-loop playbook）──────────────────────
// 从包内 skills/<dir>/SKILL.md 读正文；frontmatter 只用于校验 name/description。
// 注册失败不拖垮插件（Host 缺 skills 服务时只是没有 skill 目录）。
function parseSkillFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2];
    let blockKey = null;
    for (const line of m[1].split('\n')) {
      const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (km) {
        blockKey = null;
        let val = km[2].trim();
        if (/^[>|][+-]?$/.test(val)) { meta[km[1]] = ''; blockKey = km[1]; continue; }
        meta[km[1]] = val.replace(/^['"]|['"]$/g, '');
        continue;
      }
      if (blockKey && /^\s+\S/.test(line)) {
        meta[blockKey] = `${meta[blockKey] ? `${meta[blockKey]} ` : ''}${line.trim()}`;
      }
    }
  }
  return { meta, body: body.trim() };
}
const SKILL_SPECS = [
  { dir: 'goal-loop', name: 'goal-loop' },
  { dir: 'goal-loop-contract', name: 'goal-loop-contract' },
];
function registerSkills(ctx, injectedService) {
  const skills = injectedService
    ?? (typeof ctx.get === 'function' ? ctx.get('skills') : ctx.skills);
  if (!skills?.register) return false;
  for (const spec of SKILL_SPECS) {
    try {
      const file = fileURLToPath(new URL(`../skills/${spec.dir}/SKILL.md`, import.meta.url));
      const { meta, body } = parseSkillFile(file);
      const name = meta.name ?? spec.name;
      if (name !== spec.name) throw new Error(`skill name mismatch: frontmatter "${name}" != "${spec.name}"`);
      if (!meta.description) throw new Error('skill frontmatter requires a description');
      skills.register({
        name,
        description: meta.description,
        ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
        content: body,
        source: 'runtime',
        path: file,
      });
    } catch (e) {
      ctx.logger?.warn?.(`goal-gate: skill registration skipped (${spec.dir}): ${e?.message ?? e}`);
    }
  }
  return true;
}

// ── 工具 schema 片段 ─────────────────────────────────────────────────────
const AC_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    why: { type: 'string' },
    stderr: { type: 'string' },
    value: { type: 'number' },
    spread: { type: 'number' },
  },
};
const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' }, kind: { type: 'string' }, detail: { type: 'string' },
  },
};
const FAILED_ACTION_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' }, statement: { type: 'string' }, check: { type: 'string' },
    expected: { type: 'string' }, why: { type: 'string' },
  },
};
const EFFICIENCY_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    score: { type: 'number' }, prevScore: { type: 'number' }, scoreDelta: { type: 'number' },
    slope: { type: 'number' }, window: { type: 'number' }, strategy: { type: 'string' },
    strategies: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      strategy: { type: 'string' }, runs: { type: 'number' }, lastScore: { type: 'number' },
      bestScore: { type: 'number' }, avgDelta: { type: 'number' },
    } } },
  },
};
// 兼容两种注册路径:（a) 真实 defineTool 的 value-schema DSL;(b) identity shim
// 直接交给工具注册表做 assertSupportedJsonSchema。两者都接受的只有标准子集,
// 所以不能用 author-only 的 type:'json',用 oneOf/null 或开放 object 表达。
const ANY_OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const NULLABLE_OBJECT_SCHEMA = { oneOf: [ANY_OBJECT_SCHEMA, { type: 'null' }] };

const DISPATCH_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string' },
    dispatched: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, taskId: { type: 'string' }, subject: { type: 'string' },
    } } },
    failed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, error: { type: 'string' },
    } } },
    reason: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, subject: { type: 'string' }, description: { type: 'string' },
    } } },
  },
};

export function apply(ctx, config) {
  const cfg = config ?? {};

  // 工具：goal_loop_at —— 触发整个循环（/goal-loop-at 的工具形态）
  ctx.tools.register(defineTool({
    name: 'goal_loop_at',
    description: 'Start the goal-loop for an objective: write the contract skeleton and loop config under .goal-gate/, and return the loop protocol plus suggested Agent Teams tasks derived from each AC. Set dispatch:true to create those tasks in the current native Agent Teams. The gate then enforces completion; iterate via goal_gate_check.',
    parameters: {
      objective: { type: 'string', required: true, description: 'One-line objective of the goal.' },
      acs: { type: 'array', items: { type: 'string' }, description: 'Optional acceptance statements; each becomes one AC line with a fail-closed placeholder check to fill in.' },
      maxRounds: { type: 'number', description: `Loop round budget (default ${cfg.maxRounds ?? DEFAULT_MAX_ROUNDS}).` },
      dispatch: { type: 'boolean', description: 'Create one native Agent Teams task per AC when the caller is a Team Lead (default false).' },
    },
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      created: { type: 'boolean' },
      contractPath: { type: 'string' },
      loopPath: { type: 'string' },
      objective: { type: 'string' },
      maxRounds: { type: 'number' },
      tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, subject: { type: 'string' }, verify: { type: 'string' },
      } } },
      protocol: { type: 'array', items: { type: 'string' } },
      preflight: { type: 'array', items: PREFLIGHT_SCHEMA },
      dispatch: DISPATCH_SCHEMA,
    } } },
    async execute(args, exec) {
      const root = workspaceRoot(exec);
      const res = startLoop(root, args ?? {}, cfg);
      if (args?.dispatch === true) {
        const parsed = parseContract(fs.readFileSync(res.contractPath, 'utf8'));
        const items = parsed.acs.map((ac) => ({
          id: ac.id,
          subject: `${ac.id} ${ac.statement}`,
          description: taskDescription(ac, '这是 loop 启动时的全量分派；失败修复请用 goal_gate_dispatch。'),
        }));
        const dispatch = await dispatchItems(ctx, exec, items, 'agent-teams');
        return jsonSafe({ ...res, dispatch });
      }
      return res;
    },
  }));

  // 工具：goal_gate_init —— 生成契约骨架（好用：用户不用自己记格式）
  ctx.tools.register(defineTool({
    name: 'goal_gate_init',
    description: 'Create the goal-gate contract skeleton at .goal-gate/goal.md in the workspace. Edit it with your real objective and failable AC checks, then get the user to stamp it (goal_gate_stamp or /goal-stamp) before the gate enforces completion.',
    parameters: {},
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      created: { type: 'boolean' }, path: { type: 'string' }, alreadyExisted: { type: 'boolean' },
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

  // 工具：goal_gate_stamp —— 用户批准 done 的定义（R3）；契约改动会自动作废批准
  ctx.tools.register(defineTool({
    name: 'goal_gate_stamp',
    description: 'Freeze the approved goal contract (R3): record a stamp over the current ACs plus optional round/time budgets. Any later contract edit invalidates this approval; completion claims are denied with [goal-gate:contract-revised] until the contract is re-approved with restamp:true. Use only after the user has explicitly approved the contract summary.',
    parameters: {
      approvedBy: { type: 'string', description: 'Who approved the contract (default: user).' },
      maxRounds: { type: 'number', description: 'Bind the loop round budget at approval time.' },
      timeBudgetMinutes: { type: 'number', description: 'Bind a wall-clock budget at approval time (minutes).' },
      restamp: { type: 'boolean', description: 'Approve a contract that changed after the previous stamp (must be an explicit human decision).' },
      note: { type: 'string', description: 'Optional one-line approval note.' },
    },
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      stamped: { type: 'boolean' },
      code: { type: 'string' },
      stamp: { type: 'string' },
      approvedBy: { type: 'string' },
      approvedAt: { type: 'string' },
      maxRounds: { type: 'number' },
      timeBudgetMinutes: { type: 'number' },
      restamped: { type: 'boolean' },
    } } },
    async execute(args, exec) {
      const root = workspaceRoot(exec);
      const cp = contractPath(root);
      if (!fs.existsSync(cp)) throw new Error(`[goal-gate:no-contract] 没有契约: ${cp}（先 goal_loop_at / goal_gate_init）`);
      const res = applyStamp(root, fs.readFileSync(cp, 'utf8'), args ?? {});
      if (!res.ok) throw new Error(`[goal-gate:${res.code}] ${res.detail}`);
      return jsonSafe({
        stamped: true, code: res.code, stamp: res.stamp,
        approvedBy: res.approvedBy, approvedAt: res.approvedAt,
        ...(res.maxRounds !== undefined ? { maxRounds: res.maxRounds } : {}),
        ...(res.timeBudgetMinutes !== undefined ? { timeBudgetMinutes: res.timeBudgetMinutes } : {}),
        restamped: res.restamped === true,
      });
    },
  }));

  // 工具：goal_gate_check —— 确定性门控 + 度量（score/轮次/趋势/效率/修复清单）
  ctx.tools.register(defineTool({
    name: 'goal_gate_check',
    description: 'Run the deterministic goal gate: re-run every AC check itself and return GO/NO-GO/BLOCKED with score, round, trend, efficiency, time budget and per-AC repair actions. Zero model trust. This is an experiment and consumes one round; use goal_gate_status for a read-only look.',
    parameters: {
      strategy: { type: 'string', description: 'Optional one-line attack direction label for this round (recorded for efficiency attribution).' },
      note: { type: 'string', description: 'Optional controller note recorded in history.jsonl.' },
    },
    output: {
      render: renderJson,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rc: { type: 'number' },
          code: { type: 'string' },
          reason: { type: 'string' },
          ms: { type: 'number' },
          stamp: { type: 'string' },
          note: { type: 'string' },
          idleHours: { type: 'number' },
          contract: { type: 'string' },
          score: { type: 'number' },
          totals: { type: 'object', additionalProperties: false, properties: {
            passed: { type: 'number' }, failed: { type: 'number' }, broken: { type: 'number' }, unverifiable: { type: 'number' },
          } },
          digestBefore: { type: 'string' },
          digestAfter: { type: 'string' },
          treeMoved: { type: 'boolean' },
          round: { type: 'number' },
          maxRounds: { type: 'number' },
          remainingRounds: { type: 'number' },
          roundsExhausted: { type: 'boolean' },
          bestScore: { type: 'number' },
          regression: { type: 'boolean' },
          trend: { type: 'array', items: { type: 'number' } },
          failedActions: { type: 'array', items: FAILED_ACTION_SCHEMA },
          neverFailed: { type: 'array', items: { type: 'string' } },
          preflight: { type: 'array', items: PREFLIGHT_SCHEMA },
          results: { type: 'array', items: AC_RESULT_SCHEMA },
          timeBudgetMinutes: { type: 'number' },
          timeRemainingMinutes: { type: 'number' },
          timeExhausted: { type: 'boolean' },
          efficiency: EFFICIENCY_SCHEMA,
        },
      },
    },
    async execute(args, exec) {
      const root = workspaceRoot(exec);
      const cp = contractPath(root);
      const state = readState(root);
      if (!fs.existsSync(cp)) {
        return { rc: 4, code: 'state-error', reason: 'no contract', contract: cp };
      }
      const strategy = typeof args?.strategy === 'string' ? args.strategy : undefined;
      const note = typeof args?.note === 'string' ? args.note : undefined;
      const historyBefore = readHistory(root); // 重评检测/效率归因用(recordRun 追加前的历史)
      const contractText = fs.readFileSync(cp, 'utf8');
      const g = runGate(contractText, { cwd: root, baselines: { ...(state.baselines ?? {}) } });
      const { baselineUpdates: _baselineUpdates, ...gOut } = g; // 内部字段，不进输出 schema
      const loopBefore = readLoop(root);
      const fin = recordRun(root, state, g, 'check', { strategy, note });
      const acs = parseContract(fs.readFileSync(cp, 'utf8')).acs;
      const failedActions = failedActionsOf(g, acs);
      const trend = readHistory(root).filter((h) => (h.loopKey ?? 'default') === (readLoop(root)?.createdAt ?? 'default')).slice(-5).map((h) => h.score).filter((s) => typeof s === 'number' && Number.isFinite(s));
      const never = neverFailedAcs(readHistory(root), acs, 2, g.stamp);
      const preflight = preflightChecks(contractText, root);
      const loopNow = readLoop(root);
      const idleWarn = idleWarning(state, loopNow);
      if (idleWarn) preflight.push(idleWarn);
      const idle = loopIdleStatus(state, loopNow);
      const time = timeBudgetStatus(state, loopNow);
      const dup = duplicateEvalNote(historyBefore, loopBefore, g); // 缺陷 #16:同结论重评点名"只看不修也烧轮"
      const efficiency = efficiencyOf(historyBefore, loopNow?.createdAt ?? 'default', g, strategy);
      const base = {
        ...gOut,
        contract: cp,
        ...(dup ? { note: gOut.note ? `${gOut.note}; ${dup}` : dup } : {}),
        round: fin.round, maxRounds: fin.maxRounds, remainingRounds: fin.remainingRounds,
        roundsExhausted: fin.roundsExhausted, bestScore: state.bestScore ?? undefined,
        regression: fin.regression, trend, failedActions,
        idleHours: idle ? idle.idleHours : undefined,
        neverFailed: never.length ? never : undefined,
        preflight: preflight.length ? preflight : undefined,
        ...(time ? {
          timeBudgetMinutes: time.budgetMinutes,
          timeRemainingMinutes: time.remainingMinutes,
          timeExhausted: time.exhausted,
        } : {}),
        ...(efficiency ? { efficiency } : {}),
      };
      // R1 BLOCKED：假完成 ≥ 2 的状态下，检查也如实报 BLOCKED（rc=3，等人介入）
      if ((state.falseCompletes ?? 0) >= 2) {
        return jsonSafe({ ...base, rc: 3, code: 'blocked', reason: `false-completes=${state.falseCompletes} ≥ 2; gate blocked. 等人介入。(${g.reason})` });
      }
      return jsonSafe(base);
    },
  }));

  // 工具：goal_gate_status —— 只读状态（不跑 check、不烧轮）
  ctx.tools.register(defineTool({
    name: 'goal_gate_status',
    description: 'Read-only goal-gate status: contract path/stamp/approval, loop, round budget, time budget, false-complete counters, digest binding and recent history. Runs no checks and consumes no round; use goal_gate_check when you need current evidence.',
    parameters: {
      includeHistory: { type: 'boolean', description: 'Include the last five history rows (default true).' },
    },
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      workspace: { type: 'string' },
      contractPath: { type: 'string' },
      contractExists: { type: 'boolean' },
      objective: { type: 'string' },
      deliverable: { type: 'string' },
      exitPolicy: { type: 'string' },
      acs: { type: 'number' },
      unparsedAcs: { type: 'number' },
      stamp: { type: 'string' },
      approval: NULLABLE_OBJECT_SCHEMA,
      approvalStale: { type: 'boolean' },
      falseCompletes: { type: 'number' },
      partialCompletes: { type: 'number' },
      blocked: { type: 'boolean' },
      bestScore: { type: 'number' },
      baselines: ANY_OBJECT_SCHEMA,
      loop: NULLABLE_OBJECT_SCHEMA,
      roundsUsed: { type: 'number' },
      roundsRemaining: { type: 'number' },
      roundsExhausted: { type: 'boolean' },
      lastRunAt: { type: 'string' },
      idle: NULLABLE_OBJECT_SCHEMA,
      timeBudget: NULLABLE_OBJECT_SCHEMA,
      digest: { type: 'string' },
      digestBound: { type: 'string' },
      digestStale: { type: 'boolean' },
      lastCheck: NULLABLE_OBJECT_SCHEMA,
      history: { type: 'array', items: ANY_OBJECT_SCHEMA },
    } } },
    async execute(args, exec) {
      const report = statusReport(workspaceRoot(exec));
      if (args?.includeHistory === false) delete report.history;
      return jsonSafe(report);
    },
  }));

  // 工具：goal_gate_audit —— 声明前审计（只读账本一致性，不重跑 check）
  ctx.tools.register(defineTool({
    name: 'goal_gate_audit',
    description: 'Read-only pre-claim audit: checks the contract is parseable, the approval stamp matches, the last evaluation is GO at the current contract, the tree digest has not moved, and the ledger has no contradictions. Run this before update_goal(complete). It does not re-run checks or consume a round.',
    parameters: {},
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean' },
      violations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        code: { type: 'string' }, detail: { type: 'string' },
      } } },
      warnings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        code: { type: 'string' }, detail: { type: 'string' },
      } } },
      stamp: { type: 'string' },
      digest: { type: 'string' },
      lastCheck: NULLABLE_OBJECT_SCHEMA,
      roundsUsed: { type: 'number' },
      maxRounds: { type: 'number' },
      timeBudget: NULLABLE_OBJECT_SCHEMA,
      recommendations: { type: 'array', items: { type: 'string' } },
    } } },
    async execute(_args, exec) {
      return jsonSafe(auditReport(workspaceRoot(exec)));
    },
  }));

  // 工具：goal_gate_dispatch —— 把失败 AC 变成 native Agent Teams 修复任务
  ctx.tools.register(defineTool({
    name: 'goal_gate_dispatch',
    description: 'Turn the current failing/unverifiable ACs into native Agent Teams tasks (when the caller is a Team Lead). Read-only with respect to the gate ledger: it re-runs checks to know what is failing, but does not record a round. Without the Agent Teams service it returns task suggestions instead.',
    parameters: {
      includeUnverifiable: { type: 'boolean', description: 'Also dispatch unverifiable ACs (default true).' },
    },
    output: { render: renderJson, schema: { type: 'object', additionalProperties: false, properties: {
      gate: { type: 'object', additionalProperties: false, properties: {
        rc: { type: 'number' }, code: { type: 'string' }, score: { type: 'number' },
      } },
      ...DISPATCH_SCHEMA.properties,
    } } },
    async execute(args, exec) {
      const root = workspaceRoot(exec);
      const cp = contractPath(root);
      if (!fs.existsSync(cp)) throw new Error(`[goal-gate:no-contract] 没有契约: ${cp}`);
      const text = fs.readFileSync(cp, 'utf8');
      const parsed = parseContract(text);
      const state = readState(root);
      const g = runGate(text, { cwd: root, baselines: { ...(state.baselines ?? {}) } });
      if (g.code === 'state-error') throw new Error(`[goal-gate:state-error] ${g.reason}`);
      const includeUnverifiable = args?.includeUnverifiable !== false;
      const items = (g.results ?? [])
        .filter((r) => r.status === 'failed' || r.status === 'broken' || (includeUnverifiable && r.status === 'unverifiable'))
        .map((r) => {
          const ac = parsed.acs.find((x) => x.id === r.id);
          const statement = ac?.statement ?? r.id;
          return {
            id: r.id,
            subject: `Repair ${r.id}: ${String(statement).slice(0, 80)}`,
            description: taskDescription(ac ?? { id: r.id, statement, check: '(missing)', expected: 'exit=0' },
              `当前门控结论: ${r.status}${r.why ? ` — ${r.why}` : ''}`),
          };
        });
      const dispatch = items.length
        ? await dispatchItems(ctx, exec, items, 'agent-teams-repair')
        : { kind: 'agent-teams-repair', dispatched: [], failed: [], reason: 'no failing or unverifiable ACs to dispatch' };
      return jsonSafe({ gate: { rc: g.rc, code: g.code, score: g.score }, ...dispatch });
    },
  }));

  ctx.inject(['commands'], (c) => {
    const commands = c.commands;
    // /goal-gate —— 状态查询（只读，不记轮次）
    commands.register({
      name: 'goal-gate',
      description: 'Show goal-gate status: contract path, stamp/approval, digest, false-complete count, round history and score trend (read-only, consumes no round)',
      handler(invocation) {
        return { kind: 'success', text: JSON.stringify(statusReport(workspaceRoot(invocation)), null, 2) };
      },
    });

    // /goal-loop-at <objective> —— 循环触发入口（命令形态；工具形态是 goal_loop_at）
    commands.register({
      name: 'goal-loop-at',
      description: 'Start the goal-loop for an objective: write contract + loop config and activate the agentic loop',
      input: { hint: '<objective>' },
      handler(invocation) {
        const objective = String(invocation.rawInput ?? '').trim();
        if (!objective) return { kind: 'error', text: 'Usage: /goal-loop-at <objective>' };
        const res = startLoop(workspaceRoot(invocation), { objective }, cfg);
        // 把循环协议递交给 agent（UserMessage: id/role/content/source 齐全）
        try {
          invocation.agent?.followup?.({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: `goal-loop activated for objective: ${objective}\n\n${res.protocol.join('\n')}` }],
            source: { kind: 'user' },
          });
        } catch { /* followup 不可用时命令返回值里已带协议 */ }
        return { kind: 'success', text: `goal-loop started (rounds=${res.maxRounds})\n${res.protocol.join('\n')}` };
      },
    });

    // /goal-stamp [approvedBy] —— 人类批准契约并冻结（R3）
    commands.register({
      name: 'goal-stamp',
      description: 'Approve and freeze the current goal contract (R3). Re-run after editing the contract; completion claims stay blocked by contract-revised until re-approved.',
      input: { hint: '[--restamp] [--max-rounds=N] [--time-budget-minutes=N] [approvedBy]' },
      handler(invocation) {
        const root = workspaceRoot(invocation);
        const cp = contractPath(root);
        if (!fs.existsSync(cp)) return { kind: 'error', text: `No contract at ${cp}. Start one with /goal-loop-at <objective>.` };
        const raw = String(invocation.rawInput ?? '').trim();
        const tokens = raw.split(/\s+/).filter(Boolean);
        const valueOf = (name) => {
          const hit = tokens.find((t) => t.startsWith(`${name}=`));
          return hit ? hit.slice(name.length + 1) : undefined;
        };
        const approvedBy = tokens.find((t) => !t.startsWith('--')) || 'user';
        const maxRounds = valueOf('--max-rounds');
        const timeBudget = valueOf('--time-budget-minutes');
        const res = applyStamp(root, fs.readFileSync(cp, 'utf8'), {
          approvedBy,
          restamp: tokens.includes('--restamp'),
          ...(maxRounds !== undefined ? { maxRounds: Number(maxRounds) } : {}),
          ...(timeBudget !== undefined ? { timeBudgetMinutes: Number(timeBudget) } : {}),
        });
        if (!res.ok) return { kind: 'error', text: `[goal-gate:${res.code}] ${res.detail}` };
        return { kind: 'success', text: JSON.stringify({
          stamped: true, code: res.code, stamp: res.stamp, approvedBy: res.approvedBy,
          approvedAt: res.approvedAt,
          ...(res.maxRounds !== undefined ? { maxRounds: res.maxRounds } : {}),
          ...(res.timeBudgetMinutes !== undefined ? { timeBudgetMinutes: res.timeBudgetMinutes } : {}),
        }, null, 2) };
      },
    });

    // /goal-reset [--new-loop] —— 人类解除 BLOCKED / 开启新实验（模型无此入口）
    commands.register({
      name: 'goal-reset',
      description: 'Human-only recovery: clear false-complete/partial counters after a BLOCKED, optionally rotate the loop clock (--new-loop) to restart the round budget. Model tools cannot reset their own block.',
      input: { hint: '[--new-loop] [reason]' },
      handler(invocation) {
        const root = workspaceRoot(invocation);
        const raw = String(invocation.rawInput ?? '').trim();
        const state = readState(root);
        const before = { falseCompletes: state.falseCompletes ?? 0, partialCompletes: state.partialCompletes ?? 0 };
        state.falseCompletes = 0;
        state.partialCompletes = 0;
        writeState(root, state);
        let loop = readLoop(root);
        if (raw.includes('--new-loop') && loop) {
          loop = { ...loop, createdAt: new Date().toISOString(), status: 'active' };
          fs.writeFileSync(loopPath(root), JSON.stringify(loop, null, 2));
        }
        return { kind: 'success', text: JSON.stringify({
          reset: true, before, after: { falseCompletes: 0, partialCompletes: 0 },
          newLoop: raw.includes('--new-loop'), loop,
          note: 'history.jsonl 保留(审计证据不删);树没变的话 digest 仍绑定旧 GO。',
        }, null, 2) };
      },
    });

    // /goal-audit —— 声明前审计（只读）
    commands.register({
      name: 'goal-audit',
      description: 'Audit the goal-gate ledger before claiming completion (read-only): contract/stamp/digest/last-GO consistency',
      handler(invocation) {
        return { kind: 'success', text: JSON.stringify(auditReport(workspaceRoot(invocation)), null, 2) };
      },
    });
  });

  // 运行时 skill：goal-loop / goal-loop-contract（模型目录可见）
  if (cfg.registerSkills !== false) {
    let registered = false;
    const attempt = (c, service) => {
      if (registered) return;
      try { registered = registerSkills(c, service); } catch (e) { ctx.logger?.warn?.(`goal-gate: skill registration failed: ${e?.message ?? e}`); }
    };
    attempt(ctx);
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['skills'], (scoped) => attempt(scoped, scoped.skills ?? (typeof scoped.get === 'function' ? scoped.get('skills') : undefined)));
      } catch { /* 没有 skills 服务就跳过 */ }
    }
  }

  // 拦截器：tools/pre-execute（完成声明 + 盖章的人工确认）
  if (cfg.intercept !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        // 可选严模式：盖章本身要人批（需要部署挂 user-approval；never 策略会自动拒绝）
        if (cfg.requireHumanApproval === true && exec.name === 'goal_gate_stamp') {
          return {
            kind: 'ask',
            reason: 'Approve and freeze the goal contract? Any later edit will invalidate this approval.',
            displayReason: { en: 'Approve and freeze this goal contract?', zh: '批准并冻结这份目标契约？' },
          };
        }
        return await intercept(exec, next, cfg);
      } catch (e) {
        // 门控自身出错 → fail-closed，但用 deny 不用 throw
        return deny('internal-error', `goal-gate failed closed: ${e.message}`);
      }
    });
  }
}
