// lessons.js — 学习边（Art3 §6「the learning edge」/ Art1 §14「failure upgrades the harness」）
//
// 病根：图有纠正边（gate 把失败单元打回生产者，修的是**这一次**），
// 但没有学习边（被确认的病因变成约束，修的是**以后每一次**）。
// 症状就是"系统很快，但永远不会变聪明"。
//
// 本模块只做三件事：
//   1. 观测：每次门控后，把失败/损坏的 AC 按「AC 编号 + 成因签名」累计；
//   2. 升格：同一成因复发 ≥2 次 → 变成一条持久 lesson（约束候选）；
//   3. 结账：lesson 必须被显式处理（resolved 附证据 / waived 附理由），
//      否则**下次盖章**和**完成声明**都不放行——约束回流到"切分工作的那份 brief"，
//      而不是停在某个 worker 的指令里。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LESSONS_FILE = 'lessons.json';
export const PROMOTE_AT = 2; // 同一成因复发 2 次即升格（1 次可能只是偶发）

/** 成因签名：状态 + 归一化后的 why（去掉数字/摘要等易变部分），保证"同一个病"能对上号。 */
export function failureSignature(status, why) {
  const norm = String(why ?? '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#hash')
    .replace(/\b\d+(\.\d+)?\b/g, '#n')
    .replace(/rc=#n/g, 'rc=#n')
    .slice(0, 160)
    .trim();
  return createHash('sha1').update(`${status}|${norm}`).digest('hex').slice(0, 10);
}

function lessonsPath(root) { return path.join(root, '.goal-gate', LESSONS_FILE); }

export function readLessons(root) {
  try {
    const j = JSON.parse(fs.readFileSync(lessonsPath(root), 'utf8'));
    return { version: 1, lessons: j.lessons ?? {} };
  } catch { return { version: 1, lessons: {} }; }
}

export function writeLessons(root, data) {
  const p = lessonsPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, p); // 原子替换：与 state.json 同款纪律
}

/**
 * Observe one gate run and promote recurring failure causes into lessons.
 * Pure bookkeeping — never judges the artifact itself.
 * @returns {{ promoted: string[], lessonCount: number }}
 */
export function recordLessons(root, { results = [], stamp = null, round = null, now = new Date().toISOString() } = {}) {
  const data = readLessons(root);
  const promoted = [];
  for (const r of results) {
    if (r.status !== 'failed' && r.status !== 'broken') continue;
    const sig = failureSignature(r.status, r.why);
    const key = `${r.id}::${sig}`;
    const prev = data.lessons[key];
    // 同一轮重复记账（check + intercept）不应把计数翻倍：按 round+trigger 去重。
    const roundKey = round === null || round === undefined ? null : String(round);
    if (prev && roundKey !== null && prev.lastRound === roundKey) continue;
    const count = (prev?.count ?? 0) + 1;
    // 已处理的 lesson 再次复发 → 重新打开：约束没起作用，这件事本身必须被看见。
    const resurfaced = prev?.state === 'resolved' || prev?.state === 'waived';
    const reopened = resurfaced ? (prev?.reopened ?? 0) + 1 : prev?.reopened;
    data.lessons[key] = {
      ...(prev ?? {}),
      key, acId: r.id, sig, status: r.status, why: String(r.why ?? '').slice(0, 300),
      count, firstSeen: prev?.firstSeen ?? now, lastSeen: now,
      ...(roundKey !== null ? { lastRound: roundKey } : {}),
      ...(stamp ? { stamps: [...new Set([...(prev?.stamps ?? []), stamp])].slice(-5) } : {}),
      ...(reopened !== undefined ? { reopened } : {}),
      state: resurfaced ? 'open' : (prev?.state ?? 'pending'),
    };
    if (count >= PROMOTE_AT && data.lessons[key].state === 'pending') {
      data.lessons[key].state = 'open';
      data.lessons[key].promotedAt = now;
      promoted.push(key);
    }
  }
  writeLessons(root, data);
  return { promoted, lessonCount: Object.keys(data.lessons).length };
}

/** Lessons that are promoted and still open — these block stamping/claiming. */
export function openLessons(root) {
  const { lessons } = readLessons(root);
  return Object.values(lessons).filter((l) => l.state === 'open');
}

/** All recorded causes, for audit/diagnostics (including pending, not yet promoted). */
export function allLessons(root) {
  return Object.values(readLessons(root).lessons).sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
}

/**
 * Close a lesson: `resolved` needs evidence for what changed, `waived` needs a reason.
 * A bare acknowledgement is refused — that is just silencing the alarm.
 */
export function handleLesson(root, { key, action, note, by = 'user', now = new Date().toISOString() } = {}) {
  const data = readLessons(root);
  const lesson = data.lessons[key];
  if (!lesson) return { ok: false, code: 'unknown-lesson', detail: `没有这条 lesson: ${key}` };
  if (action !== 'resolved' && action !== 'waived') {
    return { ok: false, code: 'bad-action', detail: 'action 必须是 resolved(附证据) 或 waived(附理由)' };
  }
  if (typeof note !== 'string' || note.trim().length < 8) {
    return { ok: false, code: 'note-required', detail: `${action} 必须写清楚原因/证据(≥8 字)——空口结账等于把报警器关掉` };
  }
  lesson.state = action;
  lesson.handledBy = by;
  lesson.handledAt = now;
  lesson.note = note.trim();
  writeLessons(root, data);
  return { ok: true, code: action, key, lesson };
}

/** Human-readable one-liner used in denials and audit output. */
export function describeLesson(l) {
  return `${l.acId} 复发 ${l.count} 次 [${l.status}] ${l.why ? `— ${l.why}` : ''}`.trim();
}
