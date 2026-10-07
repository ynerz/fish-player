# -*- coding: utf-8 -*-
"""面片密度测量 —— 判断「低模够不够精细」的客观指标。

用途：调 `GEOM`（防写实几何块）时，别只靠眼睛说「感觉块面少了」。
      这个脚本给一个可比的数：**鱼身剪影内「独立亮度色块」数 ÷ 千像素**。
      色块多 = 面片多 = 低模更细。

为什么需要它（真实的坑）：
  `GEOM` 原稿写的是 `large flat angular facets ... minimal surface detail` ——
  字面上命令模型「用大面片、少细节」，结果鱼身只有 30~50 个大块，
  比 v9 标准图的密集三角网糙得多，而且**光看单张图不容易意识到差多少**。
  有了这个数才能和靶子直接比。

参考值（2026-10-07 实测，1152×768 图）：
  v9 标准图 `docs/images/标准/fish_normal.jpg` ≈ **3.6**（靶子）
  老稿（large / minimal）                       ≈ 1.5
  现稿（dense triangular polygon mesh）          ≈ 3.3  ← 最贴靶子
  只写 `hundreds of small facets`                ≈ 5.7（过头，块面发碎）

算法（纯几何，不依赖模型）：
  ① 用四角均色当背景基准，色距 > 70 的像素算鱼身
  ② 只留最大连通块（去掉碎屑）
  ③ 鱼身内按亮度量化（步长 4），数面积 ≥ 25px 的独立色块

用法：
  python tools/facet-count.py docs/images/标准/fish_normal.jpg assets/cards/A01.png
  python tools/facet-count.py --ref        # 只跑 v9 标准图，看靶子还在不在

⚠️ 解释器：系统 conda（需要 PIL）：`C:/Users/15001/miniconda3/python.exe`
"""
import os, sys
from collections import deque

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 PIL：请用系统 conda 解释器 C:/Users/15001/miniconda3/python.exe")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "docs", "images", "标准", "fish_normal.jpg")

MIN_BLOCK = 25    # 色块面积下限（px）：低于它的算噪点不算面片
DIST = 70         # 与背景基准色的曼哈顿距离阈值
QUANT = 4         # 亮度量化步长


def component(seed, ok, w, h):
    """从 seed 出发的 4 连通块，返回成员下标列表。"""
    q = deque([seed]); seen = {seed}; mem = []
    while q:
        i = q.popleft(); mem.append(i)
        x, y = i % w, i // w
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if j not in seen and ok(j):
                    seen.add(j); q.append(j)
    return mem


def facet_density(path):
    im = Image.open(path).convert("RGB"); w, h = im.size; px = im.load()
    c = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    base = tuple(sum(v[i] for v in c) // 4 for i in range(3))

    def is_fish(i):
        r, g, b = px[i % w, i // w]
        return abs(r - base[0]) + abs(g - base[1]) + abs(b - base[2]) > DIST

    # ① 最大连通块 = 鱼身
    seen = bytearray(w * h)
    body = []
    for s in range(w * h):
        if not seen[s] and is_fish(s):
            mem = component(s, lambda j: (not seen[j]) and is_fish(j), w, h)
            for j in mem:
                seen[j] = 1
            if len(mem) > len(body):
                body = mem
    if not body:
        return 0, 0, base

    # ② 按亮度量化数色块
    lum = [0] * (w * h)
    for i in body:
        r, g, b = px[i % w, i // w]
        lum[i] = ((r * 299 + g * 587 + b * 114) // 1000) // QUANT
    mask = bytearray(w * h)
    for i in body:
        mask[i] = 1
    vis = bytearray(w * h)
    blocks = 0
    for s in body:
        if vis[s]:
            continue
        v0 = lum[s]
        mem = component(s, lambda j: (not vis[j]) and mask[j] and lum[j] == v0, w, h)
        for j in mem:
            vis[j] = 1
        if len(mem) >= MIN_BLOCK:
            blocks += 1
    return blocks, len(body), base


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--ref" in sys.argv or not args:
        args = [REF]
    print("%-46s %8s %10s %8s" % ("file", "色块数", "鱼身px", "每千px"))
    for p in args:
        if not os.path.exists(p):
            print("%-46s  不存在" % os.path.basename(p)); continue
        n, area, base = facet_density(p)
        d = (n / area * 1000) if area else 0
        print("%-46s %8d %10d %8.2f" % (os.path.basename(p), n, area, d))
    print("\n靶子（v9 标准图）≈ 3.6 / 千px。低于 2.5 = 块面偏少，高于 5 = 发碎。")


if __name__ == "__main__":
    main()
