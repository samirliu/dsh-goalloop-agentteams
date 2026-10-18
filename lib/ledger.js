// ledger.js — 账本层(状态/历史/轮次),供 index.js(宿主内)与 bin/gate.mjs(bash 兜底)共用
// 背景:恢复会话可能拿不到 goal_gate_* 工具表(实测),循环必须能被 bash 直接驱动 ——
// 同一份账本、同一个判定内核,只是入口不同。
import fs from 'node:fs';
import path from 'node:path';
import { runGate, parseContract, AC_RE, contractStamp, treeDigest } from './core.js';

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
  // 原子发布:进程被杀时不留下半截 JSON(state.json 坏了会让门控失忆)。
  const target = statePath(root);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, target);
}
export function readLoop(root) {
  try { return JSON.parse(fs.readFileSync(loopPath(root), 'utf8')); } catch { return null; }
}
export function readHistory(root) {
  // 逐行解析:torn tail(进程被杀时半行)不许让整个账本变空——
  // 账本是审计证据,坏一行只丢一行,并如实跳过。
  try {
    return fs.readFileSync(historyPath(root), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}

// ── 契约盖章/审批(R3):用户批准的是"done 的定义",不是模型自己说 done ──────
// 盖章把契约摘要 + 预算写进 state.approval;之后任何契约编辑都会改变摘要 ⇒
// 旧批准自动作废(completion claim 会被 contract-revised 拦下),直到重新盖章。
export function applyStamp(root, contractText, opts = {}) {
  const { approvedBy, maxRounds, timeBudgetMinutes, restamp = false } = opts;
  const parsed = parseContract(contractText);
  const unparsed = contractText.split('\n').map((l) => l.trim())
    .filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l));
  if (unparsed.length) return { ok: false, code: 'contract-malformed', detail: `unparseable AC line(s): ${unparsed.map((l) => l.split('|')[0].trim()).join(', ')}` };
  if (!parsed.objective) return { ok: false, code: 'contract-malformed', detail: 'contract has no objective line' };
  if (parsed.acs.length === 0) return { ok: false, code: 'contract-malformed', detail: 'contract has no AC lines' };
  if (maxRounds !== undefined && (!Number.isFinite(Number(maxRounds)) || Number(maxRounds) <= 0)) {
    return { ok: false, code: 'bad-budget', detail: 'maxRounds must be a positive number' };
  }
  if (timeBudgetMinutes !== undefined && (!Number.isFinite(Number(timeBudgetMinutes)) || Number(timeBudgetMinutes) <= 0)) {
    return { ok: false, code: 'bad-budget', detail: 'timeBudgetMinutes must be a positive number' };
  }

  const stamp = contractStamp(contractText);
  const state = readState(root);
  const loop = readLoop(root);
  const existing = state.approval;
  if (existing && existing.stamp !== stamp && !restamp) {
    return {
      ok: false, code: 'contract-revised',
      detail: `契约在上次批准后已修改(stamp ${existing.stamp} → ${stamp})。改契约 = 重新审批:确认后带 restamp:true 重新盖章。`,
      previousStamp: existing.stamp, stamp,
    };
  }
  const now = new Date().toISOString();
  const sameContract = existing?.stamp === stamp;
  // 显式重新绑定墙钟预算 = 重新起表(否则到期后无法通过重新盖章续时)。
  const resetClock = timeBudgetMinutes !== undefined
    && (!existing || existing.timeBudgetMinutes !== Number(timeBudgetMinutes));
  const approval = {
    stamp,
    approvedAt: sameContract && !resetClock ? existing.approvedAt : now,
    approvedBy: String(approvedBy ?? existing?.approvedBy ?? 'user'),
    ...(maxRounds !== undefined ? { maxRounds: Number(maxRounds) } : {}),
    ...(timeBudgetMinutes !== undefined ? { timeBudgetMinutes: Number(timeBudgetMinutes) }
      : existing?.timeBudgetMinutes !== undefined ? { timeBudgetMinutes: existing.timeBudgetMinutes } : {}),
  };
  state.approval = approval;
  writeState(root, state);

  if (loop && maxRounds !== undefined) {
    loop.maxRounds = Number(maxRounds);
    fs.writeFileSync(loopPath(root), JSON.stringify(loop, null, 2));
  }
  return {
    ok: true, code: sameContract ? 'already-stamped' : 'stamped', stamp,
    approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
    ...(approval.maxRounds !== undefined ? { maxRounds: approval.maxRounds } : {}),
    ...(approval.timeBudgetMinutes !== undefined ? { timeBudgetMinutes: approval.timeBudgetMinutes } : {}),
    restamped: Boolean(existing && existing.stamp !== stamp),
  };
}

