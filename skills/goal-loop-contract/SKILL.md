---
name: goal-loop-contract
description: >-
  Write or repair a goal-loop contract: objective, deliverable, exit policy,
  and acceptance criteria whose checks can actually fail. Use when the user
  wants to write/repair acceptance criteria or a goal contract, define done,
  choose metrics or judged rubrics, or prepare ACs before goal_gate_stamp.
  Produces a contract; never runs the gate and never stamps by itself.
whenToUse: >-
  Load from goal-loop Step 1, or when the user says "define done", "draft
  acceptance criteria", "how do we verify this", "write a goal contract".
  Not for one-check tasks, or for running the loop/gate itself.
---

# Goal Loop Contract
**Role.** The pre-stamp evaluation advisor for **goal-loop**. You turn a fuzzy
objective into a contract the gate can enforce. You do not judge completion,
do not stamp, and do not edit a stamped contract. The stamp is the user's
signature, applied through `goal_gate_stamp` or `/goal-stamp`.

**Line shape** (field order is fixed; reordering makes the line unparsed, a
state-error): `AC-N | <statement> | check: <cmd> | [probe: <cmd>] | [metric:
<regex>] | [baseline: delta|abs] | [timeout: <s>] | [tolerance: <rel>] |
[sd: <regex>] | [var: <regex>] | [calib: good=<f> bad=<f>] | expected: <spec>`;
`spec = exit=0 | exit=N | <=N | >=N | <N | >N | =N | !=N | maximize | minimize | judged`.

## Workflow

1. Interview in rounds: ask the whole current frontier, never one orphan
   question. Check facts yourself (run the command, inspect the tree); the
   user owns decisions.
2. Draft the contract: objective, deliverable, exit policy, AC table, budget.
   Choose `exit:`: `strict` when task completion is goal completion;
   `goal-only` for multi-task loops. `exit: forge` is not implemented (preflight `unsupported-exit-policy`).
3. Smoke-run every named check; measure the noise floor before choosing a
   threshold.
4. Run the stamp checklist. Then hand off to goal-loop Step 1 for the
   one-screen summary and the user's approval.

## Interview tree

| Branch | Questions | Exit condition |
|---|---|---|
| What | objective in the user's words; who consumes the artifact; what exists today | one line, no solution smuggled in |
| Done | enumerate done-items; claim family per item; what must never regress; one primary number? what does the number not see? | every done-item has a failable check or a named judged rubric |
| Proof | what is the deliverable itself; which command proves it; does it run in the real environment; judged anchors; good/bad fixtures | every AC is executable as written and smoke-run |
| Budget | maxRounds, timeBudgetMinutes, repeats for noisy metrics, tolerance/spread | budgets and noise bands are numbers, not vibes |
| Non-goals | explicit out of scope; where late ideas go | the list is written |

## Claim family → check shape

| Family | Shape of a failable check |
|---|---|
| correctness | parse/lint exits 0; happy path exits 0; a known-bad input exits with the exact N; byte diff against a stored file; the named suite |
| behavioral | scripted replay with observable assertions at fixed steps; end state re-checked; transcript/evidence retained |
| quantitative | one command, N fixed repeats, internal aggregation (mean/p50 named), single number on the last stdout line; `probe:` + `metric:` + `tolerance:`/`sd:`; noise floor measured first; first run sets the water mark (PASS), `delta` from run 2 |
| perceptual | `judged`, with written rubric anchors or a fixed-point A/B against a reference; the check produces the evidence the judge reads; `calib:` good/bad |
| data | shape first (head + counts); recompute one subtotal independently; null/duplicate recount; same input twice → byte-identical |
| documents | read back the rendered file; required sections by name; cross-references resolve; length via the named counting command |
| long-running | the log is the check: observable done items, each continuation re-reads it; timeout + end-state; a continuation that moves nothing is stagnation |

## Goodhart sentinel (every AC)

