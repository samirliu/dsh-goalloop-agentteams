---
name: goal-gate
description: >
  DSH 插件：契约先行 + 确定性门控 + digest 绑定 verdict 的目标闭环。
  一条命令触发完整 agentic loop：/goal-loop-at {objective}（或 goal_loop_at 工具）
  写契约 + 轮次配置，返回循环协议与建议的 Agent Teams 任务；门控零模型重跑每条
  AC，指标分数驱动自主优化（不回退），假完成计数兜底。
  适用场景：任何"多阶段、多成员、必须机器判定完成"的目标型任务（研究包、
  代码交付、文档产出），尤其是不能让模型自我宣布完成的场合。

  【三要点】right agentic loop = /goal-loop-at 触发的轮次循环（派工→修复→重验，
  轮次封顶）；right eval = 确定性门控（重跑式、probe 验证器、Goodhart 防线）；
  right metric = score/轮次历史/趋势/不回退规则（.goal-gate/history.jsonl）。

  【判命面 vs 执行面】执行面直接用原生 Agent Teams 与任务板（agent_teams_create /
  claim / write_scopes）；判命面用本插件，与 quality-kind 不重复——quality-kind
  管"步骤有没有做完"，本插件管"整个目标算不算真正达成"，两者叠加才是完整链条。

  【验证金字塔(证据保真,血的教训)】数据检查 → 产物检查 → 运行时检查(在真实运行
  环境执行交付物本体)→ 对交付物本体的评审。只验数据/衍生品 = 交付物可能是坏的
  (实测:数据全对、页面全黑,门控却给 GO)。契约必须声明 deliverable: <本体路径>,
  至少一条 AC 在运行时执行它;judged 评审必须针对交付物本体,结论带
  artifact: + digest: sha256: 两行,交付物变了而评审没跟 → 门控判 unverifiable 作废。
  【契约文法】目标写成可失败的具名检查：
    objective: <一句话目标>
    deliverable: <交付物本体路径>
    [exit: goal-only | strict]（完成声明治理策略，见下）
    AC-N | <yes/no 判定语句> | check: `<命令>` | [probe: `<探针>`] |
           [metric: `<指标正则，带一个捕获组>`] | [baseline: delta|abs] | expected: <规格>
    规格 = exit=0 | <op><数字>（<=5 >0 =3 …）| maximize | judged
  每条 check 必须真的能失败（环境依赖、空值、错误路径都写进检查里），否则退化成
  永真式。metric 不写则回退"取输出最后一个数字"（输出混有其他数字时务必写 metric）。
  契约存 .goal-gate/goal.md（工作区根）。

  【规格判定语义】
  - exit=0 / <op><数字>：确定性判定；读不到数字 = unverifiable（不当 passed）。
  - maximize：与上一轮指标比。baseline: delta = 必须严格改善；abs（缺省）= 不得
    回退。首轮无基线 → unverifiable（先跑一轮 goal_gate_check 建基线再判）。
  - judged：probe 即确定性判官，probe 退出码就是结论（0=passed，非0=failed）；
    判官缺失（127）或没有 probe 的 judged 行一律 unverifiable（Goodhart 防线）。

  【门控】goal_gate_check 自己重跑每条 check，零模型参与。
  rc=0 GO / rc=2 NO-GO / rc=3 BLOCKED / rc=4 状态错。输出含 score（passed/总数）、
  round/maxRounds/remainingRounds、bestScore、regression（本轮 score < 历史最高 =
  回退，先修回退）、trend（近 5 轮）、failedActions（逐条 {id, statement, check,
  expected}，直接可转 repair 任务）。unverifiable 比例 > 1/3 整门控回 NO-GO。

  【循环驱动兜底(重要)】恢复会话可能拿不到 goal_gate_* 工具表(实测)——循环必须始终
  可驱动:任何会话用 bash 跑 `bin/gate.mjs check --cwd <工作区>`(绝对路径 node),
  输出与 goal_gate_check 同构(score/round/failedActions/neverFailed/preflight)且记同一本账。
  【eval 自我加固】preflight 检查命令(裸 node/python、相对路径、疑似永真式)并给出告警;
  neverFailed 列出从未失败过的 AC(≥2 轮后,疑似永真式/未被真实考验)。
  【循环协议】/goal-loop-at {objective}（命令）或 goal_loop_at（工具）写契约骨架
  （占位 check 是 fail-closed 的 TODO-REPLACE-ME）+ loop.json（maxRounds，默认 8）
  并返回协议：派工（agent_teams_create，AC→质量任务）→ 迭代（goal_gate_check 看
  score/failedActions）→ NO-GO 转 repair 任务 → GO 才声明完成。每轮评估记入
  .goal-gate/history.jsonl（ts/trigger/round/code/score/totals/失败 AC）。
  轮次超预算 → roundsExhausted，停下等人。

  【digest 绑定（R7）】verdict 绑定 tree digest；文件改了摘要变，已过审结论自动
  作废、强制重验。摘要变化 ≠ 假完成：只有没重验通过就声称完成才计 R1。

  【假完成计数（R1）】完成声明被门控抓住 = 一次假完成；2 次 → BLOCKED 等人。
  门控绝不 throw，一律 {kind:'deny'} + 自带 code 的 reason。

  【完成声明拦截（真实工具名 + 分级治理）】tools/pre-execute 盯完成声明：
  目标级 update_goal(action:'complete') **永远硬门控**（全量契约 + R1 计数）；
  任务级 agent_teams_update_task(status:'completed')、team_task_update(action:'complete')、
  旧名 update_task(status:'completed') 按契约 exit 策略分级：
  - 缺省 strict：全量契约硬拦 + 计数（单工作单元：任务完成=目标完成）；
  - exit: goal-only（goal_loop_at 生成的契约自动带上）：步骤进度放行（步骤判定属
    quality-kind），GO→digest 绑定，NO-GO→只记账（history + partialCompletes）；
    不分级会死锁多任务循环（成员完成自己的任务时别人的 AC 必然未过）。
  BLOCKED（假完成≥2）冻结一切完成声明。没有契约时 pass-through；契约空/畸形 → deny。
  与 quality-gate 异常路径分离（它 throw，本插件 deny）。
---
