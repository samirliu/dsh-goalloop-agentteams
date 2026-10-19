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
| 17 | **unverifiable 稀释 GO** | 缺仪器(127)、probe 失败、取数失败、无判官、不支持 `minimize`/`!=` 全被归为 `unverifiable`;3 条 AC 里 1 条坏 + 2 条地板 → rc=0 GO(score 0.67) | 引入 `broken` 状态(决定性 NO-GO):仪器/判官/证据/取数故障一律 broken;GO 要求 failed=0 且 broken=0;≥1/3 的 unverifiable 仍 NO-GO | smoke:broken-vs-unverifiable;redteam 四向 |
| 18 | AC 静默丢失 | goal-loop 原生 `- AC-1 \| ...` 行不被识别;混合契约丢掉带 dash 的失败 AC 还能 GO;重复编号被接受 | 解析兼容可选 `- ` 前缀;重复 AC 编号 state-error;contractStamp 覆盖 dashed 行 | smoke:dashed / duplicate / dashed-stamp |
| 19 | 基线冻结 | recordRun 用 `r.id === 'AC-1#hash'` 查状态,永远 undefined → 基线停在首轮观测(10→20→15 仍 10),回退检测失效 | 按 `#` 前 AC 编号匹配结果;只有 passing 轮推进基线 | smoke:基线推进/失败不拉低;ledger 回归 |
| 20 | 摘要失明 | digest 只哈希 path+size → 同尺寸编辑不可见;排除 dist/build/out 可能藏交付物;检查改树仍 GO | 2MB 内内容哈希(更大用 size+mtime);只排除账本/依赖/git/DSH;runGate 前后摘要对比,改树 → `check-mutated-tree` | smoke:同尺寸编辑 / mutating check |
| 21 | R3 盖章是装饰 | contractStamp 只算不比对;改 AC 仍 GO;没有批准入口 | `goal_gate_stamp` / `/goal-stamp` 记录批准+预算;契约变更 → 完成声明 `contract-revised`,restamp 才能放行 | v07:R3 stamp 全流程 |
| 22 | 预算是建议 | roundsExhausted 只报不拦;BLOCKED 无恢复路径;state.json 非原子写 | 轮次/墙钟到点拒绝非 GO 完成声明;`/goal-reset` 人类恢复;state 原子 rename | v07:fuses / reset;ledger:atomic |
| 23 | 任务板绕过门控 | `task_board_manage(action:'move-done')` 不在拦截名单 | 加入 completion claim 集合,按 strict/goal-only 治理 | v07:task board move-done |
| 24 | **成功返回全部失败(真实宿主)** | 0.6.x 的 output 只有 schema、没有 render;0.2.1-rc.2 的 defineTool 安装 wrapper 并在成功时调用 → 每次成功调用 `output.render failed: userRender is not a function`;deny 路径不渲染,所以"看起来在工作" | 每个工具声明共享 `renderJson`(JSON text block) | wiring:render 存在/可调用;真实 registry harness 全工具成功返回 |
| 25 | **命令从未注册** | `ctx.inject(['commands'], c => c.register(...))` 的 c 是子 Context → 读 `c.register` 抛 "cannot get property";空 `input.hint:''` 又被 register 拒绝 | `c.commands.register(...)`;无参命令省略 `input`;followup 使用完整 UserMessage | wiring + 真实 commands fiber:5 个命令在 list 中 |
| 26 | 输出 schema 越界 | 属性级 `required:true` 与 author-only `type:'json'` 不在受支持子集 → register 直接拒绝或成功调用校验失败 | 输出 schema 只用受支持子集;可空对象用 `oneOf:[object,null]` | wiring:递归 schema 断言;真实 harness |
| 27 | 首轮水位判定 | goal-loop 的数值语义是首轮建立水位即 PASS;插件判 unverifiable,叠加 17 会稀释 GO。**v0.10.0 复查推翻**:首轮免判本身就是漏洞——改一次 check 文本就换一个指标序列,每轮都能白拿 PASS | maximize/minimize 首轮 `unverifiable`(只建档、不给结论);水位靠 `goal_gate_baseline` 或上一轮建立,delta 从第二轮生效 | smoke:基线闭环;P0/P1:首轮不判 |
| 28 | 目标面缺件 | 无 `minimize` / `!=` / `sd:` / `var:`,无法表达最小化目标与数据噪声 | 全部解析与判定;声明了 spread 却匹配不到 = broken;噪声带 `max(2*spread/|prev|, tolerance)` | smoke:minimize/!=/sd/spread-miss |
| 29 | 循环身份漂移 | goal_loop_at 复用旧 loop.createdAt;目标变了却沿用旧契约/轮次/历史 | 目标不一致 → `objective-drift`;只有新建契约才换 loop 时钟 | v07:objective drift |
| 30 | CLI 状态字段错 | `bin/gate.mjs status` 把 stamp 报成 AC 数量 | 改为真实 contractStamp;补齐 audit/stamp/reset/status | ledger:gate.mjs CLI;v07 |
| 31 | 证据目录无家 | 检查写工作区会被 20 的 mutation guard 判无效,但没有文档化的证据目录 | `.goal-gate/evidence/`(摘要排除);judged artifact 可指向交付物本体或证据文件 | skill 文档 + smoke:check-mutated-tree |
| 32 | **参数 schema 无根 type(启动即瘫痪)** | 测试把 identity `@deepseek-ai/dsh-tools` shim 留在 link 安装的包目录里 → Host 解析到 shim → `parameters` 是裸属性表;provider 报 `Invalid schema for function 'goal_gate_audit': schema must be a JSON Schema of 'type: "object"', got 'type: null'` | 测试不再写 node_modules shim;入口 fallback 负责把属性表编译成 `{type:'object',properties,required?}`;wiring 断言每个工具 parameters.type==='object' | wiring:schema 断言;真实 registry harness 9 工具 |
| 33 | 团队派工无依赖图 | `scope:`/`depends:` 没进契约文法;并行任务无序,写范围重叠 | 文法新增 scope:/depends;parse/validate(未知/自依赖/环=state-error);`plan.waves` 拓扑分波;task brief 携带 scope/depends | v08:grammar/plan |
| 34 | 重查重复建卡 | 每次 `goal_gate_dispatch` 都新建任务;团队板被重复 repair 卡淹没 | 任务 subject = `[goal-gate <stamp>] AC-id: ...`;pending/in-progress 同 subject 复用(`skippedExisting`) | v08:dispatch idempotency |
| 35 | 团队并发污染账本 | 多个成员同时 check/stamp/声明完成 → round/baseline/digest 互相覆盖 | `.goal-gate/lock` O_EXCL 账本锁(10min stale);check/stamp/dispatch/intercept 串行化,抢不到返回 busy | v08:lock |
| 36 | eval 设计没有对抗面 | 契约能写但没人问"能不能刷分/能不能失败/证据绑没绑";问题到烧完轮才发现 | `goal-loop-grill` skill + `goal_gate_grill` 工具:findings/questions/metricDesign/goodhart;ready 需无 high/medium | v08:grill |
| 37 | 基线/噪声只靠口头 | optimize AC 的首轮值直接当水位,没有均值/离散度;后续 band 靠猜 | `goal_gate_baseline` 跑 N 次,写 state.baselines/spreads;runGate 在无 sd/var 输出时使用已记录 spread;audit 对未建基线亮黄牌 | v08:baseline/spread;v08:audit |
| 38 | 下一步不可执行 | 门控给出 failedActions,但团队里"现在该派工/等谁/停止"要靠模型猜 | check/status 输出 `nextActions`(dispatch-repairs/collect-team/assign-ready-tasks/audit-and-claim/stop-budget…);status 带 team 快照 | v08:team/nextActions |
| 39 | 只能建任务,不能组队 | Agent Teams 适配停在 task board:谁干什么、谁拥有哪张卡、怎么唤醒全靠模型手工 | `goal_gate_staff` 把 AC/依赖波变成队友规格;默认预览,`spawn:true` 才 spawn 原生队友、建/派任务并发 AC 简报 | v09:staff preview/spawn |
| 40 | 团队完成度不可判定 | 只能看任务状态,不知道是否所有 AC 都有任务、能不能跑门控 | `goal_gate_collect` 映射 completed/inProgress/pending/missing→AC,给出 `readyToCheck` | v09:collect |
| 41 | 冷席评审没有入口 | judged AC 只能靠模型自己"记得"找 fresh reviewer,证据/calib 纪律不可执行 | `goal_gate_judge` 为 judged AC 建幂等评审任务,简报强制 artifact/digest/calib/score | v09:judge |
| 42 | 并发锁立即失败 / 优化无 horizon | 队友同时操作时 busy 直接失败;optimize-only 契约没有盲区防线 | `withLedgerLock waitMs` 短等待重试;grill 对无 judged+calib 且无 `horizon-waived:` 的优化契约亮 medium | v09:lock/grill |
| 43 | 完成声明重复要求 delta 改善 | GO 已经接受当前水位;拦截器重跑同一 optimize AC 时 `baseline: delta` 仍要求再涨一次,一次正常波动就能把已 GO 的目标判 NO-GO | `runGate(mode:'claim')`:声明轮 `delta` 退化为不回退(真恶化仍失败);`goal_gate_check` 保持严格 delta | e2e case1;smoke:claimMode |
| 44 | grill 对"按序同 scope"和"有 probe+calib 的 judged"误报 | 顺序依赖的两个 AC 共享目录被报 scope 冲突;任何 judged 都带 medium "must bind evidence" → 有 judged 的契约永远无法 ready | scope 冲突仅在**无 depends 顺序**时报告;judged evidence 改为 low 提醒(门控仍强制 digest/calib) | v09:ordered/judged grill |
| 45 | CLI 并发无锁 | `bin/gate.mjs check/stamp` 绕过账本锁,两个进程并发会互相覆盖 round/baseline;case4 暴露 | CLI check/stamp 走 `withLedgerLock(...,{waitMs:2000})`,busy 明确退出 | examples/plugin-e2e case4 |
| 46 | **Windows 上门控永远 NO-GO** | `runCommand` 硬编码 `spawnSync('/bin/sh', ['-c', cmd])`;Windows 无 `/bin/sh` → ENOENT → 映射 128 → 所有 AC 判 failed/broken → 门控永不 GO,拦截器拦掉每次 `update_goal(complete)`/`team_task_update(complete)`,两次后 BLOCKED | 显式解释器解析 `resolveShell()`:POSIX 默认 `/bin/sh -c`,Windows 默认 `%COMSPEC% /d /s /c`(verbatim 参数);`config.shell`/`GOAL_GATE_SHELL`/`--shell` 可覆盖;结论带 `shell` 字段;解释器缺失判 broken 并点名修复;preflight 新增 `posix-syntax-on-cmd`;超时识别 `ETIMEDOUT` | 平台中立夹具:+ Windows 默认 shell / Git Bash sh 双模式全量套件 |
| 47 | **CRLF checkout 下 skill 静默消失** | `parseSkillFile` 用 `([A-Za-z0-9_-]+):\s*(.*)$`(无 m 标志)解析 frontmatter;Windows / `core.autocrlf=true` 的 CRLF 让 `$` 落不到行尾 → description 为空 → 3 个 runtime skill 全部被跳过(真实 Git checkout 上 wiring 断言得到 `[]`;LF 工作区不复现) | 读取时 `\r\n?` → `\n` 归一化再解析;导出 `parseSkillFile` 并加 CRLF frontmatter 回归用例 | wiring:CRLF frontmatter |

