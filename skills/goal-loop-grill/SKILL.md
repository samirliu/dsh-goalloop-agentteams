---
name: goal-loop-grill
description: >-
  Adversarial pre-stamp review of a goal-loop contract's evaluation design:
  interrogate the objective until every acceptance criterion is falsifiable,
  cheap to re-run, hard to game, and evidence-bound. Use for "grill the eval",
  Goodhart audit, metric design, or attacking a weak contract before stamping.
whenToUse: >-
  Load before goal_gate_stamp, or when the user says "grill this contract",
  "poke holes in the eval", "is this metric gameable", "design the metric",
  "audit our acceptance criteria". Not for drafting from scratch
  (goal-loop-contract) or for running the loop/gate (goal-loop).
---

# Goal Loop Grill
**Role.** The pre-stamp adversarial evaluator for **goal-loop**. Interrogate the objective and its evaluation until the contract can fail honestly. You do not judge completion, run the gate, or stamp; `goal_gate_check` decides GO and the user signs the stamp. 盖戳前的对抗式评估审查。

**Run order** (no stamp before the last step):
```
goal_loop_at/edit contract -> read preflight -> smoke every check -> goal_gate_baseline
-> goal_gate_grill -> fix findings -> re-grill/re-baseline -> user approval -> goal_gate_stamp -> loop
```
`goal_gate_status({})` is read-only (stamp/approval state, no check, no round).

- `goal_gate_grill` is the checklist, not your prose. Run it, quote it, close it; "looks reasonable" is not a review.
- `goal_gate_baseline` measures the optimize ACs and records baseline/spread; it burns no round. Never choose a threshold, tolerance, or `maximize`/`minimize` without it (or the same command run at least twice by hand).
- Advisory vs decisive: `verdict: ready` is not GO. A clean grill never excuses a broken instrument; only `goal_gate_check` can return GO.
- Never stamp on your own authority, and never edit a stamped contract silently.

## Interview discipline

Design tree; each branch is a decision with a testable exit:
```
A Fit      objective matches deliverable; who consumes it; what exists today
B Done     enumerate done-items -> claim family -> one failable AC per item
C Proof    command runs? probe alive? known-bad fixture? evidence bound?
D Metric   one number, N repeats, named aggregation, noise floor, direction
E Horizon  what the number cannot see -> judged + calib (or say why not)
F Graph    budget, scope:, depends:, who writes what in which wave
```
- **Frontier** = questions whose prerequisites are settled. Ask the whole current frontier per round, never one orphan question; recompute after the answers. Format: `❓ Q1 — <decision>` + `➡️ <recommended answer>`.
- **Facts are yours** (run it, inspect the tree, dispatch a subagent to measure); **decisions are the user's** (what done means, acceptable risk, budget). Never ask a user a fact you can check; never decide one you cannot.
- Interview until the frontier is empty and the user confirms shared understanding. Rounds for a non-trivial contract: scope/facts -> coverage -> instruments -> metrics/noise -> horizon/graph -> confirm; dependents wait for their prerequisite.

## Attack checklist

Severity is about false-GO risk. **High** = the gate can return GO while the objective is unmet or the instrument lies, or the AC can never settle honestly: fix before stamp. **Medium** = a false pass/fail or stale evidence is likely: fix before stamp, or get the user's explicit written risk acceptance and record it as a known weakness (the grill still reports `needs-work`; never call it `ready`). **Low** = hygiene or an optimization: decide each one and note it. The tool's severity is the floor: raise a finding when the claim is safety-, validation-, or customer-critical.

