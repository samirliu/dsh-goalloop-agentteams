// redteam_test.mjs — 对抗性红队:故意攻击评估系统的防线,防线必须全部接住
// 每个攻击都是合成场景(假交付物/假评审),验证的是插件防线本身,不含任何具体案例。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runGate, metricKey } from '../lib/core.js';
import { preflightChecks, recordRun, neverFailedAcs, readState, writeState, contractPath, readHistory } from '../lib/ledger.js';

const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'gate.mjs');
const node = process.execPath;
let attacks = 0, blocked = 0;
function defense(name, ok, detail) {
  attacks++;
  if (ok) blocked++;
  console.log(`${ok ? '🛡️' : '💀'} ${name} — ${detail}`);
}

// ── 攻击 1:过期评审证据(评过的不是要发的)────────────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-1-');
  fs.mkdirSync(path.join(root, '.goal-gate'));
  const art = path.join(root, 'deliverable.txt');
  fs.writeFileSync(art, 'v1 content\n');
  const digest = createHash('sha256').update(fs.readFileSync(art)).digest('hex');
  fs.writeFileSync(contractPath(root), `objective: 攻击1
deliverable: deliverable.txt
AC-1 | 评审 | check: \`echo artifact: deliverable.txt; echo digest: sha256:${digest}\` | probe: \`test -f deliverable.txt\` | expected: judged
AC-2 | 运行时 | check: \`sh -c 'test -s deliverable.txt'\` | expected: exit=0
`);
  const g1 = runGate(fs.readFileSync(contractPath(root), 'utf8'), { cwd: root });
  defense('过期评审证据(先给对的摘要)', g1.results[0].status === 'passed', `初判 ${g1.results[0].status}(应 passed)`);
  // 篡改交付物:评审摘要不再匹配 → 必须作废
  fs.writeFileSync(art, 'v2 content — what ships now\n');
  const g2 = runGate(fs.readFileSync(contractPath(root), 'utf8'), { cwd: root });
  defense('交付物已变、评审没跟', g2.results[0].status === 'unverifiable' && g2.code !== 'go',
    `判为 ${g2.results[0].status},门控 ${g2.code}(应 unverifiable 且非 go)`);
}

// ── 攻击 2:伪造摘要 ─────────────────────────────────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-2-');
  fs.mkdirSync(path.join(root, '.goal-gate'));
  fs.writeFileSync(path.join(root, 'd.txt'), 'real\n');
  const g = runGate(`objective: 攻击2
deliverable: d.txt
AC-1 | 伪造评审 | check: \`echo artifact: d.txt; echo digest: sha256:${'0'.repeat(64)}\` | probe: \`test -f d.txt\` | expected: judged
AC-2 | 运行时 | check: \`sh -c 'test -s d.txt'\` | expected: exit=0
`, { cwd: root });
  defense('伪造评审摘要', g.results[0].status === 'unverifiable', `判为 ${g.results[0].status}`);
}

// ── 攻击 3:无凭据评审却宣称通过(最难防的一类)───────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-3-');
  fs.mkdirSync(path.join(root, '.goal-gate'));
  fs.writeFileSync(path.join(root, 'd.txt'), 'x\n');
  const g = runGate(`objective: 攻击3
deliverable: d.txt
AC-1 | 口头评审 | check: \`echo VERDICT: PASS\` | probe: \`true\` | expected: judged
AC-2 | 运行时 | check: \`sh -c 'test -s d.txt'\` | expected: exit=0
`, { cwd: root });
  defense('无凭据评审宣称 PASS', g.results[0].status === 'unverifiable' && g.code !== 'go',
    `判为 ${g.results[0].status},门控 ${g.code}`);
}

// ── 攻击 4:数据全过、交付物是坏的(检查只碰衍生品)────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-4-');
  fs.mkdirSync(path.join(root, 'derived'));
  fs.writeFileSync(path.join(root, 'derived', 'stats.txt'), 'poly=9999 rows=42\n');
  const contract = `objective: 攻击4
deliverable: app.html
AC-1 | 衍生数据检查 | check: \`grep -q poly= derived/stats.txt\` | expected: exit=0
AC-2 | 文件存在 | check: \`test -s derived/stats.txt\` | expected: exit=0
`;
  // 注意:交付物 app.html 根本不存在、也没有任何检查碰它
  const warnings = preflightChecks(contract);
  defense('数据全过但交付物未被验收',
    warnings.some((w) => w.kind === 'deliverable-unverified') && warnings.some((w) => w.kind === 'no-runtime-ac'),
    `预检亮了 ${warnings.map((w) => w.kind).join(', ') || '(无)'}`);
}

// ── 攻击 5:永真式检查 + 评审过审后换皮 ───────────────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-5-');
  fs.mkdirSync(path.join(root, '.goal-gate'));
  fs.writeFileSync(path.join(root, 'd.txt'), 'x\n');
  const contract = `objective: 攻击5
deliverable: d.txt
AC-1 | 永真 | check: \`echo done\` | expected: exit=0
AC-2 | 运行时 | check: \`sh -c 'test -s d.txt'\` | expected: exit=0
`;
  const warnings = preflightChecks(contract);
  defense('永真式检查混入契约', warnings.some((w) => w.kind === 'tautology-suspect'),
    `预检: ${warnings.map((w) => w.kind).join(', ') || '(无)'}`);
  // 同一 AC 连过 N 轮从未失败 → neverFailed 点名
  const acs = [{ id: 'AC-1' }, { id: 'AC-2' }];
  const hist = [
    { trigger: 'check', failed: ['AC-1'], unverifiable: [] },
    { trigger: 'check', failed: [], unverifiable: [] },
    { trigger: 'check', failed: [], unverifiable: [] },
  ];
  defense('从未失败过的检查被点名', neverFailedAcs(hist, acs).includes('AC-2'),
    `neverFailed=${JSON.stringify(neverFailedAcs(hist, acs))}`);
}

// ── 攻击 6:失败观测拉低基线(好定律漏洞回归)──────────────────────────
{
  const root = fs.mkdtempSync('/tmp/redteam-6-');
  const st = { falseCompletes: 0, digests: {}, baselines: {}, bestScore: null };
  const gFail = { code: 'no-go', score: 0.1, stamp: 'X', results: [{ id: 'AC-1', status: 'failed' }], baselineUpdates: { 'AC-1#k': 1 } };
  recordRun(root, st, gFail, 'check');
  recordRun(root, st, { ...gFail, baselineUpdates: { 'AC-1#k': 999 } }, 'check'); // 999 的失败观测想拉高/乱动基线
  recordRun(root, st, { ...gFail, code: 'no-go', baselineUpdates: { 'AC-1#k': 0.5 } }, 'check'); // 0.5 想拉低基线
  defense('失败观测无法拉低基线', st.baselines['AC-1#k'] === 1,
    `基线保持 ${st.baselines['AC-1#k']}(应 1)`);
}

console.log(`\n红队结果:防线接住 ${blocked}/${attacks} 次攻击`);
if (blocked < attacks) {
  console.error('💀 有攻击突破防线 —— 插件不达标');
  process.exit(1);
}
console.log('\nRed-team tests passed.');
