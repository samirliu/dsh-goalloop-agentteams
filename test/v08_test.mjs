// v08_test.mjs — Agent Teams-native loop + grilling surfaces:
// scope:/depends: grammar, dependency waves, idempotent/blocked dispatch,
// team snapshot + nextActions, grilling audit, baseline/spread persistence, ledger lock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseContract, validateTeamMeta, runGate, contractStamp } from '../lib/core.js';
import { acquireLedgerLock, withLedgerLock, measureBaselines, readState, readLoop } from '../lib/ledger.js';
import { mkdtemp, ok, echo, metric, fileExists, all, nodeNoop } from './fixtures/shell.mjs';

const mod = await import('../lib/index.js');

function makeCtx(team) {
  const tools = [];
  const cmds = [];
  const skills = [];
  const listeners = [];
  const skillsService = { register: (s) => skills.push(s), list: async () => skills.map((s) => ({ name: s.name })) };
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    inject: (_deps, fn) => fn({ commands: { register: (c) => cmds.push(c) }, skills: skillsService, get: (k) => (k === 'skills' ? skillsService : undefined) }),
    get: (k) => {
      if (k === 'skills') return skillsService;
      if (k === 'agentTeams') return team;
      return undefined;
    },
    on: (name, fn) => { if (name === 'tools/pre-execute') listeners.push(fn); return () => {}; },
    logger: { warn: () => {} },
  };
  return { ctx, tools, cmds, skills, listeners };
}
function tool(reg, name) { return reg.tools.find((t) => t.name === name); }
async function call(reg, name, args, exec) { return tool(reg, name).execute(args ?? {}, exec); }

function fakeTeam({ lead = true } = {}) {
  const tasks = [];
  const members = [
    { id: 'lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
    { id: 'm1', name: 'engineer', role: 'teammate', status: 'inactive', diagnostics: [] },
  ];
  let n = 0;
  return {
    tasks, members,
    tryMembership: (agent) => (agent?.member ? { role: lead ? 'lead' : 'teammate' } : undefined),
    listMembers: () => members,
    listTasks: () => tasks,
    createTask: async (_agent, req) => {
      const view = {
        id: `task-${++n}`, revision: 1, status: 'pending', ready: req.blockedBy?.length ? false : true,
        blockedBy: req.blockedBy ?? [], writeScopes: req.writeScopes ?? [], writeScopeWarnings: [],
        ownerName: req.owner, ...req,
      };
      tasks.push(view);
      return view;
    },
    updateTask: async (_agent, req) => {
      const t = tasks.find((x) => x.id === req.taskId);
      if (req.action === 'reassign' && t) t.ownerName = req.owner;
      return t ?? { id: req.taskId, revision: req.revision };
    },
  };
}

// ── 1. scope:/depends: grammar + validation ───────────────────────────────
{
  const text = `objective: team contract
deliverable: out.txt
AC-1 | foundation | check: \`${fileExists('out.txt')}\` | scope: src/core | expected: exit=0
AC-2 | layer | check: \`${fileExists('out.txt')}\` | scope: src/ui | depends: AC-1 | expected: exit=0
`;
  const parsed = parseContract(text);
  assert.deepEqual(parsed.acs[0].scope, ['src/core']);
  assert.deepEqual(parsed.acs[1].depends, ['AC-1']);
  assert.equal(validateTeamMeta(parsed.acs), null);
  const cyclic = parseContract(`objective: c\nAC-1 | a | check: \`${ok()}\` | depends: AC-2 | expected: exit=0\nAC-2 | b | check: \`${ok()}\` | depends: AC-1 | expected: exit=0\n`);
  assert.match(validateTeamMeta(cyclic.acs) ?? '', /cycle/);
  const unknown = parseContract(`objective: u\nAC-1 | a | check: \`${ok()}\` | depends: AC-9 | expected: exit=0\n`);
  assert.match(validateTeamMeta(unknown.acs) ?? '', /unknown AC/);
  const work = mkdtemp('v08-meta-');
  fs.writeFileSync(path.join(work, 'out.txt'), 'x');
  const bad = runGate(`objective: bad\nAC-1 | a | check: \`${ok()}\` | depends: AC-2 | expected: exit=0\nAC-2 | b | check: \`${ok()}\` | depends: AC-1 | expected: exit=0\n`, { cwd: work });
  assert.equal(bad.code, 'state-error', 'cyclic depends refuse the gate');
  console.log('✓ v0.8 grammar: scope:/depends: parsed; unknown/cyclic deps are state-error');
}

// ── 2. dependency waves + plan ───────────────────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-plan-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  await call(reg, 'goal_loop_at', { objective: 'waves', acs: ['foundation', 'layer'] }, exec);
  const cp = path.join(work, '.goal-gate/goal.md');
  fs.writeFileSync(cp, `objective: waves
AC-1 | foundation | check: \`${ok()}\` | scope: src/core | expected: exit=0
AC-2 | layer | check: \`${ok()}\` | scope: src/ui | depends: AC-1 | expected: exit=0
`);
  const res = await call(reg, 'goal_loop_at', { objective: 'waves' }, exec);
  assert.deepEqual(res.plan.waves, [['AC-1'], ['AC-2']]);
  assert.deepEqual(res.tasks.find((t) => t.id === 'AC-2').depends, ['AC-1']);
  console.log('✓ v0.8 plan: dependency waves + task metadata');
}

