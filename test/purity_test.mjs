// purity_test.mjs — 通用区纯度守卫:插件是通用产品,案例内容只允许存在于 examples/。
// 违禁词表按需追加(案例代号/产品专名);命中即测试失败。
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GENERIC = ['lib', 'bin', 'skills', 'test', 'docs', 'README.md', 'README.zh.md', 'package.json', 'cordis.patch.yml'];
const FORBIDDEN = ['b747', '波音', '747-400'];

const out = execSync(
  `grep -rniE "${FORBIDDEN.join('|')}" ${GENERIC.join(' ')} 2>/dev/null || true`,
  { cwd: root, encoding: 'utf8' },
).trim();

if (out) {
  console.error('✗ 通用区发现案例相关内容(案例只能放 examples/):');
  console.error(out);
  process.exit(1);
}
console.log(`✓ 通用区纯度:lib/bin/skills/test/docs/README* 无案例内容(违禁词:${FORBIDDEN.join(', ')})`);
console.log('\nPurity tests passed.');