// ── 墙钟预算(盖章时绑定):到点不没收已通过的交付(GO 可放行),
// 但没通过就必须停——预算不是"再烧一轮"的许可。
export function timeBudgetStatus(state, loop, now = Date.now()) {
  const approval = state?.approval;
  const minutes = Number(approval?.timeBudgetMinutes);
  if (!approval || !Number.isFinite(minutes) || minutes <= 0) return null;
  const start = Date.parse(approval.approvedAt ?? '') || Date.parse(loop?.createdAt ?? '');
  if (!Number.isFinite(start) || start <= 0) return null;
  const elapsed = Math.max(0, (now - start) / 60_000);
  const remaining = minutes - elapsed;
  return {
    budgetMinutes: minutes,
    elapsedMinutes: Math.round(elapsed * 10) / 10,
    remainingMinutes: Math.round(Math.max(0, remaining) * 10) / 10,
    exhausted: remaining <= 0,
  };
}

// ── 效率面(GRADIENT):每轮 score 变化 + 策略归因,给"这一波值不值"一个数 ──
// 纯旁路:不参与门控裁决,只把"改善斜率"和"哪个攻击方向有效"说出来。
export function efficiencyOf(history, loopKey, g, strategy) {
  const runs = (history ?? []).filter((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === (loopKey ?? 'default'));
  const score = typeof g?.score === 'number' ? g.score : null;
  const prev = runs[runs.length - 1];
  const scoreDelta = prev && typeof prev.score === 'number' && score !== null ? round4(score - prev.score) : null;
  const window = [...runs.slice(-4), { score, strategy }];
  const first = window[0];
  const slope = window.length > 1 && typeof first?.score === 'number' && score !== null
    ? round4((score - first.score) / (window.length - 1)) : null;
  const byStrategy = {};
  for (const h of runs) {
    const key = h.strategy ?? '(unlabeled)';
    const row = byStrategy[key] ?? { runs: 0, lastScore: undefined, bestScore: undefined, deltaSum: 0, deltaCount: 0 };
    row.runs++;
    if (typeof h.score === 'number') {
      if (row.prevScore !== undefined && row.prevScore !== null) { row.deltaSum += h.score - row.prevScore; row.deltaCount++; }
      row.prevScore = h.score;
      row.lastScore = h.score;
      row.bestScore = row.bestScore === undefined ? h.score : Math.max(row.bestScore, h.score);
    }
    byStrategy[key] = row;
  }
  if (strategy !== undefined && strategy !== null) {
    const key = String(strategy);
    const row = byStrategy[key] ?? { runs: 0, lastScore: undefined, bestScore: undefined, deltaSum: 0, deltaCount: 0 };
    row.runs++;
    if (score !== null) { row.lastScore = score; row.bestScore = row.bestScore === undefined ? score : Math.max(row.bestScore, score); }
    byStrategy[key] = row;
  }
  const strategies = Object.entries(byStrategy).map(([label, row]) => ({
    strategy: label, runs: row.runs,
    ...(row.lastScore !== undefined ? { lastScore: row.lastScore } : {}),
    ...(row.bestScore !== undefined ? { bestScore: row.bestScore } : {}),
    ...(row.deltaCount ? { avgDelta: round4(row.deltaSum / row.deltaCount) } : {}),
  }));
  return {
    score: score ?? undefined,
    prevScore: prev && typeof prev.score === 'number' ? prev.score : undefined,
    scoreDelta: scoreDelta ?? undefined,
    slope: slope ?? undefined,
    window: window.length,
    strategy: strategy ?? undefined,
    strategies,
  };
}
function round4(n) { return Math.round(n * 10_000) / 10_000; }

// ── 轮次/度量账本:每次门控评估都记一行 history.jsonl ───────────────────────
// round = 优化迭代数(check / 完成声明评估计入;goal-only 任务里程碑记账不计入预算)。
// opts = { strategy?: string, note?: string } — strategy 是这一波的攻击方向标签
// (GRADIENT 归因用,不改门控);note 是控制器的单行记录(可审计,不进模型裁决)。
export function recordRun(root, state, g, trigger, opts = {}) {
  const history = readHistory(root);
  const milestone = trigger === 'task-claim';
  const isGateError = g.code === 'state-error'; // 契约畸形/零评估 = 故障,不是实验(缺陷 #14)
  const loop = readLoop(root);
  const loopKey = loop?.createdAt ?? 'default';
  // 轮次属于"实验"(loop)而不是工作区:换 loop 重新计数,否则多实验共享工作区时
  // 轮次预算被历史撑爆(roundsExhausted 假阳性)。
  // state-error 行不进轮次计数:解析/契约故障不能让"什么都没评"的轮白烧预算。
  const round = history.filter((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === loopKey).length + ((milestone || isGateError) ? 0 : 1);
  const maxRounds = loop?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const strategy = typeof opts.strategy === 'string' && opts.strategy.trim() ? opts.strategy.trim().slice(0, 120) : undefined;
  const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.trim().slice(0, 400) : undefined;
  const entry = {
    ts: new Date().toISOString(), trigger, round, loopKey,
    code: g.code, score: g.score ?? null, totals: g.totals ?? null, stamp: g.stamp ?? null,
    failed: (g.results ?? []).filter((r) => r.status === 'failed').map((r) => r.id),
    broken: (g.results ?? []).filter((r) => r.status === 'broken').map((r) => r.id),
    unverifiable: (g.results ?? []).filter((r) => r.status === 'unverifiable').map((r) => r.id),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(g.ms !== undefined ? { ms: g.ms } : {}), // 门控自计时(缺陷 #15:停摆/拖沓要从账本可见)
  };
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  fs.appendFileSync(historyPath(root), `${JSON.stringify(entry)}\n`);
  state.lastRunAt = entry.ts; // 最近一次评估时钟(缺陷 #15)

  // case 边界 = loop.json 换代(新实验):bestScore 重新开始。基线本身按
  // metricKey(=AC 编号+check 哈希)隔离,无需在此清空——契约微调不许清史。
  if (state.loopKey !== undefined && state.loopKey !== loopKey) { state.bestScore = null; }
  state.loopKey = loopKey;

  // 基线推进纪律(不回退规则的牙齿):只有"本轮通过"的 AC 才允许把基线推进到新观测值;
  // 未建基线的 AC 首轮照常建档;失败/不可验证的观测不许把基线拉下来(否则失败一次
  // 基线就滑到低位,下一轮低水平"通过"——不回退规则会被自己的更新策略瓦解)。
  const merged = { ...(state.baselines ?? {}) };
  for (const [key, v] of Object.entries(g.baselineUpdates ?? {})) {
    // 指标键是 `AC-N#<checkhash>`,结果 id 是 `AC-N` —— 直接比较会让 status
    // 永远 undefined、基线永远停在首轮观测(实测缺陷:10→20→15 后仍是 10)。
    const acId = String(key).split('#')[0];
    const status = (g.results ?? []).find((r) => r.id === acId)?.status;
    if (merged[key] === undefined || status === 'passed') merged[key] = v;
  }
  state.baselines = merged;

  const regression = g.score !== undefined && state.bestScore !== null && state.bestScore !== undefined && g.score < state.bestScore;
  if (g.score !== undefined) state.bestScore = Math.max(state.bestScore ?? -Infinity, g.score);
  writeState(root, state);

  return { round, maxRounds, remainingRounds: Math.max(0, maxRounds - round), roundsExhausted: round > maxRounds && g.code !== 'go', regression };
}

// ── loop 停摆检测(缺陷 #15)────────────────────────────────────────────
// loop 挂 active 但迟迟没人评估 = 停摆。停摆不是错误,零活动顶着 "active" 才是
// 自欺——状态必须直接说清闲置了多久;长期离开应显式把 loop.json 标成 suspended。
export function loopIdleStatus(state, loop, now = Date.now()) {
  if (!loop) return null;
  const since = Date.parse(state?.lastRunAt ?? '') || Date.parse(loop.createdAt ?? '');
  if (!Number.isFinite(since) || since <= 0) return null;
  const warnHours = Number.isFinite(+loop.idleWarnHours) && +loop.idleWarnHours > 0 ? +loop.idleWarnHours : 4;
  const idleHours = Math.max(0, (now - since) / 3_600_000);
  return { idleHours: Math.round(idleHours * 10) / 10, warnHours, stalled: loop.status !== 'suspended' && idleHours > warnHours };
}
export function idleWarning(state, loop) {
  const s = loopIdleStatus(state, loop);
  return s?.stalled ? { id: '*', kind: 'loop-idle', detail: `距上次评估已 ${s.idleHours} 小时(阈值 ${s.warnHours})——继续干,或把 loop.json 的 "status" 改成 "suspended" 并定时回来;别让停摆顶着 active 的名义` } : undefined;
}

// ── 同契约状态重评(缺陷 #16):同 stamp、同结论、同失败集 = 只为"再看一眼"再烧一轮 ──
// 语义不改(棘轮单向,重评照样计轮),但代价必须点名——只想复查结论请走只读入口。
export function duplicateEvalNote(history, loop, g) {
  if (!g || g.code === 'state-error' || g.stamp === undefined || g.stamp === null) return null;
  const loopKey = loop?.createdAt ?? 'default';
  const prev = [...history].reverse().find((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === loopKey);
  if (!prev || prev.stamp !== g.stamp || prev.code !== g.code) return null;
  const sameFailed = JSON.stringify([...(prev.failed ?? []), ...(prev.broken ?? [])])
    === JSON.stringify((g.results ?? []).filter((r) => r.status === 'failed' || r.status === 'broken').map((r) => r.id));
  const sameScore = (prev.score ?? null) === (g.score ?? null);
  if (!sameFailed || !sameScore) return null;
  return `duplicate-evaluation: 与上次评估同 stamp(${g.stamp})同结论——本轮同样计入 round;想复查结论请用只读入口(/goal-gate 或 gate.mjs status)`;
}

// ── eval 加固:检查命令预检(静态分析 + 可执行性提示)──────────────────────
// 实测教训(平台事实):check 裸写 node/python 在坏 PATH 机器上会静默失败;永真式 check 从不失败。
export function preflightChecks(contractText, cwd = undefined) {
  const warnings = [];
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
    // 取数脆弱性:数值规格但没写 metric: 正则 → 依赖"输出最后一个数字"兜底,
    // 多数字输出(报告/日志)会静默取错值——这是评估系统最常见的误判源。
    const numericExpected = /^(<=|>=|<|>|==|=|!=)\s*-?\d|\b(maximize|minimize)\b/.test(ac.expected ?? '');
    if (numericExpected && !ac.metric) {
      warnings.push({ id: ac.id, kind: 'numeric-without-metric', detail: '数值规格未配 `metric:` 正则,依赖"最后数字"兜底——多数字输出会静默取错值,请补 metric: `...([0-9.]+)...`' });
    }
    // 永真式启发:check 只含 echo/true 等无判定语义
    if (/^(echo|true|:)\b/.test(cmd) && !/[><|]|test |grep |\[\[/.test(cmd)) {
      warnings.push({ id: ac.id, kind: 'tautology-suspect', detail: 'check 只有输出/恒真命令,疑似永真式——check 必须能真失败' });
    }
    // judged 行判官要求(缺陷 #13 前移):别让轮烧完才发现"judged 缺判官"
    if (ac.expected === 'judged' && !ac.probe) {
      warnings.push({ id: ac.id, kind: 'judged-judge-missing', detail: 'judged 没有 probe 判官——无判官的 judged 一律 unverifiable;补 probe: `<命令>`,其退出码即结论' });
    }
    // 噪声带(GRADIENT/PROVE):优化类指标天然抖动,没有 tolerance/sd/var 时
    // 精确比较会把噪声当成回退/改善——先量噪声,再定带。
    if ((ac.expected === 'maximize' || ac.expected === 'minimize')
        && ac.tolerance === null && !ac.sd && !ac.variance) {
      warnings.push({ id: ac.id, kind: 'noise-band-missing', detail: '优化类规格未配 `tolerance:` / `sd:` / `var:` —— 指标抖动会被判成回退/改善;先跑两次量噪声再定带' });
    }
    if ((ac.sd || ac.variance) && ac.expected !== 'maximize' && ac.expected !== 'minimize') {
      warnings.push({ id: ac.id, kind: 'spread-unused', detail: '声明了 sd:/var: 但规格不是 maximize/minimize——噪声带只作用于优化类指标,声明不会生效' });
    }
    // 判读席校准(PROVE):单边 calib 无法校准,夹具必须真实存在(盖章前就该发现)
    if (ac.calibGood || ac.calibBad) {
      if (!ac.calibGood || !ac.calibBad) {
        warnings.push({ id: ac.id, kind: 'calib-one-sided', detail: 'calib: 必须同时声明 good=<已知好> 与 bad=<已知坏>——单边声明无法校准判读席' });
      } else if (cwd) {
        const missing = [ac.calibGood, ac.calibBad].filter((f) => !fs.existsSync(path.resolve(cwd, f)));
        if (missing.length) {
          warnings.push({ id: ac.id, kind: 'calib-fixture-missing', detail: `calib 夹具不存在: ${missing.join(', ')}——夹具缺失会让 judged 永久 unverifiable` });
        }
      }
    }
    if (ac.expected === 'judged' && !ac.calibGood && !ac.calibBad) {
      warnings.push({ id: ac.id, kind: 'judged-uncalibrated', detail: 'judged 未声明 calib: —— 判读席没被已知好/坏夹具校准;质量类目标建议补 calib: good=<f> bad=<f>' });
    }
  }
  // judged 证据绑定纪律(缺陷 #13):评审必须点名"看了什么文件、什么摘要"
  if (acs.some((a) => a.expected === 'judged')) {
    warnings.push({ id: '*', kind: 'judged-evidence-binding', detail: 'judged 结论必须含两行 `artifact: <评审所见文件>` 与 `digest: sha256:<64hex>`(该文件当前摘要)——缺绑定或摘要过期的 PASS 判 unverifiable,且作废时会点名原因' });
  }
  // exit 策略只认 goal-only|strict;其它值(如 forge)当前不实现——明说,不许静默当 strict。
  const exitPolicy = String(parseContract(contractText).exitPolicy ?? '').trim().toLowerCase();
  if (exitPolicy && exitPolicy !== 'goal-only' && exitPolicy !== 'strict') {
    warnings.push({ id: '*', kind: 'unsupported-exit-policy', detail: `exit: ${exitPolicy} 不是本插件支持的策略(只认 goal-only|strict)——当前按 strict 处理;forge 语义未实现` });
  }
  // AC 行解析失败(fail-closed 的预警版;runGate 会直接拒评)
  for (const line of contractText.split('\n')) {
    const t = line.trim();
    if (/^AC-\d+/.test(t) && !AC_RE.test(t)) {
      warnings.push({ id: t.split('|')[0].trim(), kind: 'ac-line-unparsed', detail: 'AC 行解析失败(常见:check 内嵌反引号),门控将拒评整份契约——请改用 \$(...) 或拆分命令' });
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
// core 是纯函数:静态导入即可,不需要运行期桥接。
function require_core() { return { parseContract }; }
function parseContractFull(text) { return parseContract(text); }

// ── eval 加固:从未失败过的 AC(疑似永真式/未被真实考验)──────────────────
export function neverFailedAcs(history, acs, minRuns = 2, stamp = undefined) {
  // stamp 过滤:只统计同一契约(盖戳)下的运行记录,防止跨实验/跨契约误报
  const runs = history.filter((h) => h.trigger !== 'task-claim' && (stamp === undefined || h.stamp === stamp));
  if (runs.length < minRuns) return [];
  const everFailed = new Set(runs.flatMap((h) => [...(h.failed ?? []), ...(h.broken ?? []), ...(h.unverifiable ?? [])]));
  return acs.map((a) => a.id).filter((id) => !everFailed.has(id));
}

// ── 只读状态面(status):一眼看清门控现在到底站在哪 ─────────────────────
// 关键纪律:status 绝不重跑 check、绝不记轮次——它回答"账本里记的是什么",
// 想拿当前真相请用 goal_gate_check(那是实验,要花一轮)。
export function statusReport(root) {
  const cp = contractPath(root);
  const contractExists = fs.existsSync(cp);
  const text = contractExists ? fs.readFileSync(cp, 'utf8') : '';
  const parsed = contractExists ? parseContract(text) : { objective: null, acs: [], exitPolicy: null, deliverable: null };
  const unparsed = contractExists
    ? text.split('\n').map((l) => l.trim()).filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l)).length
    : 0;
  const state = readState(root);
  const loop = readLoop(root);
  const history = readHistory(root);
  const loopKey = loop?.createdAt ?? 'default';
  const runs = history.filter((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === loopKey);
  const lastCheck = [...history].reverse().find((h) => (h.loopKey ?? 'default') === loopKey) ?? null;
  const digest = contractExists ? treeDigest(root) : null;
  const bound = state.digests?.goal ?? null;
  const stamp = contractExists && parsed.acs.length ? contractStamp(text) : null;
  const approval = state.approval ?? null;
  const timeBudget = timeBudgetStatus(state, loop);
  return {
    workspace: root,
    contractPath: cp,
    contractExists,
    objective: parsed.objective ?? undefined,
    deliverable: parsed.deliverable ?? undefined,
    exitPolicy: parsed.exitPolicy ?? undefined,
    acs: parsed.acs.length,
    unparsedAcs: unparsed || undefined,
    stamp: stamp ?? undefined,
    approval: approval ?? undefined,
    // 盖过章但契约被改过 = 批准已失效(不跑 check 也能从摘要看出来)
    approvalStale: Boolean(approval && stamp && approval.stamp !== stamp),
    falseCompletes: state.falseCompletes ?? 0,
    partialCompletes: state.partialCompletes ?? 0,
    blocked: (state.falseCompletes ?? 0) >= 2,
    bestScore: state.bestScore ?? undefined,
    baselines: state.baselines ?? {},
    loop: loop ?? undefined,
    roundsUsed: runs.length,
    roundsRemaining: Math.max(0, (loop?.maxRounds ?? DEFAULT_MAX_ROUNDS) - runs.length),
    roundsExhausted: runs.length > (loop?.maxRounds ?? DEFAULT_MAX_ROUNDS),
    lastRunAt: state.lastRunAt ?? undefined,
    idle: loopIdleStatus(state, loop) ?? undefined,
    timeBudget: timeBudget ?? undefined,
    digest: digest ?? undefined,
    digestBound: bound ?? undefined,
    digestStale: Boolean(bound && digest && bound !== digest),
    lastCheck: lastCheck ?? undefined,
    history: history.slice(-5),
  };
}

// ── 声明前审计(audit):门控判产物,审计判"控制器有没有资格声明" ──────────
// 只读:不跑 check、不记账;发现账本与契约脱节就点名,让声明者在按 update_goal
// 之前自己先把证据补齐(否则 completion claim 也会被拦)。
export function auditReport(root) {
  const violations = [];
  const warnings = [];
  const add = (arr, code, detail) => arr.push({ code, detail });
  const cp = contractPath(root);
  if (!fs.existsSync(cp)) {
    add(violations, 'no-contract', `没有契约: ${cp}`);
    return { ok: false, violations, warnings, stamp: null, digest: null, lastCheck: null, recommendations: ['先 goal_loop_at 或 goal_gate_init 建立契约'] };
  }
  const text = fs.readFileSync(cp, 'utf8');
  const parsed = parseContract(text);
  const unparsed = text.split('\n').map((l) => l.trim()).filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l));
  if (unparsed.length) add(violations, 'contract-malformed', `AC 行解析失败: ${unparsed.map((l) => l.split('|')[0].trim()).join(', ')}`);
  if (!parsed.objective) add(violations, 'contract-malformed', '契约缺少 objective 行');
  if (parsed.acs.length === 0) add(violations, 'contract-malformed', '契约没有 AC 行');

  const state = readState(root);
  const loop = readLoop(root);
  const history = readHistory(root);
  const loopKey = loop?.createdAt ?? 'default';
  const stamp = contractStamp(text);
  const digest = treeDigest(root);

  if ((state.falseCompletes ?? 0) >= 2) {
    add(violations, 'blocked', `false-completes=${state.falseCompletes} ≥ 2:门控处于 BLOCKED,必须等人介入清零`);
  }
  if (state.approval && state.approval.stamp !== stamp) {
    add(violations, 'contract-revised', `契约在上次批准(${state.approval.stamp})后被修改,当前 stamp=${stamp}:重新审批后再声明完成`);
  }
  if (!state.approval) {
    add(warnings, 'unstamped-contract', '契约未盖章(goal_gate_stamp / /goal-stamp):完成定义尚未被用户批准(可用,但事后无法证明"批准过什么")');
  }

  const runs = history.filter((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === loopKey);
  const last = [...history].reverse().find((h) => (h.loopKey ?? 'default') === loopKey) ?? null;
  const lastCheck = [...history].reverse().find((h) => h.trigger !== 'task-claim' && h.code !== 'state-error' && (h.loopKey ?? 'default') === loopKey) ?? null;
  if (!lastCheck) {
    add(violations, 'no-check-yet', '还没有一次可归因的门控评估:先 goal_gate_check(会产生轮次账)');
  } else {
    if (lastCheck.stamp && lastCheck.stamp !== stamp) {
      add(violations, 'verdict-stale-contract', `最近一次评估针对旧契约(stamp ${lastCheck.stamp} ≠ 当前 ${stamp}):重新跑 goal_gate_check`);
    }
    if (lastCheck.code !== 'go') {
      add(violations, 'last-check-not-go', `最近一次评估是 ${lastCheck.code}${lastCheck.failed?.length ? `:失败 ${lastCheck.failed.join(', ')}` : ''}${lastCheck.unverifiable?.length ? `;不可验证 ${lastCheck.unverifiable.join(', ')}` : ''}——先把 failedActions 修掉`);
    } else if ((lastCheck.unverifiable ?? []).length) {
      add(warnings, 'go-with-unverifiable', `最近一次 GO 含不可验证 AC: ${lastCheck.unverifiable.join(', ')}(≤1/3 允许,但它们没有验收证据)`);
    }
    if (lastCheck.trigger === 'task-claim') {
      add(warnings, 'last-check-is-milestone', '最近一条是同任务的里程碑记账,不是一次独立实验:声明前最好跑一次真正的 goal_gate_check');
    }
  }
  if (state.digests?.goal && state.digests.goal !== digest) {
    add(violations, 'tree-moved', `上次 GO 绑定的 tree digest ${state.digests.goal} ≠ 当前 ${digest}:文件已变,旧结论作废,重新验证`);
  } else if (!state.digests?.goal) {
    add(warnings, 'verdict-unbound', '还没有 GO 结果绑定到 tree digest:第一次声明完成时门控会重验并绑定');
  }
  const roundsUsed = runs.length;
  const maxRounds = loop?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (roundsUsed > maxRounds) add(warnings, 'rounds-exhausted', `轮次预算已用尽(${roundsUsed}/${maxRounds})——除非门控已经 GO,否则应停下向用户汇报`);
  const tb = timeBudgetStatus(state, loop);
  if (tb?.exhausted) add(warnings, 'time-budget-exhausted', `墙钟预算已用尽(${tb.elapsedMinutes}/${tb.budgetMinutes} 分钟)——除非门控已经 GO,否则应停下向用户汇报`);
  if (loop && loop.status === 'suspended') add(warnings, 'loop-suspended', 'loop.json 标记为 suspended:这是显式等待,不是停摆;恢复前不要声明完成');
  const never = neverFailedAcs(history, parsed.acs, 2, stamp);
  if (never.length) add(warnings, 'never-failed', `从未失败过的 AC: ${never.join(', ')}(≥2 轮;疑似永真式/未被真实考验)`);
  const preflight = preflightChecks(text, root);
  const severe = preflight.filter((w) => ['ac-line-unparsed', 'calib-one-sided', 'calib-fixture-missing', 'judged-judge-missing', 'numeric-without-metric', 'deliverable-unverified'].includes(w.kind));
  for (const w of severe) add(warnings, `preflight-${w.kind}`, `${w.id}: ${w.detail}`);
  for (const w of preflight.filter((x) => !severe.includes(x))) add(warnings, `preflight-${w.kind}`, `${w.id}: ${w.detail}`);

  const recommendations = [];
  for (const v of violations) {
    if (v.code === 'no-check-yet' || v.code === 'last-check-not-go' || v.code === 'verdict-stale-contract') recommendations.push('跑 goal_gate_check 拿到当前契约的 GO,再考虑声明完成');
    else if (v.code === 'contract-revised') recommendations.push('确认新契约后 /goal-stamp(或 goal_gate_stamp restamp:true)重新批准');
    else if (v.code === 'tree-moved') recommendations.push('文件已变:重跑 goal_gate_check(旧 GO 已作废)');
    else if (v.code === 'blocked') recommendations.push('等人介入:清零 falseCompletes 或明确放弃该目标');
    else if (v.code === 'contract-malformed') recommendations.push('修 AC 行文法(单行、反引号、expected: 齐全)后重新盖章');
  }
  return {
    ok: violations.length === 0,
    violations,
    warnings,
    stamp,
    digest,
    lastCheck,
    roundsUsed,
    maxRounds,
    timeBudget: tb,
    recommendations: recommendations.length ? [...new Set(recommendations)] : undefined,
  };
}
