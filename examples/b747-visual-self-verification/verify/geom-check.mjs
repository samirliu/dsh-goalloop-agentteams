// geom-check.mjs — 几何自验证:从网格实测比例,对照 747-400 真机规格
// 不是"引用输入值",而是从三角形网格里量出来的(measured, not asserted)。
// 用法:node geom-check.mjs [--poly]
import { SPECS, TRIANGLES, TRI_COLORS, PALETTE, STATS } from '../geometry.js';

const args = process.argv.slice(2);
if (args.includes('--poly')) {
  console.log('poly=' + STATS.vertices);
  process.exit(0);
}

const flat = TRIANGLES.flat();
const xs = [], ys = [], zs = [];
for (let i = 0; i < flat.length; i += 3) { xs.push(flat[i]); ys.push(flat[i + 1]); zs.push(flat[i + 2]); }
const min = (a) => Math.min(...a), max = (a) => Math.max(...a);

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

// 1) 全机长
const len = max(xs) - min(xs);
check('机长 70.6m ±0.9', Math.abs(len - SPECS.length) <= 0.9, `实测 ${len.toFixed(2)}m`);

// 2) 翼展(含翼梢小翼,容差 +2.2/-0.6)
const span = max(zs) - min(zs);
check('翼展 64.4m +2.4/-0.6', span <= SPECS.span + 2.4 && span >= SPECS.span - 0.6, `实测 ${span.toFixed(2)}m`);

// 3) 全高(地面到尾顶)
const height = max(ys) - min(ys);
check('全高 19.4m ±1.6', Math.abs(height - SPECS.height) <= 1.6, `实测 ${height.toFixed(2)}m`);

// 4) 发动机数量:扫描深色风扇面三角形的连通中心
const fanColor = PALETTE.engineDark;
const fanXs = [];
TRIANGLES.forEach((t, i) => {
  const c = TRI_COLORS[i];
  if (Math.abs(c[0] - fanColor[0]) < 0.01 && Math.abs(c[1] - fanColor[1]) < 0.01) {
    fanXs.push((t[0] + t[3] + t[6]) / 3);
  }
});
// 风扇面 x 坐标聚类(容差 1m),得到发动机台数
fanXs.sort((a, b) => a - b);
const clusters = [];
for (const x of fanXs) {
  const last = clusters[clusters.length - 1];
  if (last === undefined || Math.abs(x - last.x0) > 1) clusters.push({ x0: x, n: 1 });
  else { last.n++; }
}
const engines = clusters.filter((c) => c.n >= 12).length; // 每台发动机 M=18 风扇三角形
check('发动机 4 台', engines === SPECS.engineCount, `实测 ${engines} 台`);

// 4b) 发动机位置:风扇簇中心必须位于翼下(x < 翼根前缘 0,且在机尾之前)
const fanCenters = clusters.filter((c) => c.n >= 12);
const engPosOk = fanCenters.every((c) => c.x0 < -4 && c.x0 > -30);
check('发动机位于翼下(x∈[-30,-4])', engPosOk, `实测 x=${fanCenters.map((c) => c.x0.toFixed(1)).join(', ')}`);

// 5) 翼缘后掠角:在两个展向站位量机翼前缘 x
const wingPts = [[], [], [], []]; // z∈[9,12],[20,23] 两站位 × 前缘候选
TRIANGLES.forEach((t, i) => {
  const c = TRI_COLORS[i];
  if (Math.abs(c[0] - PALETTE.wing[0]) > 0.01) return;
  for (let k = 0; k < 3; k++) {
    const x = t[k * 3], y = t[k * 3 + 1], z = t[k * 3 + 2];
    if (y > -0.5 && y < 3) { // 机身顶以下的翼面
      if (z > 9 && z < 12) wingPts[0].push(x);
      if (z > 20 && z < 23) wingPts[1].push(x);
    }
  }
});
const le1 = max(wingPts[0]), le2 = max(wingPts[1]);
const dz = 11.5, sweep = Math.atan2(le1 - le2, dz) * 180 / Math.PI;
check('后掠角 37.5° ±2.5', Math.abs(sweep - SPECS.sweepDeg) <= 2.5, `实测 ${sweep.toFixed(1)}°`);

// 6) 驼峰:前段顶部高出中段顶部 1.2~3.0m
const topY = (x0, x1) => {
  let m = -Infinity;
  TRIANGLES.forEach((t) => {
    for (let k = 0; k < 3; k++) {
      const x = t[k * 3], y = t[k * 3 + 1];
      if (x >= x0 && x <= x1 && Math.abs(t[k * 3 + 2]) < 3.4) m = Math.max(m, y);
    }
  });
  return m;
};
const humpTop = topY(14, 28);        // 机头后 7~21m(驼峰区)
const midTop = topY(-20, -8);        // 中段(无驼峰)
const rise = humpTop - midTop;
check('驼峰隆起 1.2~3.0m', rise >= 1.2 && rise <= 3.0, `实测 ${rise.toFixed(2)}m`);

// 7) 细节密度底线
check('顶点数 ≥ 9000', STATS.vertices >= 9000, `实测 ${STATS.vertices}`);

// 输出
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`FAIL: ${failed.length}/${results.length} 项不过`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} 项全过`);
