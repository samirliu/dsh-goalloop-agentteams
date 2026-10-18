# Plugin e2e cases

Five complex cases for `dsh-goalloop-agentteams`. They run against the real plugin
code and the real `bin/gate.mjs`, with an API-faithful fake Agent Teams service, so
they need no model quota. Live team registration is checked separately by
`goal_gate_doctor`.

```sh
<abs-node> examples/plugin-e2e/run.mjs
```

| Case | Exercises |
|---|---|
| multi-wave delivery | 5 ACs with `scope:`/`depends:`, grill, baseline, stamp, `goal_gate_staff` (2 members, 5 tasks, owners), check NO-GO, implement artifacts, `goal_gate_collect` ready, GO, audit, goal claim digest binding |
| adversarial contract | tautology / missing deliverable / missing runtime are caught by `goal_gate_grill`; after repair the contract is `ready` and the gate GOes |
| budgets & revision | R3 stamp, contract-revision deny, two false completes → BLOCKED, human `/goal-reset` |
| concurrent CLI | two `bin/gate.mjs check` processes race the same ledger; the lock serializes them and both rounds are recorded exactly once |
| judged evidence | digest-bound judged PASS; stale artifact digest → BROKEN; refreshed digest → PASS |

The runner uses temp workspaces under the OS temp directory and leaves them for
inspection. Failures print the offending assertion and exit non-zero.
