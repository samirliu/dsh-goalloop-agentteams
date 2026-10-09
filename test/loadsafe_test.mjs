// loadsafe_test.mjs — prove apply() does not throw in a MINIMAL composition
// (tools present, commands ABSENT). A required inject or eager commands.register
// here would make the real Host fail to boot (DSH boot is all-or-nothing).
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');
assert.deepEqual(mod.inject, ['tools'], 'inject must be exactly ["tools"] (commands is lazy)');

const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t.name) },
  inject: () => { /* commands absent: cordis defers, never calls */ },
  on: () => () => {},
};
assert.doesNotThrow(() => mod.apply(ctx, {}));
assert.deepEqual(registered.sort(), ['goal_gate_check', 'goal_gate_init', 'goal_loop_at'], 'all tools register without commands');
console.log('✓ apply() loads with commands service ABSENT (no boot failure)');
console.log('✓ inject is ["tools"], commands registered lazily');
console.log('\nLoad-safety test passed.');
