# dsh-goalloop-agentteams

**Deterministic goal-completion gate for DeepSeek Harness** — ports the *judging face* of the [goal-loop](https://github.com/samirliu/goal-loop) skill onto native **Agent Teams** + the **task board**.

Contract-first acceptance criteria, a gate that **re-runs every check itself** (zero model trust), verdicts bound to a tree digest, and a hard deny on false completion at `update_goal` / `update_task` via `tools/pre-execute`. The portable team-file protocol and dual-ledger bookkeeping from goal-loop are deliberately *not* ported — native Agent Teams is strictly stronger.

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
AC-1 | <yes/no statement> | check: `<command>` | [probe: `<probe>`] | expected: <spec>
AC-2 | ... | check: `...` | expected: exit=0
```

Spec = `exit=0` | `<op><number>` (`<=5`, `>0`, `=3`) | `maximize` | `judged`.
Every `check` must be a **named, failable command** — include the environment dependency, the empty case, the error path — or the gate degrades into a tautology.

- `[probe:]` is *verify-the-verifier* (R9): the probe runs first; a probe failure marks the AC `unverifiable` rather than `passed`. More than 1/3 unverifiable → the whole gate returns NO-GO.
- Contract lives at `.goal-gate/goal.md` in the workspace root.

## Gate & interception

`goal_gate_check` re-runs every check itself:

- `rc=0` GO / `rc=2` NO-GO / `rc=3` BLOCKED / `rc=4` state error
- Interception is mounted on `tools/pre-execute`, covering both `update_goal(action:'complete')` and `update_task(status:'completed')`

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

Or from source: the repo declares `dsh.bundle` in `package.json` with a `cordis.patch.yml` beside it, so `dsh plugin add` picks it up directly. `apply(ctx, config)` registers the `goal_gate_check` tool, the `/goal-gate` command, and the `tools/pre-execute` listener.

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
| `goal_team.sh` portable layer + dual ledger | **dropped** — use native Agent Teams + task board |

## License

MIT
