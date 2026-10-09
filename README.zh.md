# dsh-goalloop-agentteams（中文）

确定性目标门控 + 目标闭环——把 goal-loop skill 的"模型永远不能自我宣布完成"做成 DSH 插件，
直接接入原生 **Agent Teams** 与**任务板**，丢弃其便携 team 文件协议与双账本。

**一条命令触发闭环**：`/goal-loop-at <objective>`（或 `goal_loop_at` 工具）写契约 + 轮次配置，
返回循环协议与从每条 AC 派生的 Agent Teams 建议任务；迭代期用 `goal_gate_check`（score/趋势/
failedActions），GO 了才准声明完成。

## 为什么需要它

DSH 现在有两层完成判定，但都不是 goal-loop 的判命面：

| 层 | 判什么 | 问题 |
|---|---|---|
| `dsh-agent-teams` quality-kind | 步骤有没有按契约做完 | `verify` 命令**不由运行时重跑**，`commandsRun` 的 exitCode 是成员自己填的 |
| `dsh-task-board` 验收门 | 语义上像不像做完了 | 内部是 LLM A/B 判官（阈值 0.65），且**每张卡片可 `skipVerification` 退掉** |

goal-gate 补的是硬地板：**自己重跑每条 AC 的 check，零模型参与**，verdict 绑定 tree digest，
被抓住的假完成计数，2 次 → BLOCKED。确定性门控 = 地板，LLM 判官 = 语义层，两者独立叠加。

## 契约文法

```
objective: <一句话目标>
[exit: goal-only | strict]
AC-1 | <yes/no 判定语句> | check: `<命令>` | [probe: `<探针>`] | [metric: `<指标正则，带一个捕获组>`] | [baseline: delta|abs] | expected: <规格>
AC-2 | ... | check: `...` | expected: exit=0
```

规格 = `exit=0` | `<op><数字>`（`<=5` `>0` `=3`）| `maximize` | `judged`。
每条 check 必须**真的能失败**（环境依赖、空值、错误路径都写进检查里），否则退化成永真式。

- `[probe:]` 是 verify-the-verifier（R9）：探针先跑，探针失败的 AC 判 `unverifiable` 而非 `passed`；`unverifiable` 比例 > 1/3 整个门控回 NO-GO。
- `[metric:]` 从 stdout 提指标值（一个捕获组）；不写则回退"取输出最后一个数字"——输出混有其他数字时务必写。
- `maximize` 与上一轮指标比：`baseline: delta` 要求严格改善，`abs`（缺省）要求不回退；首轮无基线 → `unverifiable`（先跑一轮 `goal_gate_check` 建基线）。
- `judged` 以 `probe` 为确定性判官，probe 退出码即结论；无 probe 的 `judged` 一律 `unverifiable`（Goodhart 防线）。
- 契约写到 `.goal-gate/goal.md`（工作区根）。

## 门控与拦截

`goal_gate_check` 工具（或 `/goal-gate` 命令）自己重跑每条 check：

- `rc=0` GO / `rc=2` NO-GO / `rc=3` BLOCKED / `rc=4` 状态错
- 输出带优化信号：`score`（passed/总数）、`round`/`maxRounds`/`remainingRounds`、`bestScore`、`regression`（回退标记）、`trend`（近 5 轮）、`failedActions`（逐条修复清单）
- 拦截挂在 `tools/pre-execute`，**按完成声明作用域分级**：目标级 `update_goal(action:'complete')` **永远硬门控**（全量契约 + R1 假完成计数）；任务级 `agent_teams_update_task(status:'completed')`、`team_task_update(action:'complete')`、旧名 `update_task(status:'completed')` 按契约 `exit:` 策略分级：
  - `exit: strict`（缺省）：全量契约硬拦 + 计数（单工作单元：任务完成=目标完成）
  - `exit: goal-only`（`goal_loop_at` 生成的契约自动带上）：多任务循环中步骤进度放行（步骤判定属 quality-kind 契约）；GO 绑定 digest，NO-GO 只记 `partialCompletes`。不分级会死锁多任务循环：成员完成自己的任务时，队友的 AC 必然未过，会被误判假完成
  - `BLOCKED`（目标级假完成 2 次）冻结一切完成声明

## 目标闭环（right loop / right eval / right metric）

`/goal-loop-at <objective>`（命令）或 `goal_loop_at`（工具）启动循环：

