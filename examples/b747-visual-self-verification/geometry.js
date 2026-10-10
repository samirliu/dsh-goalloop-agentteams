// geometry.js — 波音 747-400 几何内核(纯 JS,无 THREE 依赖)
// 场景(index.html)与验证器(geom-check.mjs / render.py)共享同一份数据,
// 保证"看到的"与"量到的"永远一致 —— 视觉自验证系统的地基。

// 真机规格(747-400,单位:米)
export const SPECS = {
  length: 70.6,          // 全机长
  span: 64.4,            // 翼展
  height: 19.4,          // 全高
  fuselageWidth: 6.5,    // 机身宽
  sweepDeg: 37.5,        // 翼缘后掠角(1/4 弦线)
  dihedralDeg: 7.0,      // 上反角
  engineCount: 4,
  engineDiameter: 2.8,
  humpLength: 24.0,      // 上层甲板(驼峰)长度
  humpRise: 2.1,         // 驼峰高出主舱顶
  tailHeight: 9.6,       // 垂尾高(自机身顶)
  stabSpan: 22.2,        // 平尾展长
};

// 由规格推导的布局
const L = SPECS.length, W = SPECS.span, FW = SPECS.fuselageWidth;
export const LAYOUT = {
  noseX: L * 0.5,          // 机头(前向 +x)
  tailX: -L * 0.5,
  wingRootX: -2.0,         // 翼根 1/4 弦点位置
  wingRootChord: 14.5,
  wingTipChord: 4.0,
  wingHalfSpan: W / 2,
  engineX: [10.5, 21.5],   // 发动机距中心线(内/外)
};

const DEG = Math.PI / 180;

// ── 基础几何工具 ─────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function ring(cx, cy, rx, ry, n, squash = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // 略扁的机身截面:底部微收(747 机腹特征)
    const yy = Math.sin(a);
    const yScale = yy < 0 ? lerp(1, squash, -yy) : 1;
    pts.push([cx, cy + yy * ry * yScale, Math.cos(a) * rx]);
  }
  return pts;
}

// ── 三角形累积器 ─────────────────────────────────────────────────────
const tris = [];
const colors = [];
function pushTri(a, b, c, col) { tris.push([a, b, c].flat()); colors.push(col); }
function pushQuad(a, b, c, d, col) { pushTri(a, b, c, col); pushTri(a, c, d, col); }

// 颜色(顶点色,便于投影渲染与 three 共享)
export const PALETTE = {
  fuselageTop: [0.92, 0.93, 0.95],   // 白机身
  fuselageBelly: [0.62, 0.65, 0.70], // 机腹浅灰
  cheatline: [0.10, 0.22, 0.48],     // 深蓝腰线
  wing: [0.80, 0.82, 0.86],
  engine: [0.72, 0.74, 0.78],
  engineDark: [0.16, 0.17, 0.20],
  glass: [0.08, 0.12, 0.18],
  gear: [0.22, 0.22, 0.24],
};

// ── 机身(含驼峰的放样)────────────────────────────────────────────────
// 从机头到机尾的一组截面;驼峰是前段顶部的第二层轮廓。
function buildFuselage() {
  const N = 22;                 // 截面环向分段
  const sections = 72;          // 纵向分段
  const halfW = FW / 2;
  const rings = [];
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const x = lerp(LAYOUT.noseX, LAYOUT.tailX, t);
    // 半径沿轴向:机头锥 0→1(前 16%),中段 1,机尾锥 1→0.18(后 22%)
    let r = 1;
    const noseT = 0.16, tailT = 0.22;
    if (t < noseT) r = Math.pow(t / noseT, 0.62);
    else if (t > 1 - tailT) r = lerp(1, 0.16, Math.pow((t - (1 - tailT)) / tailT, 1.5));
    // 机尾上翘
    const up = t > 0.82 ? Math.pow((t - 0.82) / 0.18, 2) * 1.9 : 0;
    // 驼峰:前段(x 从机头后 8m 到 8+24m)顶部凸起,平滑过渡
    const humpX0 = LAYOUT.noseX - 8.5, humpX1 = humpX0 - SPECS.humpLength;
    let hump = 0;
    if (x < humpX0 && x > humpX1) {
      const ht = (humpX0 - x) / SPECS.humpLength;
      // 驼峰轮廓:前段快速隆起,尾段渐收融入主舱
      hump = SPECS.humpRise * (ht < 0.22 ? Math.sin((ht / 0.22) * Math.PI / 2) : Math.pow(1 - (ht - 0.22) / 0.78, 0.75));
    }
    const y0 = up;
    rings.push({ x, r: r * halfW, ry: r * halfW, y0, hump, t });
  }
  // 放样
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let j = 0; j < N; j++) {
      const a1 = (j / N) * Math.PI * 2, a2 = ((j + 1) / N) * Math.PI * 2;
      const pt = (R, a, extra) => [R.x, R.y0 + Math.sin(a) * (R.ry + extra) + (Math.sin(a) > 0 ? R.hump * Math.pow(Math.sin(a), 2) : 0), Math.cos(a) * R.r];
      const v1 = pt(A, a1, 0), v2 = pt(A, a2, 0), v3 = pt(B, a2, 0), v4 = pt(B, a1, 0);
      const mid = Math.sin((a1 + a2) / 2);
      // 配色:白顶/灰腹 + 腰线
      const ym = (v1[1] + v3[1]) / 2;
      let col = PALETTE.fuselageTop;
      if (ym < -0.6) col = PALETTE.fuselageBelly;
      if (ym > -0.6 && ym < 0.4) col = PALETTE.cheatline;
      pushQuad(v1, v2, v3, v4, col);
    }
  }
  return rings;
}