## 质量演进

- **证据保真**(v0.4.x):deliverable 声明 + 覆盖预检 + judged 评审强制证据摘要绑定(R7 for judgments)——区分"验了部分"与"验了本体";v0.10.0 起证据必须落在被评估的工作区内
- **质量分**(v0.5.0):judged 结论带 score 进指标管道;`baseline: delta` 让质量逐轮必须改善;质量目标 AC 门槛。v0.10.0 起分数只采信判读席(probe)的输出,不采信被评产物自述
- **度量纪律**(v0.3.1):基线只随通过推进(失败观测永不拉低);指标身份 = AC 编号 + 语句哈希
- **鲁棒性**(v0.3.0+):bash 可达的门控 CLI(binp/gate.mjs)、裸运行时/相对解释器预检、永真式点名
- **接线**(v0.2.x):真实工具名接线、入口 name 契约、link: 安装的模块解析链
- **时间与诚实性**(v0.6.2):门控自计时、最近评估时钟、loop-idle 检测、重评点名、错误不烧轮——墙钟进账本,不再靠口头
- **判定信任**(v0.7.0):broken 分类(仪器坏 = 决定性 NO-GO)、内容摘要、R3 盖章、`- AC-` 兼容、重复编号拒绝、首轮水位与最小化
- **闭环保险丝**(v0.7.0):轮次/墙钟预算绑定盖章并拦截、人类 reset、objective-drift、任务板 move-done 纳入拦截
- **宿主契约**(v0.7.0):output.render、输出 schema 子集、commands 子 Context、skill 运行时注册——按 0.2.1-rc.2 解包产物实测修复(见 docs/platform-contract.md)
- **DSH 原生面**(v0.7.0):原生 Agent Teams 任务派工(Lead)、只读 status/audit、策略/效率归因、两个打包 skill
- **团队闭环**(v0.8.0):scope/depends 文法 + 分波派工、幂等 repair、owner 指派、团队快照/nextActions、账本锁
- **评估设计**(v0.8.0):grilling skill + grill 工具、基线与离散度测量、数据驱动噪声带、第三个运行时 skill
- **团队编排**(v0.9.0):staff 预览/spawn、collect 就绪判定、judge 冷席评审、锁等待、horizon 防线
- **复杂用例回归**(v0.9.1):多波交付、grill 修复、预算/阻塞/重置、CLI 并发、judged digest;claim-mode delta 与 grill 误报修复
- **平台中立**(v0.9.2):解释器显式解析与上报(POSIX `/bin/sh` ↔ Windows `%COMSPEC%`,可 `config.shell`/`GOAL_GATE_SHELL`/`--shell` 覆盖),解释器缺失 fail-loud 并给修复名;`app.asar` 模块回退改 `pathToFileURL`(Windows ESM 不再丢真 `defineTool`);测试与 e2e 夹具平台中立,Windows 默认 shell 与 Git Bash 双模式全绿
- **判定可信度加固**(v0.10.0):账本完整性(HMAC 签名,密钥在工作区外;篡改/删除判 state-error,绝不静默重建)、锁正确性(只读不取锁、pid 存活检测、token 校验释放、re-stat 回收、`unlock` 人工恢复)、指标身份锚语句、首轮不判定、判官分数与 calib 由门控自跑、证据工作区围栏、CLI 退出码按 rc 如实映射(4=state-error/5=busy)、工作区缺失 fail-closed、盖章默认需人批

