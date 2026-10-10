# 案例:THREE.js 波音 747 · 视觉自验证(goal-gate 插件实战样例)

> **这是 `dsh-goalloop-agentteams` 插件的一个验证案例,不是插件的一部分。**
> 插件是通用的目标门控/闭环组件;本目录记录一次真实使用,展示契约怎么写、
> 循环怎么跑、门控与视觉评审如何互相补位。通用逻辑与文档不包含本案例的任何内容。

## 目标

用 Three.js 建最逼真的波音 747-400,并用"视觉能力"构建自我验证系统。

## 契约(完整样例,展示全部判定语义)

```
objective: 使用 THREEJS 创建最逼真的波音 747——含基于视觉能力的自我验证系统
exit: goal-only
AC-1 | 交付物齐备:THREEJS 页面与本地化依赖 | check: `test -s b747/index.html && test -s b747/vendor/three.module.js` | expected: exit=0
AC-2 | 几何比例符合真机规格 | check: `<绝对路径 node> b747/verify/geom-check.mjs` | expected: exit=0
AC-3 | 四视角投影渲染非空白 | check: `<绝对路径 python> b747/verify/render-check.py` | expected: exit=0
AC-4 | 细节密度(顶点数)不得回退 | check: `<绝对路径 node> b747/verify/geom-check.mjs --poly` | metric: `poly=(\d+)` | baseline: abs | expected: maximize
AC-5 | 视觉自检通过 | check: `cat b747/verify/visual-verdict.txt` | probe: `grep -q 'VERDICT: PASS' b747/verify/visual-verdict.txt` | expected: judged
```

用到的判定语义:`exit=0`、`maximize + baseline: abs`(不回退)、`judged + probe`(确定性判官)、
`metric:` 正则取数。注意 check 一律绝对路径解释器(bare `node` 在坏 PATH 机器会静默翻车)。

## 自我验证系统(verify/)

| 组件 | 作用 | 实战战果 |
|---|---|---|
| `geom-check.mjs` | 从三角网格**实测**比例对照真机规格(机长/翼展/后掠角/发动机数/驼峰),8 项 | 抓到全高不足(17.2m→修至 19.1m) |
| `render-check.py` | 四视角投影渲染 + 非空白校验(视觉素材生成器) | 保证评审素材可用 |
| `visual-verdict.txt` | 视觉评审结论(judged 判官的输入) | 终审判定 PASS |
| 视觉评审(带防错标签) | 每张渲染烙 `view=…|file=…` 标签,评审先验标签 | 抓到发动机悬空/窗飘机身/喷口喇叭;并发现一次"图不对文"的投递错位 |

## 循环实录(节选)

1. Round 1:检查器抓到全高 17.18m(真机 19.4±1.6)→ 加长起落架 → 7/8 过
2. Round 2:视觉评审抓到发动机悬空(展向坐标误当轴向)→ 挂回翼下,并把"引擎位置"固化为确定性检查
3. Round 3:发现渲染器相机误挂俯仰角("侧视"实为俯视)→ 修视图矩阵
4. Round 4:尾喷口收敛角修正 → 8/8 + 渲染全过 → 视觉终审 PASS → 门控 GO
5. 完成声明(update_goal complete)由 pre-execute 门控真机评估放行,history 留痕 `intercept | go`

## 可复用经验(对任何 goal-gate 用户)

- **验证者要先被验证**:视觉/模型类评审先跑标定图(R9),评审素材带防错指纹
- **视觉发现要固化成确定性检查**:每次评审抓到的问题,回头变成 geom-check 的一条硬检查
- **契约命令要能在门控的 /bin/sh 里活**:绝对路径解释器,`preflight` 会告警裸写运行时
- **首轮跑 check 建基线**:maximize 类 AC 首轮 unverifiable 是特性,不是失败

## 目录

- `geometry.js` / `index.html` — 交付物(747 几何内核 + Three.js 页面;`vendor/three.module.js` 需自行下载或本地化)
- `verify/` — 自验证系统三件套
- `renders/` — 带防错标签的四视角投影

---

## 复盘:本案例暴露了评估系统的"证据保真"盲区(最终章)

**翻车现场**:门控 5 条 AC 全过(GO, score 1.0)、视觉评审写了 `VERDICT: PASS`,
但交付物本体(浏览器页面)是完全坏的——飞机在 WebGL 里隐形。逐层定位(页面遥测 →
服务器日志读数)才找到根因:三角网格的颜色属性是"每三角 1 色"却按"每顶点 1 色"
喂给显卡,颜色缓冲短 2/3 → 越界顶点读出垃圾 → 片元被丢弃 → 机体隐形,而阴影
通道不读颜色所以影子完好。

**为什么门控没抓住**:8 条检查全部是数据/文件级;没有任何一条在真实运行环境里
执行过交付物;连"视觉评审"看的也是投影渲染器的衍生图,不是那个页面。评估系统
无法区分"验了部分"与"验了本体"。

**由此长出的通用能力(见插件 v0.4.x)**:
1. 契约 `deliverable:` 声明 + 覆盖告警(deliverable-unverified / judged-without-deliverable)
2. judged 评审**强制证据绑定**:结论必须含 `artifact:` + `digest: sha256:`,门控重验摘要
   (看的东西 ≠ 要发的东西 → 作废)
3. `no-runtime-ac` 告警:没有任何 AC 在运行时执行交付物的契约被点名
4. 验证金字塔入模板:数据 → 产物 → 运行时 → 对交付物本体的评审

**本案的可复用调试法**:页面自我遥测(fetch 把诊断发给本地服务器)→ 服务器访问
日志读数 → 数字定位(`posCount=13938 colCount=4646` 一眼看穿);以及 headless
Chrome 截图作为运行时验收证据。

**遗留瑕疵记录**:上反角实测 3.86° vs 真机 7°(geometry.js 的 0.55 缩放系数),
若要严格对齐属 repair 项;低模面片风格化为有意取舍。