// ── 机翼(后掠 + 上反 + 翼梢小翼)─────────────────────────────────────
function buildWing(side) {
  const s = side; // 1 左 / -1 右
  const root = LAYOUT.wingRootX, cRoot = LAYOUT.wingRootChord, cTip = LAYOUT.wingTipChord;
  const sweep = SPECS.sweepDeg * DEG, dih = SPECS.dihedralDeg * DEG;
  const span = LAYOUT.wingHalfSpan;
  const M = 14; // 展向分段
  for (let i = 0; i < M; i++) {
    const t0 = i / M, t1 = (i + 1) / M;
    const mk = (t) => {
      const y = s * t * span;
      const xLE = root - t * span * Math.tan(sweep);   // 前缘(向后掠)
      const chord = lerp(cRoot, cTip, t);
      const z = Math.tan(dih) * t * span * 0.55;       // 上反
      const th = lerp(1.25, 0.22, t);                  // 翼型厚度
      return { y, xLE, chord, z, th };
    };
    const A = mk(t0), B = mk(t1);
    const col = PALETTE.wing;
    // 上下翼面前缘/后缘四点
    const p = (K, top) => [[K.xLE, K.z + (top ? K.th : 0), K.y], [K.xLE - K.chord, K.z + (top ? K.th * 0.4 : -K.th * 0.1), K.y]];
    const aT = p(A, true), aB = p(A, false), bT = p(B, true), bB = p(B, false);
    pushQuad(aT[0], bT[0], bT[1], aT[1], col);            // 上
    pushQuad(aB[1], bB[1], bB[0], aB[0], col);            // 下
    pushQuad(aT[0], aB[0], bB[0], bT[0], col);            // 前缘
    pushQuad(aT[1], bT[1], bB[1], aB[1], col);            // 后缘
  }
  // 翼梢小翼(747-400 常见融合式小翼的简化:上折小翼)
  const tipY = s * span, tipX = root - span * Math.tan(sweep);
  const wl = 1.8;
  pushQuad([tipX - 2.2, 0.3, tipY], [tipX - 2.2, 0.3 + wl, tipY + s * 0.55], [tipX - 4.6, 0.3 + wl * 0.75, tipY + s * 0.55], [tipX - 4.6, 0.3, tipY], PALETTE.wing);
}

// ── 发动机(短舱 + 进气环 + 风扇面 + 尾锥 + 挂架)──────────────────────
function buildEngine(x, y, z) {
  const D = SPECS.engineDiameter / 2, M = 18;
  for (let i = 0; i < M; i++) {
    const a1 = (i / M) * Math.PI * 2, a2 = ((i + 1) / M) * Math.PI * 2;
    const fx = x + 2.2, bx = x - 2.4, r2 = D * 0.82;
    const f1 = [fx, y + Math.sin(a1) * D, z + Math.cos(a1) * D];
    const f2 = [fx, y + Math.sin(a2) * D, z + Math.cos(a2) * D];
    const b1 = [bx, y + Math.sin(a1) * r2, z + Math.cos(a1) * r2];
    const b2 = [bx, y + Math.sin(a2) * r2, z + Math.cos(a2) * r2];
    pushQuad(f1, f2, b2, b1, PALETTE.engine);
    // 进气环内唇(深色)
    const D2 = D * 0.86;
    pushQuad([fx + 0.01, y + Math.sin(a1) * D, z + Math.cos(a1) * D],
             [fx + 0.01, y + Math.sin(a2) * D, z + Math.cos(a2) * D],
             [fx - 0.06, y + Math.sin(a2) * D2, z + Math.cos(a2) * D2],
             [fx - 0.06, y + Math.sin(a1) * D2, z + Math.cos(a1) * D2], PALETTE.engineDark);
    // 风扇面
    pushTri([fx - 0.08, y, z], [fx - 0.08, y + Math.sin(a2) * D2, z + Math.cos(a2) * D2], [fx - 0.08, y + Math.sin(a1) * D2, z + Math.cos(a1) * D2], PALETTE.engineDark);
    // 尾喷管 + 尾锥
    const e1 = [bx, y + Math.sin(a1) * r2, z + Math.cos(a1) * r2];
    const e2 = [bx, y + Math.sin(a2) * r2, z + Math.cos(a2) * r2];
    const c1 = [x - 2.95, y + Math.sin(a1) * D * 0.56, z + Math.cos(a1) * D * 0.56];
    const c2 = [x - 2.95, y + Math.sin(a2) * D * 0.56, z + Math.cos(a2) * D * 0.56];
    pushQuad(e1, e2, c2, c1, PALETTE.engineDark);
  }
  // 挂架(连接翼下)
  pushQuad([x + 1.2, y + D * 0.9, z - 0.45], [x + 1.2, y + D * 0.9, z + 0.45], [x - 1.8, y + D * 1.75, z + 0.45], [x - 1.8, y + D * 1.75, z - 0.45], PALETTE.engine);
}

