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
| 11 | 输出 schema 漏字段 | goal_loop_at 自 v0.4 起返回 preflight,但 output schema 未声明;宿主校验按 additionalProperties:false 拒绝整个返回值——循环文件已建好、工具却报 invalid output | 声明补全;并立新不变量:每个注册工具的实际返回 key 必须 ⊆ 声明 schema keys | wiring[10b]:key 子集采样 |
| 12 | 返回值非 lossless JSON | 嵌套 undefined/NaN/±Infinity 让宿主工具边界的 JSON 校验整单作废——记账副作用已发生,成功了也白烧一轮 | core.js 新增 jsonSafe() 递归清洗,三个工具全部返回路径过一遍 | wiring[10b] 双不变量 + 空账本首轮最毒样本 |
| 13 | judged 哑巴作废 | unverifiable 四种成因(无证据绑定/摘要过期/无判官/判官命令 127)一律不解释,修复方对着空 why 盲修好几轮;无判官的 judged 必然 unverifiable 却无人提前说 | core.js 每分支附 why(127 明说"验证器坏了 ≠ 评审不过");预检新增 judged-judge-missing / judged-evidence-binding 两条黄牌 | smoke:why 三向断言;ledger:预检点名 |
| 14 | state-error 烧轮 | 契约畸形/零评估的轮照烧预算,"验证器坏了"能把预算烧光都跑不了一次真实验 | history 中 state-error 行记账保留(可审计)但不参与轮次计数 | ledger:三连错后正常实验轮次零被吞 |
| 15 | 时间面失明 | 循环停摆(数小时无评估)与单纯慢在账本和返回值里完全不可见,墙钟只能口头承诺 | recordRun 落 lastRunAt(旧账本回落 loop.createdAt);loopIdleStatus/idleWarning:active 超阈(默认可配 4h)→ loop-idle 黄牌,suspended 视为诚实等待;runGate 自计时 ms 进账本与返回 | ledger:idle 三向/lastRunAt/ms;smoke:ms 存在 |
| 16 | 重评静默烧轮 | goal_gate_check 每次都是实验(记账烧轮),"只想再看一眼结论"也悄悄烧一轮且无人点名 | duplicateEvalNote:与上一次同盖戳/同分值/同失败集的结论点名"重评不改变事实;复查走只读入口";协议文本同步"每契约状态一次检查" | ledger:同结论点名/变则放行/错误不点名 |

## 质量演进

- **证据保真**(v0.4.x):deliverable 声明 + 覆盖预检 + judged 评审强制证据摘要绑定(R7 for judgments)——区分"验了部分"与"验了本体"
- **质量分**(v0.5.0):judged 结论带 score 进指标管道;`baseline: delta` 让质量逐轮必须改善;质量目标 AC 门槛
- **度量纪律**(v0.3.1):基线只随通过推进(失败观测永不拉低);指标身份 = AC 编号 + check 哈希
- **鲁棒性**(v0.3.0+):bash 可达的门控 CLI(binp/gate.mjs)、裸运行时/相对解释器预检、永真式点名
- **接线**(v0.2.x):真实工具名接线、入口 name 契约、link: 安装的模块解析链
- **时间与诚实性**(v0.6.2):门控自计时、最近评估时钟、loop-idle 检测、重评点名、错误不烧轮——墙钟进账本,不再靠口头

## 运营发现(循环侧,非内核缺陷)

- **队员静默停滞**:任务已认领但队员回合被回收(超时/服务端错误)时,调度器不会自动重启;
  队长必须看门并用消息唤醒或重派。"自主循环"需要队长盯梢,这是 right agentic loop 文档该补的纪律。
- **瞬时服务端错误**(如模型接口 5xx)会让任务失败一次后重派恢复——retry 机制有效。

## 尚未闭合的已知项

- Host 内拦截器的实机全保真验证(需装载当前代码后跑完成声明路径)
- 多成员循环桥(失败 AC → repair 任务 → 队员)在终章验收中
- 交付物摘要搬家触发的拦截复查会再记一轮:这是文档化的代价(改本体必须先重结证据),
  靠"攒够改动再统一声明完成"规避;复查耗时现在可从 ms 字段读出
- task-claim 里程碑门控记账不烧轮,但真实执行仍花时间——若成为瓶颈可按契约摘要缓存
  最近一次 GO 结果,当前未做(无证据表明值得引入缓存复杂度)
