// core.js — goal-gate 的判定内核（纯函数，无 IO 依赖除 fs/child_process，可单测）
// 设计来源：goal-loop skill 的判命面（契约 AC 文法 + 确定性重跑门控 + digest 绑定 + R1 假完成计数）
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   - 一律返回结构化 {kind:'deny', reason, info}，绝不 throw
//   - reason 必须自带 code，让用户知道是哪层拦的
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as require$$crypto from 'node:crypto';

// ── 契约文法 ──────────────────────────────────────────────────────────
// AC-N | <yes/no statement> | check: `<cmd>` | [probe: `<cmd>`] | [metric: `<regex>`] | [baseline: delta|abs] | expected: <spec>
// spec = exit=0 | <op><number> | maximize | judged
export const AC_RE = /^(AC-\d+)\s*\|\s*([^|]+?)\s*\|\s*check:\s*`([^`]+)`\s*(?:\|\s*probe:\s*`([^`]+)`\s*)?(?:\|\s*metric:\s*`([^`]+)`\s*)?(?:\|\s*baseline:\s*(delta|abs)\s*)?\|\s*expected:\s*(.+?)\s*$/;

export function parseContract(text) {
  const acs = [];
  let objective = null;
  let exitPolicy = null;
  let deliverable = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const obj = line.match(/^objective:\s*(.+)$/i);
    if (obj) { objective = obj[1].trim(); continue; }
    const ex = line.match(/^exit:\s*(.+)$/i);
    if (ex) { exitPolicy = ex[1].trim(); continue; }
    const dl = line.match(/^deliverable:\s*(.+)$/i);
    if (dl) { deliverable = dl[1].trim(); continue; }
    const m = line.match(AC_RE);
    if (m) {
      acs.push({
        id: m[1], statement: m[2].trim(), check: m[3],
        probe: m[4] ?? null, metric: m[5] ?? null,
        baseline: m[6] ?? null, expected: m[7].trim(),
      });
    }
  }
  return { objective, acs, exitPolicy, deliverable };
}

// 盖戳：sha1-8 over AC body + `^exit:` + `^objective:` 行（R3 冻结）
export function contractStamp(text) {
  const body = text.split('\n')
    .filter((l) => /^\s*(AC-\d+|exit:|objective:|deliverable:)/i.test(l))
    .join('\n');
  return createHash('sha1').update(body).digest('hex').slice(0, 8);
}

// ── 树摘要（R7 等价物：verdict 绑定到 tree digest）─────────────────────────
// 只扫工作区根，排除账本目录本身、依赖目录、git 元数据。
// 上限保护：超过 MAX_DIGEST_FILES 就截断并标记，避免大仓库把门控卡死。
const MAX_DIGEST_FILES = 20000;
const DEFAULT_EXCLUDE = ['.goal-gate', 'node_modules', '.git', '.dsh', 'dist', 'build', '.next', 'target', 'vendor', 'out'];

export function treeDigest(dir, { exclude = DEFAULT_EXCLUDE, maxFiles = MAX_DIGEST_FILES } = {}) {
  const files = [];
  let truncated = false;
  const walk = (d) => {
    if (files.length >= maxFiles) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (exclude.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); if (truncated) return; }
      else {
        files.push(`${p}:${fs.statSync(p).size}`);
        if (files.length >= maxFiles) { truncated = true; return; }
      }
    }
  };
  walk(dir);
  return createHash('sha1').update(files.join('\n')).digest('hex').slice(0, 12) + (truncated ? '+T' : '');
}

// ── 指标提取 ──────────────────────────────────────────────────────────
// metric 正则（带一个捕获组）优先；缺省回退"取输出里最后一个数字"。
// 取不到数字一律 null —— 调用方判 unverifiable，绝不当 passed（Goodhart 防线）。
export function extractMetric(stdout, metricRe) {
  const text = String(stdout ?? '');
  if (metricRe) {
    let m;
    try { m = new RegExp(metricRe).exec(text); } catch { return null; }
    if (!m || m[1] === undefined) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  }
  return parseLastNumber(text);
}

// 从命令输出里取最后一个数字（容忍 `wc -l` 的缩进、`total: 3` 的前缀）
function parseLastNumber(stdout) {
  const m = String(stdout ?? '').match(/-?\d+(\.\d+)?/g);
  return m ? parseFloat(m[m.length - 1]) : null;
}

// ── 期望规格判定 ────────────────────────────────────────────────────────
// 返回 'passed' | 'failed' | 'unverifiable'
// opts = { metric, prev, baseline, judgeExit }
//   metric:    指标提取正则（可缺省）
//   prev:      该 AC 上一轮的指标值（maximize 判定用；undefined = 基线未建立）
//   baseline:  'delta'（严格改善）| 'abs'（不回退，缺省语义）
//   judgeExit: judged 行的确定性判官命令（probe）退出码；undefined = 无判官 → unverifiable
export function judgeExpected(expected, { exitCode, stdout }, opts = {}) {
  const spec = expected.trim();
  if (spec === 'exit=0') return exitCode === 0 ? 'passed' : 'failed';

  const op = spec.match(/^(<=|>=|<|>|==|=)\s*(-?\d+(\.\d+)?)$/);
  if (op) {
    const v = extractMetric(stdout, opts.metric);
    if (v === null) return 'unverifiable'; // 没读到数字 = 检查不可信，不能当 passed
    const n = parseFloat(op[2]);
    const ok = op[1] === '<=' ? v <= n : op[1] === '>=' ? v >= n : op[1] === '<' ? v < n : op[1] === '>' ? v > n : v === n;
    return ok ? 'passed' : 'failed';
  }

  // maximize：跟上一轮指标比。delta = 必须严格改善；abs（缺省）= 不得回退。
  // 没有基线（首轮）→ unverifiable，先建基线再判（不能空口 maximize）。
  if (spec === 'maximize') {
    const v = extractMetric(stdout, opts.metric);
    if (v === null) return 'unverifiable';
    const prev = opts.prev;
    if (prev === undefined || prev === null || !Number.isFinite(prev)) return 'unverifiable'; // baseline not established
    return opts.baseline === 'delta' ? (v > prev ? 'passed' : 'failed') : (v >= prev ? 'passed' : 'failed');
  }

  // judged：必须有确定性判官（probe）。判官退出码即结论——判官说行才行。
  // 判官缺失（127）= 判官不可用 → unverifiable（验证器坏了 ≠ 判了不行）
  if (spec === 'judged') {
    if (opts.judgeExit === undefined || opts.judgeExit === null) return 'unverifiable';
    if (opts.judgeExit === 127) return 'unverifiable';
    return opts.judgeExit === 0 ? 'passed' : 'failed';
  }

  return 'unverifiable';
}

// ── 确定性门控：自己重跑每条 check，零模型参与 ─────────────────────────────
// opts = { cwd, env, baselines }（baselines: {acId: number} 上一轮指标快照）
// 返回值新增：score / totals / baselineUpdates（调用方负责落盘）
// 指标序列的身份 = AC 编号 + check 命令哈希:同编号不同检查 = 不同指标序列(跨契约不串号),
// 同一检查被契约微调保留 = 历史连续(不回退规则跨修订生效)。
export function metricKey(ac) {
  return `${ac.id}#${createHash('sha1').update(ac.check).digest('hex').slice(0, 8)}`;
}
export function runGate(contractText, { cwd, env, baselines = {} } = {}) {
  const { objective, acs } = parseContract(contractText);
  if (!objective) return { rc: 4, reason: 'contract has no objective line', code: 'state-error' };
  if (acs.length === 0) return { rc: 4, reason: 'contract has no AC lines', code: 'state-error' };

  const stamp = contractStamp(contractText);
  const results = [];
  const baselineUpdates = {};
  let unverifiable = 0;

  for (const ac of acs) {
    const isJudged = ac.expected === 'judged';

    // R9 probe（verify-the-verifier）：普通行探针先跑，探针失败 → unverifiable。
    // judged 行例外：probe 就是判官，在 check 之后跑，其退出码即结论。
    if (ac.probe && !isJudged) {
      const probe = runCmd(ac.probe, { cwd, env });
      if (probe.exitCode !== 0) {
        results.push({ id: ac.id, status: 'unverifiable', why: 'probe failed' });
        unverifiable++;
        continue;
      }
    }

    const r = runCmd(ac.check, { cwd, env });
    let value = extractMetric(r.stdout, ac.metric);
    if (value !== null) baselineUpdates[metricKey(ac)] = value;

    // judged 行：先跑 check 产出证据（127 = 判不了），再以 probe 为判官
    let judgeExit;
    if (isJudged && ac.probe) {
      if (r.exitCode === 127) {
        results.push({ id: ac.id, status: 'unverifiable', why: 'check command missing', value: value ?? undefined });
        unverifiable++;
        continue;
      }
      judgeExit = runCmd(ac.probe, { cwd, env }).exitCode;
    }

    let status = judgeExpected(ac.expected, r, {
      metric: ac.metric, baseline: ac.baseline,
      prev: baselines[metricKey(ac)], judgeExit,
    });
    // 质量分进指标管道:judged 结论里的 `score: <0..1|0..10>` 记为该 AC 的指标值,
    // 可配 baseline: delta(逐轮必须更逼真/更优)——质量不许停在"刚好过检"。
    if (ac.expected === 'judged') {
      const sc = /(?:^|\n)\s*score:\s*([0-9]+(?:\.[0-9]+)?)/.exec(r.stdout ?? '');
      if (sc) {
        let v = parseFloat(sc[1]);
        if (v > 1) v = v / 10; // 接受 0-10 打分,归一到 0-1
        value = v;             // judged 行的指标值 = 质量分(不走 stdout 数字兜底)
        baselineUpdates[metricKey(ac)] = v;
      }
    }
    // judged 证据摘要绑定(R7 for judgments):评审必须引用 artifact: + digest:,
    // 且摘要与当前文件一致——评过的不是现在要发的 → 作废(unverifiable)。
    if (ac.expected === 'judged' && status === 'passed') {
      const art = /(?:^|\n)\s*artifact:\s*(\S+)/.exec(r.stdout ?? '');
      const dig = /(?:^|\n)\s*digest:\s*(?:sha256:)?([a-f0-9]{64})/i.exec(r.stdout ?? '');
      if (art && dig) {
        try {
          const buf = require$$crypto.createHash('sha256').update(fs.readFileSync(path.resolve(cwd ?? '.', art[1]))).digest('hex');
          if (buf !== dig[1].toLowerCase()) { status = 'unverifiable'; }
        } catch { status = 'unverifiable'; }
      } else {
        // 强制纪律:无证据绑定的评审 = 无凭据的判断 → 作废。
        // (向后兼容路径本身构成同类漏洞:评审说 PASS 却无从追溯看了什么。)
        status = 'unverifiable';
      }
    }
    // 命令本身找不到（127）也算不可信
    if (r.exitCode === 127 || /command not found|not found/i.test(r.stderr)) status = 'unverifiable';
    results.push({ id: ac.id, status, exitCode: r.exitCode, stdout: r.stdout.slice(-200), value: value ?? undefined });
    if (status === 'unverifiable') unverifiable++;
  }

  const ratio = unverifiable / acs.length;
  const score = results.filter((x) => x.status === 'passed').length / acs.length;
  const totals = {
    passed: results.filter((x) => x.status === 'passed').length,
    failed: results.filter((x) => x.status === 'failed').length,
    unverifiable,
  };

  if (ratio > 1 / 3) return { rc: 2, reason: `unverifiable ratio ${ratio.toFixed(2)} > 1/3`, code: 'unverifiable', results, stamp, score, totals, baselineUpdates };

  const failed = results.filter((r2) => r2.status === 'failed');
  if (failed.length === 0) {
    // 全 passed 才 GO；有 unverifiable 但比例 ≤1/3 时不算 GO，但也不算 fail —— 报告里带出来
    return { rc: 0, reason: 'GO', code: 'go', results, stamp, score, totals, baselineUpdates, note: unverifiable ? `${unverifiable} AC(s) unverifiable (≤1/3)` : undefined };
  }
  return { rc: 2, reason: `NO-GO: ${failed.map((f) => f.id).join(', ')}`, code: 'no-go', results, stamp, score, totals, baselineUpdates };
}