// ── 尾翼 ────────────────────────────────────────────────────────────
function buildTail() {
  // 垂尾:梯形 + 后掠
  const rootX = LAYOUT.tailX + 14, rootY = 2.9, h = SPECS.tailHeight;
  const cRoot = 10.5, cTip = 4.2, sweep = 42 * DEG;
  const topX = rootX - h * Math.tan(sweep);
  pushQuad([rootX, rootY, 0], [rootX - cRoot, rootY, 0], [topX - cTip, rootY + h, 0], [topX, rootY + h, 0], PALETTE.wing);
  pushQuad([rootX, rootY, 0.18], [topX, rootY + h, 0.12], [topX - cTip, rootY + h, 0.12], [rootX - cRoot, rootY, 0.18], PALETTE.wing);
  pushQuad([rootX, rootY, -0.18], [rootX - cRoot, rootY, -0.18], [topX - cTip, rootY + h, -0.12], [topX, rootY + h, -0.12], PALETTE.wing);
  // 平尾
  for (const s of [1, -1]) {
    const half = SPECS.stabSpan / 2;
    const t1X = rootX - 1.2 - half * Math.tan(37 * DEG);
    pushQuad([rootX + 1.2, 1.15, s * 0.2], [rootX - 2.6, 1.15, s * 0.2], [t1X - 3.4, 1.7, s * half], [t1X + 0.6, 1.7, s * half], PALETTE.wing);
    pushQuad([rootX + 1.2, 1.02, s * 0.2], [t1X + 0.6, 1.58, s * half], [t1X - 3.4, 1.58, s * half], [rootX - 2.6, 1.02, s * 0.2], PALETTE.wing);
  }
}