// ── 2b. dispatch refuses a placeholder skeleton ─────────────────────────
{
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-placeholder-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  const res = await call(reg, 'goal_loop_at', { objective: 'placeholder', acs: ['one'], dispatch: true }, exec);
  assert.equal(res.dispatch.dispatched.length, 0, 'placeholder contract is not dispatched');
  assert.match(res.dispatch.reason, /TODO-REPLACE-ME/);
  assert.equal(team.tasks.length, 0);
  console.log('✓ v0.8 dispatch: placeholder skeleton refused until checks are real');
}

// ── 3. dispatch: blockedBy/writeScopes, idempotency, owner assignment ─────
{
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-dispatch-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), `objective: repair
AC-1 | core | check: \`${fileExists('NOPE1')}\` | scope: src/core | expected: exit=0
AC-2 | ui | check: \`${fileExists('NOPE2')}\` | scope: src/ui | depends: AC-1 | expected: exit=0
`);
  const first = await call(reg, 'goal_gate_dispatch', { assign: { 'AC-1': 'engineer' } }, exec);
  assert.equal(first.dispatched.length, 2, 'two repair tasks created');
  assert.deepEqual(first.dispatched.find((d) => d.id === 'AC-2').blockedBy, [team.tasks[0].id], 'depends maps to blockedBy');
  assert.deepEqual(team.tasks[0].writeScopes, ['src/core']);
  assert.equal(team.tasks[0].ownerName, 'engineer', 'assign maps owner');
  const second = await call(reg, 'goal_gate_dispatch', {}, exec);
  assert.equal(second.dispatched.length, 0, 're-dispatch is idempotent');
  assert.equal(second.skippedExisting.length, 2, 'pending tasks are reused');
  console.log('✓ v0.8 dispatch: deps→blockedBy, scope→writeScopes, dedupe, owner assignment');
}

// ── 4. team snapshot + nextActions in status ─────────────────────────────
{
  const team = fakeTeam();
  team.tasks.push({ id: 'task-x', revision: 1, subject: '[goal-gate abc] AC-1: core', status: 'in_progress', ownerName: 'engineer', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [], description: 'x' });
  team.tasks.push({ id: 'task-y', revision: 1, subject: '[goal-gate abc] AC-2: ui', status: 'pending', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [], description: 'y' });
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-team-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), `objective: team\nAC-1 | core | check: \`${fileExists('NOPE')}\` | expected: exit=0\n`);
  const status = await call(reg, 'goal_gate_status', {}, exec);
  assert.equal(status.team.role, 'lead');
  assert.equal(status.team.tasks.length, 2);
  assert.equal(status.team.counts.inProgress, 1);
  assert.equal(status.team.counts.readyUnowned, 1);
  assert.ok(status.nextActions.some((a) => a.action === 'collect-team'), 'nextActions names collect-team');
  assert.ok(status.nextActions.some((a) => a.action === 'assign-ready-tasks'), 'nextActions names assign-ready-tasks');
  console.log('✓ v0.8 team: status snapshot + nextActions (collect/assign)');
}

