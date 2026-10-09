// smoke_test.mjs — core.js 冒烟：契约解析、盖戳、门控 rc、假完成计数
import { runGate, parseContract, contractStamp, treeDigest, falseCompleteRule, judgeExpected } from '../lib/core.js';
import fs from 'node:fs';
import path from 'node:path';

const dir = '/tmp/goal-gate-probe/smoke';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

const contract = `objective: 产出一份带自检的研究包
AC-1 | a.txt 存在且非空 | check: \`test -s a.txt\` | expected: exit=0
AC-2 | 行数 >= 1 | check: \`wc -l < a.txt\` | expected: >=1
AC-3 | 探针可信 | check: \`test -d .\` | probe: \`test -d .\` | expected: exit=0
AC-4 | 这条会失败 | check: \`test -f NOPE\` | expected: exit=0
`;

const parsed = parseContract(contract);
console.log('解析出', parsed.acs.length, '条 AC，objective =', parsed.objective);
console.log('盖戳 =', contractStamp(contract));
console.log('treeDigest =', treeDigest(dir));

// 门控：AC-4 必然失败 → NO-GO
const g = runGate(contract, { cwd: dir });
console.log('门控 rc =', g.rc, '| code =', g.code, '| reason =', g.reason);
console.log('逐条结果 =', JSON.stringify(g.results, null, 2));

// 假完成计数
console.log('falseComplete(1) =', falseCompleteRule(1));
console.log('falseComplete(2) =', falseCompleteRule(2));

// judgeExpected 边界
console.log('judgeExpected exit=0 (rc=0) =', judgeExpected('exit=0', { exitCode: 0, stdout: '' }));
console.log('judgeExpected <=5 (stdout=3) =', judgeExpected('<=5', { exitCode: 0, stdout: '3\n' }));
console.log('judgeExpected >10 (stdout=3) =', judgeExpected('>10', { exitCode: 0, stdout: '3\n' }));

// 摘要变化 → verdict 应作废
fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
console.log('改后 treeDigest =', treeDigest(dir), '（变了 → R7 应作废已过审结论）');
