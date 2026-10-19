// ledger.js — 账本层(状态/历史/轮次),供 index.js(宿主内)与 bin/gate.mjs(bash 兜底)共用
// 背景:恢复会话可能拿不到 goal_gate_* 工具表(实测),循环必须能被 bash 直接驱动 ——
// 同一份账本、同一个判定内核,只是入口不同。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { runGate, parseContract, AC_RE, contractStamp, treeDigest, runCommand, extractMetric, extractSpread, metricKey, resolveShell, shellLabel } from './core.js';

export const DEFAULT_MAX_ROUNDS = 8;

export function ledgerDir(root) { return path.join(root, '.goal-gate'); }
export function contractPath(root) { return path.join(ledgerDir(root), 'goal.md'); }
export function statePath(root) { return path.join(ledgerDir(root), 'state.json'); }
export function loopPath(root) { return path.join(ledgerDir(root), 'loop.json'); }
export function historyPath(root) { return path.join(ledgerDir(root), 'history.jsonl'); }

// ── 账本完整性(P0):state.json 是门控的全部记忆,而它落在 workspace 内 ─────
// 攻击面:水位(baselines)/摘要(digests)/BLOCKED 闩锁(falseCompletes)/批准
// (approval)全在 state.json 里,被评估的模型对 workspace 有写权限 ⇒ 它原本可以
// 自造低水位白拿 maximize、删 state.json 清掉 BLOCKED、抹掉批准。签名密钥放在
// workspace 之外(~/.dsh/goal-gate/<root-hash>.key,0600),工作区内的写入者拿不到;
// 签名不符 = state-error(fail-closed),绝不静默重建。
const STATE_SIG_FIELD = 'sig';
function stateKeyPath(root) {
  const id = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 24);
  return path.join(os.homedir(), '.dsh', 'goal-gate', `${id}.key`);
}
// create=false 只读;create=true 首次使用时生成。生成失败(家目录只读等)返回 null,
// 此时退化为未签名账本——可用性优先,但会在 state 里留 sig:null 的痕迹。
function readStateKey(root, { create = false } = {}) {
  const file = stateKeyPath(root);
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(key)) return Buffer.from(key, 'hex');
  } catch { /* missing or unreadable */ }
  if (!create) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString('hex');
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    return Buffer.from(key, 'hex');
  } catch (e) {
    if (e.code === 'EEXIST') {
      try { return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { return null; }
    }
    return null;
  }
}
// 稳定序列化:同一个对象无论键序如何都得到同一段字节,签名才不会自己飘。
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
function withoutSig(state) {
  const { [STATE_SIG_FIELD]: _sig, ...rest } = state ?? {};
  return rest;
}
function stateSig(root, state) {
  const key = readStateKey(root, { create: true });
  if (!key) return null;
  return createHmac('sha256', key).update(canonicalJson(withoutSig(state))).digest('hex');
}
export function freshState() {
  return { falseCompletes: 0, digests: {}, baselines: {}, spreads: {}, bestScore: null };
}
// 坏账本用不可枚举的标记带出来:既能被调用方识别成 state-error,又不会被
// JSON.stringify/spread 顺手"洗白"成一份新账本。
function tamperedState(reason) {
  const s = freshState();
  Object.defineProperty(s, '__integrity', { value: 'bad', enumerable: false });
  Object.defineProperty(s, '__reason', { value: reason, enumerable: false });
  return s;
}
export function readState(root) {
  const file = statePath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 文件不存在:只有"这个工作区从没签过账"才算首次使用。密钥还在却没了账本
      // = 账本被删——那正是清 BLOCKED 闩锁 / 清水位最省事的一条路,必须暴露。
      if (readStateKey(root)) {
        return tamperedState('state.json 不存在但签名密钥仍在——账本被删除(BLOCKED 闩锁/水位/批准都随之消失)');
      }
      return freshState();
    }
    // 读不了(权限/占用/IO)= 问题,不是空账本。
    return tamperedState(`state.json 读不到(${e.code ?? e.message})`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return tamperedState(`state.json 不是合法 JSON(${e.message})——账本损坏,不静默重建;人工核对后删掉 .goal-gate/state.json 与签名密钥(~/.dsh/goal-gate/)再从零开始`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return tamperedState('state.json 不是 JSON 对象');
  }
  const declared = typeof parsed[STATE_SIG_FIELD] === 'string' ? parsed[STATE_SIG_FIELD] : null;
  const key = readStateKey(root);
  if (!key) {
    // 没有密钥:要么首次使用(旧账本/测试手写),要么密钥被删。带签名的账本
    // 却找不到密钥 ⇒ 校验不了,不能当可信账本用。
    if (declared) return tamperedState('state.json 带签名但签名密钥不存在——账本无法校验');
    return parsed;
  }
  if (!declared) {
    // 密钥已存在 ⇒ 这个工作区用过签名账本;此时没签名 = 签名被剥掉了。
    return tamperedState('state.json 缺少签名——账本被改写或替换(签名密钥存在,账本无签名)');
  }
  const expect = createHmac('sha256', key).update(canonicalJson(withoutSig(parsed))).digest();
  let got = null;
  try { got = Buffer.from(declared, 'hex'); } catch { got = null; }
  if (!got || got.length !== expect.length || !timingSafeEqual(got, expect)) {
    return tamperedState('state.json 签名不符——账本在 workspace 内被改写(水位/闩锁/批准都不可信)');
  }
  return parsed;
}
// 调用方(门控入口)用它把坏账本转成 rc=4 state-error,而不是拿一份空账本继续跑。
export function readStateChecked(root) {
  const state = readState(root);
  if (state.__integrity === 'bad') {
    return { ok: false, state: null, code: 'state-error', reason: state.__reason };
  }
  return { ok: true, state, code: 'ok' };
}
export function writeState(root, s) {
  if (s && s.__integrity === 'bad') {
    const err = new Error(`[goal-gate:state-error] refuse to overwrite a tampered ledger: ${s.__reason}`);
    err.code = 'LEDGER_TAMPERED';
    throw err;
  }
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  // 原子发布:进程被杀时不留下半截 JSON(state.json 坏了会让门控失忆)。
  const target = statePath(root);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = withoutSig(s ?? {});
  const sig = stateSig(root, payload);
  if (sig) payload[STATE_SIG_FIELD] = sig;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  // Windows 上 rename 覆盖已有文件会被并发读者/杀软短暂占用(EACCES/EBUSY/EPERM);
  // 有界重试后仍然失败就抛出——绝不静默留下半截账本,也绝不因瞬时占用丢一轮。
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.renameSync(tmp, target); return; } catch (e) {
      lastErr = e;
      if (!['EACCES', 'EBUSY', 'EPERM', 'EEXIST'].includes(e.code)) break;
      const until = Date.now() + 5 * (attempt + 1);
      while (Date.now() < until) { /* short sync backoff: writeState is sync by contract */ }
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  throw lastErr;
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
  // 与 runGate 同一套文法:先剥 `- ` 前缀再判,否则 dashed AC 行会被盖章放行、
  // 却被门控拒成 state-error(盖章接受门控拒绝 = 假批准)。
  const unparsed = contractText.split('\n').map((l) => l.trim().replace(/^-\s+(?=AC-\d+)/, ''))
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
  if (state.__integrity === 'bad') {
    return { ok: false, code: 'state-error', detail: `账本不可信,拒绝盖章:${state.__reason}` };
  }
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

  // 预算必须落盘:原来只在 loop.json 已存在时才写,首次盖章(还没 loop)时
  // --max-rounds 静默丢失,后续 check 仍按默认 8 轮跑。
  if (maxRounds !== undefined) {
    const base = loop ?? { createdAt: new Date().toISOString(), status: 'active' };
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(loopPath(root), JSON.stringify({ ...base, maxRounds: Number(maxRounds) }, null, 2));
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
  if (state && state.__integrity === 'bad') {
    const err = new Error(`[goal-gate:state-error] ledger is not trustworthy: ${state.__reason}`);
    err.code = 'LEDGER_TAMPERED';
    throw err;
  }
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
  // 数据噪声也进账本:下一轮没有 sd:/var: 输出时,优化判定仍能用实测离散度。
  const mergedSpreads = { ...(state.spreads ?? {}) };
  for (const [key, v] of Object.entries(g.spreadUpdates ?? {})) {
    const acId = String(key).split('#')[0];
    const status = (g.results ?? []).find((r) => r.id === acId)?.status;
    if (mergedSpreads[key] === undefined || status === 'passed') mergedSpreads[key] = v;
  }
  state.spreads = mergedSpreads;

  const regression = g.score !== undefined && state.bestScore !== null && state.bestScore !== undefined && g.score < state.bestScore;
  if (g.score !== undefined) state.bestScore = Math.max(state.bestScore ?? -Infinity, g.score);
  writeState(root, state);

  // 预算语义:maxRounds 是"允许的轮数",用满即耗尽(round >= maxRounds)。
  // 原来写 round > maxRounds,导致 maxRounds=2 时第 2 轮报 remaining 0 却
  // exhausted=false——预算承诺少算一轮。GO 轮不算耗尽(GO 就是放行)。
  return { round, maxRounds, remainingRounds: Math.max(0, maxRounds - round), roundsExhausted: round >= maxRounds && g.code !== 'go', regression };
}

// ── 账本锁:Agent Teams 并发检查/盖章/派工时的互斥 ───────────────────────
// 多个成员同时跑 goal_gate_check 会互相覆盖 round/baseline;锁文件排他创建,
// 过期锁(默认 10 分钟)可回收。拿不到锁 = 明确 busy,不是静默继续。
//
// 创建必须"内容可见即完整":旧实现 openSync('wx') + writeSync 是两步,竞争者
// 在两步之间读到空文件 → JSON.parse 失败 → info=null → age=Infinity → 把
// **别的进程的活锁**当过期删掉 → 两个进程同时进临界区(Windows 上随后
// rename state.json 抛 EPERM)。现在先写临时文件,再 link 成 lock:link 在目标
// 存在时原子失败,永远不会暴露半截内容;不读内容时退回 mtime 判新鲜度。
function publishLockFile(file, payload) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  fs.writeFileSync(tmp, payload);
  try {
    fs.linkSync(tmp, file); // 原子且排他:目标已存在 → EEXIST
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) {
      // 文件系统不支持硬链接:退回 O_EXCL 单步创建(仍是排他的)。
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, payload);
        fs.closeSync(fd);
        return true;
      } catch (e2) {
        if (e2.code === 'EEXIST') return false;
        throw e2;
      }
    }
    throw e;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}
