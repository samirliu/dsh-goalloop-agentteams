// v07_test.mjs — v0.7.0 surfaces: skill registration, stamp/approval (R3),
// time/round budgets, status/audit read-only entries, native Agent Teams dispatch,
// task-board completion claims, human reset, efficiency/reasoning metrics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const mod = await import('../lib/index.js');

function makeCtx({ team } = {}) {
  const tools = [];
  const cmds = [];
  const skills = [];
  const listeners = [];
  const skillsService = { register: (s) => skills.push(s) };
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
function claimDecision(reg, exec, name, args) {
  return reg.listeners[0]({ name, arguments: args, agent: exec.agent }, () => ({ kind: 'allow' }));
}

// ── 1. registration surface ────────────────────────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  assert.deepEqual(reg.skills.map((s) => s.name).sort(), ['goal-loop', 'goal-loop-contract'], 'runtime skills registered');
  for (const s of reg.skills) {
    assert.match(s.content, /^# /, `${s.name} body has a heading`);
    assert.ok(!/^---/m.test(s.content), `${s.name} body excludes frontmatter`);
    assert.equal(s.source, 'runtime');
    assert.ok(s.path && fs.existsSync(s.path), `${s.name} exposes its file path`);
  }
  assert.deepEqual(reg.cmds.map((c) => c.name).sort(), ['goal-audit', 'goal-gate', 'goal-loop-at', 'goal-reset', 'goal-stamp']);
  for (const t of reg.tools) assert.equal(typeof t.output.render, 'function', `${t.name} declares output.render`);
  for (const c of reg.cmds) assert.ok(!c.input || c.input.hint.length > 0, `${c.name} never declares an empty hint`);
  console.log('✓ v0.7 registration: 7 tools + 5 commands + 2 runtime skills');
}

// ── 2. stamp (R3): approve -> edit contract -> contract-revised denies mission control ──
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-stamp-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  await call(reg, 'goal_loop_at', { objective: 'stamp target', acs: ['artifact exists'] }, exec);
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: stamp target\nAC-1 | artifact | check: `test -f a.txt` | expected: exit=0\n');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x\n');

  const stamped = await call(reg, 'goal_gate_stamp', { approvedBy: 'tester', maxRounds: 4, timeBudgetMinutes: 90 }, exec);
  assert.equal(stamped.stamped, true);
  assert.equal(stamped.code, 'stamped');
  assert.equal(stamped.approvedBy, 'tester');
  assert.equal(stamped.maxRounds, 4);
  const loopJson = JSON.parse(fs.readFileSync(path.join(work, '.goal-gate', 'loop.json'), 'utf8'));
  assert.equal(loopJson.maxRounds, 4, 'stamp binds the round budget');
  const idempotent = await call(reg, 'goal_gate_stamp', { approvedBy: 'tester' }, exec);
  assert.equal(idempotent.code, 'already-stamped');

  // edit one AC after approval: the approval no longer covers the contract
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: stamp target\nAC-1 | artifact | check: `test -f a.txt` | expected: exit=0\nAC-2 | extra | check: `test -f b.txt` | expected: exit=0\n');
  const revised = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(revised.kind, 'deny');
  assert.equal(revised.info.code, 'contract-revised');
  assert.match(revised.reason, /restamp|goal-stamp/);

  // explicit re-approval is allowed with restamp, and the same tool refuses without it
  await assert.rejects(
    call(reg, 'goal_gate_stamp', { approvedBy: 'tester' }, exec),
    /contract-revised/,
    'stamp refuses a changed contract without restamp',
  );
  const restamped = await call(reg, 'goal_gate_stamp', { approvedBy: 'tester', restamp: true }, exec);
  assert.equal(restamped.restamped, true);

  // the command form can also re-approve a changed contract and bind budgets
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: stamp target\nAC-1 | artifact | check: `test -f a.txt` | expected: exit=0\nAC-2 | extra | check: `test -f b.txt` | expected: exit=0\nAC-3 | runtime | check: `test -d .` | expected: exit=0\n');
  const cmdRestamp = reg.cmds.find((c) => c.name === 'goal-stamp');
  const cmdRestampRes = cmdRestamp.handler({ rawInput: '--restamp --max-rounds=6 command-user', agent: exec.agent });
  assert.equal(cmdRestampRes.kind, 'success');
  assert.match(cmdRestampRes.text, /"maxRounds": 6/);

  // make the contract pass, then the goal claim is allowed again
  fs.writeFileSync(path.join(work, 'b.txt'), 'y\n');
  const allowed = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(allowed.kind, 'allow', 'GO after re-approval allows the claim');
  const state = JSON.parse(fs.readFileSync(path.join(work, '.goal-gate', 'state.json'), 'utf8'));
  assert.ok(state.digests.goal, 'GO binds the tree digest');
  assert.equal(state.approval.stamp, JSON.parse(cmdRestampRes.text).stamp);

  // /goal-stamp command form works and reports the stamp
  const cmd = reg.cmds.find((c) => c.name === 'goal-stamp');
  const cmdRes = cmd.handler({ rawInput: 'command-user', agent: exec.agent });
  assert.equal(cmdRes.kind, 'success');
  assert.match(cmdRes.text, /"stamped": true/);
  console.log('✓ v0.7 R3 stamp: bind budget / contract-revised deny / restamp / command');
}

