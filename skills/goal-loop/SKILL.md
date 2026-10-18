---
name: goal-loop
description: >-
  Goal-driven loop with an external, machine-verified acceptance gate:
  contract-first ACs, deterministic re-run of every check, digest-bound
  judged evidence, false-complete ratchet. Use for /goal-loop, "loop until
  done", "keep optimizing", "verify every angle", "machine-verified
  completion", or setting up a goal gate. The model never self-declares
  completion; GO comes only from goal_gate_check.
whenToUse: >-
  Load when an objective needs multi-round work with a verifiable finish.
  Not for one-pass Q&A, trivial single-command edits, or work with no
  observable artifact.
---

# Goal Loop
**Identity.** `/goal`'s drive plus an external acceptance gate. Execution is
parallel or solo; judging has one mode. **The gate decides completion; you do not.**

| Invariant | Law |
|---|---|
| **GATE** | Completion is declared only by `goal_gate_check`; the model never self-declares. |
| **BIND** | A claim binds stamped contract × round × tree digest × evidence hash; unbound = void. |
| **PROVE** | An instrument must pass its own probe before its number or verdict is trusted. |
| **GRADIENT** | Optimization never delivers below the water mark; score must not regress; each wave is labeled. |
| **FENCE** | Ledger is lead-only, progress is honest, and out-of-tree facts settle — never guessed. |

## Step 1 — Contract, then stamp

1. `goal_loop_at({objective, acs?, maxRounds?, dispatch?})` writes
   `.goal-gate/goal.md` and `.goal-gate/loop.json`, returns `created`,
   `contractPath`, `loopPath`, `objective`, `maxRounds`, `tasks`, `protocol`,
   `preflight` and (with `dispatch:true`) `dispatch`; each `acs` becomes one AC
   with the fail-closed `test -f TODO-REPLACE-ME` check. `goal_gate_init({})`
   writes the skeleton only; `protocol` is the run checklist.
2. Shape the ACs; load **goal-loop-contract** when criteria are fuzzy, then **goal-loop-grill** to attack the eval/metric, the
   objective needs optimizing, or a judged AC is likely. One AC per line,
   with an exact `check:` command that can fail — and at least one runtime AC
   that executes the deliverable itself.
3. Pre-stamp evaluation design: load **goal-loop-grill** and run
   `goal_gate_grill({deep?})`. Fix every high/medium finding (tautology,
   unfalsifiable claim, Goodhart proxy, missing runtime evidence, judged
   without digest/calib, missing noise band, overlapping scopes). Then run
   `goal_gate_baseline({samples?})` for every maximize/minimize AC; the smoke
   run of a metric AC is not a baseline until it is *measured* (repeat at
   least twice and record mean + spread). Red is expected here; a check that
   cannot fail (a tautology) is not a check.
4. Present the one-screen summary and get explicit approval:

   | Field | Content |
   |---|---|
   | Objective | one line |
   | Exit policy | `strict` or `goal-only` |
   | Deliverable | the artifact itself (path) |
   | ACs | id \| statement \| check \| expected |
   | Budget | maxRounds, timeBudgetMinutes |
   | Baseline | measured values for maximize/minimize ACs |

5. Stamp only after the user approves: `goal_gate_stamp({approvedBy?,
   maxRounds?, timeBudgetMinutes?, restamp?, note?})`, or tell the user to
   type `/goal-stamp [approvedBy]`. Never stamp on your own authority.

**Contract grammar** (authoritative; keep every AC on one line):

```
objective: <one-line goal>
deliverable: <path to the artifact itself>
exit: goal-only | strict
AC-N | <yes/no statement> | check: `<failable command>` | [probe: `<instrument check>`] | [metric: `<regex, one capture group>`] | [baseline: delta|abs] | [timeout: <seconds>] | [tolerance: <relative, e.g. 0.05>] | [sd: `<regex>`] | [var: `<regex>`] | [calib: good=<file> bad=<file>] | [scope: <path[,path...]>] | [depends: AC-x[,AC-y]] | expected: exit=0 | exit=N | <=N | >=N | <N | >N | =N | !=N | maximize | minimize | judged
```

