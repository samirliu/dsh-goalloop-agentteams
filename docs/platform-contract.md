# DSH host contract — verified against 0.2.1-rc.2

This is the platform surface the plugin depends on. Every claim below was verified by
running a real `ToolRuntime` / `SkillRegistry` / `CommandRegistry` composed from the
desktop app's own packages (extracted from `app.asar`), plus a scratch profile
(`dsh plugin --profile scratch add <path>` + `--dump-config`). No claim here is inferred
from an older release or from a third-party plugin.

Probe harness and extracted packages are test-time artifacts under `/tmp`; they are not
part of the package.

## 1. Tool registration (`@deepseek-ai/dsh-tools`)

| Fact | Evidence |
|---|---|
| `output.render` is mandatory and is called on every **successful** result. `defineTool` installs a wrapper around the user renderer, so registration accepts a schema-only output and the failure only appears at call time: `output.render failed: userRender is not a function` (`INVALID_TOOL_OUTPUT`). | `assertSupportedJsonSchema` in `ToolRuntime.register`; probe of a schema-only tool: registration accepted, successful call failed |
| `output.schema` is checked by `assertSupportedJsonSchema` at registration. Supported subset: `type` is one of object/array/string/number/integer/boolean/null, `properties` on object, `items` on array, `enum`/`const` on scalars, `oneOf`, and annotations. **No** `type: 'json'` (author-only), **no** property-level `required` (required is only an object-level array of names), **no** type arrays. An `object` must state `additionalProperties` explicitly. | `dsh-tools/lib/index.js` `checkSchemaNode` / `assertSupportedJsonSchema`; plugin failed registration until schemas were rewritten |
| Parameters use the same value-schema DSL with an implicit open object root; per-property `required: true` is how required arguments are declared. | `parameterSchemaSpecToJsonSchema` |
| A successful call returns the canonical value, then the declared renderer turns it into content blocks. Tool results are validated against `output.schema`; extra keys fail because the plugin declares `additionalProperties: false`. | `ToolRuntime.execute` post-validation; runtime probe |
| `exec` carries `{ token, callId, rootCallId, name, signal, agent?, parent?, schema?, arguments }` plus `deferContext` / `concludeTurn`. **No** `exec.session` / `exec.cwd`; arguments are deep-frozen. The workspace is `exec.agent.session.header.cwd`. | `ToolExecution`/`ToolRunContext` types; probe `G.exec_shape` |
| `tools/pre-execute` is an ordered waterfall: the first non-`next()` decision wins; `allow | deny{reason,info} | cancel | ask`; `ask` routes through `ctx.approval` and fails closed without an approval service. | `PreToolDecision`; probe deny/ask paths |

**Plugin rule:** every tool declares a shared `renderJson` renderer, and every output
schema is authored against the supported subset (nullable objects expressed as
`oneOf: [{type:'object', additionalProperties:true}, {type:'null'}]`).

## 2. Commands (`@deepseek-ai/dsh-commands`)

- `ctx.inject(['commands'], (c) => …)` hands the callback a **child Context**, not the
  service. Reading `c.register` throws `cannot get property "register" without inject`.
  The registration call is `c.commands.register({...})`.
- `input.hint` must be non-empty when `input` is present. No-argument commands omit
  `input` entirely.
- `handler(invocation)` receives `{ commandId, agent, rawInput, attachments, signal }`
  and must return `{kind:'success'|'error', text}` (or the richer command result shape).
  A handler may call `agent.followup(...)`; the message must be a full `UserMessage`
  (`id`, `role:'user'`, `content`, `source:{kind:'user'}`).
- Verified through a real plugin fiber: all five commands appear in
  `ctx.commands.list(agent)` after `ctx.plugin({name, inject, apply})`.

## 3. Skills (`@deepseek-ai/dsh-skill`)

- Embedded/runtime skills are registered with
  `ctx.skills.register({ name, description, content, source, invocation?, provider?, path? })`.
  `name` is kebab-case, `description` non-empty. `source` is required by the type.