// ── 3. requireStamp + time budget + round budget fuses ─────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, { requireStamp: true });
  const work = fs.mkdtempSync('/tmp/v07-fuse-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: fuse\nAC-1 | fail | check: `test -f NOPE` | expected: exit=0\n');
  const unstamped = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(unstamped.info.code, 'unstamped', 'requireStamp denies unapproved contracts');
  await call(reg, 'goal_gate_stamp', { approvedBy: 'tester', timeBudgetMinutes: 1 }, exec);
  // forge an approval timestamp in the past: no need to wait a minute in tests
  const ledger = path.join(work, '.goal-gate');
  const state = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'));
  state.approval.approvedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  fs.writeFileSync(path.join(ledger, 'state.json'), JSON.stringify(state));
  const timed = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(timed.kind, 'deny');
  assert.match(timed.reason, /goal-gate:(time-budget|no-go)/, 'non-GO at expiry is denied');
  // green delivery is never confiscated at the time fuse
  fs.writeFileSync(path.join(work, 'a.txt'), 'ok\n');
  fs.writeFileSync(path.join(ledger, 'goal.md'), 'objective: fuse\nAC-1 | pass | check: `test -f a.txt` | expected: exit=0\n');
  // contract edit voids the stamp; re-approve, keeping the expired clock
  await call(reg, 'goal_gate_stamp', { approvedBy: 'tester', restamp: true }, exec);
  const s2 = JSON.parse(fs.readFileSync(path.join(ledger, 'state.json'), 'utf8'));
  s2.approval.approvedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  fs.writeFileSync(path.join(ledger, 'state.json'), JSON.stringify(s2));
  const greenAtExpiry = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(greenAtExpiry.kind, 'allow', 'GO still delivers after the wall-clock fuse');
  console.log('✓ v0.7 fuses: requireStamp / time-budget denies red / green still delivers');
}

// ── 4. task-board completion claims are gated ──────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-board-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: board\nAC-1 | fail | check: `test -f NOPE` | expected: exit=0\n');
  const d = await claimDecision(reg, exec, 'task_board_manage', { taskId: 'card-1', action: 'move-done' });
  assert.equal(d.kind, 'deny', 'task_board_manage move-done is a completion claim');
  assert.equal(d.info.code, 'no-go');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x');
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: board\nAC-1 | pass | check: `test -f a.txt` | expected: exit=0\n');
  const ok = await claimDecision(reg, exec, 'task_board_manage', { taskId: 'card-1', action: 'move-done' });
  assert.equal(ok.kind, 'allow', 'card move-done passes on GO');
  console.log('✓ v0.7 task board: move-done gated by the same completion authority');
}

// ── 5. read-only status/audit do not burn a round; audit names the contradiction ──
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-status-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: status\nAC-1 | pass | check: `test -f a.txt` | expected: exit=0\n');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x');
  const before = await call(reg, 'goal_gate_status', {}, exec);
  assert.equal(before.contractExists, true);
  assert.equal(before.roundsUsed, 0, 'status on a fresh ledger reports zero rounds');
  await call(reg, 'goal_gate_check', { strategy: 'first wave' }, exec);
  const after = await call(reg, 'goal_gate_status', {}, exec);
  assert.equal(after.roundsUsed, 1, 'one real check = one round');
  const audit = await call(reg, 'goal_gate_audit', {}, exec);
  assert.equal(audit.ok, true, 'audit passes a GO with no contradictions');
  assert.ok(audit.warnings.some((w) => w.code === 'verdict-unbound'), 'audit warns the GO is not bound yet');
  // bind the digest through a goal claim, then mutate and audit again
  await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  const bound = await call(reg, 'goal_gate_status', {}, exec);
  assert.ok(bound.digestBound, 'claim binds the digest');
  fs.writeFileSync(path.join(work, 'a.txt'), 'changed again\n');
  const afterMove = await call(reg, 'goal_gate_audit', {}, exec);
  assert.equal(afterMove.ok, false, 'tree move invalidates the audit');
  assert.ok(afterMove.violations.some((v) => v.code === 'tree-moved'), 'audit names the moved tree');
  console.log('✓ v0.7 status/audit: read-only, round accounting, staleness named');
}

