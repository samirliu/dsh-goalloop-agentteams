// examples/plugin-e2e/run.mjs — complex end-to-end cases for dsh-goalloop-agentteams.
//
// These cases exercise the plugin the way a real team uses it: a multi-wave build
// with scopes/dependencies, grilling + baseline + stamp, native Agent Teams
// staffing/collection (API-faithful fake service), repair gates, judged evidence,
// budgets, BLOCKED/reset, and concurrent CLI checks.
//
// Run with the bundled Node (never a bare `node`):
//   <abs-node> examples/plugin-e2e/run.mjs
// Exit 0 = all cases pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileExists, fileContains, showFile, sleep, nodeNoop, sequence, all } from '../../test/fixtures/shell.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const NODE = process.execPath;
// Absolute-path ESM imports must go through fileURLToPath/pathToFileURL: a bare
// Windows path ("C:\\...\\lib\\index.js") is not a valid import specifier.
const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'lib/core.js')).href);

const results = [];
function caseStart(name) { console.log(`\n=== ${name} ===`); }
function pass(name) { results.push({ name, ok: true }); console.log(`✓ ${name}`); }
function failCase(name, error) { results.push({ name, ok: false, error }); console.error(`✗ ${name}: ${error?.stack ?? error}`); }
async function runCase(name, fn) {
  caseStart(name);
  try { await fn(); pass(name); } catch (e) { failCase(name, e); }
}

