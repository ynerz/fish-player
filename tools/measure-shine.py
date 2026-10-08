# -*- coding: utf-8 -*-
"""measure-shine.py —— 分区量「闪度」：**头部 / 背部 / 腹部** 各自有多闪。

（由 `tools/measure-headbody.py`（量头身明暗差）与「腹部不闪」那次的临时脚本**合并**而来：
 一套掩膜、一套指标、三个区域 —— 同一件事别写两遍。
 旧口径 `SPEC_THRESH = 118` 抄自 `paint-card.py` 的 `add_specular`，而那个脚本**已不在管线里**
 （五档现在是纯文生图，`gen-art.py` 只在注释里提到它）⇒ 这里换成一个不依赖死代码的定义。）

为什么需要它（2026-10-08 用户两次报障：「闪光的问题在于肚子没那么闪光」「有些图头部不闪光」）：
    实测 18 条闪光卡**全部**是同一个形态 ——
      · 腹部**比背部更亮**（158~166 vs 139~148）却**更平**（本地对比 5.6~6.4 vs 12.8~14.4），
        闪度只有背的一半（9~10% vs 22~24%）；
      · 头部高光占比「身 − 头」中位 **+5.5pp**，最差的 D14 达 **+32.6pp**。
    ⇒ 不是"不够亮"，而是**亮处（腹部被 `a clearly lighter belly` 提亮、头部被 rim light 照亮）
      变成了均匀的浅色面，局部对比被洗掉 ⇒ 闪不起来**。
      闪光的视觉本质是「局部高对比的亮点」，不是"亮"。

跑法（**要 PIL，走 conda 的 python**）：
    C:/Users/15001/miniconda3/python.exe tools/measure-shine.py              # 所有闪光卡
    C:/Users/15001/miniconda3/python.exe tools/measure-shine.py D16 D14      # 指定 id
    C:/Users/15001/miniconda3/python.exe tools/measure-shine.py _tmp/x.png   # 直接给文件（A/B 用）

口径：
    · 区域（按剪影水平包围盒的百分比）：**头** 2%~22%（鱼朝左 ⇒ 头在左）；
      **背 / 腹** = 躯干中段 35%~65% 按每一列的上下端点对半切。
      ⚠️ 这是几何切分、不是解剖学的腹侧线；**只用于相对比较**（换词前 vs 换词后、头/背/腹之间），
        不要当绝对值看。
    · 掩膜 = 闪光卡的**真 alpha**（要有透明像素才算可用）；没有真 alpha 就按四角均色的**色距**取
      （与 `check-cards.py` 同口径）。
      🔴 踩过：ComfyUI 出的 PNG **也可能是 RGBA 但 alpha 全是 255** —— 直接拿它当掩膜会把**整张图**
        （含背景）算成鱼，平均亮度从 ~150 掉到 ~87，而且不报错，看着像"这条鱼就是暗"。
    · **闪度** = 「又亮又是局部尖点」的像素占比：`L > 150` **且** `|L − 5×5 均值| > 12`。
      两个条件必须同时成立：只用相对阈值时，**腹部很暗**的鱼会被算成"腹部更闪"（暗区噪点相对自己的
      中位数也算亮）—— 第一版就是这么被骗的。
    · 本地对比 = `|L − 5×5 均值|` 的均值（叠加亮片会把它抬起来）；亮度 = 区域平均 L。
"""
import os
import sys

from PIL import Image, ImageChops, ImageFilter, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "assets", "cards")
X0, X1 = 0.35, 0.65        # 躯干中段 ⇒ 背 / 腹
HX0, HX1 = 0.02, 0.22      # 头部（鱼朝左）
T_ABS, T_HP = 150, 12      # 闪度：绝对亮度下限 + 局部对比下限


def usable_alpha(im):
    """能不能拿 alpha 当剪影掩膜（要有**真的**透明像素；见文件头那个踩坑）。"""
    if im.mode != "RGBA":
        return None
    a = im.split()[3]
    h = a.histogram()
    return a if sum(h[:128]) > 0.01 * sum(h) else None


def mask_from_rgb(im, dist=20):
    """RGB（暗底）出图没有 alpha ⇒ 用四角均色的色距当掩膜（与 check-cards.py 同口径）。"""
    w, h = im.size
    px = im.convert("RGB").load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    m = Image.new("L", im.size, 0)
    pm = m.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            c = px[x, y]
            if abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) > dist:
                pm[x, y] = 255
    for y in range(0, h, 2):          # 粗网格补洞：向右下各填一格
        for x in range(0, w, 2):
            if pm[x, y]:
                if x + 1 < w:
                    pm[x + 1, y] = 255
                if y + 1 < h:
                    pm[x, y + 1] = 255
    return m


