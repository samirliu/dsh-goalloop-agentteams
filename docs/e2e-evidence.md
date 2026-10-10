# 真机 E2E 实测证据(2026-10-10,DSH Desktop 0.2.0-rc.2)

## 背景:link: 依赖的宿主模块路由缺陷(实测)

插件以 `link:` 本地安装时,入口 `import '@deepseek-ai/dsh-tools'` 在宿主内**解析失败**
(指纹:`import FAIL [@deepseek-ai/dsh-tools]: Cannot find package ...`)→ 模块图实例化失败
→ `apply()` 从未执行 → 工具/命令/拦截器全部静默缺席。注册表/git 安装(实体目录)不受影响;
dsh-ocr、dsh-agnes-image 等所有 link: 插件同病。组合器(composeEntries)一切正常,
`goal-gate` 一直在 entry 列表里——坏的只是模块路由这一环。

**修复**:入口 defineTool 解析链——裸包名 → `process.resourcesPath` 安装目录物理路径
→ 同形 shim 保底。实测第二跳命中并全量注册成功(3 工具 + 2 命令 + pre-execute 监听器)。

## 五段实测(契约:strict,AC-2/AC-3 必失败)

| 阶段 | 期望 | 实测结果 |
|---|---|---|
| ① 假完成声明 | deny + 点名 AC | `[goal-gate:no-go] NO-GO: AC-2, AC-3 (round 1/8)` |
| ② 二次假完成 | R1 棘轮 | `[goal-gate:blocked] false-completes=2 ≥ 2; gate blocked. 等人介入。` |
| ③ 等人介入 | 清零 + 补产物 | falseCompletes→0,report.md≥3 行 + checklist.md,digest 变化 |
| ④ 再声明 | digest 作废重验→GO | 目标完成放行(score 0.33→1.0) |
| ⑤ goal-only 对照 | 任务声明放行+记账 | partialCompletes=1;里程碑不吃轮次预算(round 恒 3) |

## history.jsonl 终轨迹

```
round 1 | intercept  | no-go | score=0.3333
round 2 | intercept  | no-go | score=0.3333
round 3 | intercept  | go    | score=1
round 3 | task-claim | no-go | score=0.5    ← 里程碑记账,轮次不递增
```

state 终值:falseCompletes=0,partialCompletes=1,bestScore=1,baselines 已建立,digests 已绑定。
