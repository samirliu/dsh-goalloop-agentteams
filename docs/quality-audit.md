# 质量审计：以「harness / graph / loops」三篇精读原则为标尺

本文件是 `dsh-goalloop-agentteams` 的自评分卡与改进路线。评分维度直接取自
`agent-harness-四篇精读.md` 中可机器核对的原则，不用"感觉好不好"打分。

目标线：**9.0 / 10**。每轮改动必须让至少一个维度的分数上升，且不拉低任何维度
（对应精读 Art1 §18：度量单位是「被接受的工作」，不是活动量）。

## 评分维度（等权，共 10 项）

| # | 维度 | 对应原则 | 9 分的判据（可核对） |
|---|---|---|---|
| 1 | 可证伪性 | Art3 §1「a loop is a check that can fail」；Art2 §7「gates rot」 | 每条决定性 AC 都能证明"坏产物会让它红"，且这个证明由门控执行而非口头保证 |
| 2 | maker≠checker | Art1 §8「verification is an attempted disproof」 | 评审面与被评面不同上下文；评审者有权拒绝且不负责修复 |
| 3 | 证据绑定 | Art1 §7/§13「完成需要可证的回执」 | 结论绑定 artifact + digest；摘要过期即作废；改树即判无效 |
| 4 | 持久状态 | Art1 §6/Art2 §6「state 文件」 | 基线与水位落盘、原子写、可续跑、断点可审计 |
| 5 | 确定性优先 | Art1 §7「use code for plumbing」；Art3 §4「code node」 | 判定、合并、计分零模型参与 |
| 6 | 失败分类与恢复 | Art1 §10「recovery targets failure class」 | 仪器坏 ≠ 产物坏；有界重试；有升级与人工恢复路径 |
| 7 | 策略与授权 | Art1 §9「model proposes, policy authorizes」 | 盖章冻结、契约变更即失效、完成声明被策略拦截 |
| 8 | 爆炸半径分级 | Art3 §8「gate on blast radius, not confidence」 | 按不可逆性分车道，最危险的车道不因分数高而放行 |
| 9 | 学习边 | Art3 §6「learning edge」；Art1 §14「failure upgrades the harness」 | 复发失败自动升格为持久约束，并进入下一次契约/预检 |
| 10 | 度量与腐朽审计 | Art1 §15/§18「harness decays」「measure accepted work」 | 能指出哪些组件已无 lift、哪些 AC 可能永真 |

## v0.9.1 基线评分

| # | 维度 | 分数 | 依据 |
|---|---|---|---|
| 1 | 可证伪性 | **6** | judged 有 `calib:` 夹具、普通行有 `probe:`（仪器可用性）；但**确定性 AC 没有任何"反向对照"**——check 写成永真式或恒过断言时，门控照样 GO。grill 只能警告 `tautology-suspect`，无法验证 |
| 2 | maker≠checker | 9 | `goal_gate_judge` 冷席评审、fresh reviewer 简报、评审者只判不修 |
| 3 | 证据绑定 | 9 | `artifact:` + `digest:` 强制绑定、内容哈希（2MB 内）、`check-mutated-tree` 拒评 |
| 4 | 持久状态 | 9 | state 原子写、baselines/spreads、history.jsonl、loop-idle 检测、lastRunAt |
| 5 | 确定性优先 | 9 | runGate 全量重跑命令，零模型；score/merge 均为代码 |
| 6 | 失败分类 | 9 | broken / unverifiable / failed / state-error 四分；127/124/信号映射；预算保险丝 + 人类 reset |
| 7 | 策略与授权 | 9 | R3 盖章、contract-revised、完成声明拦截（目标级 + 任务级分级）、预算拦截 |
| 8 | 爆炸半径分级 | **4** | 契约文法无 `risk:`；一次文案改动与一次删库迁移走同一扇门，只按分数放行——正是 Art3 §8 点名的错误变量 |
| 9 | 学习边 | **5** | 缺陷总账是人写的；插件自身没有"同一失败复发 → 升格为约束 → 注入下一次契约"的自动通路 |
| 10 | 度量与腐朽审计 | **6** | 有 ms/rounds/falseCompletes；没有"这条 AC 是否可能永真""这个组件是否还有 lift"的度量 |

