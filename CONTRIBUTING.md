# Contributing / 维护交接

This plugin is the DSH-port of the [goal-loop](https://github.com/samirliu/goal-loop) skill:
the **judging face** (deterministic gate + stamped contract + completion interception)
and the **loop face** (contract/loop files, rounds, status/audit, dispatch). Read this
before changing the gate.

## Layout

| Path | Role |
|---|---|
| `lib/core.js` | Pure judgement kernel: contract parser, stamp, content digest, metric/spread extraction, expected-spec judgement, `runGate` fail taxonomy |
| `lib/ledger.js` | Ledger + lifecycle: state/history/loop, round & time budgets, efficiency, stamp (`applyStamp`), status/audit, preflight/never-failed |
| `lib/index.js` | Host entry: tool schemas + renderers, slash commands, runtime skill registration, `tools/pre-execute` completion interception, Agent Teams dispatch |
| `bin/gate.mjs` | Bash-reachable fallback CLI (`check/status/audit/stamp/reset/preflight`) sharing the same kernel and ledger |
| `skills/goal-loop/SKILL.md` | Runtime skill: the operational playbook the model loads |
| `skills/goal-loop-contract/SKILL.md` | Runtime skill: contract forge + stamp checklist |
| `test/` | smoke (kernel), wiring (registration/interception), ledger (lifecycle), redteam, purity, loadsafe, v07 (new surfaces) |
| `docs/platform-contract.md` | Verified DSH 0.2.1-rc.2 facts — read before touching registration surfaces |
| `docs/defect-ledger.md` | Every landed defect, its fix and regression test |

## Invariants (do not regress these)

1. **Completion only from the gate.** `runGate` re-runs every check itself; the model
   never declares completion. Deny decisions are structured `{kind:'deny', reason, info}`
   — never `throw` (the quality-gate layer uses exceptions; ours must stay distinct).
2. **BROKEN is decisive.** Missing instrument (127/timeout/signal), failed probe,
   metric/spread miss, missing judge, unbound/stale judged evidence, broken calib and
   unroutable specs are `broken` → NO-GO. `unverifiable` is a soft status for genuine
   temporary inapplicability only.
3. **Every tool declares `output.render`** and an output schema inside the supported
   JSON Schema subset (no `type:'json'`, no property-level `required`, explicit
   `additionalProperties`). Registration passes a schema-only output but **every
   successful call fails** — this was a real v0.6.x blocker.
4. **Returned keys ⊆ declared schema keys**, and every return path goes through
   `jsonSafe()`: no `undefined`, `NaN`, `±Infinity` or non-plain objects. Both are
   enforced by `test/wiring_test.mjs`.
5. **Commands** register through `c.commands.register` inside
   `ctx.inject(['commands'], …)`; no-argument commands omit `input` (empty hints are
   rejected); followup messages are full `UserMessage`s (`id`, `role`, `content`,
   `source`).
6. **Digest scope.** `.goal-gate/` (ledger + evidence) is excluded; everything else is
   content-hashed. Checks must not mutate the tree outside `.goal-gate/` — the gate
   returns `check-mutated-tree`.
7. **Stamp is the user's signature.** Any post-stamp contract edit voids approval;
   completion claims are denied `contract-revised` until an explicit re-stamp. Never
   auto-stamp from `goal_loop_at`.
8. **No bare `node`.** The machine's PATH `node` may be SIGKILLed. Docs, scripts and
   child-process examples use an absolute Node path.
9. **No case-specific content** in `lib/`, `skills/`, `test/`, `docs/`, `README*`
   (`test/purity_test.mjs` enforces this).

## Local workflow

```sh
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
"$NODE" test/run-local.mjs        # all suites; creates the dsh-tools test shim
"$NODE" test/smoke_test.mjs       # kernel only
```

The real `@deepseek-ai/dsh-tools` lives inside the Host. Tests use the entry's
schema-compiling fallback and **must never create `node_modules/@deepseek-ai/dsh-tools`
inside this package**: in a `link:` install that shim wins module resolution and the
Host registers raw parameter maps, which the provider rejects with
`schema must be a JSON Schema of 'type: "object"', got 'type: null'`. This was a real
boot-breaking incident; `test/run-local.mjs` no longer writes a shim and
`test/wiring_test.mjs` asserts `parameters.type === 'object'` for every tool.

### Verifying the real host contract

The registration surface is stricter than the shim. Before changing tool schemas,
commands or skills, run the real-registry harness described in
[platform-contract.md](docs/platform-contract.md): extract the app's own
`@deepseek-ai` packages, compose a real `Context` with `ToolRuntime`, the skill registry
and the command registry, apply the plugin, then execute every tool and assert
`isError === false`. A scratch profile check is also expected:

```sh
dsh plugin --profile scratch add /absolute/path/to/this/repo
dsh --profile scratch --dump-config     # expect the goal-gate row
```

Restart the desktop profile after host-side changes. Skills catalog updates are visible
on the next model step; tool/command sets are composed at boot.

## Change checklist

- [ ] Kernel change → new smoke/redteam assertion for both the pass and the fail side
- [ ] New tool / tool key → schema + renderer + wiring key-subset sample + v07 test
- [ ] New command → real command fiber check (list it) and non-empty hint if parameterized
- [ ] New contract token → parser + judgement + preflight + skill grammar + docs
- [ ] New lifecycle state → status + audit + fallback CLI + defect-ledger row
- [ ] `package.json` version and `README`/`README.zh` updated together
- [ ] `git diff --check`; run `test/run-local.mjs`; run the real-registry harness
- [ ] Commit message names the defect numbers it closes; branch from `main`

## Release

1. Bump `package.json` version (semver, minor for behaviour).
2. Update `README.md` / `README.zh.md` headline and the defect ledger.
3. Run the local suites and the real-registry harness.
4. Tag `vX.Y.Z`; push the branch and tag; the package is installable from GitHub
   without a registry (`dsh plugin add github:samirliu/dsh-goalloop-agentteams`).
