# dsh-goalloop-agentteams（中文）

**把 goal-loop 做成 DeepSeek Harness 插件**——把 [goal-loop](https://github.com/samirliu/goal-loop) skill 的**判命面**接进原生 **Agent Teams**、**任务板**与 DSH 的完成声明拦截管线；skill 本身作为两个运行时 skill（`goal-loop`、`goal-loop-contract`）随插件注册，模型知道协议，插件让协议**可执行**。

契约先行；门控**自己重跑每条 check**（零模型信任）；人类盖章冻结"done 的定义"；verdict 绑定内容摘要；假完成在 `update_goal` / 团队任务 / 任务板三个完成面被 `tools/pre-execute` 硬拦。goal-loop 的便携 team 文件协议与双账本**故意不移植**——原生 Agent Teams 更强。

**v0.7.0 — 信任修复 + 完整闭环面**（相对 0.6.2）：

- **BROKEN 是决定性的**：仪器缺失（rc 127）、probe 失败、取数失败、`sd:`/`var:` 匹配不到、judged 证据失联/过期、判官缺失、calib 缺陷一律 `broken` → NO-GO；不再能藏在"≤1/3 unverifiable"的放行带里。
- **R3 批准盖章**：`goal_gate_stamp` / `/goal-stamp` 冻结契约与预算；之后任何契约编辑都会让完成声明以 `contract-revised` 被拒，直到显式重盖章。
- **内容绑定摘要**：同尺寸改动也会改变摘要；检查期间改工作区判 `check-mutated-tree`；`dist/build/out` 不再被静默排除。
- **目标面**：`minimize`、`!=`、数据驱动的 `sd:`/`var:` 噪声带、首轮建立水位、逐轮 `efficiency` 与策略归因。
- **预算是保险丝**：轮次/墙钟预算在盖章时绑定，非 GO 的完成声明到点即拒；`/goal-reset --new-loop` 是人类恢复入口。
- **DSH 原生**：拦截 `task_board_manage` 的 `move-done`；`dispatch:true` 与 `goal_gate_dispatch` 为 Team Lead 创建真实的原生 Agent Teams 任务；只读 `goal_gate_status` / `goal_gate_audit`。
- **打包 skill + 命令**：两个 skill 出现在会话 skill 目录；`/goal-loop-at`、`/goal-gate`、`/goal-stamp`、`/goal-audit`、`/goal-reset` 注册。

## 为什么需要它

DSH 已有两层完成判定，但都不是确定性门控：

| 层 | 判什么 | 问题 |
|---|---|---|
| `dsh-agent-teams` quality-kind | 步骤有没有按契约做完 | `verify` 命令**不由运行时重跑**，`commandsRun` 的 exitCode 是成员自己填的 |
| `dsh-task-board` 验收门 | 语义上像不像做完了 | LLM A/B 判官（阈值 0.65），且每张卡片可 `skipVerification` 退掉 |

本插件是两者脚下的硬地板：自己重跑每条 AC 的 `check`，把 verdict 绑到内容摘要，统计被抓住的假完成——2 次 → `BLOCKED`。确定性门控 = 地板，LLM 判官 = 语义层，quality-kind = 步骤契约；叠起来才是完整链条。

## 安装

```sh
dsh plugin --profile <profile> add dsh-goalloop-agentteams
# 或从本地/GitHub：
dsh plugin --profile <profile> add /path/to/dsh-goalloop-agentteams
dsh plugin --profile <profile> add github:samirliu/dsh-goalloop-agentteams
```

包内声明了 `dsh.bundle` 与 `cordis.patch.yml`，`dsh plugin add` 会把 `goal-gate` 行挂进组合；安装后重启 profile（host 代码、命令与 skill 在启动时组装）。

⚠️ **入口契约**：入口必须导出 `name`（等于 `cordis.patch.yml` 的 id `goal-gate`）以及 `inject`、`apply`；缺 `name` 会被 Host 静默跳过。`link:` 安装时 `@deepseek-ai/dsh-tools` 的解析可能与注册表安装不同，入口先试裸包名再用同形 shim 兜底，两条路径都有测试覆盖。

## 插件配置

`cordis.patch.yml` 以 `config: {}` 挂载；可加以下键：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxRounds` | `8` | 新循环默认轮次预算 |
| `requireStamp` | `false` | 未盖章时拒绝完成声明 |
| `requireHumanApproval` | `false` | `goal_gate_stamp` 走 DSH approval seam（`ask`） |
| `intercept` | `true` | 挂载 `tools/pre-execute` 完成声明拦截 |
| `registerSkills` | `true` | 注册 `goal-loop` / `goal-loop-contract` 运行时 skill |

## 快速开始

```text
/goal-loop-at ship csv2jsonl with hard row validation and docs
```

或让模型调用 `goal_loop_at({objective, acs?, maxRounds?, dispatch?})`。四步循环：

1. **契约**：条件模糊时先加载 `goal-loop-contract` skill。每条 AC 一行：可判定陈述 + 一条**真的能失败**的 check；至少一条 AC 在运行时执行交付物本体。给用户一屏摘要。
2. **批准 + 盖章**：用户明确批准后，模型调 `goal_gate_stamp({approvedBy, maxRounds?, timeBudgetMinutes?})`，或用户输入 `/goal-stamp`。盖章冻结契约；之后改契约 = 批准失效。
3. **派工**：优先原生 Agent Teams（`spawn_teammate` / `team_task_create`），没有 Teams 用任务板卡（`task_board_create`），否则单干。`goal_loop_at({dispatch:true})` 为 Team Lead 一键给每条 AC 建团队任务；`goal_gate_dispatch` 把当前失败项变成修复任务。写 scope 不相交，接口先冻结。
4. **Join + 门控**：`goal_gate_check({strategy?, note?})` 是唯一完成判定。NO-GO → 按 `failedActions` 修复再查；GO → `goal_gate_audit` → 交付。目标级假完成 2 次 → `BLOCKED`，只有人类 `/goal-reset` 能解。

## 工具面

| 工具 | 用途 | 关键返回 |
|---|---|---|
| `goal_loop_at` | 启动循环：契约骨架 + `loop.json` + 协议 + 任务 | `created`、`contractPath`、`maxRounds`、`tasks`、`protocol`、`preflight`、`dispatch` |
| `goal_gate_init` | 只生成骨架 | `created`、`path`、`alreadyExisted` |
| `goal_gate_stamp` | 冻结已批准契约与预算（R3） | `stamped`、`code`、`stamp`、`approvedBy`、`approvedAt`、`maxRounds`、`timeBudgetMinutes`、`restamped` |
| `goal_gate_check` | 重跑每条 check；唯一 GO 权威 | `rc`、`code`、`score`、`totals`、`results`、`round`/`maxRounds`、`bestScore`、`regression`、`trend`、`failedActions`、`neverFailed`、`preflight`、`efficiency`、`timeRemainingMinutes`、`digestBefore`/`digestAfter` |
| `goal_gate_status` | 只读状态：不跑 check、不烧轮 | 契约/盖章/批准、loop、计数器、摘要、最近评估、stale 标记、预算 |
| `goal_gate_audit` | 声明前只读审计：契约/盖章/摘要/最近 GO 一致性 | `ok`、`violations`、`warnings`、`recommendations` |
| `goal_gate_dispatch` | 给失败/坏掉的 AC 建原生 Agent Teams 修复任务（非 Lead 返回建议） | `gate`、`dispatched`、`failed`、`reason`、`suggestions` |

命令：`/goal-loop-at <objective>`、`/goal-gate`（状态）、`/goal-stamp [--restamp] [--max-rounds=N] [--time-budget-minutes=N] [approvedBy]`、`/goal-audit`、`/goal-reset [--new-loop] [reason]`。

运行时 skill：**`goal-loop`**（主 playbook）与 **`goal-loop-contract`**（契约 forge / 盖章清单）。通过 `ctx.skills.register` 注册进模型 skill 目录，无需文件系统安装。

## 契约文法

```
objective: <一句话目标>
deliverable: <交付物本体路径>
exit: goal-only | strict
AC-N | <yes/no 判定语句> | check: `<可失败命令>` | [probe: `<仪器检查>`] | [metric: `<正则，一个捕获组>`] | [baseline: delta|abs] | [timeout: <秒>] | [tolerance: <相对容差>] | [sd: `<正则>`] | [var: `<正则>`] | [calib: good=<文件> bad=<文件>] | expected: <规格>
```

规格：`exit=0` | `exit=N` | `<=N` | `>=N` | `<N` | `>N` | `=N` | `!=N` | `maximize` | `minimize` | `judged`。

- **一条 AC 一行，token 顺序固定。** 以 `AC-N` 开头却解析失败的行会让门控拒评整份契约（`state-error`）；行首 markdown 列表符 `- ` 兼容。重复 AC 编号拒评。
- **`probe:`** 对数值/优化类 AC 先跑且必须通过；对 `judged` 它就是判官（退出码 = 结论）。probe 失败是 `broken`，绝不当 passed。
- **`metric:`** 从 stdout 提取一个捕获组（先剥 ANSI）；不写则取最后一个数字。取不到必要指标 = `broken`。
- **`maximize` / `minimize`** 与上一次**被接受**的值比较；首轮建立水位并 PASS。`baseline: delta` 要求严格改善，`abs`（缺省）禁止回退。`tolerance:` 是相对噪声带；`sd:`/`var:` 把带扩大到 `max(2*spread/|prev|, tolerance)`（`var:` 开方）；声明了却匹配不到 = `broken`。
- **`judged`** 结论必须含 `artifact: <路径>` 与 `digest: sha256:<64hex>`（门控重算）；无绑定、过期、读不到都判 `broken`。声明 `calib: good=<f> bad=<f>` 时还须含 `calib-good: PASS` 与 `calib-bad: FAIL`，且两个夹具必须存在。
- **检查产生的证据**（渲染、日志、判官输入）放 `.goal-gate/evidence/`——该目录不进摘要。检查写了工作区其它位置 → 本轮判 `check-mutated-tree`。
- **`deliverable:`** 门控不强制，但驱动预检：没有任何 check 碰交付物、也没有运行时 AC，会在烧轮前亮 `deliverable-unverified` / `no-runtime-ac`。

## 门控语义

`goal_gate_check` 返回 `rc=0` GO、`rc=2` NO-GO、`rc=3` BLOCKED、`rc=4` 状态错；每轮追加进 `.goal-gate/history.jsonl`。

| 状态 | 含义 | 对 GO 的影响 |
|---|---|---|
| `passed` | check 满足指名规格 | 计入 `score` |
| `failed` | check 跑了，产物不满足规格 | NO-GO |
| `broken` | **仪器**坏了：127/超时/信号、probe 失败、指标或离散度取不到、判官缺失、证据失联/过期、calib 坏、规格无法路由 | **决定性 NO-GO** |
| `unverifiable` | 确实暂时不可测（软状态） | 只允许 ≤1/3，并作为 `note` 报出 |

其它输出：`score`（passed/总数）、`bestScore`（水位）、`regression`（分数回退）、`trend`（近 5 轮）、`efficiency`（`scoreDelta`/`slope`/按 `strategy` 归因）、`digestBefore`/`digestAfter`（检查动了树 → `check-mutated-tree`）、`timeRemainingMinutes`、`timeExhausted`。

## 批准、预算与阻塞

- **R3 盖章**：`goal_gate_stamp({approvedBy, maxRounds?, timeBudgetMinutes?, restamp?, note?})` 把批准写进 `state.json`，可绑定预算。契约编辑会改变摘要；完成声明以 `contract-revised` 被拒，直到 `restamp:true`（或 `/goal-stamp`）。
- **`requireStamp: true`**：未盖章禁止完成声明（默认 `false`；盖章仍是 `/goal-loop-at` 协议推荐动作）。
- **`requireHumanApproval: true`**：`goal_gate_stamp` 本身走 DSH approval seam（`tools/pre-execute` 返回 `{kind:'ask'}`）；`never` 策略下自动 fail-closed。默认 `false`，headless 循环可用。
- **轮次预算**（`maxRounds`，默认 8）与**墙钟预算**（`timeBudgetMinutes`）是保险丝：非 GO 的完成声明到点被拒（`rounds-exhausted` / `time-budget`）。墙钟到点**不没收已经 GO 的交付**。
- **假完成棘轮**：`update_goal(complete)` 被拒 = 产物没完成，去修，不要重复声明。两次假完成 → `BLOCKED`，一切声明冻结。`/goal-reset [--new-loop]` 是人类唯一恢复入口（故意没有模型可调用的 reset 工具）。
- **循环身份**：第二次 `goal_loop_at` 目标不同会拒（`objective-drift`）——改目标 = 改 done 的定义，必须编辑 + 重新批准，或换工作区/新循环。

## 完成声明拦截

挂在 `tools/pre-execute`，永远返回结构化 `{kind:'deny'}`（绝不 `throw`）：

- `update_goal(action:'complete')`：永远按全量契约硬拦 + R1 计数。
- 任务级完成：`agent_teams_update_task(status:'completed')`、`team_task_update(action:'complete')`、旧名 `update_task`，以及 **`task_board_manage(action:'move-done')`**。`exit: strict` 下与目标级一样硬拦；`exit: goal-only` 下只记账（`partialCompletes`）放行，多任务团队循环不会因队友 AC 未过而死锁。`BLOCKED` 冻结一切。
- 跑门控前先校验批准新鲜度（`contract-revised`）与可选 `requireStamp`（`unstamped`）。契约畸形 → `state-error` 拦；没有契约 → 放行（不堵死未启用门控的会话）。

## 派工

- `goal_loop_at({dispatch:true})` 在调用者是 Team Lead 时给每条 AC 建一个原生 Agent Teams 任务（`ctx.agentTeams`）；其它调用者得到 `suggestions`，不会伪造成功。
- `goal_gate_dispatch({includeUnverifiable?})` **不记轮次**地重跑检查，为 `failed`/`broken`（可选 `unverifiable`）AC 建任务；任务描述带确切命令与规格。
- 没有 Teams 服务时用 `task_board_create` 或单干。插件绝不自写任务板账本。

## 只读状态与审计

- `goal_gate_status({includeHistory?})` / `/goal-gate`：契约/盖章/批准、loop、计数器、当前摘要与已绑定摘要、轮次/墙钟预算、idle 状态、最近历史。**不跑 check、不烧轮**。
- `goal_gate_audit({})` / `/goal-audit`：契约可解析、盖章匹配、非 BLOCKED、最近一次评估在当前契约下是 GO、摘要未过期、preflight/never-failed 告警、预算状态。声明完成前 `violations` 必须为空。
- 想要当前真相？那是 `goal_gate_check`——一次实验，要花一轮。同状态重评会被点名 `duplicate-evaluation`。

## bash 兜底

恢复会话可能没有插件工具表。同一本账、同一个门控可从任何 shell 驱动（node 用绝对路径，**绝不裸写 `node`**）：

```sh
<abs-node> <plugin>/bin/gate.mjs check   --cwd <工作区> [--strategy <s>] [--note <n>]
<abs-node> <plugin>/bin/gate.mjs status  --cwd <工作区>
<abs-node> <plugin>/bin/gate.mjs audit   --cwd <工作区>
<abs-node> <plugin>/bin/gate.mjs stamp   --cwd <工作区> [--approved-by <who>] [--max-rounds <n>] [--time-budget-minutes <n>] [--restamp]
<abs-node> <plugin>/bin/gate.mjs reset   --cwd <工作区> [--new-loop]
<abs-node> <plugin>/bin/gate.mjs preflight --cwd <工作区>
```

## DSH 宿主契约（0.2.1-rc.2 实测）

- 每个工具都必须声明 `output.render`；`defineTool` 会安装包装器并在成功返回时调用。只声明 schema 的 0.6.x 会"注册成功但每次成功调用都失败"：`output.render failed: userRender is not a function`。
- 输出 schema 必须落在受支持子集：不能有 author-only `type:'json'`、不能有属性级 `required: true`、每个 `object` 必须显式 `additionalProperties`。本插件用共享常量表达可空对象。
- `ctx.inject(['commands'], (c) => …)` 拿到的是子 **Context**；要通过 `c.commands.register(...)` 注册；无参数命令直接省略 `input`（空 hint 会被拒绝）。
- Skill 用 `ctx.skills.register({name, description, content, source, …})` 内存注册；DSH 不扫描包的 `skills/` 目录。
- 工作区根来自 `exec.agent.session.header.cwd`；没有 `exec.session` / `exec.cwd`。
- 原生 Agent Teams 服务是 `ctx.get('agentTeams')`（可选，不能 `inject`）；任务是 `team_task_*` 工具，不是 `agent_teams_*`。

实测证据与探针方法见 `docs/platform-contract.md`。

## 与 goal-loop 的对应

| goal-loop | 本插件 |
|---|---|
| AC 契约文法 + `approved:` 盖章 | `parseContract` + `goal_gate_stamp` / `/goal-stamp`（R3） |
| `goal_gate.sh --check` 重跑、PASS/FAIL/BROKEN | `runGate` 失败分类 + `probe` + 期望规格 |
| digest 绑定 verdict（R7） | 内容哈希 `treeDigest` + `check-mutated-tree` + 声明绑定摘要 |
| R1 假完成计数 → BLOCKED | `falseCompleteRule` + `/goal-reset`（人类） |
| 目标水位 / `sd:`/`var:` | `maximize`/`minimize` 基线 + tolerance/spread 噪声带 + `efficiency` |
| judged 判读席 + `calib:` | `artifact`+sha256 绑定 + `calib-good`/`calib-bad` 评级 |
| `/goal-loop-at` 触发 + 循环预算 | `goal_loop_at` / `/goal-loop-at` + `loop.json` + 轮次/墙钟保险丝 |
| `goal_audit.sh` 账本审计 | `goal_gate_audit` / `/goal-audit` |
| crew/work-plan/roster/inbox/Teams 后端 | **丢弃**——原生 Agent Teams + 任务板 + `goal_gate_dispatch` |
| contract-forge companion | 运行时 skill `goal-loop-contract` |

## 测试

```sh
<abs-node> test/run-local.mjs
```

真实 `@deepseek-ai/dsh-tools` 在 Host 内、Host 外不可 import；入口回退到会编译参数 schema 的 shim。测试**绝不**把 `node_modules/@deepseek-ai/dsh-tools` shim 写进包目录：`link:` 安装时它会赢得模块解析，Host 注册到未编译的参数 schema（provider 报 `type: null`）。套件覆盖判定内核、接线（全部工具/命令/skill、provider 可见参数 schema）、账本/审计/盖章、红队防线、纯度、无 commands 服务的装载安全，以及 v0.7 面（保险丝、任务板声明、派工、效率、reset）。真实宿主注册契约已对 0.2.1-rc.2 解包产物验证；见 `docs/platform-contract.md`。

## 许可

MIT
