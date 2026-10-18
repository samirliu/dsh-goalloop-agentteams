// grill.js — 契约/eval/metric 的对抗式审查（纯启发式，只读）
// 对应 goal-loop 的 grilling + contract-forge 纪律：盖章前先拷问“什么算完成、
// 这条 check 能不能真失败、这个数能不能被刷、证据能不能追溯”。
// 输出面向模型：findings 直接变成契约修改项，questions 是还需要人回答的 frontier。
import { parseContract, validateTeamMeta, contractStamp, treeDigest, metricKey } from './core.js';

const VAGUE = /(最|尽量|良好|合适|足够|合理|优秀|漂亮|完美|逼真|稳定|流畅|健壮|best|good|nice|robust|reasonable|adequate|high[- ]quality)/i;
const TAUTOLOGY = /^(echo|true|:|printf)\b/;
const RUNTIME = /\b(node|bun|deno|python3?|npx|npm|pytest|go test|cargo test|make|bash|sh)\b|\.(mjs|cjs|js|ts|py|sh|rs|go)\b/;

function high(findings, ac, issue, suggestion) { findings.push({ ac, severity: 'high', issue, suggestion }); }
function medium(findings, ac, issue, suggestion) { findings.push({ ac, severity: 'medium', issue, suggestion }); }
function low(findings, ac, issue, suggestion) { findings.push({ ac, severity: 'low', issue, suggestion }); }

/**
 * Audit a contract as an adversarial eval designer would.
 * Read-only: no checks run, no round burned, no state written.
 * @param {object} input
 * @param {string} input.contractText
 * @param {object} [input.state] ledger state (baselines/spreads/approval)
 * @param {object} [input.loop] loop.json
 * @param {string} [input.cwd] workspace root (defaults to state-free interpretation)
 */
