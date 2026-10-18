// v09_test.mjs — Agent Teams orchestration surfaces:
// staff preview/spawn, team task collection, cold-seat judge tasks, lock wait,
// grilling horizon guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withLedgerLock, acquireLedgerLock } from '../lib/ledger.js';
import { grillContract } from '../lib/grill.js';

const mod = await import('../lib/index.js');

function makeCtx(team) {
  const tools = [], cmds = [], skills = [], listeners = [];
  const skillsService = { register: (s) => skills.push(s), list: async () => skills.map((s) => ({ name: s.name })) };
  const ctx = {
    tools: { register: (t) => tools.push(t), schemas: () => tools.map((t) => ({ name: t.name, parameters: t.parameters })) },
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
async function call(reg, name, args, exec) { return reg.tools.find((t) => t.name === name).execute(args ?? {}, exec); }

function fakeTeam() {
  const members = [
    { id: 'lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
    { id: 'm1', name: 'engineer', role: 'teammate', status: 'inactive', diagnostics: [] },
  ];
  const tasks = [];
  const spawns = [];
  let n = 0;
  return {
    members, tasks, spawns,
    tryMembership: (agent) => (agent?.member ? { role: 'lead' } : undefined),
    listMembers: () => members,
    listTasks: () => tasks,
    createTask: async (_agent, req) => {
      const view = {
        id: `task-${++n}`, revision: 1, status: 'pending',
        ready: (req.blockedBy ?? []).length === 0,
        blockedBy: req.blockedBy ?? [], writeScopes: req.writeScopes ?? [], writeScopeWarnings: [],
        ownerName: req.owner, ...req,
      };
      tasks.push(view);
      return view;
    },
    updateTask: async (_agent, req) => {
      const task = tasks.find((t) => t.id === req.taskId);
      if (!task) throw new Error(`unknown task ${req.taskId}`);
      if (req.action === 'reassign') task.ownerName = req.owner;
      task.revision++;
      return task;
    },
    spawnTeammate: async (_agent, req) => {
      spawns.push(req);
      const member = { id: `m-${spawns.length}`, name: req.name, role: 'teammate', status: 'running', diagnostics: [] };
      members.push(member);
      return { member };
    },
  };
}

// ── 1. staff preview is read-only; spawn creates members + tasks + owners ───
{
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v09-staff-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } }, signal: new AbortController().signal };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), `objective: staffed team
AC-1 | core | check: \`test -d .\` | scope: src/core | expected: exit=0
AC-2 | ui | check: \`test -d .\` | scope: src/ui | depends: AC-1 | expected: exit=0
`);

  const preview = await call(reg, 'goal_gate_staff', {}, exec);
  assert.equal(preview.mode, 'preview');
  assert.deepEqual(preview.members.map((m) => m.name), ['worker-wave-1', 'worker-wave-2']);
  assert.equal(team.spawns.length, 0, 'preview spawns nobody');
  assert.equal(team.tasks.length, 0, 'preview creates no tasks');

  const spawned = await call(reg, 'goal_gate_staff', { spawn: true }, exec);
  assert.equal(spawned.mode, 'spawned');
  assert.equal(team.spawns.length, 2, 'one teammate per dependency wave');
  assert.match(team.spawns[0].prompt[0].text, /You own: AC-1/);
  assert.equal(team.tasks.length, 2);
  const owners = team.tasks.map((t) => t.ownerName).sort();
  assert.deepEqual(owners, ['worker-wave-1', 'worker-wave-2']);
  console.log('✓ v0.9 staff: preview is read-only; spawn creates wave workers, tasks, owners');
}

// ── 2. collect: readyToCheck follows team task completion ──────────────────
{
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v09-collect-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  const contract = 'objective: collect\nAC-1 | core | check: `test -d .` | expected: exit=0\nAC-2 | ui | check: `test -d .` | expected: exit=0\n';
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), contract);
  const stamp = (await import('../lib/core.js')).contractStamp(contract);
  team.tasks.push(
    { id: 't1', revision: 1, subject: `[goal-gate ${stamp}] AC-1: core`, status: 'completed', ownerName: 'engineer', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [], description: '' },
    { id: 't2', revision: 1, subject: `[goal-gate ${stamp}] AC-2: ui`, status: 'pending', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [], description: '' },
  );
  const first = await call(reg, 'goal_gate_collect', {}, exec);
  assert.equal(first.readyToCheck, false);
  assert.equal(first.completed.length, 1);
  assert.equal(first.pending.length, 1);
  team.tasks[1].status = 'completed';
  const second = await call(reg, 'goal_gate_collect', {}, exec);
  assert.equal(second.readyToCheck, true);
  assert.equal(second.missing.length, 0);
  console.log('✓ v0.9 collect: AC completion mapped; readyToCheck gates the check');
}

// ── 3. judge: cold-seat review tasks for judged ACs, idempotent ───────────
{
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v09-judge-');
  const exec = { agent: { member: true, session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate/goal.md'), `objective: judge
deliverable: out.txt
AC-1 | quality | check: \`cat .goal-gate/evidence/v.txt\` | probe: \`true\` | calib: good=good.txt bad=bad.txt | expected: judged
`);
  const first = await call(reg, 'goal_gate_judge', { reviewer: 'engineer' }, exec);
  assert.equal(first.dispatched.length, 1);
  assert.match(first.dispatched[0].subject, /Judge AC-1/);
  const desc = team.tasks[0].description;
  assert.match(desc, /artifact:/);
  assert.match(desc, /digest: sha256:/);
  assert.match(desc, /calib-good: PASS/);
  assert.equal(team.tasks[0].ownerName, 'engineer', 'reviewer owns the review task');
  const second = await call(reg, 'goal_gate_judge', { reviewer: 'engineer' }, exec);
  assert.equal(second.dispatched.length, 0, 'review task is not duplicated');
  assert.equal(second.skippedExisting.length, 1);
  console.log('✓ v0.9 judge: fresh-review brief with artifact/digest/calib, idempotent');
}

// ── 4. lock waits for a short window instead of failing immediately ───────
{
  const work = fs.mkdtempSync('/tmp/v09-lock-');
  fs.mkdirSync(path.join(work, '.goal-gate'));
  const release = acquireLedgerLock(work);
  setTimeout(release, 60);
  const result = await withLedgerLock(work, async () => 'ran-after-wait', { waitMs: 1000 });
  assert.equal(result, 'ran-after-wait');
  console.log('✓ v0.9 lock: waitMs lets a teammate retry instead of failing busy');
}

// ── 5. grill: optimization without a horizon is called out ────────────────
{
  const work = fs.mkdtempSync('/tmp/v09-horizon-');
  const report = grillContract({
    contractText: `objective: optimize only
AC-1 | throughput | check: \`printf 'm=100\\n'\` | probe: \`true\` | metric: \`m=([0-9.]+)\` | tolerance: 0.05 | expected: maximize
`,
    state: { baselines: {}, spreads: {} },
    cwd: work,
  });
  assert.ok(report.findings.some((f) => /horizon/.test(f.issue)), JSON.stringify(report.findings));
  assert.ok(report.questions.some((q) => /NOT see/.test(q)));
  console.log('✓ v0.9 grill: optimization without judged/calib horizon is needs-work');
}

console.log('\nAll v0.9 tests passed.');
