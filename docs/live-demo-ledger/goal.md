objective: goal-only 对照实验
exit: goal-only
AC-1 | 过 | check: `test -f goal-gate-demo/report.md` | expected: exit=0
AC-2 | 不过 | check: `test -f NOPE` | expected: exit=0
