# dsh-goalloop-agentteams

**Deterministic goal-completion gate for DeepSeek Harness** — ports the *judging face* of the [goal-loop](https://github.com/samirliu/goal-loop) skill onto native **Agent Teams** + the **task board**, and drives the full agentic loop from one trigger.

Contract-first acceptance criteria, a gate that **re-runs every check itself** (zero model trust), verdicts bound to a tree digest, and a hard deny on false completion at `update_goal` / `agent_teams_update_task` / `team_task_update` via `tools/pre-execute`. The portable team-file protocol and dual-ledger bookkeeping from goal-loop are deliberately *not* ported — native Agent Teams is strictly stronger.

**Trigger the loop:** `/goal-loop-at <objective>` (or the `goal_loop_at` tool) writes the contract + round config, returns the loop protocol and suggested Agent Teams tasks derived from each AC. Iterate via `goal_gate_check` (score, trend, failedActions), claim completion only on GO.

中文说明见 [README.zh.md](README.zh.md)。

## Why

DSH already has two layers of completion judgement — but neither is a deterministic gate:

| Layer | Judges | Gap |
|---|---|---|
| `dsh-agent-teams` quality kinds | Did each step follow its contract | `verify` commands are **not re-executed** by the runtime; `commandsRun` exit codes are member-supplied |
| `dsh-task-board` acceptance gate | Does it look right semantically | LLM A/B comparison (threshold 0.65) — and **every card can opt out** via `skipVerification` |

`dsh-goalloop-agentteams` is the hard floor underneath both: it re-runs every AC's `check` command itself, binds verdicts to a tree digest, and counts caught false-completes — two catches → `BLOCKED`. Deterministic gate = floor, LLM judge = semantic layer, quality kinds = step contract. Stacked, they close the loop.

## Contract grammar

```
objective: <one-line goal>
[exit: goal-only | strict]
AC-1 | <yes/no statement> | check: `<command>` | [probe: `<probe>`] | [metric: `<regex with one capture group>`] | [baseline: delta|abs] | expected: <spec>
AC-2 | ... | check: `...` | expected: exit=0
```

Spec = `exit=0` | `<op><number>` (`<=5`, `>0`, `=3`) | `maximize` | `judged`.
Every `check` must be a **named, failable command** — include the environment dependency, the empty case, the error path — or the gate degrades into a tautology.

- `[probe:]` is *verify-the-verifier* (R9): the probe runs first; a probe failure marks the AC `unverifiable` rather than `passed`. More than 1/3 unverifiable → the whole gate returns NO-GO.
- `[metric:]` extracts the metric value from stdout (one capture group). Without it the gate falls back to the last number in the output — write `metric:` whenever the output contains other numbers.
- `maximize` compares against the previous round's metric: `baseline: delta` requires strict improvement, `baseline: abs` (default) requires no regression. The first run has no baseline → `unverifiable` (run `goal_gate_check` once to establish it).
- `judged` uses the `probe` as a deterministic judge — the probe's exit code *is* the verdict. Without a probe, or when the judge command is missing (exit 127), `judged` is `unverifiable` (a broken verifier is not a failing verdict).
- Contract lives at `.goal-gate/goal.md` in the workspace root.

## Gate & interception

`goal_gate_check` re-runs every check itself:

- `rc=0` GO / `rc=2` NO-GO / `rc=3` BLOCKED / `rc=4` state error
- Output carries the optimization signal: `score` (passed/total), `round` / `maxRounds` / `remainingRounds`, `bestScore`, `regression` (score dropped below the high-water mark), `trend` (last 5 rounds), `failedActions` (per-AC repair list)
- Interception is mounted on `tools/pre-execute` with **claim scoping**: `update_goal(action:'complete')` (the goal-level claim) is *always* hard-gated against the full contract with the R1 false-complete counter. Task-level claims — `agent_teams_update_task(status:'completed')`, `team_task_update(action:'complete')`, legacy `update_task(status:'completed')` — follow the contract's `exit:` policy:
  - `exit: strict` (default): full-contract hard gate + strike (single work unit: task completion *is* goal completion)
  - `exit: goal-only` (what `goal_loop_at` writes): mid-loop task progress passes (step-level truth belongs to quality-kind contracts); GO binds a digest, NO-GO is recorded as `partialCompletes` only. Without this split, every multi-task team deadlocks: a member finishing its own task is denied because teammates' ACs are still failing
  - `BLOCKED` (two caught false goal-completes) freezes every completion claim

## Goal loop (right loop / right eval / right metric)

`/goal-loop-at <objective>` (slash command) or `goal_loop_at` (tool) starts the loop:

1. writes the contract skeleton (placeholder checks are fail-closed `TODO-REPLACE-ME`) and `.goal-gate/loop.json` (`maxRounds`, default 8);
2. returns the loop protocol and suggested Agent Teams tasks derived from each AC;
3. every gate evaluation is appended to `.goal-gate/history.jsonl` (`ts/trigger/round/code/score/totals/failed ACs`) — the trajectory the loop optimizes against;
4. NO-GO → turn `failedActions` into repair tasks, re-check; never claim completion before GO. Two caught false-completes → `BLOCKED` (human). The round budget counts optimization iterations only (check / completion-claim evaluations) — goal-only milestone records don't consume it; budget exhausted → `roundsExhausted`, stop and escalate.

Self-optimization rule: `score` must not regress (`regression: true` → fix the regression first); `maximize` ACs with `baseline: delta` require strict metric improvement round over round.

## Three hard constraints (measured, not assumed)

From an ordering probe (`tools/pre-execute` waterfall semantics, real deny-return shape):

1. **Waterfall is first-registered-first-block.** Only the earliest registered layer's deny reason reaches the user; later layers are never called. So the reason must carry its own `code` (`[goal-gate:no-go]` / `verdict-stale` / `blocked`) — otherwise the user can't tell which layer blocked.
2. **`deny` and `throw` are different propagation mechanisms and must not be mixed.** `dsh-agent-teams`'s quality-gate rejects by `throw`ing, which blows through the waterfall and hands the caller an exception; the task board returns a structured `{kind:'deny'}`. This plugin always uses structured `deny` — never `throw` — so its error path stays distinct from quality-gate exceptions.
3. **Digest binding must be self-built.** DSH has no verdict↔file-tree binding anywhere (only state-key hashes). This plugin stores the digest and re-computes it before denying, so a passing verdict is voided automatically when the tree moves (R7).

## R7 digest caveat (fixed)

If `treeDigest` walks the ledger directory, writing the ledger changes the digest → the gate spuriously invalidates its own verdicts and R1's false-complete counter never reaches 2. Fixed: the digest excludes `.goal-gate`, `node_modules`, `.git`.

## Interpreter constraint

The DSH Host bundles Node 24.21.0 (`runtime/primary-runtime/dependencies/node/bin/node`). A `node` on `PATH` may be broken (e.g. SIGKILL on launch). Plugins run inside the Host runtime — **never write a bare `node`** in a gate script; if you must spawn a child, resolve it via `config.node ?? process.execPath` (the pattern `dsh-skill-office` uses).

## Install

```sh
dsh plugin add dsh-goalloop-agentteams
```

Or from source: the repo declares `dsh.bundle` in `package.json` with a `cordis.patch.yml` beside it, so `dsh plugin add` picks it up directly. `apply(ctx, config)` registers the `goal_loop_at` / `goal_gate_init` / `goal_gate_check` tools, the `/goal-loop-at` / `/goal-gate` commands, and the `tools/pre-execute` listener.

## Tests

```sh
node test/run-local.mjs
```

The real `@deepseek-ai/dsh-tools` lives inside the DSH Host and is not importable outside it, so the runner injects a minimal `defineTool` shim from `test/fixtures/dsh-tools-shim` for the duration of the run.

## Mapping to goal-loop

| goal-loop | This plugin |
|---|---|
| AC contract grammar + sha1 stamp | `parseContract` / `contractStamp` (R3) |
| `goal_gate.sh --check` re-run | `runGate` (R9 probe + expected-spec judgement) |
| digest-bound verdicts (R7) | `treeDigest` + `verdict-stale` deny |
| R1 false-complete count → BLOCKED | `falseCompleteRule` |
| `/goal-loop-at` trigger + loop orchestration | `goal_loop_at` tool / `/goal-loop-at` command + `loop.json` round budget |
| metric trajectory / self-optimization | `history.jsonl` + `score` / `bestScore` / `regression` |
| `goal_team.sh` portable layer + dual ledger | **dropped** — use native Agent Teams + task board |

## License

MIT