// ── 6. native Agent Teams dispatch (lead vs non-member) ────────────────────
{
  const created = [];
  const team = {
    tryMembership: (agent) => (agent?.lead ? { role: 'lead' } : { role: 'teammate' }),
    createTask: async (_agent, req) => { created.push(req); return { id: `task-${created.length}` }; },
  };
  const reg = makeCtx({ team });
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-dispatch-');
  const lead = { lead: true, session: { header: { cwd: work } } };
  const member = { lead: false, session: { header: { cwd: work } } };
  const loop = await call(reg, 'goal_loop_at', { objective: 'dispatch', acs: ['one', 'two'], dispatch: true }, { agent: lead });
  assert.equal(loop.dispatch.kind, 'agent-teams');
  assert.equal(loop.dispatch.dispatched.length, 2, 'one native team task per AC');
  assert.equal(created.length, 2);
  assert.match(created[0].description, /check:/, 'task description carries the AC check');

  // a non-Lead caller gets suggestions instead of a fake success
  const work2 = fs.mkdtempSync('/tmp/v07-dispatch2-');
  const exec2 = { agent: { lead: false, session: { header: { cwd: work2 } } } };
  await call(reg, 'goal_loop_at', { objective: 'dispatch2', acs: ['one'] }, exec2);
  fs.writeFileSync(path.join(work2, '.goal-gate', 'goal.md'), 'objective: dispatch2\nAC-1 | fail | check: `test -f NOPE` | expected: exit=0\n');
  const repair = await call(reg, 'goal_gate_dispatch', {}, exec2);
  assert.equal(repair.dispatched.length, 0);
  assert.ok(repair.reason && repair.suggestions?.length === 1, 'non-Lead gets a clear reason + suggestions');
  console.log('✓ v0.7 dispatch: native Agent Teams tasks for Leads / suggestions otherwise');
}

// ── 7. efficiency attribution + strategy history ───────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-eff-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  await call(reg, 'goal_loop_at', { objective: 'eff', acs: ['one', 'two'] }, exec);
  const ledger = path.join(work, '.goal-gate');
  const writeContract = (passCount) => {
    const lines = ['objective: eff'];
    for (let i = 1; i <= 2; i++) {
      lines.push(i <= passCount
        ? `AC-${i} | pass ${i} | check: \`test -d .\` | expected: exit=0`
        : `AC-${i} | fail ${i} | check: \`test -f NOPE\` | expected: exit=0`);
    }
    fs.writeFileSync(path.join(ledger, 'goal.md'), `${lines.join('\n')}\n`);
  };
  writeContract(0);
  const c1 = await call(reg, 'goal_gate_check', { strategy: 'build' }, exec);
  writeContract(1);
  const c2 = await call(reg, 'goal_gate_check', { strategy: 'repair floor' }, exec);
  writeContract(2);
  const c3 = await call(reg, 'goal_gate_check', { strategy: 'repair floor' }, exec);
  assert.equal(c1.score, 0);
  assert.equal(c3.score, 1);
  assert.equal(c3.efficiency.scoreDelta, 0.5);
  assert.ok(c3.efficiency.slope > 0, 'efficiency slope is positive');
  assert.ok(c3.efficiency.strategies.some((s) => s.strategy === 'repair floor' && s.runs === 2));
  const history = fs.readFileSync(path.join(ledger, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history[2].strategy, 'repair floor', 'strategy label is recorded');
  console.log('✓ v0.7 efficiency: score delta / slope / per-strategy attribution');
}

// ── 8. human reset clears BLOCKED; model has no reset tool ─────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-reset-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  fs.mkdirSync(path.join(work, '.goal-gate'));
  fs.writeFileSync(path.join(work, '.goal-gate', 'goal.md'), 'objective: reset\nAC-1 | fail | check: `test -f NOPE` | expected: exit=0\n');
  await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  const blocked = await claimDecision(reg, exec, 'update_goal', { action: 'complete' });
  assert.equal(blocked.info.code, 'blocked');
  assert.ok(!reg.tools.some((t) => /reset/.test(t.name)), 'no model-facing reset tool');
  const cmd = reg.cmds.find((c) => c.name === 'goal-reset');
  const r = cmd.handler({ rawInput: '--new-loop human recovered', agent: exec.agent });
  assert.equal(r.kind, 'success');
  const state = JSON.parse(fs.readFileSync(path.join(work, '.goal-gate', 'state.json'), 'utf8'));
  assert.equal(state.falseCompletes, 0, 'human reset clears the block');
  assert.ok(JSON.parse(r.text).newLoop, '--new-loop rotates the experiment clock');
  console.log('✓ v0.7 reset: human-only recovery, no self-unblock tool');
}

// ── 9. objective drift refuses silent re-scoping ───────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const work = fs.mkdtempSync('/tmp/v07-drift-');
  const exec = { agent: { session: { header: { cwd: work } } } };
  await call(reg, 'goal_loop_at', { objective: 'alpha' }, exec);
  await assert.rejects(call(reg, 'goal_loop_at', { objective: 'beta' }, exec), /objective-drift/);
  console.log('✓ v0.7 objective drift: changing the goal requires re-approval, not a silent overwrite');
}

console.log('\nAll v0.7 tests passed.');