export function grillContract({ contractText, state = {}, loop = null, cwd = '.' } = {}) {
  const findings = [];
  const questions = [];
  const metricDesign = [];
  const goodhart = [];
  const text = String(contractText ?? '');
  const parsed = parseContract(text);
  const acs = parsed.acs ?? [];
  const stamp = acs.length || parsed.objective ? contractStamp(text) : null;
  const digest = cwd ? treeDigest(cwd) : null;

  if (!parsed.objective) high(findings, '*', 'contract has no objective line', 'write one falsifiable objective sentence');
  else if (VAGUE.test(parsed.objective) && !parsed.deliverable) medium(findings, '*', 'objective is qualitative and no deliverable is named', 'name the artifact + at least one judged AC with a written rubric');
  if (!parsed.deliverable) medium(findings, '*', 'no deliverable declared', 'declare deliverable: <path to the artifact itself>');
  if (!acs.length) high(findings, '*', 'contract has no AC lines', 'write AC-1..N, each with a named failable check');
  const teamMeta = validateTeamMeta(acs);
  if (teamMeta) high(findings, '*', teamMeta, 'fix the dependency graph before dispatch; unknown/cyclic deps are state-error');

  const checks = new Map();
  for (const ac of acs) {
    const cmd = (ac.check ?? '').trim();
    checks.set(cmd, (checks.get(cmd) ?? []).concat(ac.id));
    if (!cmd) { high(findings, ac.id, 'check is empty', 'give the exact command that settles this AC'); continue; }
    if (TAUTOLOGY.test(cmd) && !/[><|]|test |grep |\[\[/.test(cmd)) {
      high(findings, ac.id, 'check looks tautological (echo/true/printf without an assertion)', 'make it fail on a bad artifact; include the negative/error path');
    }
    const numeric = /^(<=|>=|<|>|==|=|!=)\s*-?\d/.test(ac.expected ?? '');
    const optimize = ac.expected === 'maximize' || ac.expected === 'minimize';
    if ((numeric || optimize) && !ac.metric) {
      medium(findings, ac.id, 'numeric/optimization AC has no metric regex', 'pin metric: `<regex with one capture group>`; do not rely on the last-number fallback');
    }
    if (numeric && !ac.probe) medium(findings, ac.id, 'numeric AC has no probe (instrument not proven)', 'add probe: `<command that proves the measurement setup>`');
    if (optimize) {
      if (!ac.probe) medium(findings, ac.id, 'optimization AC has no probe', 'prove the measurement instrument before trusting the water mark');
      if (ac.tolerance === null && !ac.sd && !ac.variance) {
        medium(findings, ac.id, 'optimization AC has no noise band', 'add tolerance: or sd:/var:; measure the floor first');
      }
      const hasBaseline = state?.baselines && Object.prototype.hasOwnProperty.call(state.baselines, metricKey(ac));
      if (!hasBaseline) {
        medium(findings, ac.id, 'optimization baseline not established', 'run goal_gate_baseline before stamping; a water mark measured once is not a water mark');
      }
      const spread = state?.spreads?.[metricKey(ac)];
      metricDesign.push({
        ac: ac.id,
        advice: `repeat the measurement N times, print one aggregated number; measured ${hasBaseline ? 'baseline' : 'baseline missing'}${Number.isFinite(spread) ? `, spread≈${spread}` : ''}; use ${ac.sd ? 'sd:' : ac.variance ? 'var:' : 'tolerance:'} band and ${ac.expected}; consider a floor + judged horizon so the number cannot be gamed alone`,
      });
      goodhart.push(`${ac.id}: can a cheaper change move this number without advancing the objective? name and close that path (or split the metric).`);
    }
    if (ac.expected === 'judged') {
      if (!ac.probe) high(findings, ac.id, 'judged AC has no judge', 'probe: is the deterministic judge; without it the verdict is broken');
      if (!ac.calibGood || !ac.calibBad) medium(findings, ac.id, 'judged AC has no calibration fixtures', 'calib: good=<known-good> bad=<known-bad>; a judge that cannot reject the known-bad is not a judge');
      medium(findings, ac.id, 'judged verdict must bind evidence', 'verdict file must carry artifact: <path> and digest: sha256:<64hex>; unbound/stale evidence is broken');
    }
    if (VAGUE.test(ac.statement ?? '') && !optimize && ac.expected !== 'judged' && !numeric) {
      medium(findings, ac.id, 'statement is qualitative but the spec is not judged/metric', 'rewrite as a measurable threshold or make it judged with written anchors');
    }
    if (ac.scope?.length && ac.scope.some((s) => !s || s === '/' || s === '.')) {
      low(findings, ac.id, 'scope is too broad for disjoint team work', 'give workspace-relative file/dir prefixes; overlapping scopes are advisory but slow teams down');
    }
  }
  for (const [cmd, ids] of checks) {
    if (ids.length > 1) medium(findings, ids.join(','), `duplicate check command (${ids.join(', ')})`, 'one artifact should not be judged twice by the same command; split the claim or remove the duplicate');
  }

  // Horizon: an optimization number alone is a Goodhart machine; guard it with a
  // judged+calibrated AC or an explicit waiver (goal-loop R19).
  const hasHorizon = /^horizon-waived\s*:/mi.test(text)
    || acs.some((a) => a.expected === 'judged' && a.calibGood && a.calibBad);
  const optimizeAcs = acs.filter((a) => a.expected === 'maximize' || a.expected === 'minimize');
  if (optimizeAcs.length && !hasHorizon) {
    medium(findings, '*', 'optimization has no horizon guard', 'add a judged AC with calib: (written anchors + known good/bad), or declare `horizon-waived: <reason>`');
    questions.push('What does the optimization number NOT see, and which judged/qa horizon catches it?');
  }

  // Evidence pyramid: runtime execution of the deliverable itself.
  const runtimeAcs = acs.filter((a) => RUNTIME.test(a.check ?? ''));
  if (acs.length && runtimeAcs.length === 0) {
    high(findings, '*', 'no AC executes anything at runtime', 'add a runtime AC that runs the deliverable in its real environment');
  }
  if (parsed.deliverable) {
    const base = parsed.deliverable.split('/').pop();
    if (!acs.some((a) => (a.check ?? '').includes(parsed.deliverable) || (a.check ?? '').includes(base))) {
      high(findings, '*', 'deliverable is not touched by any check', 'at least one AC must execute/read the deliverable itself, not just derived data');
    }
  }
  // Error-path coverage is a first-class claim, not an afterthought.
  if (acs.length && !acs.some((a) => /^exit=[1-9]/.test(a.expected ?? '') || a.expected === 'judged')) {
    low(findings, '*', 'no negative/error-path AC', 'add one AC that proves a known-bad input is refused (exit=N)');
  }
  // Scopes: warn about overlapping team write sets.
  for (let i = 0; i < acs.length; i++) {
    for (let j = i + 1; j < acs.length; j++) {
      const a = acs[i], b = acs[j];
      for (const sa of a.scope ?? []) {
        for (const sb of b.scope ?? []) {
          if (sa === sb || sa.startsWith(`${sb}/`) || sb.startsWith(`${sa}/`)) {
            medium(findings, `${a.id},${b.id}`, `overlapping write scopes (${sa} / ${sb})`, 'teams edit the same files; order them with depends: or split the scopes');
          }
        }
      }
    }
  }
  if (loop && Number(loop.maxRounds) <= 1) {
    low(findings, '*', 'round budget leaves no room for a repair round', 'set maxRounds >= 2, or accept that the first check is the last');
  }

  // Frontier questions: only ask what the contract cannot answer by itself.
  questions.push('What would make this pass without advancing the objective? Name the cheapest gaming path.');
  if (!parsed.deliverable) questions.push('Which file/artifact is the deliverable itself, and which command runs it?');
  if (acs.some((a) => a.expected === 'maximize' || a.expected === 'minimize')) {
    questions.push('What is the measured baseline and its run-to-run spread, and which direction is improvement?');
  }
  if (acs.some((a) => a.expected === 'judged')) questions.push('Who/what is the judge, what anchors does it use, and which known-good/known-bad fixtures calibrate it?');
  if (acs.some((a) => /^exit=0$/.test(a.expected ?? ''))) questions.push('Which known-bad input must be refused, and with which exact exit code?');
  if (!acs.some((a) => a.depends?.length)) questions.push('Which ACs can run in parallel, and which must wait for another AC (depends:)?');

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMedium = findings.some((f) => f.severity === 'medium');
  return {
    ok: !hasHigh && !hasMedium,
    verdict: hasHigh || hasMedium ? 'needs-work' : 'ready',
    findings,
    questions,
    metricDesign,
    goodhart: [...new Set(goodhart)],
    stamp,
    digest,
    ...(state?.approval ? { approval: state.approval } : {}),
  };
}