function fakeTeam() {
  const members = [{ id: 'lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] }];
  const tasks = [];
  const spawns = [];
  let n = 0;
  return {
    members, tasks, spawns,
    tryMembership: (agent) => (agent?.member ? { role: 'lead' } : undefined),
    listMembers: () => members,
    listTasks: () => tasks,
    createTask: async (_agent, req) => {
      const task = {
        id: `task-${++n}`, revision: 1, status: 'pending',
        ready: (req.blockedBy ?? []).length === 0,
        blockedBy: req.blockedBy ?? [], writeScopes: req.writeScopes ?? [], writeScopeWarnings: [],
        ownerName: req.owner, ...req,
      };
      tasks.push(task);
      return task;
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
      const member = { id: `member-${spawns.length}`, name: req.name, role: 'teammate', status: 'running', diagnostics: [] };
      members.push(member);
      return { member };
    },
    sendMessage: async () => ({ messageId: 'm1' }),
  };
}

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

function makeWorkspace(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `goalloop-e2e-${label}-`));
  fs.mkdirSync(path.join(root, '.goal-gate'), { recursive: true });
  return root;
}
function writeFile(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function contract(root, lines) {
  writeFile(root, '.goal-gate/goal.md', `${lines.join('\n')}\n`);
}
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
async function call(reg, name, args, exec) { return reg.tools.find((t) => t.name === name).execute(args ?? {}, exec); }
function execFor(root, team = false) {
  return { agent: { member: team, session: { header: { cwd: root } } }, signal: new AbortController().signal };
}

// ── Case 1: multi-wave delivery, staffing, repair, judged evidence ─────────
await runCase('multi-wave delivery (staff → collect → gate → audit)', async () => {
  const team = fakeTeam();
  const reg = makeCtx(team);
  mod.apply(reg.ctx, {});
  const root = makeWorkspace('multi');
  const exec = execFor(root, true);
  writeFile(root, 'fixtures/good.csv', 'name,age\nalice,30\nbob,25\n');
  writeFile(root, 'fixtures/bad.csv', 'name,age\nalice\n');
  writeFile(root, 'dist/csv2jsonl.mjs', '#!/usr/bin/env node\nconsole.error("not implemented"); process.exit(1);\n');
  writeFile(root, 'tests/run.mjs', 'process.exit(1);\n');
  writeFile(root, 'bench/bench.mjs', 'console.log("rows_per_sec=1000");\n');
  writeFile(root, 'docs/README.md', '# converter\n\nTODO\n');
  writeFile(root, 'verify/good-doc.md', '# good documentation\n\nCLI, errors, examples.\n');
  writeFile(root, 'verify/bad-doc.md', '# bad\n');
  // 判读席:门控会把 `{file}` 换成待判文件的绝对路径——对真实产物和两个
  // calib 夹具用的是同一把尺子,所以它必须真的按内容判。
  writeFile(root, 'verify/judge-docs.mjs', `import fs from 'node:fs';
const file = process.argv[2];
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(2); }
const lines = text.split('\\n').filter(Boolean);
const good = /(usage|cli|errors?|examples?)/i.test(text) && lines.length >= 2;
if (good) { console.log('score: 0.9'); process.exit(0); }
process.exit(1);
`);

  contract(root, [
    'objective: ship a CSV-to-JSONL converter with validation, tests, benchmark and docs',
    'deliverable: dist/csv2jsonl.mjs',
    'exit: strict',
    `AC-1 | happy path converts rows | check: \`"${NODE}" dist/csv2jsonl.mjs fixtures/good.csv\` | scope: dist | expected: exit=0`,
    `AC-2 | malformed row is refused with exit 2 | check: \`"${NODE}" dist/csv2jsonl.mjs fixtures/bad.csv\` | scope: dist | depends: AC-1 | expected: exit=2`,
    `AC-3 | unit suite passes | check: \`"${NODE}" tests/run.mjs\` | scope: tests | depends: AC-1 | expected: exit=0`,
    `AC-4 | throughput improves over the measured baseline | check: \`"${NODE}" bench/bench.mjs\` | probe: \`"${NODE}" --version\` | metric: \`rows_per_sec=([0-9.]+)\` | baseline: delta | tolerance: 0.8 | scope: bench | depends: AC-3 | expected: maximize`,
    'AC-5 | docs are accurate and calibrated | check: `' + showFile('.goal-gate/evidence/docs-verdict.txt') + '` | probe: `"' + NODE + '" verify/judge-docs.mjs {file}` | calib: good=verify/good-doc.md bad=verify/bad-doc.md | scope: docs | depends: AC-3 | expected: judged',
  ]);

  const start = await call(reg, 'goal_loop_at', { objective: 'ship a CSV-to-JSONL converter with validation, tests, benchmark and docs', maxRounds: 8 }, exec);
  assert.equal(start.created, false);
  assert.ok(start.grill, 'goal_loop_at grills the design by default');
  assert.equal(start.grill.verdict, 'needs-work');
  assert.ok(Array.isArray(start.nextActions) && start.nextActions.length > 0, 'the start reply carries next actions, not just JSON');
  const refused = await call(reg, 'goal_gate_staff', { spawn: true, members: [{ name: 'core-builder', acs: ['AC-1', 'AC-2', 'AC-4'] }, { name: 'docs-builder', acs: ['AC-3', 'AC-5'] }] }, exec);
  assert.equal(refused.mode, 'suggestions', 'dispatch is refused while the grill verdict is not ready');
  assert.equal(refused.dispatched.length, 0);
  assert.match(refused.reason ?? '', /grill verdict=needs-work/);
  assert.match(refused.findings[0].suggestion ?? '', /./, 'the refusal names what to fix');

  const weakGrill = await call(reg, 'goal_gate_grill', {}, exec);
  assert.equal(weakGrill.verdict, 'needs-work');
  assert.ok(weakGrill.findings.some((f) => /baseline/.test(f.issue)), 'grill asks for a measured baseline');

  const baseline = await call(reg, 'goal_gate_baseline', { samples: 2 }, exec);
  assert.equal(baseline.recorded, true);
  const strongGrill = await call(reg, 'goal_gate_grill', {}, exec);
  assert.equal(strongGrill.verdict, 'ready', JSON.stringify(strongGrill.findings));

  const stamped = await call(reg, 'goal_gate_stamp', { approvedBy: 'case-1', maxRounds: 8 }, exec);
  assert.equal(stamped.stamped, true);

  const noGo = await call(reg, 'goal_gate_check', { strategy: 'first build' }, exec);
  assert.equal(noGo.rc, 2);
  assert.ok(noGo.failedActions.length >= 3);

  // Build the team from ACs (explicit members, one task per owned AC).
  const staffed = await call(reg, 'goal_gate_staff', {
    spawn: true,
    members: [
      { name: 'core-builder', acs: ['AC-1', 'AC-2', 'AC-4'] },
      { name: 'docs-builder', acs: ['AC-3', 'AC-5'] },
    ],
  }, exec);
  assert.equal(staffed.mode, 'spawned');
  assert.equal(team.spawns.length, 2);
  assert.equal(team.tasks.length, 5);
  assert.ok(team.tasks.every((t) => t.ownerName));

  // Implement the deliverable (the teammates' work in a real run).
  writeFile(root, 'dist/csv2jsonl.mjs', `import fs from 'node:fs';
export function convert(text) {
  const lines = text.trim().split(/\\r?\\n/).filter(Boolean);
  if (!lines.length) throw new Error('empty input');
  const head = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    if (cells.length !== head.length) throw new Error('row width mismatch');
    return JSON.stringify(Object.fromEntries(head.map((k, i) => [k, cells[i]])));
  }).join('\\n') + '\\n';
}
if (process.argv[1] && process.argv[1].endsWith('csv2jsonl.mjs')) {
  try { process.stdout.write(convert(fs.readFileSync(process.argv[2], 'utf8'))); }
  catch (e) { console.error(e.message); process.exit(2); }
}
`);
  writeFile(root, 'tests/run.mjs', `import assert from 'node:assert/strict';
import { convert } from '../dist/csv2jsonl.mjs';
assert.equal(convert('a,b\\n1,2\\n'), '{"a":"1","b":"2"}\\n');
assert.throws(() => convert('a,b\\n1\\n'), /width mismatch/);
console.log('ok');
`);
  writeFile(root, 'bench/bench.mjs', `import { convert } from '../dist/csv2jsonl.mjs';
const csv = 'a,b\\n' + Array.from({ length: 20000 }, (_, i) => \`\${i},\${i + 1}\`).join('\\n') + '\\n';
const t0 = performance.now();
for (let i = 0; i < 5; i++) convert(csv);
const rows = 20000 * 5;
const sec = (performance.now() - t0) / 1000;
console.log(\`rows_per_sec=\${Math.round(rows / sec)}\`);
`);
  writeFile(root, 'docs/README.md', `# csv2jsonl\n\nUsage: node dist/csv2jsonl.mjs <input.csv>\n\nEach data row becomes one JSON object; a row whose width differs from the header is rejected with exit code 2.\n\nExample:\n\n  printf 'a,b\\\\n1,2\\\\n' > x.csv && node dist/csv2jsonl.mjs x.csv\n`);
  const verdictFile = path.join(root, '.goal-gate/evidence/docs-verdict.txt');
  fs.mkdirSync(path.dirname(verdictFile), { recursive: true });
  fs.writeFileSync(verdictFile, `VERDICT: PASS\nscore: 0.9\nartifact: docs/README.md\ndigest: sha256:${sha256(path.join(root, 'docs/README.md'))}\ncalib-good: PASS\ncalib-bad: FAIL\n`);

  // Teammates complete their tasks; the Lead collects.
  for (const t of team.tasks) t.status = 'completed';
  const collected = await call(reg, 'goal_gate_collect', {}, exec);
  assert.equal(collected.readyToCheck, true);

  const go = await call(reg, 'goal_gate_check', { strategy: 'repair + docs' }, exec);
  assert.equal(go.rc, 0, JSON.stringify(go.failedActions));
  assert.equal(go.code, 'go');
  assert.equal(go.team.members.length, 3);
  assert.ok(go.nextActions.some((a) => a.action === 'audit-and-claim'));

  const audit = await call(reg, 'goal_gate_audit', {}, exec);
  assert.equal(audit.ok, true, JSON.stringify(audit.violations));

  // A goal claim binds the digest and is allowed on GO.
  const decision = await reg.listeners[0]({ name: 'update_goal', arguments: { action: 'complete' }, agent: exec.agent }, () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow');
  console.log(`  rounds=${go.round}, tasks=${team.tasks.length}, score=${go.score}, efficiency=${JSON.stringify(go.efficiency)}`);
});

// ── Case 2: adversarial contract is grilled, fixed, then gate GO ───────────
await runCase('adversarial contract (grill catches, fix → GO)', async () => {
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const root = makeWorkspace('grill');
  const exec = execFor(root);
  contract(root, [
    'objective: make it good',
    'AC-1 | it works | check: `echo ok` | expected: exit=0',
  ]);
  const weak = await call(reg, 'goal_gate_grill', {}, exec);
  assert.equal(weak.verdict, 'needs-work');
  assert.ok(weak.findings.some((f) => f.severity === 'high' && /tautolog/.test(f.issue)));
  assert.ok(weak.findings.some((f) => /deliverable/.test(f.issue)));

  writeFile(root, 'out.txt', 'artifact\n');
  contract(root, [
    'objective: make it good',
    'deliverable: out.txt',
    `AC-1 | runtime executes the deliverable | check: \`${all(fileExists('out.txt'), nodeNoop())}\` | expected: exit=0`,
    `AC-2 | known-bad input is refused | check: \`${fileExists('NOPE')}\` | expected: exit=1`,
  ]);
  const strong = await call(reg, 'goal_gate_grill', {}, exec);
  assert.equal(strong.verdict, 'ready', JSON.stringify(strong.findings));
  const go = await call(reg, 'goal_gate_check', {}, exec);
  assert.equal(go.rc, 0);
});

// ── Case 3: stamp / contract-revised / false-complete / BLOCKED / reset ────
await runCase('budgets, contract-revision, BLOCKED and human reset', async () => {
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const root = makeWorkspace('fuses');
  const exec = execFor(root);
  contract(root, ['objective: fuses', `AC-1 | fail | check: \`${fileExists('NOPE')}\` | expected: exit=0`]);
  const stamp = await call(reg, 'goal_gate_stamp', { approvedBy: 'case-3', maxRounds: 1 }, exec);
  assert.equal(stamp.maxRounds, 1);

  // Edit after stamp -> approval void.
  contract(root, ['objective: fuses', `AC-1 | fail | check: \`${fileExists('NOPE2')}\` | expected: exit=0`]);
  const revised = await reg.listeners[0]({ name: 'update_goal', arguments: { action: 'complete' }, agent: exec.agent }, () => ({ kind: 'allow' }));
  assert.equal(revised.info.code, 'contract-revised');

  await call(reg, 'goal_gate_stamp', { approvedBy: 'case-3', restamp: true, maxRounds: 1 }, exec);
  const claim = async () => reg.listeners[0]({ name: 'update_goal', arguments: { action: 'complete' }, agent: exec.agent }, () => ({ kind: 'allow' }));
  const first = await claim();
  assert.equal(first.kind, 'deny');
  const second = await claim();
  assert.equal(second.info.code, 'blocked', 'two false completes block the gate');

  const reset = await reg.cmds.find((c) => c.name === 'goal-reset').handler({ rawInput: '--new-loop case-3', agent: exec.agent });
  assert.equal(reset.kind, 'success');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.goal-gate/state.json'), 'utf8'));
  assert.equal(state.falseCompletes, 0);
});

// ── Case 4: concurrent CLI checks serialize through the ledger lock ───────
await runCase('concurrent CLI checks (lock + wait)', async () => {
  const root = makeWorkspace('concurrent');
  writeFile(root, 'a.txt', 'x\n');
  contract(root, ['objective: concurrent', `AC-1 | slow pass | check: \`${sequence(sleep(0.6), fileExists('a.txt'))}\` | expected: exit=0`]);
  const cli = path.join(ROOT, 'bin/gate.mjs');
  const runCli = () => new Promise((resolve) => {
    const child = spawn(NODE, [cli, 'check', '--cwd', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  const [a, b] = await Promise.all([runCli(), runCli()]);
  assert.equal(a.code, 0, `first CLI failed: ${a.stdout.slice(0, 300)}`);
  assert.equal(b.code, 0, `second CLI failed: ${b.stdout.slice(0, 300)}`);
  const history = fs.readFileSync(path.join(root, '.goal-gate/history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(history.length, 2, 'both checks were recorded exactly once');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.goal-gate/state.json'), 'utf8'));
  assert.equal(state.bestScore, 1);
});

// ── Case 5: judged evidence binding: stale digest is BROKEN, fresh passes ─
await runCase('judged evidence: digest binding and calibration', async () => {
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const root = makeWorkspace('judged');
  const exec = execFor(root);
  writeFile(root, 'artifact.txt', 'v1\n');
  writeFile(root, 'good.txt', 'known good\n');
  writeFile(root, 'bad.txt', 'known bad\n');
  // 判读席按内容判定:门控会把 `{file}` 换成 artifact 或 calib 夹具的绝对路径。
  writeFile(root, 'judge.mjs', `import fs from 'node:fs';
let text = '';
try { text = fs.readFileSync(process.argv[2], 'utf8'); } catch { process.exit(2); }
if (/known good/.test(text) || /^v\\d/m.test(text)) { console.log('score: 0.9'); process.exit(0); }
process.exit(1);
`);
  const verdict = path.join(root, '.goal-gate/evidence/verdict.txt');
  fs.mkdirSync(path.dirname(verdict), { recursive: true });
  const writeVerdict = (digest) => fs.writeFileSync(verdict, `VERDICT: PASS\nscore: 0.9\nartifact: artifact.txt\ndigest: sha256:${digest}\ncalib-good: PASS\ncalib-bad: FAIL\n`);
  writeVerdict(sha256(path.join(root, 'artifact.txt')));
  contract(root, [
    'objective: judged evidence',
    'deliverable: artifact.txt',
    'AC-1 | quality is judged with bound evidence | check: `' + showFile('.goal-gate/evidence/verdict.txt') + '` | probe: `"' + NODE + '" judge.mjs {file}` | calib: good=good.txt bad=bad.txt | expected: judged',
  ]);
  const ok = await call(reg, 'goal_gate_check', {}, exec);
  assert.equal(ok.rc, 0, JSON.stringify(ok.results));

  writeFile(root, 'artifact.txt', 'v2 changed\n');
  const stale = await call(reg, 'goal_gate_check', {}, exec);
  assert.equal(stale.rc, 2);
  assert.equal(stale.code, 'broken');
  assert.match(stale.results[0].why, /digest/);

  writeVerdict(sha256(path.join(root, 'artifact.txt')));
  const fresh = await call(reg, 'goal_gate_check', {}, exec);
  assert.equal(fresh.rc, 0);
});

// ── Summary ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
if (failed.length) {
  for (const f of failed) console.error(`FAILED: ${f.name}\n${f.error}`);
  process.exit(1);
}
console.log('All plugin e2e cases passed.');
