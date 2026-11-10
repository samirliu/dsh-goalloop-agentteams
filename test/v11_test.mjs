// v11_test.mjs — v0.11: blast-radius lanes (Art3 §8) + harness decay audit (Art1 §15/§18)
// "Gate on blast radius, not confidence": a hard lane does not open because the
// score is high — it opens only when a human approves THIS artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAcLine, runGate } from '../lib/core.js';
import { auditReport, readState, writeState } from '../lib/ledger.js';

const mod = await import('../lib/index.js');

function makeCtx() {
  const tools = [], cmds = [], skills = [], listeners = [];
  const skillsService = { register: (s) => skills.push(s), list: async () => skills.map((s) => ({ name: s.name })) };
  const ctx = {
    tools: { register: (t) => tools.push(t), schemas: () => tools.map((t) => ({ name: t.name, parameters: t.parameters })) },
    inject: (_deps, fn) => fn({ commands: { register: (c) => cmds.push(c) }, skills: skillsService, get: (k) => (k === 'skills' ? skillsService : undefined) }),
    get: () => undefined,
    on: (name, fn) => { if (name === 'tools/pre-execute') listeners.push(fn); return () => {}; },
    logger: { warn: () => {} },
  };
  return { ctx, tools, cmds, skills, listeners };
}
const call = (reg, name, args, exec) => reg.tools.find((t) => t.name === name).execute(args ?? {}, exec);
const execFor = (root) => ({ agent: { session: { header: { cwd: root } } } });

function workspace(contractBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-'));
  fs.mkdirSync(path.join(root, '.goal-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'good\n');
  fs.writeFileSync(path.join(root, '.goal-gate/goal.md'), contractBody);
  return root;
}
const HARD = `objective: risky migration
deliverable: artifact.txt
AC-1 | migration applies | risk: hard | check: \`test -f artifact.txt\` | neg: \`test -f __absent__\` | expected: exit=0
`;

// ── 1. 文法：risk 三值 + 默认 low + 非法值拒评 ────────────────────────────
{
  assert.equal(parseAcLine('AC-1 | s | check: `true` | neg: `false` | expected: exit=0').ac.risk, 'low', 'default lane is low');
  assert.equal(parseAcLine('AC-1 | s | risk: wide | check: `true` | neg: `false` | expected: exit=0').ac.risk, 'wide');
  assert.equal(parseAcLine('AC-1 | s | check: `true` | neg: `false` | risk: HARD | expected: exit=0').ac.risk, 'hard', 'case-insensitive');
  assert.match(parseAcLine('AC-1 | s | risk: yolo | check: `true` | expected: exit=0').error, /risk must be low\|wide\|hard/);
  console.log('✓ v0.11 parse: risk: low|wide|hard, default low, invalid refused');
}

// ── 2. 门控：车道出现在输出里；宽/硬车道要求干净轨迹 ──────────────────────
{
  const root = workspace(HARD);
  const g = runGate(fs.readFileSync(path.join(root, '.goal-gate/goal.md'), 'utf8'), { cwd: root });
  assert.equal(g.code, 'go');
  assert.deepEqual(g.riskLanes, { low: [], wide: [], hard: ['AC-1'] }, 'lanes are reported');

  // 车道加严：wide/hard 下每条 AC 都必须有可证伪证据（neg: / calib:），不留豁免。
  const gapRoot = workspace(`objective: risky migration
deliverable: artifact.txt
AC-1 | migration applies | risk: hard | check: \`test -f artifact.txt\` | neg: \`test -f __absent__\` | expected: exit=0
AC-2 | unproven | check: \`test -f artifact.txt\` | expected: exit=0
`);
  const gap = runGate(fs.readFileSync(path.join(gapRoot, '.goal-gate/goal.md'), 'utf8'), { cwd: gapRoot });
  assert.equal(gap.code, 'unproven-lane', JSON.stringify(gap.results));
  assert.match(gap.reason, /AC-2.*缺 neg:/);

  // 同样的契约，把 risk 降回 low 就只是一条 grill 建议，不是 NO-GO（车道是分级而不是全覆盖）
  const lowSame = workspace(`objective: contained change
deliverable: artifact.txt
AC-1 | contained | check: \`test -f artifact.txt\` | neg: \`test -f __absent__\` | expected: exit=0
AC-2 | unproven | check: \`test -f artifact.txt\` | expected: exit=0
`);
  assert.equal(runGate(fs.readFileSync(path.join(lowSame, '.goal-gate/goal.md'), 'utf8'), { cwd: lowSame }).code, 'go');
  console.log('✓ v0.11 gate: lanes reported; wide/hard require falsifiability on EVERY AC (low does not)');
}

// ── 3. 每 AC 耗时可见（组件级开销）────────────────────────────────────────
{
  const root = workspace('objective: timing\nAC-1 | slow | check: `sleep 0.2; test -f artifact.txt` | neg: `test -f __absent__` | expected: exit=0');
  const g = runGate(fs.readFileSync(path.join(root, '.goal-gate/goal.md'), 'utf8'), { cwd: root });
  assert.ok(g.results[0].ms >= 150, `per-AC ms recorded (got ${g.results[0].ms})`);
  console.log('✓ v0.11 gate: per-AC duration is recorded');
}

// ── 4. hard 车道不开门：全绿也拦完成声明，直到人类按 digest 批准 ───────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const root = workspace(HARD);
  const exec = execFor(root);
  const [hook] = reg.listeners;
  const claim = { name: 'update_goal', arguments: { action: 'complete' }, agent: exec.agent };
  const pass = async () => hook(claim, async () => ({ kind: 'allow' }));

  const before = await pass();
  assert.equal(before.kind, 'deny', 'a green hard lane still refuses a model-side claim');
  assert.equal(before.info.code, 'risk-lane-closed');
  assert.match(before.reason, /AC-1/);

  const approve = await call(reg, 'goal_gate_approve', { by: 'samir', note: '迁移已人工复核' }, exec);
  assert.equal(approve.approved, true, JSON.stringify(approve));
  assert.equal(approve.code, 'risk-lane-open');
  assert.deepEqual(approve.hardLanes, ['AC-1']);

  const after = await pass();
  assert.equal(after.kind, 'allow', 'human approval opens the lane');

  // 产物一改，批准失效——批准的是这一版，不是这一类
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'changed\n');
  const moved = await pass();
  assert.equal(moved.kind, 'deny');
  assert.equal(moved.info.code, 'risk-lane-closed', 'approval is bound to the artifact digest');
  console.log('✓ v0.11 lanes: hard lane stays closed until a human approves THIS artifact');
}

