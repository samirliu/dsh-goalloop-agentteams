// test/run-local.mjs — run all local suites.
//   <absolute-node> test/run-local.mjs
//
// The real @deepseek-ai/dsh-tools lives inside the DSH Host and is not importable
// outside it, so lib/index.js falls back to a parameter-schema-compiling shim.
// Tests deliberately do NOT create a node_modules/@deepseek-ai/dsh-tools shim in
// the package directory: in a `link:` install that shim wins module resolution and
// the Host then registers un-compiled parameter schemas (the provider rejects them
// with "schema must be a JSON Schema of 'type: object', got 'type: null'").
//
// Per-file isolation: every file runs in its own child process, and one failing
// file never hides the rest. Exit code is non-zero iff at least one file failed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveShell } from '../lib/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suites = [
  path.join('test', 'smoke_test.mjs'),
  path.join('test', 'wiring_test.mjs'),
  path.join('test', 'ledger_test.mjs'),
  path.join('test', 'redteam_test.mjs'),
  path.join('test', 'purity_test.mjs'),
  path.join('test', 'loadsafe_test.mjs'),
  path.join('test', 'v07_test.mjs'),
  path.join('test', 'v08_test.mjs'),
  path.join('test', 'v09_test.mjs'),
  path.join('examples', 'plugin-e2e', 'run.mjs'),
];

console.log(`node: ${process.execPath} (${process.version})`);
console.log(`gate shell: ${resolveShell().label}`);

const results = [];
for (const rel of suites) {
  console.log(`\n=== ${rel} ===`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, rel)], { stdio: 'inherit' });
  const status = r.status ?? 1;
  results.push({ rel, status, ms: Date.now() - started, ok: status === 0, signal: r.signal ?? undefined, error: r.error?.code });
}

const failed = results.filter((x) => !x.ok);
console.log('\n=== per-file results ===');
for (const x of results) {
  const verdict = x.ok ? 'PASS' : `FAIL (exit ${x.status}${x.signal ? `, signal ${x.signal}` : ''}${x.error ? `, ${x.error}` : ''})`;
  console.log(`${verdict.padEnd(22)} ${x.rel}  (${x.ms}ms)`);
}
console.log(`\n${results.length - failed.length}/${results.length} suite files passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.map((x) => x.rel).join(', ')}`);
  process.exit(1);
}
console.log('All tests passed.');