| # | Attack | Ready only when | Sev |
|---|---|---|---|
| 1 | Tautological/unfalsifiable check | Smoke on the empty/broken tree goes red; `true`, `echo`, or reading a file the check just wrote is not a check | high |
| 2 | Goodhart proxy path | The cheapest gaming path is named, costs real work, or is covered by a floor + judged horizon; the number is monotone with progress | high |
| 3 | Deliverable not executed | At least one AC runs `deliverable:` itself in the real environment; file existence and derived reports do not count | high |
| 4 | Unproven instrument | Every metric/judged AC has a `probe:` that proves the fixture/tool, and it passes before the number is trusted | high |
| 5 | Judged without binding | Verdict has `artifact:` + `digest: sha256:<64hex>` matching the current file; judge exists; `calib:` good/bad fixtures exist, differ, and grade `calib-good: PASS` / `calib-bad: FAIL` | high for no judge/unbound, medium for no calib |
| 6 | Missing baseline/noise band | `goal_gate_baseline` spread recorded; `tolerance:` or `sd:`/`var:` beyond the noise; V is not inside the observed spread | high for optimize, medium for thresholds |
| 7 | No negative/error path | A known-bad input is refused with the exact `exit=N` (or bounded error), not merely "non-zero" | high for safety claims, low otherwise |
| 8 | Vague statement | One binary claim its check can refute; "fast", "clean", "robust", "good" are named thresholds or judged rubrics | medium |
| 9 | Duplicate/overlapping ACs | Unique `AC-N` ids (duplicate = state-error); disjoint claims and distinct checks; overlap does not hide a gap | high for duplicate id, medium for overlap |
| 10 | Deliverable uncovered | `deliverable:` is named and touched by a check; judged evidence points at it, not at a derived summary | high |
| 11 | Unrealistic budget | Rounds x smoke-measured check time fits `maxRounds`/`timeBudgetMinutes`; checks are fast, deterministic, cacheable | medium |
| 12 | Scope/dependency conflict | `depends:` names only existing ACs, acyclic; dispatch orders dependents after producers; `scope:` sets are disjoint per wave | high for unknown/self/cycle, medium for overlap |

## Metric design rules

