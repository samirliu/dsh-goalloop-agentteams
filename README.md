# dsh-goalloop-agentteams

**goal-loop as a DeepSeek Harness plugin** — the *judging face* of the [goal-loop](https://github.com/samirliu/goal-loop) skill, wired into native **Agent Teams**, the **task board**, and DSH's completion-interception pipeline. The skill itself ships as two runtime skills (`goal-loop`, `goal-loop-contract`) so the model knows the protocol; the plugin makes the protocol enforceable.

Contract-first acceptance criteria, a gate that **re-runs every check itself** (zero model trust), a human approval stamp that freezes done, verdicts bound to a content digest, and a hard deny on false completion at `update_goal` / team-task / task-board surfaces via `tools/pre-execute`. The portable team-file protocol and dual-ledger bookkeeping are deliberately *not* ported — native Agent Teams is strictly stronger.

**v0.9.1 — Agent Teams orchestration: staff, collect, judge.** Highlights since 0.6.2:

- **BROKEN is decisive.** Missing instrument (rc 127), failed probe, metric miss, unmatched `sd:`/`var:`, unbound/stale judged evidence, missing judge and calibration defects are `broken` → NO-GO; they can no longer hide inside the “≤1/3 unverifiable” allowance.
- **R3 approval stamp.** `goal_gate_stamp` / `/goal-stamp` freezes the contract and budgets; any later edit makes completion claims fail as `contract-revised` until an explicit re-stamp.
- **Content-bound digests.** Same-size edits change the digest; a check that mutates the workspace is refused as `check-mutated-tree`; build-output directories are no longer silently excluded.
- **Objective surface.** `minimize`, `!=`, data-driven `sd:`/`var:` noise bands, first-run baseline establishment, and per-round `efficiency` with strategy attribution.
- **Budgets are fuses.** Round and wall-clock budgets bind at stamp and deny non-GO completion claims; `goal-reset --new-loop` is the human recovery path.
- **DSH-native.** `task_board_manage` `move-done` is intercepted; `dispatch:true` and `goal_gate_dispatch` create real native Agent Teams tasks for a Team Lead; read-only `goal_gate_status` / `goal_gate_audit`.
- **Complex-case fixes (v0.9.1).** Claim-time `delta` no longer requires a second improvement, grill no longer flags ordered scopes / bound judged contracts, and the fallback CLI now takes the ledger lock; `examples/plugin-e2e` covers all three.
- **Host-contract fix (v0.7.1).** Tool parameters always compile to an object-rooted provider schema; the test-only `dsh-tools` shim is never left inside the link-installed package (that shim caused `schema must be a JSON Schema of 'type: "object"', got 'type: null'` at boot).
- **Team staffing (v0.9).** `goal_gate_staff` turns ACs (or dependency waves) into teammate specs, previews by default, and with `spawn:true` spawns real native teammates, creates/assigns their board tasks and sends an AC brief. `goal_gate_collect` maps completed/in-progress/missing tasks back to ACs (`readyToCheck`); `goal_gate_judge` creates fresh-reviewer tasks for judged ACs with digest/calib requirements.
- **Agent Teams-native dispatch (v0.8).** ACs may declare `scope:` and `depends:`; dispatch creates dependency-ordered waves with `blockedBy`/`writeScopes`, reuses pending tasks instead of duplicating them, and can assign owners. `goal_gate_status`/`goal_gate_check` return a team snapshot and `nextActions`; a ledger lock serializes concurrent member operations.
- **Grilling eval design (v0.8).** `goal-loop-grill` skill + `goal_gate_grill` tool adversarially audit the contract: tautologies, unfalsifiable claims, Goodhart proxies, missing runtime evidence, unbound judged verdicts, missing noise bands, overlapping scopes. `goal_gate_baseline` measures optimize-AC mean/spread before stamping.
- **Packaged skills + commands.** Three skills appear in the session skill catalog; `/goal-loop-at`, `/goal-gate`, `/goal-stamp`, `/goal-audit`, `/goal-reset`, `/goal-grill`, `/goal-baseline` are registered.

## 中文简介

**dsh-goalloop-agentteams** 把 goal-loop skill 做成 DeepSeek Harness 插件：**判命面**由确定性门控执行（模型永不自宣完成），**闭环面**接入原生 Agent Teams / 任务板，**知识面**是运行时注册的两个 skill。

- **门控**：自己重跑每条 AC 的 check（零模型参与）；`broken`（仪器坏了、判官缺失、证据失联、取数失败）是决定性 NO-GO；只有门控能发 GO。
- **R3 盖章**：`goal_gate_stamp` / `/goal-stamp` 冻结契约与预算；盖章后改契约，完成声明一律 `contract-revised`，重新批准才放行。
- **证据绑定**：judged 评审必须含 `artifact:` + `digest: sha256:`，`calib:` 还要求 `calib-good: PASS` / `calib-bad: FAIL`；检查自己改工作区（`check-mutated-tree`）判无效——测量产物请写 `.goal-gate/evidence/`。
- **闭环**：`/goal-loop-at <目标>` 建契约骨架 + 轮次配置 + 协议 + 建议任务；`score` 不回退、轮次/墙钟预算到点停、假完成 2 次 BLOCKED（人类 `/goal-reset` 才解）。
- **分级治理**：`update_goal(complete)` 永远硬拦；任务级完成声明按 `exit: strict|goal-only` 分级；`task_board_manage move-done` 同样受管——多任务循环不会死锁，也不会绕过门控。

完整中文文档见 [README.zh.md](README.zh.md)。

The design rationale (right agentic loop, right eval, right metric, and how each maps onto Agent Teams) is in [docs/agent-teams-loop.md](docs/agent-teams-loop.md).

## Why / 为什么需要它

DSH already has two layers of completion judgement — but neither is a deterministic gate:

| Layer | Judges | Gap |
|---|---|---|
| `dsh-agent-teams` quality kinds | Did each step follow its contract | `verify` commands are **not re-executed** by the runtime; `commandsRun` exit codes are member-supplied |
| `dsh-task-board` acceptance gate | Does it look right semantically | LLM A/B comparison (threshold 0.65) — and **every card can opt out** via `skipVerification` |

`dsh-goalloop-agentteams` is the hard floor underneath both: it re-runs every AC's `check` command itself, binds verdicts to a content digest, and counts caught false-completes — two catches → `BLOCKED`. Deterministic gate = floor, LLM judge = semantic layer, quality kinds = step contract. Stacked, they close the loop.

## Install / 安装

```sh
dsh plugin --profile <profile> add dsh-goalloop-agentteams
```

Or from a checkout / GitHub:

```sh
dsh plugin --profile <profile> add /path/to/dsh-goalloop-agentteams
dsh plugin --profile <profile> add github:samirliu/dsh-goalloop-agentteams
```

The package declares `dsh.bundle` with a `cordis.patch.yml` beside it, so `dsh plugin add` mounts the `goal-gate` row directly. Restart the profile after install (host code, commands and skills are composed at boot).

⚠️ **Entry contract:** the entry must export `name` equal to the `cordis.patch.yml` id (`goal-gate`) alongside `inject` and `apply`. A missing `name` makes the Host silently skip the bundle. `link:` installs additionally may resolve `@deepseek-ai/dsh-tools` differently than registry installs; the entry tries the bare package first and falls back to a same-shape shim, and both paths are exercised by tests.

## Plugin config / 插件配置

`cordis.patch.yml` mounts the row with `config: {}`; add any of these keys to tune it:

| Key | Default | Meaning |
|---|---|---|
| `maxRounds` | `8` | Default round budget for a new loop |
| `requireStamp` | `false` | Refuse completion claims until the contract is approved |
| `requireHumanApproval` | `false` | Route `goal_gate_stamp` through the DSH approval seam (`ask`) |
| `intercept` | `true` | Mount the `tools/pre-execute` completion interceptor |
| `registerSkills` | `true` | Register the `goal-loop` / `goal-loop-contract` runtime skills |

## Quick start / 快速开始

```text
/goal-loop-at ship csv2jsonl with hard row validation and docs
```

or let the model call `goal_loop_at({objective, acs?, maxRounds?, dispatch?})`. Then run the four-step loop:

1. **Contract.** Load the `goal-loop-contract` skill when criteria are fuzzy. Each AC is one line: a yes/no statement plus a check that can actually FAIL. At least one AC must execute the deliverable itself at runtime. Present the one-screen summary.
2. **Approve + stamp.** The user approves; the model calls `goal_gate_stamp({approvedBy, maxRounds?, timeBudgetMinutes?})`, or the user types `/goal-stamp`. The stamp freezes the contract; editing it later voids the approval.
3. **Dispatch.** Native Agent Teams (`spawn_teammate` / `team_task_create`) first, task-board cards (`task_board_create`) when teams are unavailable, solo otherwise. `goal_loop_at({dispatch:true})` creates one team task per AC for a Team Lead; `goal_gate_dispatch` turns current failures into repair tasks. Disjoint write scopes; freeze interfaces first.
4. **Join + gate.** `goal_gate_check({strategy?, note?})` is the only completion authority. NO-GO → repair from `failedActions`, check again. GO → `goal_gate_audit` → deliver. Two caught false goal-completes → `BLOCKED`; only a human `/goal-reset` clears it.

## Tool surface / 工具面

| Tool | Purpose | Key result fields |
|---|---|---|
| `goal_loop_at` | Start the loop: contract skeleton + `loop.json` + protocol + tasks | `created`, `contractPath`, `maxRounds`, `tasks`, `protocol`, `preflight`, `dispatch` |
| `goal_gate_init` | Skeleton only (no loop config) | `created`, `path`, `alreadyExisted` |
| `goal_gate_stamp` | Freeze the approved contract and budgets (R3) | `stamped`, `code`, `stamp`, `approvedBy`, `approvedAt`, `maxRounds`, `timeBudgetMinutes`, `restamped` |
| `goal_gate_check` | Re-run every check; the only GO authority | `rc`, `code`, `score`, `totals`, `results`, `round`/`maxRounds`, `bestScore`, `regression`, `trend`, `failedActions`, `neverFailed`, `preflight`, `efficiency`, `timeRemainingMinutes`, `digestBefore`/`digestAfter` |
| `goal_gate_status` | Read-only status: no checks, no round burned | contract/stamp/approval, loop, counters, digest, last checks, stale flags, budgets |
| `goal_gate_audit` | Read-only pre-claim audit: contract/stamp/digest/last-GO consistency | `ok`, `violations`, `warnings`, `recommendations` |
| `goal_gate_dispatch` | Create native Agent Teams repair tasks: deps→`blockedBy`, scope→`writeScopes`, idempotent, optional owners | `gate`, `dispatched`, `failed`, `skippedExisting`, `reason`, `suggestions` |
| `goal_gate_grill` | Read-only adversarial eval/metric audit before stamp | `ok`, `verdict`, `findings`, `questions`, `metricDesign`, `goodhart` |
| `goal_gate_baseline` | Measure optimize AC baseline/spread (no round burned) | `samples`, `acs`, `recorded`, `notes` |
| `goal_gate_staff` | Staff the loop: teammate specs per AC/wave, preview or real spawn + task assignment | `mode`, `members`, `failed`, `tasks`, `notes` |
| `goal_gate_collect` | Map team task states back to ACs; `readyToCheck` gates the next check | `available`, `readyToCheck`, `byAc`, `completed`, `inProgress`, `pending`, `missing` |
| `goal_gate_judge` | Create cold-seat review tasks for judged ACs (fresh reviewer, evidence/calib brief) | `kind`, `dispatched`, `failed`, `skippedExisting`, `reason`, `suggestions` |
| `goal_gate_doctor` | Self-check tools/parameter schemas/commands/skills/Teams/contract | `ok`, `version`, `tools`, `commands`, `skills`, `agentTeams`, `contract`, `notes` |

Commands: `/goal-loop-at <objective>`, `/goal-gate` (status), `/goal-stamp [--restamp] [--max-rounds=N] [--time-budget-minutes=N] [approvedBy]`, `/goal-audit`, `/goal-grill`, `/goal-baseline [samples]`, `/goal-collect`, `/goal-judge [reviewer]`, `/goal-doctor`, `/goal-reset [--new-loop] [reason]`.

Runtime skills: **`goal-loop`** (the playbook), **`goal-loop-contract`** (contract forge / stamp checklist) and **`goal-loop-grill`** (adversarial eval/metric design). They are registered with `ctx.skills.register` and appear in the model's skill catalog; no filesystem install is needed.

## Contract grammar / 契约文法

```
objective: <one-line goal>
deliverable: <path to the artifact itself>
exit: goal-only | strict
AC-N | <yes/no statement> | check: `<failable command>` | [probe: `<instrument check>`] | [metric: `<regex, one capture group>`] | [baseline: delta|abs] | [timeout: <seconds>] | [tolerance: <relative>] | [sd: `<regex>`] | [var: `<regex>`] | [calib: good=<file> bad=<file>] | [scope: <path[,path...]>] | [depends: AC-x[,AC-y]] | expected: <spec>
```

Specs: `exit=0` | `exit=N` | `<=N` | `>=N` | `<N` | `>N` | `=N` | `!=N` | `maximize` | `minimize` | `judged`.

- **One AC per line, fixed token order.** A line that starts with `AC-N` but does not parse makes the gate refuse the whole contract (`state-error`); a leading `- AC-N` list marker is accepted. Duplicate AC ids, unknown dependencies and dependency cycles are refused.
- **`scope:`** is the workspace-relative write scope used by team dispatch (`writeScopes`); **`depends:`** builds the dependency graph (`blockedBy`, `plan.waves`).
- **`probe:`** runs first for numeric/optimization ACs and must pass; for `judged` it is the judge (exit code = verdict). A failed probe is `broken`, never `passed`.
- **`metric:`** extracts one capture group from stdout (ANSI stripped); without it the last number is used. Missing required metric = `broken`.
- **`maximize` / `minimize`** compare against the previous **accepted** value; the first run establishes the water mark and passes. `baseline: delta` demands strict improvement, `abs` (default) forbids regression. `tolerance:` is a relative noise band; `sd:`/`var:` widen it to `max(2*spread/|prev|, tolerance)` (`var:` is square-rooted); declared-but-unmatched spread is `broken`.
- **`judged`** requires the verdict to carry `artifact: <path>` and `digest: sha256:<64hex>` (recomputed by the gate). Unbound, stale or unreadable evidence is `broken`. With `calib: good=<f> bad=<f>` the verdict must also carry `calib-good: PASS` and `calib-bad: FAIL`, and both fixtures must exist.
- **Evidence produced by checks** (renders, logs, judge inputs) belongs under `.goal-gate/evidence/` — it is excluded from the digest. Checks that write anywhere else in the workspace fail the round as `check-mutated-tree`.
- **`deliverable:`** is advisory in the gate but drives preflight: a contract with no check touching the deliverable and no runtime AC gets `deliverable-unverified` / `no-runtime-ac` warnings before a round is burned.

## Gate semantics / 门控语义

`goal_gate_check` returns `rc=0` GO, `rc=2` NO-GO, `rc=3` BLOCKED, `rc=4` state error. Every round is appended to `.goal-gate/history.jsonl`.

| Status | Meaning | Effect on GO |
|---|---|---|
| `passed` | check met the named spec | counts toward `score` |
| `failed` | check ran and the artifact does not meet the spec | NO-GO |
| `broken` | the **instrument** is broken: 127/timeout/signal, failed probe, metric/spread miss, missing judge, unbound/stale evidence, broken calibration, unroutable spec | **NO-GO (decisive)** |
| `unverifiable` | genuinely not measurable yet (soft status) | allowed only up to 1/3; reported as `note` |

Additional outputs: `score` (passed/total), `bestScore` (high-water), `regression` (score dropped), `trend` (last five), `efficiency` (`scoreDelta`, `slope`, per-`strategy` attribution), `digestBefore`/`digestAfter` (a check that moved the tree returns `check-mutated-tree`), `timeRemainingMinutes`, `timeExhausted`.

## Approval, budgets and blockers / 批准、预算与阻塞

- **R3 stamp.** `goal_gate_stamp({approvedBy, maxRounds?, timeBudgetMinutes?, restamp?, note?})` writes the approval to `state.json` and may bind the budgets. A contract edit changes its stamp; completion claims are denied `contract-revised` until `restamp:true` (or `/goal-stamp`).
- **`requireStamp: true`** in plugin config makes an approved stamp mandatory before any completion claim (default `false`; the stamp remains recommended and is what `/goal-loop-at`'s protocol asks for).
- **`requireHumanApproval: true`** makes `goal_gate_stamp` itself go through the DSH approval seam (`{kind:'ask'}` in `tools/pre-execute`). Under an approval policy of `never` this fails closed — the default is `false` so headless loops still work.
- **Round budget** (`maxRounds`, default 8) and **wall-clock budget** (`timeBudgetMinutes`) are fuses: a non-GO completion claim at/over budget is denied (`rounds-exhausted` / `time-budget`). Green delivery is never confiscated at the time fuse.
- **False-complete ratchet:** a denied `update_goal(complete)` means the artifact is not done. Two denied goal-completes → `BLOCKED`; all claims freeze. `/goal-reset [--new-loop]` is the human-only recovery (there is deliberately no model-facing reset tool).
- **Loop identity:** a second `goal_loop_at` with a different objective refuses (`objective-drift`); changing the objective is changing the definition of done, so edit + re-approve or start a fresh workspace/loop.

## Interception / 完成声明拦截

Mounted on `tools/pre-execute`; always returns structured `{kind:'deny'}` (never `throw`):

- `update_goal(action:'complete')` — always hard-gated by the full contract, with the R1 counter.
- Task-level completion — `agent_teams_update_task(status:'completed')`, `team_task_update(action:'complete')`, legacy `update_task`, and **`task_board_manage(action:'move-done')`**. Under `exit: strict` they are gated like a goal claim; under `exit: goal-only` they are recorded (`partialCompletes`) and pass, so multi-task team loops do not deadlock on teammates' unfinished ACs. `BLOCKED` freezes every claim.
- Before running the gate it checks approval freshness (`contract-revised`) and, when configured, `requireStamp` (`unstamped`). A malformed contract is denied as `state-error`; no contract at all passes through.

## Dispatch / 派工

- `goal_loop_at({dispatch:true})` creates one native Agent Teams task per AC when the caller is a Team Lead (`ctx.agentTeams`); other callers get `suggestions` instead of a fake success.
- `goal_gate_dispatch({includeUnverifiable?})` re-runs the checks **without recording a round** and creates tasks for `failed`/`broken` (and optionally `unverifiable`) ACs. Each task description carries the exact command and spec.
- Without a Teams service, use `task_board_create` / solo work. The plugin never writes the task-board ledger directly.

## Agent Teams loop / Agent Teams 闭环

The plugin adapts to the native team service opportunistically (`ctx.get('agentTeams')`); it never requires it and never writes the task-board ledger itself.

| Concern | Behaviour |
|---|---|
| Planning | `goal_loop_at` returns `plan.waves` (topological from `depends:`) and task briefs carrying `scope:`/`depends:` |
| Dispatch | `goal_loop_at({dispatch:true})` / `goal_gate_dispatch` create tasks in dependency order, set `blockedBy` to created task ids and `writeScopes` from `scope:` |
| Idempotency | same AC + same contract stamp + pending/in-progress task = reused (`skippedExisting`), never multiplied by re-checks |
| Ownership | `goal_gate_dispatch({assign: {"AC-2": "engineer"}})` reassigns the created task to a member |
| Visibility | `goal_gate_status` / `goal_gate_check` return `team` (members, tasks mapped to ACs, ready/unowned counts) and `nextActions` (`dispatch-repairs`, `collect-team`, `assign-ready-tasks`, `stop-budget`, …) |
| Concurrency | `goal_gate_check`/`stamp`/`dispatch`/completion interception take a ledger lock; a concurrent caller gets `[goal-gate:busy]` instead of corrupting rounds/baselines |
| Staffing | `goal_gate_staff` previews teammate→AC/wave assignment; `spawn:true` spawns real teammates, assigns their tasks and sends a brief |
| Collection | `goal_gate_collect` maps board task state back to ACs; `readyToCheck=true` means the team claims the wave is done and the Lead should run the gate |
| Review | `goal_gate_judge` creates fresh-reviewer tasks for judged ACs; the brief requires `artifact:`, `digest:`, `calib-good/bad`, `score:` |
| Non-Lead callers | get `suggestions` (subject/description/scope/depends) instead of a fake dispatch; the protocol falls back to `subagent`/`subagent_fork` or `task_board_create` |

## Eval design with grilling / 用 grilling 设计评估

`goal_gate_grill` is a read-only attack on the contract, derived from goal-loop's grilling/contract-forge discipline. It returns `findings[severity, ac, issue, suggestion]`, the remaining `questions` for the user, `metricDesign` advice per optimize AC, and `goodhart` gaming paths. `verdict: ready` requires no high/medium findings. The `goal-loop-grill` skill teaches the interview frontier: ask what "done" means, how a cheap change could game the number, what known-bad case proves refusal, what baseline/spread was measured, and which evidence a judge must bind. Fix findings → re-grill → `goal_gate_baseline` → stamp.

## Read-only status and audit / 只读状态与审计

- `goal_gate_status({includeHistory?})` / `/goal-gate`: contract/stamp/approval, loop, counters, digest and bound digest, round/time budgets, idle status, recent history. It runs **no checks** and burns no round.
- `goal_gate_audit({})` / `/goal-audit`: contract parses, stamp matches, not BLOCKED, last evaluation is GO under the current contract, digest not stale, preflight/never-failed advisories, budget state. `violations` must be empty before claiming completion.
- `goal_gate_doctor` / `/goal-doctor` is the deployment self-check: registered tools, provider-visible object parameter schemas, commands, runtime skills, Agent Teams membership and contract readability. Run it first when a profile looks broken.
- Want current truth? That is `goal_gate_check` — an experiment that costs a round. A no-change re-evaluation is named `duplicate-evaluation`.

## Fallback CLI / bash 兜底

A resumed session may lack the plugin's tool table. The same ledger and the same gate are reachable from any shell (resolve the absolute Node path from `process.execPath` or plugin config — **never write a bare `node`**):

```sh
<abs-node> <plugin>/bin/gate.mjs check   --cwd <workspace> [--strategy <s>] [--note <n>]
<abs-node> <plugin>/bin/gate.mjs status  --cwd <workspace>
<abs-node> <plugin>/bin/gate.mjs audit   --cwd <workspace>
<abs-node> <plugin>/bin/gate.mjs stamp   --cwd <workspace> [--approved-by <who>] [--max-rounds <n>] [--time-budget-minutes <n>] [--restamp]
<abs-node> <plugin>/bin/gate.mjs reset   --cwd <workspace> [--new-loop]
<abs-node> <plugin>/bin/gate.mjs preflight --cwd <workspace>
```

## DSH host contract notes / 宿主契约（0.2.1-rc.2 实测）

- Every tool declares `output.render`; `defineTool` installs the wrapper and calls it on success. A schema-only output registers but every successful call fails `output.render failed: userRender is not a function` — the 0.6.x silent breakage.
- Output schemas must live in the supported JSON Schema subset: no author-only `type:'json'`, no property-level `required: true`, and every `object` states `additionalProperties`. Shared constant schemas are used for nullable objects.
- `ctx.inject(['commands'], (c) => …)` receives a child **Context**; register through `c.commands.register(...)`, and omit `input` rather than declaring an empty hint.
- Skills are registered in-memory with `ctx.skills.register({name, description, content, source, …})`; DSH does not scan a package's `skills/` directory.
- Workspace root comes from `exec.agent.session.header.cwd`; there is no `exec.session` / `exec.cwd`.
- The native Agent Teams service is `ctx.get('agentTeams')` (optional, never `inject`); its tasks are the `team_task_*` tools, not `agent_teams_*`.

`docs/platform-contract.md` records the verified evidence and probe method.

## Mapping to goal-loop / 与 goal-loop 的对应

| goal-loop | This plugin |
|---|---|
| AC contract grammar + `approved:` stamp | `parseContract` + `goal_gate_stamp` / `/goal-stamp` (R3) |
| `goal_gate.sh --check` re-run, BROKEN/FAIL/PASS | `runGate` fail taxonomy + `probe` + expected specs |
| digest-bound verdicts (R7) | content-hash `treeDigest` + `check-mutated-tree` + digest-bound claims |
| R1 false-complete count → BLOCKED | `falseCompleteRule` + `goal-reset` (human) |
| objective water mark / `sd:`/`var:` | `maximize`/`minimize` baselines + tolerance/spread bands + `efficiency` |
| judged seat + `calib:` | artifact+sha256 binding + `calib-good`/`calib-bad` grades |
| `/goal-loop-at` trigger + loop budget | `goal_loop_at` / `/goal-loop-at` + `loop.json` + round/time fuses |
| `goal_audit.sh` ledger audit | `goal_gate_audit` / `/goal-audit` |
| crew/work-plan/roster/inbox/Teams backend | **dropped** — native Agent Teams + task board + `goal_gate_dispatch` |
| contract-forge companion | runtime skill `goal-loop-contract` |

## Complex e2e cases / 复杂集成用例

`examples/plugin-e2e/run.mjs` runs five end-to-end cases against the real plugin code and the real CLI: a multi-wave CSV-to-JSONL converter with scopes/dependencies, staffing + collect + judged evidence, an adversarial contract that is grilled and repaired, budgets/contract-revision/BLOCKED/reset, concurrent CLI checks, and judged digest binding. It uses an API-faithful fake Agent Teams service so it runs without consuming model quota; live team registration is verified separately by `goal_gate_doctor`.

```sh
<abs-node> examples/plugin-e2e/run.mjs
```

## Tests / 测试

```sh
<abs-node> test/run-local.mjs
```

The real `@deepseek-ai/dsh-tools` lives inside the DSH Host and is not importable outside it, so the entry falls back to a parameter-schema-compiling shim. Tests never write a `node_modules/@deepseek-ai/dsh-tools` shim into the package directory: in a `link:` install that shim wins module resolution and the Host would register un-compiled parameter schemas (the provider rejects them with `type: null`). The suite covers core judgement, wiring (all tools/commands/skills, provider-visible parameter schemas), ledger/audit/stamp, red-team defences, purity, load-safety without commands, the v0.7 surfaces (fuses, task-board claims, dispatch, efficiency, reset), the v0.8 surfaces (scope/depends waves, idempotent/blocked dispatch, team snapshot/nextActions, grilling, baseline/spread, ledger lock) and the v0.9 surfaces (staff preview/spawn, collect readiness, judge tasks, lock wait, horizon guard). The real-host registration contract is verified against the extracted 0.2.1-rc.2 packages; see `docs/platform-contract.md`.

## License / 许可

MIT