## 运营发现(循环侧,非内核缺陷)

- **队员静默停滞**:任务已认领但队员回合被回收(超时/服务端错误)时,调度器不会自动重启;
  队长必须看门并用消息唤醒或重派。"自主循环"需要队长盯梢,这是 right agentic loop 文档该补的纪律。
- **瞬时服务端错误**(如模型接口 5xx)会让任务失败一次后重派恢复——retry 机制有效。

## 尚未闭合的已知项

- 桌面 Host 内"重启后完整会话"的实机验证:注册契约已用解包产物 + 真实 registry harness 验证(render / schema / commands fiber / skills / agentTeams),但 restarted-desktop E2E 仍建议发布前跑一遍
- `exit: forge` / `external:` / `window:` 未实现(preflight 对 forge 亮 `unsupported-exit-policy`);v0.8 议题
- 多成员循环桥(失败 AC → repair 任务 → 队员)在终章验收中
- 交付物摘要搬家触发的拦截复查会再记一轮:这是文档化的代价(改本体必须先重结证据),
  靠"攒够改动再统一声明完成"规避;复查耗时现在可从 ms 字段读出
- task-claim 里程碑门控记账不烧轮,但真实执行仍花时间——若成为瓶颈可按契约摘要缓存
  最近一次 GO 结果,当前未做(无证据表明值得引入缓存复杂度)
