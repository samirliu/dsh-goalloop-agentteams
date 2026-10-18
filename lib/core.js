// core.js — goal-gate 的判定内核（纯函数，无 IO 依赖除 fs/child_process，可单测）
// 设计来源：goal-loop skill 的判命面（契约 AC 文法 + 确定性重跑门控 + digest 绑定 + R1 假完成计数）
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   - 一律返回结构化 {kind:'deny', reason, info}，绝不 throw
//   - reason 必须自带 code，让用户知道是哪层拦的
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as require$$crypto from 'node:crypto';

// ── 契约文法 ──────────────────────────────────────────────────────────
// AC-N | <yes/no statement> | check: `<cmd>` | [probe: `<cmd>`] | [metric: `<regex>`] | [baseline: delta|abs] | expected: <spec>
// spec = exit=0 | <op><number> | maximize | judged
export const AC_RE = /^(AC-\d+)\s*\|\s*([^|]+?)\s*\|\s*check:\s*`([^`]+)`\s*(?:\|\s*probe:\s*`([^`]+)`\s*)?(?:\|\s*metric:\s*`([^`]+)`\s*)?(?:\|\s*baseline:\s*(delta|abs)\s*)?(?:\|\s*timeout:\s*(\d+)\s*)?(?:\|\s*tolerance:\s*([0-9.]+)\s*)?(?:\|\s*sd:\s*`([^`]+)`\s*)?(?:\|\s*var:\s*`([^`]+)`\s*)?(?:\|\s*calib:\s*good=(\S+)\s+bad=(\S+)\s*)?(?:\|\s*scope:\s*([^|]+?)\s*)?(?:\|\s*depends:\s*([^|]+?)\s*)?\|\s*expected:\s*(.+?)\s*$/;

// ── Team orchestration metadata (scope:/depends:) ─────────────────────────
// These fields do not judge the artifact; they make dispatch correct. A bad
// dependency graph is a contract defect (fail-closed like an unparsed AC).
export function validateTeamMeta(acs) {
  const ids = new Set(acs.map((a) => a.id));
  for (const ac of acs) {
    for (const dep of ac.depends ?? []) {
      if (!ids.has(dep)) return `${ac.id} depends on unknown AC "${dep}"`;
      if (dep === ac.id) return `${ac.id} depends on itself`;
    }
  }
  const state = new Map();
  const visit = (id, trail) => {
    const mark = state.get(id);
    if (mark === 2) return null;
    if (mark === 1) return `dependency cycle: ${[...trail, id].join(' -> ')}`;
    state.set(id, 1);
    const ac = acs.find((a) => a.id === id);
    for (const dep of ac?.depends ?? []) {
      const err = visit(dep, [...trail, id]);
      if (err) return err;
    }
    state.set(id, 2);
    return null;
  };
  for (const ac of acs) {
    const err = visit(ac.id, []);
    if (err) return err;
  }
  return null;
}

export function parseContract(text) {
  const acs = [];
  let objective = null;
  let exitPolicy = null;
  let deliverable = null;
  for (const raw of text.split('\n')) {
    // 兼容 goal-loop 原生写法 `- AC-N | ...`:dash 只是 markdown 列表标记
    const line = raw.trim().replace(/^-\s+(?=AC-\d+)/, '');
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
        baseline: m[6] ?? null, timeout: m[7] ? parseInt(m[7], 10) : null,
        tolerance: m[8] !== undefined ? parseFloat(m[8]) : null,
        sd: m[9] ?? null, variance: m[10] ?? null,
        calibGood: m[11] ?? null, calibBad: m[12] ?? null,
        scope: m[13] ? m[13].split(',').map((x) => x.trim()).filter(Boolean) : [],
        depends: m[14] ? m[14].split(',').map((x) => x.trim()).filter(Boolean) : [],
        expected: m[15].trim(),
      });
    }
  }
  return { objective, acs, exitPolicy, deliverable };
}

/**
 * Recursively strip `undefined`-valued properties so a tool result survives the
 * harness transport intact: the in-process wire validator rejects values that
 * are not losslessly JSON-compatible (nested undefined / non-finite numbers),
 * so an otherwise-correct tool output would fail with "value is not lossless
 * JSON". NaN/±Infinity become null (JSON has no syntax for them).
 */
export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : jsonSafe(v)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Reflect.ownKeys(value)) {
      if (typeof k !== 'string') continue;
      const v = value[k];
      if (v !== undefined) out[k] = jsonSafe(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

// 盖戳：sha1-8 over AC body + `^exit:` + `^objective:` 行（R3 冻结）
export function contractStamp(text) {
  const body = text.split('\n')
    .filter((l) => /^\s*(?:-\s+)?(AC-\d+|exit:|objective:|deliverable:)/i.test(l))
    .join('\n');
  return createHash('sha1').update(body).digest('hex').slice(0, 8);
}

// ── 树摘要（R7 等价物：verdict 绑定到 tree digest）─────────────────────────
// 只扫工作区根，排除账本目录本身、依赖目录、git 元数据。
// 上限保护：超过 MAX_DIGEST_FILES 就截断并标记，避免大仓库把门控卡死。
const MAX_DIGEST_FILES = 20000;
// 只排除真正的"非交付面":账本自身、依赖、git 元数据、DSH 配置。
// 旧版连 dist/build/out 一起排除 = 交付物常常正好在里面 → 摘要对交付物失明。
const DEFAULT_EXCLUDE = ['.goal-gate', 'node_modules', '.git', '.dsh'];
const DIGEST_CONTENT_LIMIT = 2 * 1024 * 1024; // 2MB 以内直接内容哈希;更大用 size+mtime

function fingerprintFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.size <= DIGEST_CONTENT_LIMIT) {
      return `${p}:${st.size}:${createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`;
    }
    return `${p}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${p}:unreadable`;
  }
}

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
        files.push(fingerprintFile(p));
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
  // 剥 ANSI 颜色序列:真实 CLI 会染色输出,控制序列会把正则匹配切断
  const text = String(stdout ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (metricRe) {
    let m;
    try { m = new RegExp(metricRe).exec(text); } catch { return null; }
    if (!m) return null;
    // 交替正则(如 \`a=(\d+)|b=(\d+)\`)可能命中第二分支——取首个非空捕获组,
    // 否则空捕获会把可测指标误判为 unverifiable(取数歧义)。
    const cap = m.slice(1).find((g) => g !== undefined);
    if (cap === undefined) return null;
    const v = parseFloat(cap);
    return Number.isFinite(v) ? v : null;
  }
  return parseLastNumber(text);
}

// 从命令输出里取最后一个数字（容忍 `wc -l` 的缩进、`total: 3` 的前缀）
function parseLastNumber(stdout) {
  const m = String(stdout ?? '').match(/-?\d+(\.\d+)?/g);
  return m ? parseFloat(m[m.length - 1]) : null;
}

// ── 噪声带（sd:/var:，PROVE 的统计面）────────────────────────────────────
// `sd:` 直接读标准差，`var:` 读方差后开方（docs 语义：var 也要 sqrt'd）。
// 声明了却匹配不到 = 取数仪器坏了：调用方必须判 BROKEN，绝不许静默退化成
// 无噪声带的精确比较（那是把测量噪声当真实回退/改善）。
// 返回 { value, kind } 或 null（未声明 / 匹配失败 / 非法数字）。
export function extractSpread(stdout, ac = {}) {
  const re = ac.sd ?? ac.variance;
  if (!re) return null;
  const text = String(stdout ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let m;
  try { m = new RegExp(re).exec(text); } catch { return { kind: 'invalid', value: null }; }
  if (!m) return { kind: 'unmatched', value: null };
  const cap = m.slice(1).find((g) => g !== undefined);
  if (cap === undefined) return { kind: 'unmatched', value: null };
  let v = parseFloat(cap);
  if (!Number.isFinite(v)) return { kind: 'invalid', value: null };
  if (ac.variance && !ac.sd) v = Math.sqrt(Math.max(0, v));
  return { kind: 'ok', value: Math.max(0, v) };
}

// ── 期望规格判定 ────────────────────────────────────────────────────────
// 返回 'passed' | 'failed' | 'unverifiable'
// opts = { metric, prev, baseline, tolerance, spread, judgeExit }
//   metric:    指标提取正则（可缺省）
//   prev:      该 AC 上一轮被接受的指标值（maximize/minimize 判定用；undefined = 基线未建立）
//   baseline:  'delta'（严格改善）| 'abs'（不回退，缺省语义）
//   tolerance: 相对容差（如 0.08 = ±8%），吸收基准测量噪声
//   spread:    sd:/var: 读到的实测标准差（绝对量）；噪声带 = max(2*spread/|prev|, tolerance)
//   judgeExit: judged 行的确定性判官命令（probe）退出码；undefined = 无判官 → unverifiable
export function judgeExpected(expected, { exitCode, stdout }, opts = {}) {
  const spec = expected.trim();
  // exit=N:断言必须以特定退出码结束(N=0 成功;N>0 = 必须以该错误码失败——
  // 错误路径是验收的一等公民,之前只能表达 exit=0,其余被静默判 unverifiable)。
  const exSpec = spec.match(/^exit=(\d+)$/);
  if (exSpec) return exitCode === parseInt(exSpec[1], 10) ? 'passed' : 'failed';

  const op = spec.match(/^(<=|>=|<|>|==|=|!=)\s*(-?\d+(\.\d+)?)$/);
  if (op) {
    const v = extractMetric(stdout, opts.metric);
    if (v === null) return 'unverifiable'; // 没读到数字 = 检查不可信，不能当 passed
    const n = parseFloat(op[2]);
    const ok = op[1] === '<=' ? v <= n : op[1] === '>=' ? v >= n : op[1] === '<' ? v < n : op[1] === '>' ? v > n : op[1] === '!=' ? v !== n : v === n;
    return ok ? 'passed' : 'failed';
  }

  // maximize / minimize：跟上一轮被接受的指标比。
  // delta = 必须严格改善；abs（缺省）= 不得回退。
  // 没有基线（首轮）→ unverifiable，先建基线再判（不能空口 maximize）。
  // 噪声带来自声明：tolerance 是作者经验，sd:/var: 是数据自己的噪声（取较大者）。
  if (spec === 'maximize' || spec === 'minimize') {
    const v = extractMetric(stdout, opts.metric);
    if (v === null) return 'unverifiable';
    const prev = opts.prev;
    // 首次测量 = 建立水位,记为 PASS(goal-loop numeric 语义);后续才比较。
    // 因而 `baseline: delta` 的"必须改善"从第二轮起生效,首轮是基线。
    if (prev === undefined || prev === null || !Number.isFinite(prev)) return 'passed';
    const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : 0;
    const spread = Number.isFinite(opts.spread) ? opts.spread : 0;
    const relative = Math.max(tol, prev !== 0 ? (2 * spread) / Math.abs(prev) : 0);
    // prev=0 时相对带退化,退回绝对噪声带 2*spread(否则精确比较 0 附近噪声)。
    const band = prev !== 0 ? relative * Math.abs(prev) : 2 * spread;
    // 负指标也成立：改善方向按 spec 走，噪声带按 |prev| 缩放。
    if (spec === 'maximize') {
      return opts.baseline === 'delta' ? (v > prev + band ? 'passed' : 'failed') : (v >= prev - band ? 'passed' : 'failed');
    }
    return opts.baseline === 'delta' ? (v < prev - band ? 'passed' : 'failed') : (v <= prev + band ? 'passed' : 'failed');
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
export function runGate(contractText, { cwd, env, baselines = {}, spreads = {} } = {}) {
  // fail-closed:AC 样行解析失败 = 契约畸形,拒评而不是评一份不完整的契约
  // (静默丢弃 AC 会让评估面开天窗,是最危险的缺陷类别)。
  const t0 = Date.now(); // 门控自计时:整轮多慢必须可从账本看出来(停摆诊断)
  const unparsed = contractText.split('\n')
    .map((l) => l.trim().replace(/^-\s+(?=AC-\d+)/, ''))
    .filter((l) => /^AC-\d+/.test(l) && !AC_RE.test(l));
  if (unparsed.length) {
    return { rc: 4, code: 'state-error', ms: Date.now() - t0, reason: `unparseable AC line(s): ${unparsed.map((l) => l.split('|')[0].trim()).join(', ')}(常见原因:check 内嵌反引号;请用 \$(...) 或拆分)` };
  }
  const { objective, acs } = parseContract(contractText);
  if (!objective) return { rc: 4, reason: 'contract has no objective line', code: 'state-error', ms: Date.now() - t0 };
  if (acs.length === 0) return { rc: 4, reason: 'contract has no AC lines', code: 'state-error', ms: Date.now() - t0 };
  // 重复 AC 编号 = 验收面重叠/歧义,静默接受等于允许一条被另一条覆盖(fail-closed)。
  const seen = new Set();
  const dups = [];
  for (const ac of acs) { if (seen.has(ac.id)) dups.push(ac.id); seen.add(ac.id); }
  if (dups.length) return { rc: 4, reason: `duplicate AC id(s): ${[...new Set(dups)].join(', ')}`, code: 'state-error', ms: Date.now() - t0 };
  const teamMetaError = validateTeamMeta(acs);
  if (teamMetaError) return { rc: 4, reason: teamMetaError, code: 'state-error', ms: Date.now() - t0 };

  const stamp = contractStamp(contractText);
  const digestBefore = cwd ? treeDigest(cwd) : null;
  const results = [];
  const baselineUpdates = {};
  const spreadUpdates = {};
  let unverifiable = 0;
  let broken = 0;

  for (const ac of acs) {
    const isJudged = ac.expected === 'judged';

    // R9 probe（verify-the-verifier）：普通行探针先跑，探针失败 → unverifiable。
    // judged 行例外：probe 就是判官，在 check 之后跑，其退出码即结论。
    if (ac.probe && !isJudged) {
      const probe = runCommand(ac.probe, { cwd, env, timeout: (ac.timeout ?? 30) * 1000 });
      if (probe.exitCode !== 0) {
        results.push({ id: ac.id, status: 'broken', why: `probe failed (rc=${probe.exitCode}): measurement untrusted — fix the instrument before the number` });
        broken++;
        continue;
      }
    }

    const r = runCommand(ac.check, { cwd, env, timeout: (ac.timeout ?? 30) * 1000 });
    let value = extractMetric(r.stdout, ac.metric);
    if (value !== null) baselineUpdates[metricKey(ac)] = value;

    // PROVE:sd:/var: 声明了就必须量到——量不到 = 取数仪器坏了(fail-closed),
    // 不许退化成无噪声带的精确比较。只有优化类规格才需要噪声带。
    const needsSpread = Boolean(ac.sd || ac.variance) && /^(maximize|minimize)$/.test(ac.expected);
    let spread;
    if (needsSpread) {
      const spreadInfo = extractSpread(r.stdout, ac);
      // 声明了 sd:/var: 就必须量到(PROVE);baseline 记录的 spread 只服务于
      // 没声明离散度仪器的 optimize AC(走 else 分支)。
      if (spreadInfo?.kind === 'ok') { spread = spreadInfo.value; spreadUpdates[metricKey(ac)] = spread; }
      else {
        results.push({
          id: ac.id, status: 'broken',
          why: `spread instrument ${spreadInfo?.kind ?? 'unmatched'}: sd:/var: 声明了但输出里取不到离散度——验证器坏了 ≠ 指标不合格(补正则或删声明)`,
          exitCode: r.exitCode, stdout: (r.stdout || '').slice(-300), stderr: (r.stderr || '').slice(-300) || undefined,
          value: value ?? undefined,
        });
        broken++;
        continue;
      }
    } else if (Number.isFinite(spreads[metricKey(ac)])) {
      spread = spreads[metricKey(ac)];
    }

    // judged 行：先跑 check 产出证据（127 = 判不了），再以 probe 为判官
    let judgeExit;
    if (isJudged && ac.probe) {
      if (r.exitCode === 127 && ac.expected !== 'exit=127') {
        results.push({ id: ac.id, status: 'broken', why: 'check command missing (rc=127) — 验证器坏了 ≠ 评审不过', stdout: (r.stdout || '').slice(-300), stderr: (r.stderr || '').slice(-300) || undefined, value: value ?? undefined });
        broken++;
        continue;
      }
      judgeExit = runCommand(ac.probe, { cwd, env, timeout: (ac.timeout ?? 30) * 1000 }).exitCode;
    }

    let status = judgeExpected(ac.expected, r, {
      metric: ac.metric, baseline: ac.baseline, tolerance: ac.tolerance,
      spread, prev: baselines[metricKey(ac)], judgeExit,
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
    // why 声明提前:作废原因必须指名道姓(缺陷 #13)——unverifiable 不该是一条哑巴结论。
    let why;
    // judged 证据摘要绑定(R7 for judgments):评审必须引用 artifact: + digest:,
    // 且摘要与当前文件一致——评过的不是现在要发的 → 作废(unverifiable)。
    if (ac.expected === 'judged' && status === 'passed') {
      const art = /(?:^|\n)\s*artifact:\s*(\S+)/.exec(r.stdout ?? '');
      const dig = /(?:^|\n)\s*digest:\s*(?:sha256:)?([a-f0-9]{64})/i.exec(r.stdout ?? '');
      if (art && dig) {
        try {
          const buf = require$$crypto.createHash('sha256').update(fs.readFileSync(path.resolve(cwd ?? '.', art[1]))).digest('hex');
          if (buf !== dig[1].toLowerCase()) { status = 'broken'; why = `judged evidence stale: ${art[1]} 的当前 sha256 与结论声明的 digest 不一致——评审对象已变(重跑评审并写回新摘要)`; }
        } catch (e) { status = 'broken'; why = `judged evidence unreadable: artifact ${art[1]} 读不到(${e.code ?? e.message})`; }
      } else {
        // 强制纪律:无证据绑定的评审 = 无凭据的判断 → 作废。
        // (向后兼容路径本身构成同类漏洞:评审说 PASS 却无从追溯看了什么。)
        status = 'broken';
        why = 'judged evidence unbound: 结论必须含两行 `artifact: <评审所见文件路径>` 与 `digest: sha256:<64位hex>`(digest=该文件当前摘要)——缺任一行的 PASS 视为无凭据评审';
      }
    }
    // PROVE(判断面):calib 夹具 = 判读席的已知好/已知坏校准。
    // 判读席必须证明自己能把已知坏判 FAIL,否则它对真实产物的 PASS 不可信。
    if (ac.expected === 'judged' && status === 'passed' && (ac.calibGood || ac.calibBad)) {
      if (!ac.calibGood || !ac.calibBad) {
        status = 'broken';
        why = 'calibration broken: calib: 必须同时声明 good=<已知好夹具> 与 bad=<已知坏夹具>(单边声明无法校准判读席)';
      } else {
        const resolveFixture = (f) => path.resolve(cwd ?? '.', f);
        const goodExists = fs.existsSync(resolveFixture(ac.calibGood));
        const badExists = fs.existsSync(resolveFixture(ac.calibBad));
        if (!goodExists || !badExists) {
          status = 'broken';
          why = `calibration broken: 夹具不存在(${[!goodExists ? ac.calibGood : null, !badExists ? ac.calibBad : null].filter(Boolean).join(', ')})——夹具缺失 ≠ 评审不过,但判读席无法校准`;
        } else if (!/calib-good:\s*PASS/i.test(r.stdout ?? '') || !/calib-bad:\s*FAIL/i.test(r.stdout ?? '')) {
          status = 'broken';
          why = 'calibration unbound: 结论必须含 `calib-good: PASS` 与 `calib-bad: FAIL` 两行(判读席对已知好/坏夹具的评级)——缺任一行或评级不符 = 判读席未校准';
        }
      }
    }
    // 验证器执行层面的故障 = BROKEN(决定性 NO-GO),不是"不可验证"的软状态。
    // 例外:AC 显式要求 exit=124/127 的,那是错误路径断言,照常判。
    if (r.exitCode === 124 && ac.expected !== 'exit=124') { status = 'broken'; why = 'check timed out (rc=124) — 验证器超时 ≠ 产物不合格'; }
    else if (r.exitCode === 127 && ac.expected !== 'exit=127') { status = 'broken'; why = 'check command missing (rc=127) — 验证器坏了 ≠ 产物不合格'; }
    else if (r.exitCode > 128) { status = 'broken'; why = `check killed by signal (rc=${r.exitCode})`; }
    else if (/command not found|not found/i.test(r.stderr) && ac.expected !== 'exit=127') { status = 'broken'; why = 'check command not found (stderr) — 验证器坏了 ≠ 产物不合格'; }
    const tail = (s) => (s || '').slice(-300);
    // fail-loud:数值规格却取不到指标值 = 测量仪器坏了(BROKEN),不是可放行的 unverifiable
    if (value === null && /^(<=|>=|<|>|==|=|!=|maximize|minimize)/.test(ac.expected)) {
      status = 'broken';
      why = 'metric not found in output (metric regex mismatch or no number) — 测量仪器坏了 ≠ 指标不合格';
    }
    // judged 的两种哑巴 unverifiable(无判官 / 判官命令缺失)同样必须指名道姓(缺陷 #13)
    if (ac.expected === 'judged' && (status === 'unverifiable' || status === 'broken') && !why) {
      if (!ac.probe) { status = 'broken'; why = 'judged 行缺少判官:需要 probe: `<命令>`,其退出码即结论——没有判官的 judged 无法验证'; }
      else if (judgeExit === 127) { status = 'broken'; why = 'judge command unavailable: probe 不存在或不可执行(exit 127)——验证器坏了 ≠ 评审不过'; }
      else if (status === 'unverifiable') { status = 'broken'; why = 'judged verdict unreachable: 判官未给出可采信结论'; }
    }
    // 无法路由的期望规格 = 契约缺陷(不是"暂时不可验证"),fail-closed。
    if (status === 'unverifiable' && !/^(exit=\d+$|(?:<=|>=|<|>|==|=|!=)\s*-?\d|maximize$|minimize$|judged$)/.test(ac.expected)) {
      status = 'broken';
      why = `unroutable expectation "${ac.expected}" — 规格必须是 exit=N / 比较式 / maximize / minimize / judged`;
    }
    // delta 饱和诊断:指标停在基线原地踏步 = delta 目标永不可达(封顶指标用 delta 是
    // 作者陷阱),必须说清楚,而不是默默 failed。
    if ((ac.expected === 'maximize' || ac.expected === 'minimize') && ac.baseline === 'delta' && value !== null
        && baselines[metricKey(ac)] !== undefined && value === baselines[metricKey(ac)]) {
      why = 'delta target unreachable: metric saturated at baseline (考虑 tolerance/sd、baseline: abs,或提高可达成上限)';
    }
    results.push({ id: ac.id, status, exitCode: r.exitCode, why, stdout: tail(r.stdout), stderr: tail(r.stderr) || undefined, value: value ?? undefined, ...(spread !== undefined ? { spread } : {}) });
    if (status === 'unverifiable') unverifiable++;
    if (status === 'broken') broken++;
  }

  const ratio = unverifiable / acs.length;
  const score = results.filter((x) => x.status === 'passed').length / acs.length;
  const totals = {
    passed: results.filter((x) => x.status === 'passed').length,
    failed: results.filter((x) => x.status === 'failed').length,
    broken,
    unverifiable,
  };
  const digestAfter = cwd ? treeDigest(cwd) : null;
  const treeMoved = digestBefore !== null && digestAfter !== null && digestBefore !== digestAfter;
  const digestFields = { ...(digestBefore ? { digestBefore } : {}), ...(digestAfter ? { digestAfter } : {}), ...(treeMoved ? { treeMoved: true } : {}) };

  // 检查自身改了工作区 = 评测在动被测对象:结论不可绑定,NO-GO(goal-loop check-mutated-tree)。
  if (treeMoved) {
    return { rc: 2, code: 'check-mutated-tree', reason: `check mutated the tree during evaluation (${digestBefore} → ${digestAfter})——评测期间改产物,结论无效;测量写缓存请放 .goal-gate/ 下`, results, stamp, score, totals, baselineUpdates, spreadUpdates, ms: Date.now() - t0, ...digestFields };
  }

  // BROKEN 是决定性的:验证器/测量仪器坏了不许被当成"比例内可放行的 unverifiable"。
  const brokenRows = results.filter((r2) => r2.status === 'broken');
  if (brokenRows.length) {
    return { rc: 2, code: 'broken', reason: `BROKEN: ${brokenRows.map((f) => `${f.id}${f.why ? ` (${f.why})` : ''}`).join(', ')}`, results, stamp, score, totals, baselineUpdates, spreadUpdates, ms: Date.now() - t0, ...digestFields };
  }

  if (ratio > 1 / 3) return { rc: 2, reason: `unverifiable ratio ${ratio.toFixed(2)} > 1/3`, code: 'unverifiable', results, stamp, score, totals, baselineUpdates, spreadUpdates, ms: Date.now() - t0, ...digestFields };

  const failed = results.filter((r2) => r2.status === 'failed');
  if (failed.length === 0) {
    // 全 passed 且没有 BROKEN 才 GO;unverifiable ≤1/3 允许 GO 但如实带出来。
    return { rc: 0, reason: 'GO', code: 'go', results, stamp, score, totals, baselineUpdates, spreadUpdates, ms: Date.now() - t0, ...(unverifiable ? { note: `${unverifiable} AC(s) unverifiable (≤1/3)` } : {}), ...digestFields };
  }
  return { rc: 2, reason: `NO-GO: ${failed.map((f) => f.id).join(', ')}`, code: 'no-go', results, stamp, score, totals, baselineUpdates, spreadUpdates, ms: Date.now() - t0, ...digestFields };
}

export function runCommand(cmd, { cwd, env, timeout = 30_000 } = {}) {
  // spawnSync:成功与失败都能拿到 stderr —— 失败原因常常只在 stderr,
  // 丢了它 = 门控只报"failed"却给不出任何诊断(评估系统必须 fail-loud)。
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd, env: { ...process.env, ...env },
    encoding: 'utf8', timeout,
  });
  return {
    // spawnSync 超时会在 status===null 且 signal 有值:映射为 124(goal-loop 的超时码),
    // 让"验证器超时"能被判成 BROKEN 而不是普通 failed。
    exitCode: r.status !== null && r.status !== undefined ? r.status : (r.signal === 'SIGTERM' ? 124 : 128),
    signal: r.signal ?? undefined,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// ── R1 假完成计数 → BLOCKED ──────────────────────────────────────────────
export function falseCompleteRule(count) { return count >= 2 ? 'BLOCKED' : 'OK'; }

// ── 契约模板（好用：init 生成骨架，用户照着填）────────────────────────────
export const CONTRACT_TEMPLATE = `objective: <一句话目标>
deliverable: <交付物本体路径——一切验收与评审的锚点>
# 可选治理策略：exit: goal-only = 任务级完成声明只记账不硬拦（多任务循环用）；缺省 = strict 全硬拦
# AC 每行一条：AC-N | 判定语句 | check: \`命令\` | [probe: \`探针\`] | [metric: \`指标正则(带一个捕获组)\`] | [baseline: delta|abs] | [timeout: <秒,缺省30>] | [tolerance: <相对容差,如 0.08>] | [sd: \`离散度正则\` | var: \`方差正则\`] | [calib: good=<已知好夹具> bad=<已知坏夹具>] | expected: <规格>
# 规格 = exit=0 | exit=N | <=N | >=N | <N | >N | =N | maximize | minimize | judged
# check 必须是能真的失败的具名命令（环境依赖、空值、错误路径都要写进去）
# 验证金字塔：数据检查 → 产物检查 → 【运行时检查：在真实运行环境执行交付物】→ 对交付物本体的评审
AC-1 | <运行时验收：在真实运行环境执行交付物本体> | check: \`<运行时执行命令，必须碰 deliverable>\` | expected: exit=0
AC-2 | <产物/数据检查> | check: \`test -f <产物路径>\` | expected: exit=0
# judged 评审纪律：结论文件必须含 artifact: <评审所见文件> 与 digest: sha256:<其摘要> 两行，
# 且 artifact 必须是 deliverable 本体（或直接截自它的运行时输出）——否则评审无效
# 判读席校准（PROVE）：声明 calib: good=<已知好> bad=<已知坏> 时，结论还必须含
# calib-good: PASS 与 calib-bad: FAIL 两行，证明判读席能把已知坏判出来
AC-3 | 质量分达标(最逼真/最优类目标必填) | check: \`cat <评审结论文件>\` | metric: \`score: ([0-9.]+)\` | expected: >=0.85
# 逐轮改善用 baseline: delta(每轮质量必须更高);指标有测量噪声时用 tolerance/sd/var
# 最小化类目标用 expected: minimize(如体积/耗时/成本);全过但质量不足 → 轮次继续
`;
