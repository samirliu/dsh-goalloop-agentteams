# 缺陷总账与质量演进

压测 campaign 的正式产出:每一条都是在真实验收过程中发现、修复并有回归测试的插件缺陷。
(发现场景以通用措辞描述;具体校验样例见 examples/。)

## 缺陷清单

| # | 缺陷 | 症状 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | 轮次计数跨实验累计 | 多实验共享工作区时轮次预算被历史撑爆(roundsExhausted 假阳性);neverFailed 跨契约误报 | 轮次/趋势按 loop 作用域计数;neverFailed 按契约盖戳隔离 | ledger_test:换 loop 重计 / 盖戳隔离 |
| 2 | 数值规格取数脆弱 | 多数字输出下"最后数字"兜底静默取错值,误导性失败 | 预检 `numeric-without-metric` 黄牌 | ledger_test:有/无正则两向 |
| 3 | 固定 30s 硬超时 | 合法长时验收(浸泡/大构建)被静默击杀,空输出像普通失败 | 文法新增 `[timeout: <秒>]`(check/probe 双通道) | smoke:短超时击杀 / 放行 |
| 4 | 交替正则捕获组 | `a=(\d+)\|b=(\d+)` 命中第二分支时首捕获组为空 → 可测值判 unverifiable | extractMetric 取首个非空捕获组 | smoke:肇事正则 |
| 5 | AC 行静默丢弃 | check 内嵌反引号等文法错误 → 整条验收无声消失,门控评残缺契约还照常报告 | runGate fail-closed(rc=4 点名肇事行);预检 `ac-line-unparsed` | smoke + ledger |
| 6 | 错误路径不可断言 | 只能表达 exit=0;"必须以特定码失败"无法表达,其余被静默 unverifiable | 通用 `exit=N`(必须精确以 N 结束) | smoke:三向(对码/错码/反例) |
| 7 | 度量比较无容差 | 基准类指标天然波动(实测同代码 5 次 ±5.2%),abs/delta 精确比较 → 假红 | 文法 `[tolerance: <相对容差>]`:abs 噪声带内不算回退;delta 须超带 | smoke:四向语义 |
| 8 | 诊断面失明 | 失败原因只写 stderr,门控只报 failed/exitCode/stdout 空——评估系统自身不 fail-loud | runCmd 全量捕获 stderr 进结果;unverifiable 数值规格自报原因 | smoke:stderr 捕获 |
| 9 | ANSI 染色盲区 | 真实 CLI 染色输出切断指标正则,值存在却量不到 | extractMetric 先剥 ANSI 再匹配 | smoke:染色 metric 行 |
| 10 | delta 饱和无诊断 | 封顶指标(如 0..1 质量分)首次即达上限时,delta 改善目标永不可达,门控默默 failed 无线索 | 饱和诊断(why 给出可操作建议:tolerance / abs / 提高上限) | smoke:饱和场景 |

## 质量演进

- **证据保真**(v0.4.x):deliverable 声明 + 覆盖预检 + judged 评审强制证据摘要绑定(R7 for judgments)——区分"验了部分"与"验了本体"
- **质量分**(v0.5.0):judged 结论带 score 进指标管道;`baseline: delta` 让质量逐轮必须改善;质量目标 AC 门槛
- **度量纪律**(v0.3.1):基线只随通过推进(失败观测永不拉低);指标身份 = AC 编号 + check 哈希
- **鲁棒性**(v0.3.0+):bash 可达的门控 CLI(binp/gate.mjs)、裸运行时/相对解释器预检、永真式点名
- **接线**(v0.2.x):真实工具名接线、入口 name 契约、link: 安装的模块解析链

## 运营发现(循环侧,非内核缺陷)

- **队员静默停滞**:任务已认领但队员回合被回收(超时/服务端错误)时,调度器不会自动重启;
  队长必须看门并用消息唤醒或重派。"自主循环"需要队长盯梢,这是 right agentic loop 文档该补的纪律。
- **瞬时服务端错误**(如模型接口 5xx)会让任务失败一次后重派恢复——retry 机制有效。

## 尚未闭合的已知项

- Host 内拦截器的实机全保真验证(需装载当前代码后跑完成声明路径)
- 多成员循环桥(失败 AC → repair 任务 → 队员)在终章验收中