def region_masks(alpha, size):
    """按剪影切出 (头, 背, 腹) 三个掩膜。"""
    w, h = size
    px = alpha.load()
    xs = [x for x in range(w) if any(px[x, y] > 128 for y in range(0, h, 4))]
    if len(xs) < 40:
        return None, None, None
    x0, x1 = xs[0], xs[-1]
    hm = Image.new("L", size, 0)
    ph = hm.load()
    for x in range(x0 + int((x1 - x0) * HX0), x0 + int((x1 - x0) * HX1)):
        for y in range(h):
            if px[x, y] > 128:
                ph[x, y] = 255
    a, b = x0 + int((x1 - x0) * X0), x0 + int((x1 - x0) * X1)
    up, lo = Image.new("L", size, 0), Image.new("L", size, 0)
    pu, pl = up.load(), lo.load()
    for x in range(a, b):
        ys = [y for y in range(h) if px[x, y] > 128]
        if len(ys) < 8:
            continue
        mid = (ys[0] + ys[-1]) // 2
        for y in range(ys[0], mid):
            pu[x, y] = 255
        for y in range(mid, ys[-1] + 1):
            pl[x, y] = 255
    return hm, up, lo


def stats(lum, mask):
    """返回 (平均亮度, 闪度%, 本地对比能量)，区域像素不足时返回 None。"""
    if mask is None or sum(mask.histogram()[128:]) < 500:
        return None
    mean = ImageStat.Stat(lum, mask=mask).mean[0]
    hi = ImageChops.difference(lum, lum.filter(ImageFilter.BoxBlur(2)))
    glint = ImageChops.multiply(
        lum.point(lambda v: 255 if v > T_ABS else 0),
        hi.point(lambda v: 255 if v > T_HP else 0))
    glint = glint.point(lambda v: 255 if v > 128 else 0)
    n_all = sum(mask.histogram()[128:])
    n_glint = sum(ImageChops.multiply(mask, glint).histogram()[128:])
    return (mean, n_glint * 100.0 / n_all, ImageStat.Stat(hi, mask=mask).mean[0])


def measure(im):
    a = usable_alpha(im)
    alpha = a if a is not None else mask_from_rgb(im)
    lum = im.convert("L")
    hm, up, lo = region_masks(alpha, im.size)
    if hm is None:
        return None
    r = [stats(lum, x) for x in (hm, up, lo)]
    return None if any(x is None for x in r) else r


HEAD = "%-30s  头 %5.1f/%5.2f%%/%5.2f   背 %5.1f/%5.2f%%/%5.2f   腹 %5.1f/%5.2f%%/%5.2f   Δ(背-头) %+5.2fpp  Δ(背-腹) %+5.2fpp"


def line(name, r):
    h, u, l = r
    return HEAD % (name, h[0], h[1], h[2], u[0], u[1], u[2], l[0], l[1], l[2], u[1] - h[1], u[1] - l[1])


def main():
    args = sys.argv[1:]
    files = [a for a in args if os.sep in a or a.endswith(".png")]
    ids = [a for a in args if a not in files]
    if not ids and not files:
        ids = sorted(f[:-10] for f in os.listdir(CARDS)
                     if f.endswith("-shiny.png") and not f.startswith("_"))
    print("（亮度 / 闪度% / 本地对比）")
    out = []
    for f in files:
        im = Image.open(f)
        r = measure(im)
        out.append(line(os.path.basename(f), r) if r else "%-30s (区域像素不足)" % os.path.basename(f))
    for fid in ids:
        p = os.path.join(CARDS, fid + "-shiny.png")
        if not os.path.exists(p):
            out.append("%-30s (没有闪光卡)" % fid)
            continue
        r = measure(Image.open(p))
        out.append(line(fid, r) if r else "%-30s (区域像素不足)" % fid)
    print("\n".join(out))
    print("\n注：区域按剪影几何切分（头 2%~22%、背/腹 = 35%~65% 按列上下对半），只用于相对比较。")
    print("    闪度 = (L>%d 且 局部对比>%d) 的像素占比；Δ(背-腹)=正 ⇒ 腹部更不闪。" % (T_ABS, T_HP))


if __name__ == "__main__":
    main()