- There is **no** package-directory scan: a `skills/` folder in a plugin package is not
  a discovery root. Filesystem roots are `<project>/.dsh/skills`,
  `<project>/.agents/skills`, configured `customSkillDirs`, `~/.dsh/skills`,
  `~/.agents/skills`.
- The catalog reaches the model on the next pre-step; the body is loaded on demand.
- Verified: after applying the plugin with a real skill registry, `ctx.skills.list({})`
  returns `goal-loop` and `goal-loop-contract`, and `get()` returns the full bodies.

## 4. Agent Teams (`@deepseek-ai/dsh-experimental-agent-team`)

- The service is `ctx.get('agentTeams')` (optional). It exposes
  `membership / tryMembership / listMembers / spawnTeammate / sendMessage /
  createTask / getTask / listTasks / updateTask / waitForChange / interrupt`.
- Every call takes the **exact live caller Agent**; `tryMembership` returns
  `undefined` for non-members instead of throwing. Only a Lead can spawn or interrupt.
- Model-facing tool names are `spawn_teammate`, `send_message`, `list_agents`,
  `wait_agent`, `interrupt_agent`, and `team_task_*` — **not** `agent_teams_*`.
- Verified: the plugin resolves the service with `ctx.get`, checks `role === 'lead'`,
  and creates real tasks through `createTask`; non-Lead callers receive suggestions.

## 5. Task board

The task board is a third-party plugin (`dsh-task-board` / `dsh-client-ui-task-board`).
Its host service exposes no programmatic card API; the only programmatic surfaces are
the `task_board_*` tools and the user's ledger file (never written by this plugin).
Because a manual `task_board_manage(action:'move-done')` is a completion claim in the
same sense as `update_goal(complete)`, it is included in the completion interceptor.

## 6. Approval (`@deepseek-ai/dsh-user-approval`)

Returning `{kind:'ask', reason?, displayReason?}` from `tools/pre-execute` routes the
call through `ctx.approval.request(...)`; only `allowed-once` grants. Under policy
`never` the request is rejected deterministically before any answerer. The plugin uses
this only for `goal_gate_stamp` when `requireHumanApproval: true`, so headless loops
keep working by default.

## 7. Bootstrap, bundle and testing

- A bundle package declares `dsh.bundle.patch` → `cordis.patch.yml`; the patch is a
  top-level list with `insert: [{ id, name, config }]`. The entry must export `name`
  equal to the row id; a missing `name` makes the Host skip the bundle silently.
- Scratch-profile verification without touching the user's GUI/profile:
  `dsh plugin --profile scratch add <path>`, then `dsh --profile scratch --dump-config`.
  The dump shows `# == dsh-goalloop-agentteams` and the `id: goal-gate` row.
- The desktop host bundles Node 24.21.0 under
  `runtime/primary-runtime/dependencies/node/bin/node`. A `node` on `PATH` can be
  broken (SIGKILL on this machine): never write a bare `node` in gate scripts or docs.
- `link:` installs may fail to resolve `@deepseek-ai/dsh-tools` through the host's
  module routing; the entry tries the bare specifier first and falls back to a
  same-shape `defineTool` shim. Registry/git installs resolve the real package.

## 8. What the 0.6.x release got wrong

The 0.6.x plugin was verified against DSH 0.2.0-rc.2 and later looked healthy because
only its **deny** path was exercised end-to-end. On 0.2.1-rc.2:

1. schema-only `output` → every successful tool call failed (`userRender is not a function`);
2. `c.register` instead of `c.commands.register` → no slash command ever registered;
3. `{ hint: '' }` → registration rejected even after (2) was fixed;
4. property-level `required` / `type:'json'` in output schemas → registration rejected.

v0.7.0 fixes all four; `test/wiring_test.mjs` now asserts render presence, the output
schema subset invariant and optional non-empty hints, and the registry harness above
was re-run to prove successful GO/NO-GO returns.