**基线合计：7.5 / 10**

## R1 落地后（v0.10.0）

| # | 维度 | 分数 | 变化依据 |
|---|---|---|---|
| 1 | 可证伪性 | 6 → **9** | `neg:` 反向对照由门控执行；`neg` 退出 0 = 永真式 → `broken`；`GG_NEG=1` 支持同命令切夹具；预检/grill 要求决定性 AC 给凭证，`vacuity-waived:` 显式豁免。回归：`test/v10_test.mjs` 8 组断言 |
| 10 | 度量与腐朽审计 | 6 → **7** | 每个 AC 现在带 `negExit`，可看出"这条 AC 是否被真正证伪过"；主动的腐朽审计（恒绿 AC 统计）仍未做 |
| — | 顺带修复 | — | 解析器改为顺序无关（缺陷 #46）与未知字段拒评（#47）——dogfooding 时发现"强契约"里有一条 AC 从未被评估过 |

**合计：7.9 / 10**

## R2 落地后（v0.11.0）

| # | 维度 | 分数 | 变化依据 |
|---|---|---|---|
| 8 | 爆炸半径分级 | 4 → **9** | `risk: low|wide|hard`；车道进 gate 输出与账本；wide/hard 要求**每条** AC 有可证伪证据；`hard` 车道不开门——全绿也拦完成声明，需人类按 `stamp+digest` 批准（`goal_gate_approve` / `/goal-approve` / CLI），产物一改即失效。回归：`test/v11_test.mjs` 6 组 |
| 10 | 度量与腐朽审计 | 7 → **9** | 每个 AC 带 `ms`、history 记 `slowestAc/slowestMs`、audit 报 `dominant-ac-cost`；恒绿 AC 拆成 `possibly-tautological`（无 neg:）与 `green-but-falsifiable`（有 neg:），噪音不再淹没信号；`hard-lane-unapproved` 提前亮牌 |
| — | 顺带发现 | — | 缺陷 #50：`unverifiable` 在正常路径已不可达 → "≤1/3 允许 GO" 是死代码；本轮不依赖它，改为可达的车道加严，并记账待处置 |

**合计：8.6 / 10**（下轮目标 9.0：学习边——复发失败升格为持久约束）

## 改进路线（按杠杆排序）

### R1（本轮）— 可证伪性：`neg:` 反向对照

- 契约文法新增 `neg: \`<命令>\``：**必须失败（非零退出）**。它把同一条断言打到
  故意做坏的输入上，用来证明这条 check 真的会红。
- 门控执行顺序 `probe → neg → check`；`neg` 退出 0 = 永真式检查 → **broken**
  （决定性 NO-GO，不参与 unverifiable 稀释）。
- `GG_NEG=1` 注入环境，鼓励"同一命令 + 一个开关切到坏夹具"的写法，避免复制断言。
- 预检与 grill 同步：决定性 AC 未声明 `neg:` → 提示"可证伪性未证明"，
  可用 `vacuity-waived: <理由>` 显式豁免（与 `horizon-waived:` 同款纪律）。
- 预期：维度 1 由 6 → 9。

### R2 — 爆炸半径车道（维度 8）

- 文法新增 `risk: low|wide|hard`；`hard` 车道**不开门**：即使全绿也不得
  由模型侧完成声明放行，必须有人类批准记录（绑定当前 digest）才 GO。

### R3 — 学习边 + 腐朽审计（维度 9、10）

- `lessons.jsonl`：同一 AC + 同一 BROKEN 成因复发 ≥2 次 → 自动升格为约束条目，
  并由预检/grill 强制显式处理（记为已修 / 显式豁免），否则每次盖章都亮牌。
- 腐朽审计：连续 N 轮恒绿的 AC 若无可证伪证据 → 列为"可能永真"，
  与 R1 的 `neg:` 互为印证。

## 评分纪律

- 每轮结束重跑全部测试（`node test/run-local.mjs` + `examples/plugin-e2e`），
  红则不认分数。
- 分数只在有回归测试覆盖的情况下上调：一个维度 +1 必须对应至少一条断言。
- 参照 Art1 §15：新增机制同时要能回答"它挡的是哪类失败、删掉会怎样"，
  否则按 harness 腐化计入负面。
