// purity_test.mjs — 通用区纯度守卫:插件是通用产品,案例内容只允许存在于 examples/。
// 违禁词表按需追加(案例代号/产品专名);命中即测试失败。
//
// The original scan shelled out to `grep -rniE ... || true`, which is POSIX-only.
// The scan is reimplemented in JS so the guard is identical on Windows and POSIX.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GENERIC = ['lib', 'bin', 'skills', 'test', 'docs', 'README.md', 'README.zh.md', 'package.json', 'cordis.patch.yml'];
const FORBIDDEN = ['b747', '波音', '747', '飞机', '全黑', '翻车'];
const EXCLUDE_FILES = new Set(['purity_test.mjs']);

const forbiddenRe = new RegExp(FORBIDDEN.join('|'), 'i');
const hits = [];

function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; } // unreadable/binary: skip like grep's 2>/dev/null
  text.split(/\r?\n/).forEach((line, i) => {
    if (forbiddenRe.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}:${line}`);
  });
}

function walk(entry) {
  let stat;
  try { stat = fs.statSync(entry); } catch { return; } // missing GENERIC entry: not an error
  if (stat.isFile()) {
    if (!EXCLUDE_FILES.has(path.basename(entry))) scanFile(entry);
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
  }
}

for (const rel of GENERIC) walk(path.join(root, rel));

if (hits.length) {
  console.error('✗ 通用区发现案例相关内容(案例只能放 examples/):');
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log(`✓ 通用区纯度:lib/bin/skills/test/docs/README* 无案例内容(违禁词:${FORBIDDEN.join(', ')})`);
console.log('\nPurity tests passed.');