// ── 账本锁(P0)────────────────────────────────────────────────────────
// 原实现有三个洞:①释放时不校验持有者(任何进程都能删别人的锁);②只看时间不看
// 进程是否还活着(崩溃留下的锁要白等 10 分钟);③读 age 与 rm 之间无再校验,两个
// 回收者能互相踩。现在:锁里带 pid + 每把锁独立的 token,释放只在 token 匹配时生效,
// 回收前先看 pid 是否存活(死了立即回收),并在 rm 前 re-stat 确认还是那把锁。
export function lockPath(root) { return path.join(ledgerDir(root), 'lock'); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但属于别的用户;ESRCH = 不存在。
    return e.code === 'EPERM';
  }
}
export function readLockInfo(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    return info && typeof info === 'object' ? info : null;
  } catch { return null; }
}
// 同一把锁的判定:token 优先(token 是每把锁的随机身份,不会被 pid 复用撞上);
// 老版本锁没有 token,退回 pid+at 组合。
function sameLock(info, payload) {
  if (!info) return false;
  if (info.token && payload.token) return info.token === payload.token;
  return info.pid === payload.pid && info.at === payload.at;
}
export function acquireLedgerLock(root, { staleMs = 10 * 60_000 } = {}) {
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  const file = lockPath(root);
  const token = randomBytes(12).toString('hex');
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  const owned = () => sameLock(readLockInfo(file), { pid: process.pid, at: undefined, token });
  const release = () => {
    // 只删自己那把:锁被别人回收后重发,旧持有者不能把新持有者的锁删掉。
    if (!owned()) return false;
    try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
  };
  release.token = token;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (publishLockFile(file, payload)) return release;
    const info = readLockInfo(file);
    const at = info?.at;
    let age = Number.isFinite(Number(at)) ? Date.now() - Number(at) : Infinity;
    if (!Number.isFinite(age)) {
      // 内容读不出来 ≠ 锁已过期:用 mtime 当新鲜度证据(半写窗口不能被回收)。
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = Infinity; }
    }
    // pid 存活检测:持有者已死 ⇒ 立刻回收,不必等满 staleMs(崩溃恢复从 10 分钟
    // 降到一次 syscall)。pid 活着的锁即使超时也不抢——超时可能是长任务。
    const holderDead = info && Number.isInteger(info.pid) && !pidAlive(info.pid);
    if (!holderDead && Number.isFinite(age) && age < staleMs) return null;
    // 回收前再读一次:确认还是刚才判定的那把锁(别人可能已抢先回收并重发)。
    // 换了就不删——下一轮重新判定,避免把新持有者的锁删掉。
    const again = readLockInfo(file);
    if (info && again && (again.token !== info.token || again.pid !== info.pid || again.at !== info.at)) continue;
    try { fs.rmSync(file, { force: true }); } catch { return null; }
  }
  return null;
}
// 人工恢复路径:锁持有者已死/不可判定时,允许显式强制解锁(CLI `unlock`)。
export function forceUnlock(root) {
  const file = lockPath(root);
  const info = readLockInfo(file);
  try { fs.rmSync(file, { force: true }); return { unlocked: true, released: info }; } catch { return { unlocked: false, released: info }; }
}
export async function withLedgerLock(root, fn, options = {}) {
  const { waitMs = 0, ...lockOptions } = options;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const release = acquireLedgerLock(root, lockOptions);
    if (release) {
      try { return await fn(); } finally { release(); }
    }
    if (Date.now() >= deadline) return { busy: true };
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

// ── 基线/噪声测量(PROVE):盖章前把 optimize AC 跑 N 次,记录均值与离散度 ──
// 这不是一次门控实验(不记轮次),但会被写入 state.baselines/spreads,供后续
// maximize/minimize 判定做数据驱动噪声带。检查期间改树 = 测量无效,不记录。
export function measureBaselines(root, contractText, { samples = 3, shell } = {}) {
  const { acs } = parseContract(contractText);
  const optimize = acs.filter((a) => a.expected === 'maximize' || a.expected === 'minimize');
  const results = [];
  const state = readState(root);
  if (state.__integrity === 'bad') {
    return { samples: Math.max(2, samples), acs: [], recorded: false, code: 'state-error', notes: [`账本不可信,拒绝写入基线:${state.__reason}`] };
  }
  const digestBefore = treeDigest(root);
  for (const ac of optimize) {
    const values = [];
    const raw = [];
    for (let i = 0; i < Math.max(2, samples); i++) {
      const r = runCommand(ac.check, { cwd: root, timeout: (ac.timeout ?? 30) * 1000, shell });
      raw.push({ exitCode: r.exitCode, stdout: (r.stdout || '').slice(-200), stderr: (r.stderr || '').slice(-200) });
      // 只有"仪器正常退出"的观测才算数:非零退出说明测量命令本身坏了,
      // 从坏观测建的水位比没有水位更危险(它会给后续判定一个假基准)。
      if (r.exitCode !== 0) continue;
      const v = extractMetric(r.stdout, ac.metric);
      if (v !== null) values.push(v);
      const spread = extractSpread(r.stdout, ac);
      if (spread?.kind === 'ok' && Number.isFinite(spread.value)) values.spread = spread.value;
    }
    if (values.length < 2) {
      const failedSamples = raw.filter((x) => x.exitCode !== 0).length;
      results.push({
        id: ac.id, metricKey: metricKey(ac), values, recorded: false,
        note: failedSamples
          ? `need at least two successful metric readings (${failedSamples}/${raw.length} samples exited non-zero)`
          : 'need at least two successful metric readings',
      });
      continue;
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    const spread = Number.isFinite(values.spread) ? values.spread : sd;
    results.push({
      id: ac.id, metricKey: metricKey(ac), values,
      mean: Math.round(mean * 1e6) / 1e6,
      sd: Math.round(sd * 1e6) / 1e6,
      min: Math.min(...values), max: Math.max(...values),
      spread: Math.round(spread * 1e6) / 1e6,
      recorded: false,
      ...(raw.some((x) => x.exitCode !== 0) ? { note: 'some samples exited non-zero; values only from successful readings' } : {}),
    });
  }
  const digestAfter = treeDigest(root);
  const treeMoved = digestBefore !== digestAfter;
  if (!treeMoved) {
    for (const row of results) {
      if (!row.values.length) continue;
      const acId = row.id;
      state.baselines = { ...(state.baselines ?? {}), [row.metricKey]: row.mean };
      state.spreads = { ...(state.spreads ?? {}), [row.metricKey]: row.spread };
      row.recorded = true;
    }
    state.lastBaselineAt = new Date().toISOString();
    writeState(root, state);
  }
  return {
    samples: Math.max(2, samples),
    acs: results,
    recorded: !treeMoved && results.some((r) => r.recorded),
    ...(treeMoved ? { notes: ['tree changed during measurement; baselines were not recorded'] } : {}),
    ...(optimize.length === 0 ? { notes: ['no maximize/minimize ACs in the contract'] } : {}),
  };
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
export function preflightChecks(contractText, cwd = undefined, shell = undefined) {
  const warnings = [];
  const sh = resolveShell(shell);
  const { acs } = parseContract(contractText);
  for (const ac of acs) {
    const cmd = ac.check.trim();
    const head = cmd.split(/\s+/)[0];
    // 裸解释器/裸命令:非绝对路径、非内建 shell 命令
    const builtins = new Set(['test', 'echo', 'cat', 'grep', 'wc', 'ls', 'sh', 'bash', 'true', 'false', 'find', 'sort', 'head', 'tail', 'cut', 'tr', 'sed', 'awk', 'python3', 'node', 'npm', 'npx']);
    if (!head.startsWith('/') && !head.includes('=') && (head.includes('/') || head.includes('.'))) {
      warnings.push({ id: ac.id, kind: 'relative-interpreter', detail: `\`${head}\` 是相对写法;门控用 ${sh.label} 执行,坏 PATH 环境会静默失败——建议绝对路径` });
    }
    // 平台错配:Windows 默认 cmd.exe,而 POSIX 写法(test/grep/&&...)在 cmd 里
    // 不是"检查失败"而是"语法根本不存在"——必须提前点名,否则整轮门控全是 no-go。
    if (sh.kind === 'cmd' && /(^|\s)(test|printf|grep|sed|awk|chmod|head|tail|cut|tr|sort|find)\s|&&|\|\||\$\{?[A-Za-z_]/.test(cmd)) {
      warnings.push({ id: ac.id, kind: 'posix-syntax-on-cmd', detail: `check 疑似 POSIX 写法,但 Windows 门控解释器是 cmd.exe(${sh.label})——这类命令失败通常是语法不存在,不是产物不合格;改写成本机命令,或把 plugin config \`shell\` / 环境变量 GOAL_GATE_SHELL 指向 Git Bash/WSL 的 sh 绝对路径` });
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
  // 剥 `- ` 前缀:与 runGate/applyStamp 用同一套判定,否则 dashed 契约会被
  // 预检误报(而门控其实接受)。
  for (const line of contractText.split('\n')) {
    const t = line.trim().replace(/^-\s+(?=AC-\d+)/, '');
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
    ? text.split('\n').map((l) => l.trim().replace(/^-\s+(?=AC-\d+)/, '')).filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l)).length
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
    spreads: state.spreads ?? {},
    loop: loop ?? undefined,
    roundsUsed: runs.length,
    roundsRemaining: Math.max(0, (loop?.maxRounds ?? DEFAULT_MAX_ROUNDS) - runs.length),
    roundsExhausted: runs.length >= (loop?.maxRounds ?? DEFAULT_MAX_ROUNDS),
    // 账本完整性:只读面也要如实报出来(坏账本时下面的水位/闩锁都不可信)
    ledgerIntegrity: state.__integrity === 'bad' ? { ok: false, reason: state.__reason } : { ok: true },
    lastRunAt: state.lastRunAt ?? undefined,
    idle: loopIdleStatus(state, loop) ?? undefined,
    timeBudget: timeBudget ?? undefined,
    digest: digest ?? undefined,
    digestBound: bound ?? undefined,
    digestStale: Boolean(bound && digest && bound !== digest),
    // 解释器也是门控事实的一部分:Windows 默认 cmd.exe,可通过 config.shell 覆盖。
    shell: shellLabel(),
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
  const unparsed = text.split('\n').map((l) => l.trim().replace(/^-\s+(?=AC-\d+)/, '')).filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l));
  if (unparsed.length) add(violations, 'contract-malformed', `AC 行解析失败: ${unparsed.map((l) => l.split('|')[0].trim()).join(', ')}`);
  if (!parsed.objective) add(violations, 'contract-malformed', '契约缺少 objective 行');
  if (parsed.acs.length === 0) add(violations, 'contract-malformed', '契约没有 AC 行');

  const state = readState(root);
  const loop = readLoop(root);
  const history = readHistory(root);
  const loopKey = loop?.createdAt ?? 'default';
  const stamp = contractStamp(text);
  const digest = treeDigest(root);

  // 账本被改写/损坏:后面所有基于 state 的判断(闩锁/水位/批准)都不可信,
  // 直接作为最高优先级违规报出,不再往下编"看起来正常"的结论。
  if (state.__integrity === 'bad') {
    add(violations, 'ledger-tampered', `账本不可信:${state.__reason}——水位/闩锁/批准都不能采信;人工核对后删掉 .goal-gate/state.json 与 ~/.dsh/goal-gate/ 下对应密钥,从零重建`);
  }
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
  if (roundsUsed >= maxRounds) add(warnings, 'rounds-exhausted', `轮次预算已用尽(${roundsUsed}/${maxRounds})——除非门控已经 GO,否则应停下向用户汇报`);
  const tb = timeBudgetStatus(state, loop);
  if (tb?.exhausted) add(warnings, 'time-budget-exhausted', `墙钟预算已用尽(${tb.elapsedMinutes}/${tb.budgetMinutes} 分钟)——除非门控已经 GO,否则应停下向用户汇报`);
  if (loop && loop.status === 'suspended') add(warnings, 'loop-suspended', 'loop.json 标记为 suspended:这是显式等待,不是停摆;恢复前不要声明完成');
  const never = neverFailedAcs(history, parsed.acs, 2, stamp);
  // 优化类 AC 没量过基线 = 水位是空的;先跑 goal_gate_baseline。
  const missingBaseline = parsed.acs
    .filter((a) => a.expected === 'maximize' || a.expected === 'minimize')
    .filter((a) => !Object.prototype.hasOwnProperty.call(state.baselines ?? {}, metricKey(a)))
    .map((a) => a.id);
  if (missingBaseline.length) add(warnings, 'baseline-unestablished', `优化类 AC 尚无基线: ${missingBaseline.join(', ')}——先跑 goal_gate_baseline 再盖章/声明`);
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
