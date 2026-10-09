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
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const obj = line.match(/^objective:\s*(.+)$/i);
    if (obj) { objective = obj[1].trim(); continue; }
    const m = line.match(AC_RE);
    if (m) {
      acs.push({
        id: m[1], statement: m[2].trim(), check: m[3],
        probe: m[4] ?? null, baseline: m[5] ?? null, expected: m[6].trim(),
      });
    }
  }
  return { objective, acs };
}

// 盖戳：sha1-8 over AC body + `^exit:` + `^objective:` 行（R3 冻结）
export function contractStamp(text) {
  const body = text.split('\n')
    .filter((l) => /^\s*(AC-\d+|exit:|objective:)/i.test(l))
    .join('\n');
  return createHash('sha1').update(body).digest('hex').slice(0, 8);
}

// ── 树摘要（R7 等价物：verdict 绑定到 tree digest）─────────────────────────
// 默认摘要 root，但必须排除账本目录本身（否则写账本→摘要变→误判 verdict 作废）
export function treeDigest(dir, { exclude = ['.goal-gate', 'node_modules', '.git'] } = {}) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (exclude.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(`${p}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return createHash('sha1').update(files.join('\n')).digest('hex').slice(0, 12);
}

// ── 期望规格判定 ────────────────────────────────────────────────────────
export function judgeExpected(expected, { exitCode, stdout }) {
  const spec = expected.trim();
  if (spec === 'exit=0') return exitCode === 0;
  const op = spec.match(/^(<=|>=|<|>|==|=)\s*(\d+(\.\d+)?)$/);
  if (op) {
    const v = parseFloat(stdout.trim().split('\n').pop() ?? 'NaN');
    if (Number.isNaN(v)) return false;
    const n = parseFloat(op[2]);
    switch (op[1]) {
      case '<=': return v <= n;
      case '>=': return v >= n;
      case '<': return v < n;
      case '>': return v > n;
      case '==': case '=': return v === n;
    }
  }
  if (spec === 'maximize' || spec === 'judged') return true;
  return false;
}

// ── 确定性门控：自己重跑每条 check，零模型参与 ─────────────────────────────
export function runGate(contractText, { cwd, env } = {}) {
  const { objective, acs } = parseContract(contractText);
  if (!objective) return { rc: 4, reason: 'no objective', code: 'state-error' };
  if (acs.length === 0) return { rc: 4, reason: 'no ACs', code: 'state-error' };

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
    const pass = judgeExpected(ac.expected, r);
    results.push({ id: ac.id, status: pass ? 'passed' : 'failed', exitCode: r.exitCode, stdout: r.stdout.slice(-200) });
    if (r.exitCode === 127 || /command not found|not found/i.test(r.stderr)) unverifiable++;
  }

  const ratio = unverifiable / acs.length;
  if (ratio > 1 / 3) return { rc: 2, reason: `unverifiable ratio ${ratio.toFixed(2)} > 1/3`, code: 'unverifiable', results, stamp };

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length === 0) return { rc: 0, reason: 'GO', code: 'go', results, stamp };
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