// ── 细节层:舷窗带/驾驶舱风挡/舱门/天线/起落架 ────────────────────────
// 机身半径剖面(与放样同源):细节贴合轮廓不外飘
function radiusAt(x) {
  const t = (LAYOUT.noseX - x) / L;
  let r = 1;
  const noseT = 0.16, tailT = 0.22;
  if (t < noseT) r = Math.pow(t / noseT, 0.62);
  else if (t > 1 - tailT) r = lerp(1, 0.16, Math.pow((t - (1 - tailT)) / tailT, 1.5));
  return r * (FW / 2);
}
function buildDetails() {
  const halfW = FW / 2 + 0.02;
  const zAt = (x, y = 0) => {
    const r = radiusAt(x);
    return Math.sqrt(Math.max(0.05, r * r - y * y)) + 0.02;
  };
  // 驾驶舱风挡:机头顶部深色四边形组
  for (let k = 0; k < 4; k++) {
    const x0 = LAYOUT.noseX - 5.4 + k * 1.15;
    const z0 = zAt(x0, 2.4) * 0.98, z1 = zAt(x0 + 1.0, 2.5) * 0.98;
    pushQuad([x0, 2.55 + k * 0.08, z0], [x0 + 1.0, 2.62 + k * 0.08, z1], [x0 + 1.0, 2.28 + k * 0.06, z1 * 1.06], [x0, 2.2 + k * 0.06, z0 * 1.1], PALETTE.glass);
    pushQuad([x0 + 1.0, 2.62 + k * 0.08, -z1], [x0, 2.55 + k * 0.08, -z0], [x0, 2.2 + k * 0.06, -z0 * 1.1], [x0 + 1.0, 2.28 + k * 0.06, -z1 * 1.06], PALETTE.glass);
  }
  // 舷窗:主舱 + 上舱,沿机身两侧
  const rows = [
    { y: 1.05, from: LAYOUT.noseX - 11, to: LAYOUT.tailX + 16, n: 42 },
    { y: 2.62, from: LAYOUT.noseX - 9.5, to: LAYOUT.noseX - 26, n: 12 },
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const x = lerp(row.from, row.to, i / row.n);
      for (const s of [1, -1]) {
        pushQuad([x, row.y, s * zAt(x, row.y)], [x + 0.62, row.y, s * zAt(x + 0.62, row.y)], [x + 0.62, row.y + 0.42, s * zAt(x + 0.62, row.y + 0.42)], [x, row.y + 0.42, s * zAt(x, row.y + 0.42)], PALETTE.glass);
      }
    }
  }
  // 舱门(每侧 4 个,稍大的深色矩形)
  for (const dx of [22, 8, -16, -30]) {
    for (const s of [1, -1]) {
      pushQuad([dx, 0.35, s * zAt(dx, 0.35)], [dx + 1.35, 0.35, s * zAt(dx + 1.35, 0.35)], [dx + 1.35, 2.5, s * zAt(dx + 1.35, 2.5)], [dx, 2.5, s * zAt(dx, 2.5)], [0.72, 0.74, 0.78]);
    }
  }
  // 起落架:机头 2 轮 + 4 组主起落架各 4 轮(共 18 轮)
  const wheel = (x, y, z, r) => {
    for (let i = 0; i < 12; i++) {
      const a1 = (i / 12) * Math.PI * 2, a2 = ((i + 1) / 12) * Math.PI * 2;
      pushQuad([x, y + Math.sin(a1) * r, z + Math.cos(a1) * r], [x, y + Math.sin(a2) * r, z + Math.cos(a2) * r], [x + 0.55, y + Math.sin(a2) * r, z + Math.cos(a2) * r], [x + 0.55, y + Math.sin(a1) * r, z + Math.cos(a1) * r], PALETTE.gear);
    }
  };
  const strut = (x, yTop, yBot, z) => {
    const w = 0.17;
    pushQuad([x - w, yTop, z - w], [x - w, yTop, z + w], [x - w, yBot, z + w], [x - w, yBot, z - w], PALETTE.gear);
    pushQuad([x + w, yTop, z + w], [x + w, yTop, z - w], [x + w, yBot, z - w], [x + w, yBot, z + w], PALETTE.gear);
    pushQuad([x - w, yTop, z + w], [x + w, yTop, z + w], [x + w, yBot, z + w], [x - w, yBot, z + w], PALETTE.gear);
    pushQuad([x + w, yTop, z - w], [x - w, yTop, z - w], [x - w, yBot, z - w], [x + w, yBot, z - w], PALETTE.gear);
  };
  // 机头起落架(加长支柱,对齐全机高 19.4m)
  strut(LAYOUT.noseX - 12, -2.6, -5.5, 0);
  wheel(LAYOUT.noseX - 12.2, -5.55, 0.45, 0.62); wheel(LAYOUT.noseX - 12.2, -5.55, -0.45, 0.62);
  // 主起落架:翼下两组(每组 4 轮)+ 机身中线两组
  for (const [gx, gz] of [[-4, 4.2], [-4, -4.2], [-9.5, 1.4], [-9.5, -1.4]]) {
    strut(gx, -2.6, -5.9, gz);
    for (const dz of [-0.75, 0.75]) for (const dx of [-0.55, 0.55]) wheel(gx + dx, -5.95, gz + dz, 0.68);
  }
  // 天线(机背小片)+ APU 排气口
  pushQuad([-31.5, 3.42, -0.2], [-31.5, 3.42, 0.2], [-32.3, 4.05, 0.12], [-32.3, 4.05, -0.12], PALETTE.wing);
  pushQuad([-24.5, 3.35, -0.15], [-24.5, 3.35, 0.15], [-25.1, 3.85, 0.1], [-25.1, 3.85, -0.1], PALETTE.wing);
}

// ── 组装 & 导出 ──────────────────────────────────────────────────────
buildFuselage();
buildWing(1); buildWing(-1);
// 发动机:内侧 z=±12.2m、外侧 z=±23.5m,吊挂于翼下(y 随翼面抬升略抬)
for (const s of [1, -1]) {
  buildEngine(-10.5, -1.45, s * 12.2);   // 内侧发动机:翼下
  buildEngine(-16.8, -0.70, s * 23.5);   // 外侧发动机:翼下(随翼面抬升)
}
buildTail();
buildDetails();

export const TRIANGLES = tris;
export const TRI_COLORS = colors;
export const STATS = {
  triangles: tris.length,
  vertices: tris.length * 3,
};

// 导出纯数据(给 python 投影渲染器)
export function exportJSON() {
  return JSON.stringify({ specs: SPECS, layout: LAYOUT, triangles: TRIANGLES, colors: TRI_COLORS, stats: STATS });
}
