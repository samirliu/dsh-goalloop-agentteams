# E2E / host-contract evidence

## v0.7.0 — real registration contract (DSH 0.2.1-rc.2, 2026-10-18)

Method: the desktop app's own packages were extracted from `app.asar` (dsh-tools,
dsh-skill, dsh-commands, dsh-agent-team family) into a temp tree and composed into a
real `Context`: real `ToolRuntime`, real `SkillRegistry`, real `CommandRegistry`, real
`ctx.agentTeams`-free baseline. The plugin entry was then applied and every tool was
executed through `ctx.tools.execute`, i.e. through registration, argument validation,
`tools/pre-execute`, the execute body, output validation and the declared renderer.

| Check | Expected | Observed |
|---|---|---|
| 0.6.2 successful tool call | returns a value | **FAILED** `output.render failed: userRender is not a function` (blocker #24) |
| 0.6.2 slash commands | 2 commands listed | **FAILED** `cannot get property "register" without inject` (blocker #25) |
| 0.7.0 registration | 7 tools in `ctx.tools.schemas()` | 7 tools, every one with a callable `output.render` |
| 0.7.0 `goal_gate_init` | success value | `{created:true, path:…, alreadyExisted:false}` |
| 0.7.0 `goal_loop_at` | success value | contract + loop.json + tasks + protocol returned |
| 0.7.0 `goal_gate_stamp` | success value | stamp recorded, budgets bound |
| 0.7.0 `goal_gate_check` GO | success value | `rc:0, code:'go', score:1, totals{passed:1,failed:0,broken:0,unverifiable:0}, efficiency{…}, digestBefore==digestAfter` |
| 0.7.0 `goal_gate_status` | success value | read-only snapshot, `roundsUsed:1`, no nulls |
| 0.7.0 `goal_gate_audit` | success value | `ok:true`, warnings only |
| 0.7.0 completion deny | structured deny | `Error: [goal-gate:contract-revised] …` after a post-stamp edit |
| 0.7.0 commands through a real plugin fiber | 5 goal-* commands in `ctx.commands.list` | `/goal-audit`, `/goal-gate`, `/goal-loop-at`, `/goal-reset`, `/goal-stamp` |
| 0.7.0 runtime skills | 2 entries in `ctx.skills.list` | `goal-loop`, `goal-loop-contract`, full bodies loadable |
| 0.7.0 output schema subset | accepted by `assertSupportedJsonSchema` | accepted (no property-level `required`, no `type:'json'`, explicit `additionalProperties`) |

Also verified with the real CLI: `dsh plugin --profile scratch add <path>` creates a
link install, and `dsh --profile scratch --dump-config` shows the row:

```yaml
# == dsh-goalloop-agentteams
- id: goal-gate
  name: dsh-goalloop-agentteams
  config: {}
```

The full facts and probe method are in [platform-contract.md](platform-contract.md).
A restarted-desktop end-to-end run is still recommended before a release tag; the
registration contract itself no longer relies on a shim.

## Legacy run — 2026-10-10, DSH Desktop 0.2.0-rc.2

### Background: the `link:` module-routing defect (measured)

With a `link:` local install, the entry's `import '@deepseek-ai/dsh-tools'` failed to
resolve inside the Host → module-graph instantiation failed → `apply()` never ran →
tools/commands/interceptor all silently absent. Registry/git installs were unaffected.
The workaround is the entry's resolution chain (bare specifier → install-path physical
fallback → same-shape shim). On 0.2.1-rc.2 the bare specifier resolves for `link:`
installs again, but the chain is kept for older hosts.

Five-segment live run (contract `strict`, AC-2/AC-3 fail by design):

| Segment | Expected | Observed |
|---|---|---|
| ① false completion | deny + named ACs | `[goal-gate:no-go] NO-GO: AC-2, AC-3 (round 1/8)` |
| ② second false completion | R1 ratchet | `[goal-gate:blocked] false-completes=2 ≥ 2; gate blocked.` |
| ③ human intervention | counters cleared, artifacts added | falseCompletes→0, digest changed |
| ④ claim again | digest re-verify → GO | goal completion allowed (score 0.33→1.0) |
| ⑤ goal-only control | task claim passes + bookkeeping | partialCompletes=1; round stays 3 |

`history.jsonl` tail:

```
round 1 | intercept  | no-go | score=0.3333
round 2 | intercept  | no-go | score=0.3333
round 3 | intercept  | go    | score=1
round 3 | task-claim | no-go | score=0.5    ← milestone bookkeeping, round unchanged
```

This run predates the v0.7 fail taxonomy: the same trajectory now reports BROKEN
rows instead of allowing GO with unverifiable ACs, and the stamp/audit path is added.
