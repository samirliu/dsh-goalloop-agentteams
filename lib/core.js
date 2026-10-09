// core.js — goal-gate 的判定内核（纯函数，无 IO 依赖除 fs/child_process，可单测）
// 设计来源：goal-loop skill 的判命面（契约 AC 文法 + 确定性重跑门控 + digest 绑定 + R1 假完成计数）
// 实测约束（/tmp/goal-gate-probe/order_probe.mjs）：
//   - 一律返回结构化 {kind:'deny', reason, info}，绝不 throw
//   - reason 必须自带 code，让用户知道是哪一层拦的
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── 契约文法 ──────────────────────────────────────────────────────────
// AC-N | <yes/no statement> | check: `<cmd>` | [probe: `<cmd>`] | [baseline: delta|abs] | expected: <spec>
// spec = exit=0 | <op><number> | maximize | judged
export const AC_RE = /^(AC-\d+)\s*\|\s*([^|]+?)\s*\|\s*check:\s*`([^`]+)`\s*(?:\|\s*probe:\s*`([^`]+)`\s*)?(?:\|\s*baseline:\s*(delta|abs)\s*)?\|\s*expected:\s*(.+?)\s*$/;

export function parseContract(text) {
  const acs = [];
  let objective = null;
  let exitPolicy = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const obj = line.match(/^objective:\s*(.+)$/i);
    if (obj) { objective = obj[1].trim(); continue; }
    const ex = line.match(/^exit:\s*(.+)$/i);
    if (ex) { exitPolicy = ex[1].trim(); continue; }
    const m = line.match(AC_RE);
    if (m) {
      acs.push({
        id: m[1], statement: m[2].trim(), check: m[3],
        probe: m[4] ?? null, baseline: m[5] ?? null, expected: m[6].trim(),
      });
    }
  }
  return { objective, acs, exitPolicy };
}

// 盖戳：sha1-8 over AC body + `^exit:` + `^objective:` 行（R3 冻结）
export function contractStamp(text) {
  const body = text.split('\n')
    .filter((l) => /^\s*(AC-\d+|exit:|objective:)/i.test(l))
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

// ── 期望规格判定 ────────────────────────────────────────────────────────
// 返回 'passed' | 'failed' | 'unverifiable'
export function judgeExpected(expected, { exitCode, stdout }) {
  const spec = expected.trim();
  if (spec === 'exit=0') return exitCode === 0 ? 'passed' : 'failed';

  const op = spec.match(/^(<=|>=|<|>|==|=)\s*(-?\d+(\.\d+)?)$/);
  if (op) {
    const v = parseLastNumber(stdout);
    if (v === null) return 'unverifiable'; // 没读到数字 = 检查不可信，不能当 passed
    const n = parseFloat(op[2]);
    const ok = op[1] === '<=' ? v <= n : op[1] === '>=' ? v >= n : op[1] === '<' ? v < n : op[1] === '>' ? v > n : v === n;
    return ok ? 'passed' : 'failed';
  }

  // maximize / judged 无法用命令行确定真伪（需 baseline 或冷席判官）
  // —— 标为 unverifiable 而非 passed，避免永真式（R9/R11 的 Goodhart 防线）
  return 'unverifiable';
}

// 从命令输出里取最后一个数字（容忍 `wc -l` 的缩进、`total: 3` 的前缀）
function parseLastNumber(stdout) {
  const m = String(stdout ?? '').match(/-?\d+(\.\d+)?/g);
  return m ? parseFloat(m[m.length - 1]) : null;
}

// ── 确定性门控：自己重跑每条 check，零模型参与 ─────────────────────────────
export function runGate(contractText, { cwd, env } = {}) {
  const { objective, acs } = parseContract(contractText);
  if (!objective) return { rc: 4, reason: 'contract has no objective line', code: 'state-error' };
  if (acs.length === 0) return { rc: 4, reason: 'contract has no AC lines', code: 'state-error' };

  const stamp = contractStamp(contractText);
  const results = [];
  let unverifiable = 0;

  for (const ac of acs) {
    if (ac.probe) {
      const probe = runCmd(ac.probe, { cwd, env });
      if (probe.exitCode !== 0) {
        results.push({ id: ac.id, status: 'unverifiable', why: 'probe failed' });
        unverifiable++;
        continue;
      }
    }
    const r = runCmd(ac.check, { cwd, env });
    let status = judgeExpected(ac.expected, r);
    // 命令本身找不到（127）也算不可信
    if (r.exitCode === 127 || /command not found|not found/i.test(r.stderr)) status = 'unverifiable';
    results.push({ id: ac.id, status, exitCode: r.exitCode, stdout: r.stdout.slice(-200) });
    if (status === 'unverifiable') unverifiable++;
  }

  const ratio = unverifiable / acs.length;
  if (ratio > 1 / 3) return { rc: 2, reason: `unverifiable ratio ${ratio.toFixed(2)} > 1/3`, code: 'unverifiable', results, stamp };

  const failed = results.filter((r) => r.status === 'failed');
  const passed = results.filter((r) => r.status === 'passed');
  if (failed.length === 0) {
    // 全 passed 才 GO；有 unverifiable 但比例 ≤1/3 时不算 GO，但也不算 fail —— 报告里带出来
    return { rc: 0, reason: 'GO', code: 'go', results, stamp, note: unverifiable ? `${unverifiable} AC(s) unverifiable (≤1/3)` : undefined };
  }
  return { rc: 2, reason: `NO-GO: ${failed.map((f) => f.id).join(', ')}`, code: 'no-go', results, stamp };
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
# AC 每行一条：AC-N | 判定语句 | check: \`命令\` | [probe: \`探针\`] | expected: <规格>
# 规格 = exit=0 | <=N | >=N | <N | >N | =N | maximize | judged
# check 必须是能真的失败的具名命令（环境依赖、空值、错误路径都要写进去）
AC-1 | <第一个可失败的判定语句> | check: \`test -f <产物路径>\` | expected: exit=0
AC-2 | <第二个> | check: \`<命令>\` | expected: exit=0
`;
