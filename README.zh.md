# dsh-goalloop-agentteams（中文）

**把 goal-loop 做成 DeepSeek Harness 插件**——把 [goal-loop](https://github.com/samirliu/goal-loop) skill 的**判命面**接进原生 **Agent Teams**、**任务板**与 DSH 的完成声明拦截管线；skill 本身作为两个运行时 skill（`goal-loop`、`goal-loop-contract`）随插件注册，模型知道协议，插件让协议**可执行**。

契约先行；门控**自己重跑每条 check**（零模型信任）；人类盖章冻结"done 的定义"；verdict 绑定内容摘要；假完成在 `update_goal` / 团队任务 / 任务板三个完成面被 `tools/pre-execute` 硬拦。goal-loop 的便携 team 文件协议与双账本**故意不移植**——原生 Agent Teams 更强。

**v0.9.1 — Agent Teams 编排：编队、收集、评审**（相对 0.6.2）：

- **BROKEN 是决定性的**：仪器缺失（rc 127）、probe 失败、取数失败、`sd:`/`var:` 匹配不到、judged 证据失联/过期、判官缺失、calib 缺陷一律 `broken` → NO-GO；不再能藏在"≤1/3 unverifiable"的放行带里。
- **R3 批准盖章**：`goal_gate_stamp` / `/goal-stamp` 冻结契约与预算；之后任何契约编辑都会让完成声明以 `contract-revised` 被拒，直到显式重盖章。
- **内容绑定摘要**：同尺寸改动也会改变摘要；检查期间改工作区判 `check-mutated-tree`；`dist/build/out` 不再被静默排除。
- **目标面**：`minimize`、`!=`、数据驱动的 `sd:`/`var:` 噪声带、首轮建立水位、逐轮 `efficiency` 与策略归因。
- **预算是保险丝**：轮次/墙钟预算在盖章时绑定，非 GO 的完成声明到点即拒；`/goal-reset --new-loop` 是人类恢复入口。
- **DSH 原生**：拦截 `task_board_manage` 的 `move-done`；`dispatch:true` 与 `goal_gate_dispatch` 为 Team Lead 创建真实的原生 Agent Teams 任务；只读 `goal_gate_status` / `goal_gate_audit`。
- **复杂用例修复（v0.9.1）**：完成声明轮 `delta` 不再要求二次改善；grill 不再误报按序同 scope / 已绑定证据的 judged；CLI 也走账本锁；`examples/plugin-e2e` 全部覆盖。
- **宿主契约修复（v0.7.1）**：工具参数始终编译成 object 根的 provider schema；测试用的 `dsh-tools` shim 绝不再留进 link 安装的包目录（它曾导致启动即报 `schema must be a JSON Schema of 'type: "object"', got 'type: null'`）。
- **团队编队（v0.9）**：`goal_gate_staff` 把 AC（或依赖波）变成队友规格，默认只预览；`spawn:true` 才真正创建原生队友、建/派任务并发送 AC 简报。`goal_gate_collect` 把任务状态映射回 AC（`readyToCheck` 决定何时跑门控）；`goal_gate_judge` 为 judged AC 建冷席评审任务（要求 digest/calib 证据）。
- **Agent Teams 原生派工（v0.8）**：AC 可声明 `scope:`/`depends:`；派工按依赖分波，设置 `blockedBy`/`writeScopes`，复用未完成的同 stamp 任务而不是重复建卡，并可指定 owner。`goal_gate_status`/`goal_gate_check` 返回团队快照与 `nextActions`；账本锁把并发成员的判定/记账串行化。
- **Grilling 评估设计（v0.8）**：`goal-loop-grill` skill + `goal_gate_grill` 工具对抗式审查契约（永真式、不可判、Goodhart 代理、缺运行时证据、judged 未绑定、缺噪声带、scope 重叠）；`goal_gate_baseline` 在盖章前量出 optimize AC 的均值/离散度。
- **打包 skill + 命令**：三个 skill 出现在会话 skill 目录；`/goal-loop-at`、`/goal-gate`、`/goal-stamp`、`/goal-audit`、`/goal-reset` 注册。

设计要点（right agentic loop / right eval / right metric 与 Agent Teams 的对应）见 [docs/agent-teams-loop.md](docs/agent-teams-loop.md)。

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

⚠️ **别装 0.6.x**：v0.6.x 早于 DSH 0.2.1-rc.2 的工具注册契约（只声明 schema、没有 `render`），装上后每个**成功**的工具调用都会失败，而 `--dump-config` 看不出区别。从 checkout 或 ≥ v0.7.0 的版本安装。

⚠️ **入口契约**：入口必须导出 `name`（等于 `cordis.patch.yml` 的 id `goal-gate`）以及 `inject`、`apply`；缺 `name` 会被 Host 静默跳过。`link:` 安装时 `@deepseek-ai/dsh-tools` 的解析可能与注册表安装不同，入口先试裸包名再用同形 shim 兜底，两条路径都有测试覆盖。

## 平台支持

门控要自己重跑每条 AC 的 `check`，所以**解释器由门控自己决定**，并且显式写在结论里，不做静默平台假设：

| 平台 | 默认解释器 | 覆盖方式 |
|---|---|---|
| Linux / macOS | `/bin/sh -c` | `config.shell` / `GOAL_GATE_SHELL` |
| Windows | `%COMSPEC%` → `cmd.exe /d /s /c` | `config.shell` / `GOAL_GATE_SHELL`，填 `sh.exe` / `bash.exe` / `pwsh.exe` / `cmd.exe` 的绝对路径 |

- 每轮结论里的 `shell` 字段说明"这条 check 是被谁执行的"（`goal_gate_check`、`goal_gate_status`、`bin/gate.mjs check` 都会带）。
- 解释器不存在时判 `broken` 并直接点名 *"gate shell not found …"*（配置问题，不是产物不合格）——不会再退化成一串哑巴 `failed`。
- Windows 上用 `cmd.exe` 跑 POSIX 写法（`test`、`grep`、`&&`、`$VAR`）时，`preflight` 会报 `posix-syntax-on-cmd`，在烧轮次之前提醒你。
- Windows 上要么把 check 写成 cmd/pwsh 语法，要么把门控指到 POSIX shell：

```yaml
- id: goal-gate
  name: dsh-goalloop-agentteams
  config:
    shell: 'C:\Program Files\Git\usr\bin\sh.exe'
```

优先级：`bin/gate.mjs --shell` / 插件 `config.shell` > 环境变量 `GOAL_GATE_SHELL` > 平台默认。

## 插件配置

`cordis.patch.yml` 以 `config: {}` 挂载；可加以下键：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxRounds` | `8` | 新循环默认轮次预算 |
| `requireStamp` | `false` | 未盖章时拒绝完成声明 |
| `requireHumanApproval` | `false` | `goal_gate_stamp` 走 DSH approval seam（`ask`） |
| `intercept` | `true` | 挂载 `tools/pre-execute` 完成声明拦截 |
| `registerSkills` | `true` | 注册 `goal-loop` / `goal-loop-contract` 运行时 skill |
| `shell` | 平台默认 | 执行 AC `check`/`probe` 的解释器（见「平台支持」） |

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
| `goal_gate_dispatch` | 给失败/坏掉的 AC 建原生修复任务：依赖→`blockedBy`、scope→`writeScopes`、幂等、可指定 owner | `gate`、`dispatched`、`failed`、`skippedExisting`、`reason`、`suggestions` |
| `goal_gate_grill` | 盖章前只读对抗审查 eval/metric | `ok`、`verdict`、`findings`、`questions`、`metricDesign`、`goodhart` |
| `goal_gate_baseline` | 测量 optimize AC 基线/离散度（不烧轮） | `samples`、`acs`、`recorded`、`notes` |
| `goal_gate_staff` | 编队：按 AC/波生成队友规格；预览或真实 spawn + 派任务 | `mode`、`members`、`failed`、`tasks`、`notes` |
| `goal_gate_collect` | 把团队任务状态映射回 AC；`readyToCheck` 决定是否跑门控 | `available`、`readyToCheck`、`byAc`、`completed`、`inProgress`、`pending`、`missing` |
| `goal_gate_judge` | 为 judged AC 建冷席评审任务（fresh reviewer、digest/calib 简报） | `kind`、`dispatched`、`failed`、`skippedExisting`、`reason`、`suggestions` |
| `goal_gate_doctor` | 自检工具/参数 schema/命令/skill/Teams/契约 | `ok`、`version`、`tools`、`commands`、`skills`、`agentTeams`、`contract`、`notes` |

命令：`/goal-loop-at <objective>`、`/goal-gate`（状态）、`/goal-stamp [--restamp] [--max-rounds=N] [--time-budget-minutes=N] [approvedBy]`、`/goal-audit`、`/goal-grill`、`/goal-baseline [samples]`、`/goal-collect`、`/goal-judge [reviewer]`、`/goal-doctor`、`/goal-reset [--new-loop] [reason]`。

运行时 skill：**`goal-loop`**（主 playbook）、**`goal-loop-contract`**（契约 forge / 盖章清单）与 **`goal-loop-grill`**（对抗式 eval/metric 设计）。通过 `ctx.skills.register` 注册进模型 skill 目录，无需文件系统安装。

## 契约文法

```
objective: <一句话目标>
deliverable: <交付物本体路径>
exit: goal-only | strict
AC-N | <yes/no 判定语句> | check: `<可失败命令>` | [probe: `<仪器检查>`] | [metric: `<正则，一个捕获组>`] | [baseline: delta|abs] | [timeout: <秒>] | [tolerance: <相对容差>] | [sd: `<正则>`] | [var: `<正则>`] | [calib: good=<文件> bad=<文件>] | [scope: <路径[,路径...]>] | [depends: AC-x[,AC-y]] | expected: <规格>
```

规格：`exit=0` | `exit=N` | `<=N` | `>=N` | `<N` | `>N` | `=N` | `!=N` | `maximize` | `minimize` | `judged`。

- **一条 AC 一行，token 顺序固定。** 以 `AC-N` 开头却解析失败的行会让门控拒评整份契约（`state-error`）；行首 markdown 列表符 `- ` 兼容。重复 AC 编号、未知依赖、依赖环都拒评。
- **`scope:`** 是团队派工用的工作区写范围（`writeScopes`）；**`depends:`** 建依赖图（`blockedBy`、`plan.waves`）。
- **`probe:`** 对数值/优化类 AC 先跑且必须通过；对 `judged` 它就是判官（退出码 = 结论）。probe 失败是 `broken`，绝不当 passed。
- **`metric:`** 从 stdout 提取一个捕获组（先剥 ANSI）；不写则取最后一个数字。取不到必要指标 = `broken`。
- **`maximize` / `minimize`** 与上一次**被接受**的值比较；首轮建立水位并 PASS。普通轮 `baseline: delta` 要求严格改善，`abs`（缺省）禁止回退；**完成声明时** `delta` 退化为不回退——上一次 GO 已接受当前水位，重复测量不需要再涨一次（真实恶化仍失败）。`tolerance:` 是相对噪声带；`sd:`/`var:` 把带扩大到 `max(2*spread/|prev|, tolerance)`（`var:` 开方）；声明了却匹配不到 = `broken`。
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

## Agent Teams 闭环

插件按需探测原生团队服务（`ctx.get('agentTeams')`），不强制依赖，也绝不自写任务板账本。

| 关注点 | 行为 |
|---|---|
| 计划 | `goal_loop_at` 返回 `plan.waves`（按 `depends:` 拓扑分层）与带 `scope:`/`depends:` 的任务简报 |
| 派工 | `goal_loop_at({dispatch:true})` / `goal_gate_dispatch` 按依赖顺序建任务，`blockedBy` 指向已建 task id，`writeScopes` 来自 `scope:` |
| 幂等 | 同 AC + 同契约 stamp + pending/in-progress 任务 = 复用（`skippedExisting`），重查不会重复建卡 |
| 归属 | `goal_gate_dispatch({assign: {"AC-2": "engineer"}})` 把新建任务改派给成员 |
| 可见性 | `goal_gate_status` / `goal_gate_check` 返回 `team`（成员、任务→AC 映射、ready/未分配计数）与 `nextActions`（`dispatch-repairs`、`collect-team`、`assign-ready-tasks`、`stop-budget`…） |
| 并发 | `goal_gate_check`/`stamp`/`dispatch`/完成声明拦截都会拿账本锁；并发调用得到 `[goal-gate:busy]`，不会互相覆盖轮次/基线 |
| 编队 | `goal_gate_staff` 预览队友→AC/波分配；`spawn:true` 真正创建队友、派任务并发简报 |
| 收集 | `goal_gate_collect` 把任务板状态映射回 AC；`readyToCheck=true` 表示团队认为该波完成，Lead 应跑门控 |
| 评审 | `goal_gate_judge` 为 judged AC 建冷席评审任务；简报要求 `artifact:`、`digest:`、`calib-good/bad`、`score:` |
| 非 Lead | 返回 `suggestions`（subject/description/scope/depends）而不是伪造成功；协议回退到 `subagent`/`subagent_fork` 或 `task_board_create` |

## 用 grilling 设计评估

`goal_gate_grill` 是对契约的只读攻击（来自 goal-loop 的 grilling/contract-forge 纪律）：返回 `findings[severity, ac, issue, suggestion]`、还需要人回答的 `questions`、每个 optimize AC 的 `metricDesign` 建议，以及 `goodhart` 刷分路径。`verdict: ready` 要求没有 high/medium findings。`goal-loop-grill` skill 教模型跑 interview frontier：什么叫完成、便宜改动能不能刷分、哪个 known-bad 证明拒绝、基线与离散度量过没有、判官必须绑定什么证据。修完 → 重 grill → `goal_gate_baseline` → 盖章。

## 只读状态与审计

- `goal_gate_status({includeHistory?})` / `/goal-gate`：契约/盖章/批准、loop、计数器、当前摘要与已绑定摘要、轮次/墙钟预算、idle 状态、最近历史。**不跑 check、不烧轮**。
- `goal_gate_audit({})` / `/goal-audit`：契约可解析、盖章匹配、非 BLOCKED、最近一次评估在当前契约下是 GO、摘要未过期、preflight/never-failed 告警、预算状态。声明完成前 `violations` 必须为空。
- `goal_gate_doctor` / `/goal-doctor` 是部署自检：注册工具、provider 可见的 object 参数 schema、命令、运行时 skill、Agent Teams 成员关系、契约可读性。profile 看起来坏了，先跑它。
- 想要当前真相？那是 `goal_gate_check`——一次实验，要花一轮。同状态重评会被点名 `duplicate-evaluation`。

## bash 兜底

恢复会话可能没有插件工具表。同一本账、同一个门控可从任何 shell 驱动（node 用绝对路径，**绝不裸写 `node`**）：

```sh
<abs-node> <plugin>/bin/gate.mjs check   --cwd <工作区> [--strategy <s>] [--note <n>] [--shell <shell>]
<abs-node> <plugin>/bin/gate.mjs status  --cwd <工作区>
<abs-node> <plugin>/bin/gate.mjs audit   --cwd <工作区>
<abs-node> <plugin>/bin/gate.mjs stamp   --cwd <工作区> [--approved-by <who>] [--max-rounds <n>] [--time-budget-minutes <n>] [--restamp]
<abs-node> <plugin>/bin/gate.mjs reset   --cwd <工作区> [--new-loop]
<abs-node> <plugin>/bin/gate.mjs preflight --cwd <工作区> [--shell <shell>]
```

## DSH 宿主契约（0.2.1-rc.2 实测）

- 每个工具都必须声明 `output.render`；`defineTool` 会安装包装器并在成功返回时调用。只声明 schema 的 0.6.x 会"注册成功但每次成功调用都失败"：`output.render failed: userRender is not a function`。
- 输出 schema 必须落在受支持子集：不能有 author-only `type:'json'`、不能有属性级 `required: true`、每个 `object` 必须显式 `additionalProperties`。本插件用共享常量表达可空对象。
- `ctx.inject(['commands'], (c) => …)` 拿到的是子 **Context**；要通过 `c.commands.register(...)` 注册；无参数命令直接省略 `input`（空 hint 会被拒绝）。
- Skill 用 `ctx.skills.register({name, description, content, source, …})` 内存注册；DSH 不扫描包的 `skills/` 目录。
- 工作区根来自 `exec.agent.session.header.cwd`；没有 `exec.session` / `exec.cwd`。
- 原生 Agent Teams 服务是 `ctx.get('agentTeams')`（可选，不能 `inject`）；任务是 `team_task_*` 工具，不是 `agent_teams_*`。
- 门控自己开子进程跑 check：POSIX 用 `/bin/sh -c`，Windows 用 `%COMSPEC%`（见「平台支持」）。`app.asar` 里的模块回退用 `pathToFileURL` 加载——ESM 在 Windows 上不接受裸 `C:\…` 路径（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
- 0.2.1-rc.2 的 Agent 上**没有** `agent.followup(...)`；`/goal-loop-at` 因此把协议放在命令结果里返回，而不是注入对话。

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
| grilling + contract-forge | 运行时 skill `goal-loop-grill` + `goal_gate_grill`；`goal_gate_baseline` 量噪声底 |
| contract-forge companion | 运行时 skill `goal-loop-contract` |

## 复杂集成用例

[examples/plugin-e2e/run.mjs](examples/plugin-e2e/README.md) 用真实插件代码与真实 CLI 跑五个端到端 case：多波 CSV→JSONL 交付（scope/depends、staffing、collect、judged 证据）、弱契约 grill 修复、预算/契约变更/BLOCKED/reset、并发 CLI 检查、judged digest 绑定。Agent Teams 用 API 一致的 fake service，不耗模型额度；真实团队注册由 `goal_gate_doctor` 单独验证。

```sh
<abs-node> examples/plugin-e2e/run.mjs
```

## 测试

```sh
<abs-node> test/run-local.mjs
```

套件本身平台中立：Windows（`cmd.exe` 门控）与 POSIX（`/bin/sh`）都能跑；换 `GOAL_GATE_SHELL` 就能用同一批文件验证"Windows 上的 POSIX shell"（Git Bash / WSL）：

```sh
$env:GOAL_GATE_SHELL='C:\Program Files\Git\usr\bin\sh.exe'; <abs-node> test/run-local.mjs
```

真实 `@deepseek-ai/dsh-tools` 在 Host 内、Host 外不可 import；入口回退到会编译参数 schema 的 shim。测试**绝不**把 `node_modules/@deepseek-ai/dsh-tools` shim 写进包目录：`link:` 安装时它会赢得模块解析，Host 注册到未编译的参数 schema（provider 报 `type: null`）。套件覆盖判定内核、接线（全部工具/命令/skill、provider 可见参数 schema）、账本/审计/盖章、红队防线、纯度、无 commands 服务的装载安全，v0.7 面（保险丝、任务板声明、派工、效率、reset），v0.8 面（scope/depends 分波、幂等/阻塞派工、团队快照/nextActions、grilling、基线/离散度、账本锁），以及 v0.9 面（编队预览/spawn、收集团队完成度、评审任务、锁等待、horizon 防线）。真实宿主注册契约已对 0.2.1-rc.2 解包产物验证；见 `docs/platform-contract.md`。

## 许可

MIT