function runCmd(cmd, { cwd, env } = {}) {
  try {
    const stdout = execFileSync('/bin/sh', ['-c', cmd], {
      cwd, env: { ...process.env, ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e) {
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

// ── R1 假完成计数 → BLOCKED ──────────────────────────────────────────────
export function falseCompleteRule(count) { return count >= 2 ? 'BLOCKED' : 'OK'; }

// ── 契约模板（好用：init 生成骨架，用户照着填）────────────────────────────
export const CONTRACT_TEMPLATE = `objective: <一句话目标>
deliverable: <交付物本体路径——一切验收与评审的锚点>
# 可选治理策略：exit: goal-only = 任务级完成声明只记账不硬拦（多任务循环用）；缺省 = strict 全硬拦
# AC 每行一条：AC-N | 判定语句 | check: \`命令\` | [probe: \`探针\`] | [metric: \`指标正则(带一个捕获组)\`] | [baseline: delta|abs] | expected: <规格>
# 规格 = exit=0 | <=N | >=N | <N | >N | =N | maximize | judged
# check 必须是能真的失败的具名命令（环境依赖、空值、错误路径都要写进去）
# 验证金字塔：数据检查 → 产物检查 → 【运行时检查：在真实运行环境执行交付物】→ 对交付物本体的评审
AC-1 | <运行时验收：在真实运行环境执行交付物本体> | check: \`<运行时执行命令，必须碰 deliverable>\` | expected: exit=0
AC-2 | <产物/数据检查> | check: \`test -f <产物路径>\` | expected: exit=0
# judged 评审纪律：结论文件必须含 artifact: <评审所见文件> 与 digest: sha256:<其摘要> 两行，
# 且 artifact 必须是 deliverable 本体（或直接截自它的运行时输出）——否则评审无效
AC-3 | 质量分达标(最逼真/最优类目标必填) | check: \`cat <评审结论文件>\` | metric: \`score: ([0-9.]+)\` | expected: >=0.85
# 逐轮改善用 baseline: delta(每轮质量必须更高);全过但质量不足 → 轮次继续
`;