// ── 5. 批准的两条拒绝路径：红的门控 / 没有硬车道 ─────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const redRoot = workspace('objective: red\nAC-1 | broken | risk: hard | check: `test -f NOPE` | neg: `test -f __absent__` | expected: exit=0');
  const red = await call(reg, 'goal_gate_approve', { by: 'x' }, execFor(redRoot));
  assert.equal(red.approved, false);
  assert.equal(red.code, 'gate-red', 'a human cannot approve a red artifact');

  const lowRoot = workspace('objective: low\nAC-1 | contained | check: `test -f artifact.txt` | neg: `test -f __absent__` | expected: exit=0');
  const noLane = await call(reg, 'goal_gate_approve', { by: 'x' }, execFor(lowRoot));
  assert.equal(noLane.approved, false);
  assert.equal(noLane.code, 'no-hard-lane');
  console.log('✓ v0.11 approve: refuses red gates and lane-free contracts');
}

// ── 6. 腐朽审计：恒绿要分"稳定通过"和"可能永真"；未批准的硬车道要点名 ────
{
  const provenRoot = workspace(`objective: decay
AC-1 | proven failable | check: \`test -f artifact.txt\` | neg: \`test -f __absent__\` | expected: exit=0
AC-2 | unproven green | check: \`test -f artifact.txt\` | expected: exit=0
`);
  // 两轮都通过 → 两条都"从未失败"
  for (let i = 0; i < 2; i++) runGate(fs.readFileSync(path.join(provenRoot, '.goal-gate/goal.md'), 'utf8'), { cwd: provenRoot });
  const { recordRun } = await import('../lib/ledger.js');
  const st = readState(provenRoot);
  for (let i = 0; i < 2; i++) {
    const g = runGate(fs.readFileSync(path.join(provenRoot, '.goal-gate/goal.md'), 'utf8'), { cwd: provenRoot });
    recordRun(provenRoot, st, g, 'check');
  }
  writeState(provenRoot, st);
  const rep = auditReport(provenRoot);
  const taut = rep.warnings.find((w) => w.code === 'possibly-tautological');
  assert.ok(taut && /AC-2/.test(taut.detail), 'never-failed + no neg: is the decay signal');
  assert.ok(!taut || !/AC-1/.test(taut.detail), 'a proven-failable AC is not lumped in');
  assert.ok(rep.warnings.some((w) => w.code === 'green-but-falsifiable' && /AC-1/.test(w.detail)), 'proven green is reported separately');

  const hardRoot = workspace(HARD);
  const hardRep = auditReport(hardRoot);
  assert.ok(hardRep.warnings.some((w) => w.code === 'hard-lane-unapproved'), 'unapproved hard lane is surfaced before anyone claims completion');
  console.log('✓ v0.11 audit: "stable" is separated from "possibly tautological"; hard lanes are named');
}

console.log('\nAll v0.11 tests passed.');