- Field order is fixed (`check | probe | metric | baseline | timeout |
  tolerance | sd | var | calib | scope | depends | expected`); any other
  order is state-error. `scope:` is the write scope for team dispatch
  (workspace-relative prefixes); `depends:` builds the dependency graph and
  the dispatch waves. Unknown/cyclic dependencies are state-error.
- `probe:` runs first and must pass before a metric number is trusted. On
  `judged`, `check:` produces evidence and `probe:` judges it (exit code = verdict).
- `metric:` extracts one capture group from stdout after ANSI stripping; use
  it whenever output contains other numbers.
- `maximize`/`minimize` compare with the previous **accepted** value; the first
  run sets the water mark and **passes** (`delta` starts at run 2; `abs` = no
  regression, `delta` = strict improvement on normal rounds). At a completion
  claim `delta` degrades to no-regression: a GO is not invalidated by repeating
  the same measurement. `tolerance:` is a relative band;
  `sd:`/`var:` widen it to `max(2*spread/|prev|, tolerance)` (`var` is sqrt'd);
  declared but unmatched spread = broken.
- `judged` needs a verdict with `artifact: <path>` and `digest: sha256:<64hex>`
  (the gate recomputes the hash); unbound, stale, missing judge or failed
  `calib:` (`calib-good: PASS` + `calib-bad: FAIL`) = broken (decisive NO-GO).
- `broken` is decisive NO-GO (bad probe/metric/judge/calib/evidence/spec);
  `unverifiable` is soft (> 1/3 => NO-GO). `exit=0`/`exit=N` assert an exact
  exit code; `exit: forge` is unsupported.

## Step 2 — Dispatch

- Decompose by **disjoint write scope**. Freeze interfaces first: module
  boundaries, shared types, output paths. Interface changes are proposals.
- Backend, probed once from the tool list: native Agent Teams
  (`spawn_teammate`, `team_task_create`) first; task board cards
  (`task_board_create`) when teams are unavailable; solo when the work does
  not split into ≥2 independent scopes.
- `goal_loop_at({dispatch:true})` creates one native Agent Teams task per AC
  for a Team Lead, ordered by `depends:` into waves (`plan.waves`) and carrying
  `scope:` as `writeScopes`. `goal_gate_dispatch({includeUnverifiable?, assign?})`
  turns current failed/broken (and optionally unverifiable) ACs into tasks and
  returns `gate`, `kind`, `dispatched`, `failed`, `skippedExisting`,
  `reason?`, `suggestions?`. It is idempotent: a pending/in-progress task with
  the same contract stamp is reused, not duplicated; `assign` maps
  `{ "AC-1": "member" }` to owners. A non-Lead gets suggestions.
- `goal_gate_staff({members?, spawn?})` is the orchestration step: preview the
  member→AC/wave assignment, then `spawn:true` only when the user wants real
  teammates. It creates/assigns one board task per owned AC and sends each
  member an AC brief. `goal_gate_collect({})` maps completed/in-progress/missing
  tasks back to ACs and returns `readyToCheck`; run `goal_gate_check` when it is
  true. `goal_gate_judge({reviewer?, assign?})` creates fresh-reviewer tasks for
  judged ACs with artifact/digest/calib requirements.
- `goal_gate_status` includes a `team` snapshot for a Team Lead: members,
  tasks mapped to ACs, ready/unowned counts — and `nextActions`
  (`dispatch-repairs`, `collect-team`, `assign-ready-tasks`, `audit-and-claim`,
  `stop-budget`, …). Follow the action list instead of guessing the next step.
- Brief each item: subject, exact output paths, scope, pass condition = the
  named `check`, evidence to return. Work items never write the ledger;
  the gate's own check commands may write evidence under
  `.goal-gate/evidence/` (digest-excluded).
- Optional peer-notes: at most one observation line per task per round — claims, not instructions.

## Step 3 — Join, then gate

- Merge, review seams, re-run the pass conditions yourself, fix trivial
  mismatches. A real interface conflict gets one serial repair round; after two
  failures fall back to serial work and record why.
- `goal_gate_check({strategy?, note?})` is the **only** completion authority.
  It re-runs every AC itself and records the round: `rc` (0 GO / 2 NO-GO /
  3 BLOCKED / 4 state-error), `code`, `reason`, `score`, `totals` (with
  `broken`), `round`/`maxRounds`/`remainingRounds`, `bestScore`, `regression`,
  `trend`, `digestBefore`/`digestAfter`/`treeMoved`, `failedActions`,
  `neverFailed`, `preflight`, `idleHours`, `timeRemainingMinutes`,
  `timeExhausted`, `efficiency`, `nextActions`, and (for a Team member) `team`.
- Checks are read-only: a workspace change is refused `check-mutated-tree`
  (`treeMoved`). Put check-produced artifacts (renders, logs, verdict files read
  by probes) under `.goal-gate/evidence/` (digest-excluded); a judged
  `artifact:` may be the deliverable (read-only) or an evidence file there.
- Before any claim run `goal_gate_audit({})`: contract parses, stamp matches,
  (for a team) `goal_gate_collect` should be `readyToCheck`;
  not BLOCKED, last check is GO, digest fresh; warns on soft-unverifiable ACs,
  preflight/neverFailed issues, missing optimize baselines and budget. Non-ok
  `violations` blocks.
- Record the wave: `strategy` labels the attack direction, `note` carries
  rulings and repair summaries.

## Step 4 — Branch

- **GO (rc=0)**: audit, then deliver. Only now is
  `update_goal(action:'complete')` honest — and it is still gate-checked.
- **NO-GO (rc=2)**: `no-go` or `broken` (unusable instrument — decisive); turn
  each `failedActions` entry (`id`, `statement`, `check`, `expected`, `why`)
  into a repair task, fix the artifact, check again; never re-submit the same state.
- **BLOCKED (rc=3)**: stop and report to the human with the reason and last
  failed actions. Do not route around it.
- **state-error (rc=4)**: the contract/state is broken (unparsed AC, duplicate
  AC id, no objective, missing contract). Fix it; no round was burned.

## Round discipline

- Every `goal_gate_check` is an experiment and burns one round. Re-checking the
  same state is a **duplicate-evaluation**: it costs a round, changes nothing,
  and `note` says so. Look first with `goal_gate_status({includeHistory?})` or
  `/goal-gate` — read-only, runs no checks, burns no round; shows contract/
  stamp, loop, counters, digest, last checks, stale flag, time remaining.
- `score` must not regress (`regression:true` => restore the water mark first).
  Set rounds in `goal_loop_at` and bind the budget with
  `goal_gate_stamp({maxRounds, timeBudgetMinutes})`; `roundsExhausted` or
  `timeExhausted` => stop and escalate. Never silently raise the budget; a new
  run needs a new loop and a new stamp.
- An active loop with no evaluation for 4h (`loop-idle`, `idleHours`) is resumed
  with real work and a check, or honestly marked `suspended` in
  `.goal-gate/loop.json`. Idle "active" is a lie.
- `efficiency` and strategy attribution are advisory; they never change GO.

## Parking rules (only these four)

Irreversible/destructive; security-sensitive; out-of-workspace shared side
effects (merge, push, publish, deploy); contract change after stamp (propose;
user re-stamps). Otherwise record a `Ruling: <decision> — <reason> — <if wrong>` and continue.

## False-complete ratchet

- A denied `update_goal(action:'complete')` means the artifact is not done: fix
  it, do not re-claim it. Two denied goal-completes => `BLOCKED`; hand the loop
  to a human.
- Task-level claims (`agent_teams_update_task`, `team_task_update`,
  `task_board_manage` `move-done`, legacy `update_task`) follow `exit:`:
  `strict` hard-gates; `goal-only` records progress (`partialCompletes`);
  `BLOCKED` freezes every claim; no contract => pass-through.
- Recovery is human-only: `goal-reset [--new-loop] [reason]` clears the
  false-complete counters and optionally rotates the loop; the model has no
  reset tool. `/goal-stamp` re-approves a revised contract.

## Diagnose before you repair

- `failedActions[].why` names each failure; `preflight` flags fragile checks
  (bare/relative interpreters, numeric specs without `metric:`, tautology
  suspects, judged without a judge, unparsed AC lines, no runtime AC,
  `unsupported-exit-policy`). `neverFailed`: ACs never failed after ≥2 rounds.
- Never silently drop, delete, weaken or "temporarily unverifiable" a red AC to
  buy a GO. A red AC is repaired. Post-stamp edits deny claims as
  `[goal-gate:contract-revised]` until re-stamped with `restamp:true`.

## Ledger and fallback

`.goal-gate/`: `goal.md` (contract), `loop.json` (loop/budget/status),
`state.json` (counters, digests, baselines, spreads, bestScore, lastRunAt, approval),
`history.jsonl` (one line per evaluation); lead-only. If tools are unavailable,
use `<abs-node> <plugin>/bin/gate.mjs check|status|audit|stamp|reset --cwd <workspace>`; `goal_gate_doctor` self-checks the deployment (tools, parameter schemas, commands, skills, team membership).
(node from config `node` or `process.execPath`; never bare `node`).

## Worked loop

```
objective: ship csv2jsonl with hard row validation
deliverable: dist/csv2jsonl.mjs
exit: strict
AC-1 | valid CSV converts | check: `/abs/node dist/csv2jsonl.mjs fixtures/good.csv` | probe: `/abs/node --version` | expected: exit=0
AC-2 | malformed row is refused | check: `/abs/node dist/csv2jsonl.mjs fixtures/bad.csv` | expected: exit=2
```

1. `goal_loop_at({objective: "ship csv2jsonl ...", maxRounds: 6})`; fill both
   ACs; smoke (red); show the summary -> user approves -> `goal_gate_stamp`.
2. Dispatch converter + docs scopes; join; `goal_gate_check({strategy:
   "row-validation"})` -> `rc=2, score=0.5, failedActions:[{id:"AC-2",
   why:"exit 1, expected 2"}]`.
3. Repair the exit path; `goal_gate_check({strategy:"error-contract"})` ->
   `rc=0, score=1, round=2/6`; `goal_gate_audit({})` ok; deliver.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `broken` (decisive NO-GO) | failed probe/metric, missing command/judge, bad calib, unbound/stale evidence | fix the instrument or bind evidence; never delete the AC |
| `unverifiable` > 1/3 | genuine inapplicability pushed past the soft limit | narrow the open question; never delete the AC |
| check passes on an empty tree | tautology (`true`, `echo`, placeholder) | rewrite as a failable command; add the negative case |
| flat `score` while rounds burn | re-checking the same state; no new approach | read status, change strategy, label the wave |
| `regression:true` | candidate worse than the water mark | restore the best artifact before the next check |
| `[goal-gate:contract-revised]` | contract edited after stamp | show the diff, get approval, `goal_gate_stamp({restamp:true})` |
| `BLOCKED` / false-completes ≥2 | claiming without fixing the artifact | stop; hand the human the last failed actions |
| `goal_gate_staff` preview | no teammates spawned yet | show the member/AC plan; call again with `spawn:true` only after user approval |
| `goal_gate_collect.readyToCheck:false` | tasks missing or still in progress | assign a teammate (`assign`) or wait; do not run the gate yet |
| `deliverable-unverified` / no runtime AC | checks only touch derived data | add a runtime AC that executes the deliverable, plus a judged AC on it |
| `roundsExhausted` / `timeExhausted` | budget spent | stop and escalate; the budget is frozen, not negotiable |