1. **One programmatic number per metric AC.** If you cannot name the number and the command that prints it, use a floor + judged AC instead. One AC, one number.
2. **N fixed repeats inside one command**, aggregated with a named statistic (mean, p50, min-of-N). Print that number on the last stdout line; pin `metric:` with one capture group when stdout carries other numbers.
3. **Noise floor first.** Run `goal_gate_baseline({samples: 5})` (or the same command twice) on the pre-work artifact. Choose V and `tolerance:` after you see `sd`/`spread`; never place a threshold inside the noise.
4. **Tolerance vs sd/var.** `tolerance:` is your authored relative band; `sd:`/`var:` extract measured spread from output (`var` is sqrt'd). The band is `max(2*spread/|prev|, tolerance)`; a declared spread that matches neither output nor a recorded baseline is broken. If 2*spread makes the target unreachable, fix the instrument (more repeats, isolate load); do not hide noise under a huge tolerance.
5. **Direction.** `maximize`/`minimize` compare to the previous accepted value; without a recorded baseline the first reading sets the water mark and passes. `baseline: abs` = no regression; `delta` = strict improvement from run 2. Use `delta` only where improvement is available; capped metrics saturate.
6. **Floor + horizon.** Floors (exact output, refusals, invariants) pass every round; one metric supplies the gradient; at least one `judged` AC covers what the number does not see. A metric-only optimization contract is a Goodhart machine.
7. **Cheap and hard to game.** Checks re-run each round: deterministic, no live network, default `timeout:` 30s. Cache expensive evidence once under `.goal-gate/evidence/` keyed by input hash; writes elsewhere hit `check-mutated-tree`. Prefer byte diffs, exit codes, counts, invariants over text metrics; never word-count natural language; name the exact extraction command.

## Reading `goal_gate_grill`

`goal_gate_grill({deep?})` audits `.goal-gate/goal.md` read-only. `deep` defaults to true and includes low-severity findings; `deep:false` drops only those for a quick pass. It returns:

| Field | What you do with it |
|---|---|
| `verdict` / `ok` | `ready` = no high/medium finding left. A floor, not a GO and not a stamp. |
| `findings[]` | `{ac, severity, issue, suggestion}`; `ac` may be `*` or `AC-3,AC-4`. Fix by line; never argue a severity down. |
| `questions[]` | The tool's open frontier: answer with facts or bring the decision to the user in one round. |
| `metricDesign[]` | `{ac, advice}` for optimize ACs; apply it or say why not. |
| `goodhart[]` | Named gaming paths. Close each with a floor, a judged horizon, a rewrite, or a written "not cheap because ...". |
| `stamp` / `digest` | What the review saw (contract stamp + tree digest). Any edit or file change makes them stale: re-run before stamping. |

`goal_gate_baseline({samples?})` (default 3, minimum 2) runs the `maximize`/`minimize` ACs, records the mean baseline and measured spread (keyed by AC id + check hash), and burns no round. It returns `{samples, acs, recorded, notes?}`; each `acs` row carries `id, metricKey, values, mean, sd, min, max, spread, recorded`. A row with `recorded:false`, or a top-level `notes` entry, means it did not take (missing readings, or the tree changed during measurement): fix the metric and re-run. A recorded baseline seeds the water mark, so the next `goal_gate_check` compares against it.

## From finding to edit to stamp

Keep the contract line shape fixed (field order is grammar): `AC-N | <statement> | check: ... | probe: ... | metric: ... | baseline: ... | timeout: ... | tolerance: ... | sd: ... | var: ... | calib: ... | scope: ... | depends: ... | expected: ...`. `scope:`/`depends:` are dispatch metadata, not verdicts: the gate rejects unknown/self/cyclic `depends:` as state-error, while overlapping `scope:` is advisory — check it yourself.

- One finding, one edit: tautology -> a command that goes red on a bad artifact plus the known-bad fixture; gameable -> floor/judged horizon or a better number; missing runtime -> execute the deliverable; judged -> judge + artifact/digest + calib; no noise -> baseline then tolerance/sd; vague -> split into binary claims; duplicate -> unique ids and disjoint checks; budget -> smoke timing then stamp it; scope/depends -> fix the graph and write scopes; uncovered deliverable -> add the AC that runs it.
- Re-run smoke, `goal_gate_baseline` (if a metric changed), and `goal_gate_grill`. Do not re-word to silence the tool; the issue must be resolved.
- Before stamp: show objective, deliverable, exit, AC table, baselines/budget, plus the grill verdict and what changed. Get explicit approval. Only then `goal_gate_stamp({approvedBy, maxRounds, timeBudgetMinutes})`; then loop.
- **Already stamped?** Stop. Do not edit silently: approval is void and claims are denied `[goal-gate:contract-revised]`. Show the diff, get approval, then `goal_gate_stamp({restamp:true, ...})`, re-grill, re-run baseline. Never delete, weaken, or "temporarily unverifiable" a red AC to buy a GO; replace it with a stronger one and record the ruling.

## Worked example

Draft:
```
objective: make the page renderer fast
deliverable: dist/render.mjs
AC-1 | renders ok | check: `node dist/render.mjs page.html` | expected: exit=0
AC-2 | fast | check: `node bench.mjs` | metric: `([0-9.]+)` | expected: <=20
AC-3 | looks good | check: `cat out/notes.txt` | probe: `node judge.mjs` | expected: judged
```
Grill (mechanical findings plus manual attacks): AC-1 is a bare runtime that only proves "did not crash" (no negative path); AC-2 has no repeats, aggregation, probe, baseline, or noise band, and its regex may grab another number; AC-3 is judged with no `artifact:`/`digest:`/`calib:` and reviews a derived summary, not the deliverable; the objective is vague and no AC checks the rendered output. `questions`: what output must stay identical, what is the measured baseline/spread, which known-bad page must be refused? `goodhart`: skipping work or rendering fewer pixels can lower ms without improving the page.

Fixed:
```
objective: cut cold page-render time without changing rendered output
deliverable: dist/render.mjs
AC-1 | valid page renders exactly | check: `/abs/node dist/render.mjs fixtures/page.html --diff fixtures/page.expected` | probe: `/abs/node --version` | expected: exit=0
AC-2 | malformed page is refused | check: `/abs/node dist/render.mjs fixtures/bad.html` | expected: exit=2
AC-3 | mean render time improves | check: `/abs/node bench/render.mjs --repeat 7 --aggregate mean` | probe: `/abs/node bench/probe.mjs` | metric: `mean_ms=([0-9.]+)` | sd: `sd_ms=([0-9.]+)` | baseline: delta | tolerance: 0.05 | timeout: 120 | scope: bench/ | depends: AC-1 | expected: minimize
AC-4 | rendered page is legible | check: `/abs/node bench/evidence.mjs` | probe: `/abs/node bench/judge.mjs` | calib: good=fixtures/good.svg bad=fixtures/bad.svg | timeout: 120 | depends: AC-1 | expected: judged
```
`bench/evidence.mjs` writes the verdict with `artifact:` + `digest:` and the two calib grade lines; `bench/judge.mjs` exits 0 only if the verdict is complete and calibrated.
`goal_gate_baseline({samples:7})` on the pre-work renderer: AC-3 values `[38.2, 37.6, 38.9, 38.1, 37.8, 38.4, 38.0]`, mean 38.14, sd 0.40 -> band 2*0.40/38.14 = 0.021 < tolerance 0.05, so 0.05 sits outside noise. Re-grill -> `verdict: ready`; explain the closed Goodhart path (AC-2 + AC-4 catch "skip the work"); user approves; `goal_gate_stamp({maxRounds:6, timeBudgetMinutes:90})`. The first `goal_gate_check` must beat the recorded water mark or return NO-GO; only `goal_gate_check` can GO.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `verdict: ready`, then `goal_gate_check` says `broken` | Grill is heuristic; it cannot run your commands or see evidence | Smoke and baseline yourself; bind judged evidence before stamping |
| Green on an empty tree | Tautology or placeholder survived | Rewrite as a failable command; add the known-bad fixture and `exit=N` |
| Metric flips red/green with no artifact change | Threshold inside noise; single run | `goal_gate_baseline`, N repeats, `sd:`/`tolerance:`; widen only to measured noise |
| Number improves while quality drops | Proxy metric | Add a floor and a judged horizon with `calib:`; rewrite the number |
| Judged AC always `broken` | Judge missing, `artifact:`/`digest:` absent/stale, calib one-sided or identical fixtures | Fix the evidence chain, not the AC; re-judge the current digest |
| `state-error` on depends | Unknown, self, or cyclic `depends:` | Point at existing ACs, break the cycle, or merge the ACs |
| Producer has not run when a dependent checks | `depends:`/scope conflict or overlapping wave | Order with `depends:`, split `scope:` sets, dispatch in waves |
| `[goal-gate:contract-revised]` | Contract edited after the stamp | Show the diff, get approval, `goal_gate_stamp({restamp:true})`, re-grill |
| Rounds exhausted before convergence | Per-round check time ignored | Smoke-time the checks, cache evidence, set the budget at stamp |
| Grill stays `needs-work` after re-wording | Underlying issue or open question not fixed | Answer the frontier, edit, re-run; do not silence the tool |

## Handoff

Return the findings and their disposition, the contract diff, the baseline table, and the open `questions`/`goodhart` answers. `goal_gate_status` shows stamp/round state read-only; `goal_gate_audit` runs before any completion claim; a NO-GO becomes `goal_gate_dispatch` tasks. The user stamps; `goal_gate_check` decides GO. Load **goal-loop-contract** for line shapes and **goal-loop** for loop/gate mechanics.
