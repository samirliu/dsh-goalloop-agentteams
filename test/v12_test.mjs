// v12_test.mjs — v0.12: the learning edge (Art3 §6 / Art1 §14)
// "Any failure you do not turn into a permanent constraint, you will meet again."
// Observed causes are promoted to lessons after 2 occurrences; open lessons block
// stamping and completion claims until they are resolved (with evidence) or waived.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { failureSignature, recordLessons, openLessons, allLessons, handleLesson, PROMOTE_AT } from '../lib/lessons.js';
import { applyStamp, auditReport, recordRun, readState } from '../lib/ledger.js';
import { runGate } from '../lib/core.js';
import { grillContract } from '../lib/grill.js';

const mod = await import('../lib/index.js');

function workspace(contractBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-'));
  fs.mkdirSync(path.join(root, '.goal-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'good\n');
  fs.writeFileSync(path.join(root, '.goal-gate/goal.md'), contractBody);
  return root;
}
const HEALTHY = 'objective: learn\nAC-1 | present | check: `test -f artifact.txt` | neg: `test -f __absent__` | expected: exit=0\n';
const failing = (why = 'assertion blew up rc=1') => [{ id: 'AC-1', status: 'failed', why }];

function makeCtx() {
  const tools = [], listeners = [];
  const ctx = {
    tools: { register: (t) => tools.push(t), schemas: () => tools.map((t) => ({ name: t.name, parameters: t.parameters })) },
    inject: (_d, fn) => fn({ commands: { register: () => {} }, skills: { register: () => {}, list: async () => [] }, get: () => undefined }),
    get: () => undefined,
    on: (name, fn) => { if (name === 'tools/pre-execute') listeners.push(fn); return () => {}; },
    logger: { warn: () => {} },
  };
  return { ctx, tools, listeners };
}
const call = (reg, name, args, exec) => reg.tools.find((t) => t.name === name).execute(args ?? {}, exec);
const execFor = (root) => ({ agent: { session: { header: { cwd: root } } } });

// ── 1. 成因签名：易变部分被归一化，同一个病对得上号 ────────────────────────
{
  const a = failureSignature('failed', 'expected 10 got 3 (rc=1)');
  const b = failureSignature('failed', 'expected 27 got 8 (rc=1)');
  assert.equal(a, b, 'numbers are normalized away');
  assert.notEqual(a, failureSignature('broken', 'expected 10 got 3 (rc=1)'), 'status is part of the identity');
  console.log('✓ v0.12 signature: the same cause maps to the same key');
}

// ── 2. 升格：复发 2 次才成为 open lesson；同一轮不重复计数 ─────────────────
{
  const root = workspace(HEALTHY);
  const first = recordLessons(root, { results: failing(), round: 1 });
  assert.equal(first.promoted.length, 0);
  assert.equal(allLessons(root)[0].state, 'pending', 'one occurrence is not yet a lesson');

  recordLessons(root, { results: failing(), round: 1 }); // same round: deduped
  assert.equal(allLessons(root)[0].count, 1, 'the same round does not double-count');

  const second = recordLessons(root, { results: failing(), round: 2 });
  assert.equal(second.promoted.length, 1);
  assert.equal(openLessons(root).length, 1, `promoted at ${PROMOTE_AT} occurrences`);
  console.log('✓ v0.12 promote: recurring cause becomes an open lesson (deduped per round)');
}

// ── 3. 空口结账被拒：必须写清证据/理由 ────────────────────────────────────
{
  const root = workspace(HEALTHY);
  recordLessons(root, { results: failing(), round: 1 });
  const key = allLessons(root)[0].key;
  const bare = handleLesson(root, { key, action: 'resolved', note: '' });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'note-required', 'silencing the alarm is not a fix');
  const done = handleLesson(root, { key, action: 'resolved', note: '把断言从字符串比较改成解析后比较,已覆盖 rc=1 路径', by: 'samir' });
  assert.equal(done.ok, true);
  assert.equal(openLessons(root).length, 0);
  // 同一成因再次复发 → 重新打开，并记账"约束没起作用"
  recordLessons(root, { results: failing(), round: 3 });
  const re = allLessons(root)[0];
  assert.equal(re.state, 'open', 'a resurfaced cause reopens the lesson');
  assert.equal(re.reopened, 1);
  console.log('✓ v0.12 close: evidence required; a resurfacing cause reopens');
}

// ── 4. 学习边回流到 brief：未结账就不许盖章 ───────────────────────────────
{
  const root = workspace(HEALTHY);
  recordLessons(root, { results: failing(), round: 1 });
  recordLessons(root, { results: failing(), round: 2 });
  const blocked = applyStamp(root, HEALTHY, { approvedBy: 'samir' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'lessons-open');
  assert.match(blocked.detail, /AC-1/);
  const forced = applyStamp(root, HEALTHY, { approvedBy: 'samir', acceptLessons: true });
  assert.equal(forced.ok, true, 'informed override exists, but it must be explicit');
  console.log('✓ v0.12 stamp: open lessons block approval unless explicitly overridden');
}

// ── 5. 完成声明被拦；结账后放行 ──────────────────────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const [hook] = reg.listeners;
  const root = workspace(HEALTHY);
  const exec = execFor(root);
  const claim = { name: 'update_goal', arguments: { action: 'complete' }, agent: exec.agent };
  const pass = () => hook(claim, async () => ({ kind: 'allow' }));

  assert.equal((await pass()).kind, 'allow', 'clean workspace can claim');

  recordLessons(root, { results: failing(), round: 1 });
  recordLessons(root, { results: failing(), round: 2 });
  const denied = await pass();
  assert.equal(denied.kind, 'deny');
  assert.equal(denied.info.code, 'lessons-open');

  const key = openLessons(root)[0].key;
  await call(reg, 'goal_gate_lesson', { action: 'waived', key, note: '该失败来自已下线的旧环境,不再适用,已在契约里移除对应前置' }, exec);
  assert.equal((await pass()).kind, 'allow', 'closing the lesson unblocks the claim');
  console.log('✓ v0.12 claim: completion is blocked while a cause is unaccounted for');
}

// ── 6. 工具面：list 可见、audit 亮牌、grill 落点 ─────────────────────────
{
  const reg = makeCtx();
  mod.apply(reg.ctx, {});
  const root = workspace(HEALTHY);
  const exec = execFor(root);
  recordLessons(root, { results: failing(), round: 1 });
  recordLessons(root, { results: failing(), round: 2 });

  const listed = await call(reg, 'goal_gate_lesson', { action: 'list' }, exec);
  assert.equal(listed.ok, true);
  assert.equal(listed.open.length, 1);
  assert.equal(listed.promoteAt, PROMOTE_AT);

  const report = auditReport(root);
  assert.ok(report.warnings.some((w) => w.code === 'lessons-open' && /AC-1/.test(w.detail)), 'audit names it');

  const grilled = grillContract({ contractText: HEALTHY, cwd: root });
  assert.ok(grilled.findings.some((f) => f.ac === 'AC-1' && /recurring failure cause/.test(f.issue)), 'the brief (contract review) inherits the constraint');
  console.log('✓ v0.12 surface: list / audit / grill all carry the learning edge');
}

// ── 7. 记录不阻断门控本身（学习是记账，不是判据）────────────────────────
{
  const root = workspace('objective: learn\nAC-1 | fails | check: `test -f NOPE` | neg: `test -f __absent__` | expected: exit=0\n');
  const g = runGate(fs.readFileSync(path.join(root, '.goal-gate/goal.md'), 'utf8'), { cwd: root });
  const st = readState(root);
  assert.doesNotThrow(() => recordRun(root, st, g, 'check'));
  assert.ok(allLessons(root).length >= 1, 'a failing gate run leaves a cause on record');
  console.log('✓ v0.12 isolation: recording never changes the verdict');
}

console.log('\nAll v0.12 tests passed.');
