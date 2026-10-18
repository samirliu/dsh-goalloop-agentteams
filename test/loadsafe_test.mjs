// loadsafe_test.mjs — prove apply() does not throw in a MINIMAL composition
// (tools present, commands ABSENT). A required inject or eager commands.register
// here would make the real Host fail to boot (DSH boot is all-or-nothing).
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');
assert.equal(mod.name, 'goal-gate', 'entry must export name (= cordis.patch.yml id) or the Host silently skips the bundle');
assert.deepEqual(mod.inject, ['tools'], 'inject must be exactly ["tools"] (commands is lazy)');

const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t.name) },
  inject: () => { /* commands absent: cordis defers, never calls */ },
  on: () => () => {},
};
assert.doesNotThrow(() => mod.apply(ctx, {}));
assert.deepEqual(registered.sort(), ['goal_gate_audit', 'goal_gate_baseline', 'goal_gate_check', 'goal_gate_collect', 'goal_gate_dispatch', 'goal_gate_doctor', 'goal_gate_grill', 'goal_gate_init', 'goal_gate_judge', 'goal_gate_staff', 'goal_gate_stamp', 'goal_gate_status', 'goal_loop_at'], 'all tools register without commands');
console.log('✓ apply() loads with commands service ABSENT (no boot failure)');
console.log('✓ inject is ["tools"], commands registered lazily');
console.log('\nLoad-safety test passed.');
