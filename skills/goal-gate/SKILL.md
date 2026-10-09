---
name: goal-gate
description: >
  DSH 插件：契约先行 + 确定性门控 + digest 绑定 verdict 的完成判定。
  适用场景：任何"多阶段、多成员、必须机器判定完成"的目标型任务（研究包、
  代码交付、文档产出），尤其是不能让模型自我宣布完成的场合。
  借 goal-loop skill 的判命面（AC 契约文法、重跑式门控、R7 摘要绑定、
  R1 假完成计数），丢弃其便携 team 文件协议（DSH 原生 Agent Teams 更强）。

  【判命面 vs 执行面】执行面直接用原生 Agent Teams 与任务板（spawn_teammate /
  claim / write_scopes / 任务板子任务树）；判命面用本插件，不与 Agent Teams 的
  quality-kind 重复——quality-kind 管"步骤有没有做完"，本插件管"整个目标算不算
  真正达成"，两者叠起来才是完整的一条链。

  【契约文法】目标写成可失败的具名检查：
    objective: <一句话目标>
    AC-1 | <yes/no 判定语句> | check: `<命令>` | [probe: `<探针命令>`] | expected: <规格>
    规格 = exit=0 | <op><数字>（如 <=5, >0, =3）| maximize | judged
  每条 check 必须真的能失败（环境依赖、空值、错误路径都得写进检查里），
  否则门控会退化成"永真式"，失去意义。
  [probe:] 是 verify-the-verifier（R9）：先确认探针本身可信，探针失败的 AC
  判为 unverifiable 而非 passed；unverifiable 比例 > 1/3 整个门控回 NO-GO。

  【门控】goal_gate_check 工具（或 /goal-gate 命令）自己重跑每条 check，零模型参与。
  rc=0 GO / rc=2 NO-GO / rc=3 BLOCKED / rc=4 状态错。
  门控通过 ≠ 任务板判官通过：确定性门控是硬地板，LLM 判官是语义层，两者独立。

  【digest 绑定（R7）】verdict 绑定 tree digest；文件改了摘要变，已过审结论自动作废。
  这是 DSH 现在完全没有的能力，必须由本插件自建，不能指望 Agent Teams。

  【假完成计数（R1）】模型试图完成但被门控抓住 = 一次假完成；2 次 → BLOCKED，
  不可再自宣完成，等人。门控绝不 throw，一律返回 {kind:'deny'} + 带 code 的 reason。

  【对接原生 Agent Teams】派工用 spawn_teammate + write_scopes（不相交子域）；
  契约字段（objective/acceptance/verify）直接给 create_task 的质量 kind；
  完成拦截挂在 tools/pre-execute 上同时盯 update_goal(complete) 与
  update_task(status:completed)，与 quality-gate 的异常路径分离（它 throw，本插件 deny）。
---
