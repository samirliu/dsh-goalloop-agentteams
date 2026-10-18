// test/run-local.mjs — run all local suites.
//   <absolute-node> test/run-local.mjs
//
// The real @deepseek-ai/dsh-tools lives inside the DSH Host and is not importable
// outside it, so lib/index.js falls back to a parameter-schema-compiling shim.
// Tests deliberately do NOT create a node_modules/@deepseek-ai/dsh-tools shim in
// the package directory: in a `link:` install that shim wins module resolution and
// the Host then registers un-compiled parameter schemas (the provider rejects them
// with "schema must be a JSON Schema of 'type: object', got 'type: null'").
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const t of ['smoke_test.mjs', 'wiring_test.mjs', 'ledger_test.mjs', 'redteam_test.mjs', 'purity_test.mjs', 'loadsafe_test.mjs', 'v07_test.mjs', 'v08_test.mjs']) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [path.join(root, 'test', t)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\nAll tests passed.');