1. 写契约骨架（占位 check 是 fail-closed 的 `TODO-REPLACE-ME`）+ `.goal-gate/loop.json`（`maxRounds`，默认 8）；
2. 返回循环协议与从每条 AC 派生的 Agent Teams 建议任务；
3. 每轮门控评估追加进 `.goal-gate/history.jsonl`（ts/trigger/round/code/score/totals/失败 AC）——循环优化的轨迹；
4. NO-GO → 把 `failedActions` 变 repair 任务再验；GO 之前绝不声明完成。假完成 2 次 → BLOCKED 等人；轮次超预算 → `roundsExhausted` 停下上报。

自优化规则：`score` 不得回退（`regression: true` 先修回退）；`maximize` + `baseline: delta` 的 AC 要求逐轮严格改善。

## 实测得到的三条硬约束（`/tmp/goal-gate-probe/order_probe.mjs`）

1. **waterfall 先到先拦**：`tools/pre-execute` 里最先注册的那个层的 deny reason 到达用户，后面的层不会被调用。**reason 必须自带 code**，否则用户分不清是哪一层拦的（`[goal-gate:no-go]` / `[goal-gate:verdict-stale]` / `[goal-gate:blocked]`）。
2. **一律 `{kind:'deny'}`，绝不 `throw`**：`dsh-agent-teams` 的 quality-gate 走 `throw`，会炸穿 waterfall，调用方拿到异常而非结构化决策。goal-gate 必须用结构化 deny，否则错误路径会和 quality-gate 的异常混在一起。
3. **digest 绑定必须自建**：文件改动 → 摘要变 → 已过审 verdict 自动作废（R7）。DSH 无此机制。实测摘要在 `0ef9f008`→`0b08f446`（改动）/`2654c26635df`（另一改动）间变化。

## R7 摘要的一个坑（已修）

`treeDigest` 若扫整个工作区会把账本目录自己算进去 → 写账本→摘要变→误判 verdict 作废，R1 假完成计数永远到不了。已修：摘要排除 `.goal-gate`、`node_modules`、`.git`。

## 解释器约束

DSH Host 自带 Node 24.21.0（`runtime/primary-runtime/dependencies/node/bin/node`）；PATH 上的 `node` 可能是坏的（本机 SIGKILL 137）。插件跑在 Host 运行时内，**绝不在门控脚本里裸写 `node`**；要起子进程时用 `config.node ?? process.execPath`（照 `dsh-skill-office` 的做法）。

## 安装（cordis bundle）

```jsonc
// package.json
{ "name": "dsh-goalloop-agentteams", "type": "module",
  "main": "lib/index.js",
  "dsh": { "engines": { "dsh": ">=0.2.0-rc.2" }, "bundle": { "patch": "./cordis.patch.yml" } } }
```

```yaml
# cordis.patch.yml
- insert:
    - id: goal-gate
      name: 'dsh-goalloop-agentteams'
      config: {}
```

经 `plugin_manager` `install_bundle` 装载；`apply(ctx, config)` 注册 `goal_loop_at` / `goal_gate_init` / `goal_gate_check` 工具 + `/goal-loop-at` / `/goal-gate` 命令 + `tools/pre-execute` 监听器。

## 测试

```bash
NODE=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node
$NODE test/smoke_test.mjs   # core 契约解析 / 门控 rc / 判定 / 摘要
$NODE test/wiring_test.mjs  # 注册路径 + 双枝拦截 + R7 stale + R1 BLOCKED
```

> 测试用 `node_modules/@deepseek-ai/dsh-tools/` 里的最小 shim 模拟 `defineTool`（真实包在 Host 内，Host 外不可 import）。

## 与 goal-loop 的对应

| goal-loop | 本插件 |
|---|---|
| AC 契约文法 + sha1 盖戳 | `parseContract` / `contractStamp`（R3） |
| `goal_gate.sh --check` 重跑 | `runGate`（R9 probe / 期望规格判定） |
| digest 绑定 verdict（R7） | `treeDigest` + `verdict-stale` deny |
| R1 假完成计数 → BLOCKED | `falseCompleteRule` |
| `/goal-loop-at` 触发 + 循环编排 | `goal_loop_at` 工具 / `/goal-loop-at` 命令 + `loop.json` 轮次预算 |
| 指标轨迹 / 自主优化 | `history.jsonl` + `score` / `bestScore` / `regression` |
| `goal_team.sh` 便携层 + 双账本 | **丢弃**——用原生 Agent Teams + 任务板 |