// ── 5. grill: weak contract needs work; strong contract is ready ─────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const weakWork = mkdtemp('v08-grill-weak-');
  const exec = { agent: { session: { header: { cwd: weakWork } } } };
  fs.mkdirSync(path.join(weakWork, '.goal-gate'));
  fs.writeFileSync(path.join(weakWork, '.goal-gate/goal.md'), `objective: make it good
AC-1 | it works | check: \`${echo('ok')}\` | expected: exit=0
`);
  const weak = await call(reg, 'goal_gate_grill', {}, exec);
  assert.equal(weak.verdict, 'needs-work');
  assert.ok(weak.findings.some((f) => f.severity === 'high' && /tautolog/.test(f.issue)));
  assert.ok(weak.findings.some((f) => /deliverable/.test(f.issue)));
  assert.ok(weak.questions.length >= 2);

  const strongWork = mkdtemp('v08-grill-strong-');
  const exec2 = { agent: { session: { header: { cwd: strongWork } } } };
  fs.mkdirSync(path.join(strongWork, '.goal-gate'));
  fs.writeFileSync(path.join(strongWork, 'out.txt'), 'x\n');
  fs.writeFileSync(path.join(strongWork, '.goal-gate/goal.md'), `objective: build a parser
deliverable: out.txt
AC-1 | parser runs on the deliverable | check: \`${all(fileExists('out.txt'), nodeNoop())}\` | expected: exit=0
AC-2 | bad input is refused with code 1 | check: \`${fileExists('NOPE')}\` | expected: exit=1
AC-3 | throughput | check: \`${metric('m=100')}\` | metric: \`m=([0-9.]+)\` | baseline: abs | tolerance: 0.05 | probe: \`${ok()}\` | expected: maximize
`);
  await call(reg, 'goal_gate_baseline', { samples: 2 }, exec2);
  const strong = await call(reg, 'goal_gate_grill', {}, exec2);
  assert.equal(strong.verdict, 'ready', JSON.stringify(strong.findings));
  console.log('✓ v0.8 grill: weak -> needs-work with named findings; strong -> ready');
}

// ── 6. baseline + spread persistence + data-driven band ──────────────────
{
  const work = mkdtemp('v08-baseline-');
  fs.mkdirSync(path.join(work, '.goal-gate'));
  const contract = `objective: baseline
AC-1 | metric | check: \`${metric('m=100 sd=4')}\` | metric: \`m=([0-9.]+)\` | baseline: abs | sd: \`sd=([0-9.]+)\` | expected: maximize
`;
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), contract);
  const res = measureBaselines(work, contract, { samples: 2 });
  assert.equal(res.recorded, true);
  assert.equal(res.acs[0].values.length, 2);
  assert.equal(res.acs[0].mean, 100);
  assert.equal(res.acs[0].spread, 4, 'declared sd is used as spread');
  const state = readState(work);
  assert.equal(state.baselines[res.acs[0].metricKey], 100);
  assert.equal(state.spreads[res.acs[0].metricKey], 4);
  const g = runGate(contract, { cwd: work, baselines: { ...state.baselines }, spreads: { ...state.spreads } });
  assert.equal(g.results[0].spread, 4, 'stored spread feeds the judgement band');
  console.log('✓ v0.8 baseline: mean/spread recorded; stored spread used by the gate');
}

// ── 7. ledger lock serializes team operations ────────────────────────────
{
  const work = mkdtemp('v08-lock-');
  fs.mkdirSync(path.join(work, '.goal-gate'));
  const release = acquireLedgerLock(work);
  assert.equal(typeof release, 'function');
  assert.equal(acquireLedgerLock(work), null, 'second acquisition is refused');
  const busy = await withLedgerLock(work, async () => 'should-not-run');
  assert.equal(busy.busy, true);
  release();
  const ok = await withLedgerLock(work, async () => 'ran');
  assert.equal(ok, 'ran');
  console.log('✓ v0.8 lock: team operations are serialized, busy is explicit');
}

// ── 8. audit names missing optimize baselines ────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-audit-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), `objective: audit
AC-1 | metric | check: \`${metric('m=5')}\` | metric: \`m=([0-9.]+)\` | expected: maximize
`);
  const report = await call(reg, 'goal_gate_audit', {}, exec);
  assert.ok(report.warnings.some((w) => w.code === 'baseline-unestablished'), 'audit warns about missing baseline');
  console.log('✓ v0.8 audit: missing optimize baseline is named');
}

// ── 9. doctor: registration surface is diagnosable ──────────────────────
{
  const reg = makeCtx();
  // expose the same schemas/tools a real Host would; fake ctx only records
  reg.ctx.tools.schemas = () => reg.tools.map((t) => ({ name: t.name, parameters: t.parameters }));
  reg.ctx.tools.register = (t) => { reg.tools.push(t); };
  mod.apply(reg.ctx, {});
  const work = mkdtemp('v08-doctor-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  const report = await call(reg, 'goal_gate_doctor', {}, exec);
  assert.equal(report.ok, true, JSON.stringify(report.notes));
  assert.equal(report.tools.length, 13);
  assert.ok(report.tools.every((t) => t.parametersObject));
  assert.ok(report.skills.includes('goal-loop-grill'));
  console.log('✓ v0.8 doctor: tools/schemas/skills/team diagnosable');
}

console.log('\nAll v0.8 tests passed.');
