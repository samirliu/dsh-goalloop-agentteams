# The three rights, implemented in an Agent Teams-native plugin

This document is the design contract for **why** the plugin behaves the way it does. The
original goal-loop skill names three design goals; this port maps each onto a concrete
DSH surface and a concrete failure mode it prevents.

## 1. Right agentic loop

A loop is only agentic if it can decide **what to do next without asking the model to
remember a protocol**. The plugin keeps the loop state on disk and turns it into
machine-readable next steps.

```
objective
  → contract skeleton (goal_loop_at)
  → grill + baseline + user approval (goal_gate_grill / goal_gate_baseline / goal_gate_stamp)
  → plan waves (depends:) + dispatch (goal_loop_at dispatch / goal_gate_dispatch)
  → members work, complete team tasks
  → join + gate (goal_gate_check)
  → nextActions: repair / dispatch / collect / assign / re-check / stop
      ↳ repeat until GO, BLOCKED, or budget exhausted
  → audit → claim (update_goal)
```

| Loop concern | Mechanism | Why it matters |
|---|---|---|
| Contract before work | `.goal-gate/goal.md`; `goal_gate_stamp` freezes it + budgets | "done" is the user's definition, not the model's |
| Wave planning | `depends:` → topological `plan.waves`; `scope:` → write scope | parallel work without merge chaos |
| Dispatch | native Agent Teams tasks with `blockedBy`/`writeScopes`; idempotent by contract stamp | re-checks never multiply the board |
| Convergence | `goal_gate_check` is the only GO authority; `nextActions` routes the next step | no "continue until it feels done" |
| Stop rules | round budget, wall-clock budget, BLOCKED (2 false completes), loop-idle | grinding and self-declaration are both named |
| Human path | `/goal-stamp`, `/goal-reset`, approval seam for stamp | recovery and approval stay human |
| Concurrency | ledger lock around check/stamp/dispatch/claim | multiple members cannot corrupt rounds or baselines |
| Non-Lead fallback | suggestions + `subagent`/`task_board_create` guidance | the loop works without the Teams service |

`nextActions` is deliberately small and closed: `create-contract`, `fix-contract`,
`fix-instrument`, `fix-regression`, `dispatch-repairs`, `repair-then-check`,
`probe-again`, `run-check`, `audit-and-claim`, `stop-blocked`, `stop-budget`,
`assign-ready-tasks`, `collect-team`, `loop-suspended`. A controller can follow it
mechanically; a model can explain it.

## 2. Right eval

The gate judges artifacts, not promises. Four independent layers:

| Layer | Enforces | Failure it prevents |
|---|---|---|
| Deterministic re-run | every AC's `check` runs again; `probe` proves the instrument | "the member said the command passed" |
| Fail taxonomy | `failed` (artifact wrong), `broken` (instrument/judge/evidence wrong), `unverifiable` (soft) | a missing verifier hiding inside the ≤1/3 allowance |
| Evidence binding | judged verdict needs `artifact:` + `digest: sha256:`; `calib:` needs good/bad grades | "looks good to me" with no traceable observation |
| Ledger audit | stamp matches contract, last evaluation is GO at the current stamp, digest not stale, budget/never-failed advisories | claiming after the tree moved or the contract was edited |

`goal_gate_grill` is the **design-time** eval check, not the run-time one: it attacks the
contract before money is spent on rounds. It looks for tautologies, thesis statements
without a failable check, metrics that can be gamed, missing runtime execution of the
deliverable, judged ACs without calibration, and scopes that overlap. Its output is
meant to be edited into the contract and re-grilled until `verdict: ready`.

The gate's own evidence pyramid: data check → artifact check → **runtime execution of
the deliverable** → **judgment of the deliverable**. A contract that stops at derived
data is structurally "unverified" no matter how green it looks.

## 3. Right metric

Metrics are treated as instruments with noise, not as truths.

| Metric rule | Implementation |
|---|---|
| One programmatic number | `metric:` captures one group; ANSI stripped; missing number = broken |
| Direction is explicit | `maximize` / `minimize`; first run establishes the water mark and passes |
| Improvement is explicit | `baseline: delta` (strict) vs `abs` (no regression) |
| Noise is measured | `goal_gate_baseline` records mean + spread; `sd:`/`var:` read spread from output; band = `max(2*spread/|prev|, tolerance)` |
| Completion is more than a number | a floor AC (`>=`) plus a judged horizon; judged evidence is digest-bound and calibrated |
| Improvement is attributable | each check can carry a `strategy` label; `efficiency` returns score delta, slope and per-strategy runs |
| Score cannot slide | `bestScore` high-water + `regression` flag; a regression must be fixed before another claim |

Goodhart discipline: every metric is asked "can a cheaper change move this number
without advancing the objective?" If yes, the metric is a proxy; split it, add a floor,
or add a judged horizon. `goal_gate_grill` repeats that question mechanically in
`goodhart[]` and `metricDesign[]`.

## Agent Teams adaptation points

| DSH surface | Plugin use |
|---|---|
| `ctx.get('agentTeams')` (optional) | membership probe, `createTask`, `listTasks`, `listMembers`, `updateTask` |
| `team_task_update` / `task_board_manage move-done` | completion interceptor (goal vs task claim; strict vs goal-only) |
| `team_task_*` model tools | the plugin does not reimplement them; it produces briefs and reads the board |
| task `blockedBy` / `writeScopes` | generated from `depends:` / `scope:`; never invented |
| members' `inactive`/`running` | surfaced in `team.members`; `nextActions` says whether to wait or wake |
| concurrent callers | ledger lock turns races into explicit `busy`, not corrupted state |

The plugin never writes the task-board ledger, never spawns teammates on its own, and
never claims completion. Those remain the model's / user's / gate's jobs respectively.

## What this intentionally does not do

- No portable crew/work-plan file protocol: native Agent Teams is the roster/task store.
- No Stop-hook: DSH's `tools/pre-execute` is the completion boundary.
- No LLM judge in the plugin: judged evidence is produced by the controller and
  validated mechanically; semantic judgment stays with a fresh seat.
- No hidden auto-stamp: approval is always an explicit act (`goal_gate_stamp` /
  `/goal-stamp`), even though the default does not *require* a stamp for headless use.