Ask: **can this pass without advancing the goal?** If yes, it is a proxy —
rewrite or delete it. Name the cheap gaming path. Is the number monotone with
progress? If not, split the metric, add a floor, or add a judged horizon.
Never set a threshold inside the measured noise.

## Evidence pyramid

Data checks → artifact checks → **runtime execution of the deliverable** →
**judgment of the deliverable itself**. A contract that stops at data or
derived files leaves the deliverable unproven. Declare `deliverable:`, give at
least one AC that executes it, and make judged evidence point at it.

Checks are read-only: a workspace mutation is refused `check-mutated-tree`.
Put check-produced evidence (renders, logs, verdict files) under
`.goal-gate/evidence/` (digest-excluded); a judged `artifact:` may be the
deliverable itself (read-only) or an evidence file there.

## Judged discipline

- `check:` produces the evidence; `probe:` is the judge (0 PASS, non-zero FAIL).
- The verdict carries `artifact: <path>` and `digest: sha256:<64hex>`; the gate
  recomputes the hash. Unbound, stale, missing judge or failed `calib:` =
  **broken (decisive NO-GO)**.
- `calib: good=<f> bad=<f>`: the judge must grade the good fixture PASS and the
  bad fixture FAIL (`calib-good: PASS`, `calib-bad: FAIL`); otherwise broken.
- Rubric before vibes: written dimensions, anchors per level, a threshold.
  `unverifiable` is only genuine inapplicability and stays soft (≤ 1/3).

## Stamp checklist

- [ ] Contract parses: one `objective:`, one `deliverable:`, one `exit:`; no stray `|`
- [ ] Every AC is a single line with `check:` and `expected:` (unparsed = state-error)
- [ ] No `TODO-REPLACE-ME` placeholder survives (the skeleton is fail-closed until replaced)
- [ ] No duplicate `AC-N` ids (duplicates are state-error)
- [ ] Every check can fail; the exact command is named; no tautology
- [ ] At least one AC executes the deliverable at runtime; the deliverable is covered
- [ ] Numeric specs pin `metric:`; metric/max/min ACs have a passing `probe:`
- [ ] Noisy metrics have `tolerance:` and/or `sd:`/`var:`, plus a measured baseline
- [ ] Judged ACs have a judge, digest binding, and `calib:` where quality is at stake
- [ ] Budget: `maxRounds` / `timeBudgetMinutes` set; smoke runs passed; summary approved

## Two examples

Threshold with a pinned instrument:

```
objective: cut cold build time without breaking tests
deliverable: scripts/build.sh
exit: strict
AC-1 | suite passes | check: `/abs/node test/run.mjs` | expected: exit=0
AC-2 | cold build under 20s | check: `/abs/bash bench/build.sh --repeat 5` | probe: `/abs/bash bench/probe.sh` | metric: `mean=([0-9.]+)` | tolerance: 0.05 | expected: <=20
```

Judged with binding and calibration:

```
AC-3 | diagram is legible | check: `/abs/node verify/render.mjs` | probe: `/abs/node verify/judge.mjs` | calib: good=fixtures/good.svg bad=fixtures/bad.svg | expected: judged
```

`render.mjs` writes `out/verdict.txt` with `artifact:`/`digest:` and calib grades; `judge.mjs` exits with the verdict.

## Repairing a failing contract

- **state-error / unparsed AC / duplicate id** → fix the line shape: one AC per
  line, no nested backticks inside `check:` (use `$(...)` or a separate script).
- **unverifiable or broken** → fix the instrument: add `probe:`, pin `metric:`,
  bind judged evidence, repair calib fixtures, or replace the check command.
  Do not delete the AC.
- **NO-GO with a plausible `why`** → fix the artifact, not the contract. A red
  AC is repaired, never removed to buy a green.
- **Post-stamp edit** → claims are denied `[goal-gate:contract-revised]`; show
  the diff, get approval, then `goal_gate_stamp({restamp:true})`.

## Handoff

Return the draft plus the stamp checklist, and let goal-loop Step 1 present the
summary. The user stamps; you never do.
