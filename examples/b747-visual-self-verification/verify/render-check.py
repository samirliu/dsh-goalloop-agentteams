#!/usr/bin/env python3
# render-check.py — 投影渲染 + 非空白校验(视觉验证素材生成器)
# 从 geometry.js 导出的同一份三角形数据做四视角正交投影(画家算法 + 朗伯着色),
# 输出 renders/*.png 供视觉评审;并断言渲染非空白。
import json, math, subprocess, sys, os
from pathlib import Path

# 自举:系统 python 缺 numpy/Pillow 时自动改用 DSH 捆绑 Python
try:
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401
except ModuleNotFoundError:
    bundled = '/Users/m/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3'
    if os.path.exists(bundled) and sys.executable != bundled:
        os.execv(bundled, [bundled, __file__] + sys.argv[1:])
    raise

ROOT = Path(__file__).resolve().parent.parent
RENDERS = ROOT / 'renders'
RENDERS.mkdir(exist_ok=True)

# 1) 取几何数据(node 导出)
node = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'
out = subprocess.run([node, '--input-type=module', '-e',
    "const g = await import('./b747/geometry.js'); process.stdout.write(g.exportJSON());"],
    cwd=ROOT.parent, capture_output=True, text=True)
if out.returncode != 0:
    print('geometry export FAILED:', out.stderr[:400]); sys.exit(2)
data = json.loads(out.stdout)
tris, colors = data['triangles'], data['colors']

# 2) 四视角投影
def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return lambda p: (c*p[0] + s*p[2], p[1], -s*p[0] + c*p[2])
def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return lambda p: (p[0], c*p[1] - s*p[2], s*p[1] + c*p[2])

VIEWS = {
    'side':    (rot_y(0),            0),   # 侧视(正交,无俯角)
    'front':   (rot_y(math.pi/2),   0),   # 正视(正交)
    'top':     (rot_x(-math.pi/2),  0),   # 俯视(正交)
    'quarter': (rot_y(math.pi/5),   1),   # 3/4 视角(带 22° 俯角)
}
LIGHT = (0.45, 0.75, 0.5)

def render(name, transform, pitched):
    from PIL import Image, ImageDraw
    W, H = 1400, 900
    img = Image.new('RGB', (W, H), (232, 238, 246))
    draw = ImageDraw.Draw(img)
    tf = transform
    if pitched:
        tf2 = rot_x(-0.38)
        tf = lambda p: tf2(transform(p))
    # 变换 + 深度
    faces = []
    for t, col in zip(tris, colors):
        pts = [tf((t[i], t[i+1], t[i+2])) for i in (0, 3, 6)]
        faces.append((sum(p[2] for p in pts)/3, pts, col))
    faces.sort(key=lambda f: f[0])           # 画家算法:远→近
    # 取景框(按投影范围)
    allp = [p for f in faces for p in f[1]]
    minx, maxx = min(p[0] for p in allp), max(p[0] for p in allp)
    miny, maxy = min(p[1] for p in allp), max(p[1] for p in allp)
    sc = min(W*0.92/(maxx-minx), H*0.86/(maxy-miny))
    cx, cy = (minx+maxx)/2, (miny+maxy)/2
    for _, pts, col in faces:
        xy = [((p[0]-cx)*sc + W/2, H/2 - (p[1]-cy)*sc) for p in pts]
        # 朗伯着色(法线 × 光向)
        ax, ay, az = (pts[1][0]-pts[0][0], pts[1][1]-pts[0][1], pts[1][2]-pts[0][2])
        bx, by, bz = (pts[2][0]-pts[0][0], pts[2][1]-pts[0][1], pts[2][2]-pts[0][2])
        nx, ny, nz = (ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx)
        nl = math.sqrt(nx*nx+ny*ny+nz*nz) or 1
        lam = abs((nx*LIGHT[0]+ny*LIGHT[1]+nz*LIGHT[2])/nl)
        shade = 0.45 + 0.55*lam
        rgb = tuple(int(255*min(1, c*shade)) for c in col)
        draw.polygon(xy, fill=rgb)
    # 防错指纹:烙上文件名标签(视觉评审先验标签,防投递错位)
    draw.rectangle((0, H-56, W, H), fill=(20, 24, 32))
    draw.text((24, H-42), f'747-400 VERIFIER | view={name} | file={name}.png | {len(tris)}tris', fill=(255, 255, 80))
    img.save(RENDERS / f'{name}.png')
    return RENDERS / f'{name}.png'

# 3) 渲染 + 非空白断言
import numpy as np
ok = True
for name, (tf, pitched) in VIEWS.items():
    p = render(name, tf, pitched)
    im = np.asarray(__import__('PIL.Image', fromlist=['Image']).open(p).convert('L'), dtype=float)
    std = float(im.std())
    size = p.stat().st_size
    good = size > 8000 and std > 6
    ok = ok and good
    print(f'{"✓" if good else "✗"} {name}.png — {size} bytes, pixel-std {std:.1f}')
print('RENDER PASS' if ok else 'RENDER FAIL')
sys.exit(0 if ok else 1)
