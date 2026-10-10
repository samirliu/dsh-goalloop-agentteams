// test/run-local.mjs — run the smoke tests with the dsh-tools shim injected.
//   node test/run-local.mjs
// Creates node_modules/@deepseek-ai/dsh-tools from test/fixtures/dsh-tools-shim
// (the real package lives inside the DSH Host and is not importable outside it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shimSrc = path.join(root, 'test', 'fixtures', 'dsh-tools-shim');
const shimDst = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools');

fs.mkdirSync(shimDst, { recursive: true });
fs.copyFileSync(path.join(shimSrc, 'index.js'), path.join(shimDst, 'index.js'));
fs.writeFileSync(path.join(shimDst, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0-test-shim', type: 'module',
  main: 'index.js', exports: { '.': './index.js' },
}, null, 2));

for (const t of ['smoke_test.mjs', 'wiring_test.mjs', 'ledger_test.mjs', 'purity_test.mjs', 'loadsafe_test.mjs']) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [path.join(root, 'test', t)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\nAll tests passed.');
