"""轮廓测量：把 v9 参考图与 3D 网格出图按**同一套量法**比出宽高比与宽度剖面。

用法：
  1) 参考图放 docs/images/v9-ref/<体型>.jpg
  2) 网格出图放 docs/images/_m3d/<体型>.png（用 tools/style-preview-3d.html 的「对比 v9」视图
     或任意一次离屏渲染导出，尺寸 900×600 即可）
  3) python tools/measure-silhouette.py

为什么要有这个脚本：体型比例**不能靠肉眼估**。v9 那批图是美术方向，
本项目的网格参数是照着量出来的数字拟合的（见 docs/3D渲染方案.md §12）。
"""
# -*- coding: utf-8 -*-
"""同一套量法对比 v9 参考图 与 我的 3D 网格出图。"""
import subprocess, os
FF = r"E:/novels/ffmpeg-7.0.2-full_build-shared/bin/ffmpeg"
W, H = 900, 600

def profile_of(path, thr):
    r = subprocess.run([FF, "-loglevel", "error", "-y", "-i", path,
                        "-vf", "scale=%d:%d:flags=neighbor" % (W, H),
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True)
    b = r.stdout
    if len(b) < W*H*3: return None
    bg = (b[0], b[1], b[2])
    cols = []
    for x in range(W):
        top = bot = -1; base = x*3
        for y in range(H):
            i = base + y*W*3
            if (abs(b[i]-bg[0]) + abs(b[i+1]-bg[1]) + abs(b[i+2]-bg[2])) > thr:
                if top < 0: top = y
                bot = y
        cols.append((top, bot))
    xs = [x for x, (t, bo) in enumerate(cols) if t >= 0]
    if not xs: return None
    x0, x1 = xs[0], xs[-1]
    bh = max(cols[x][1] for x in xs) - min(cols[x][0] for x in xs) + 1
    bw = x1-x0+1
    prof = []
    for k in range(12):
        a = x0 + int(bw*k/12); c = max(a+1, x0 + int(bw*(k+1)/12))
        seg = [cols[x][1]-cols[x][0]+1 for x in range(a, c) if cols[x][0] >= 0]
        prof.append(round(max(seg)/bh, 2) if seg else 0.0)
    return dict(ar=round(bw/bh, 2), fill=round(bw/W, 2), prof=prof)

REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "images", "v9-ref")
MINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "images", "m3d")
print("%-7s %-28s %s" % ("体型", "v9 参考（宽高比 / 剖面）", "我的网格"))
print("-" * 96)
for k in ["fish", "shark", "ray", "squid", "jelly", "dragon"]:
    a = profile_of(os.path.join(REF, k + ".jpg"), 70)
    b = profile_of(os.path.join(MINE, k + ".png"), 30)
    if not a or not b:
        print(k, "测量失败"); continue
    print("%-7s 比 %5.2f  %s" % (k, a["ar"], a["prof"]))
    print("%-7s 比 %5.2f  %s   ← 我的" % ("", b["ar"], b["prof"]))
    print()
