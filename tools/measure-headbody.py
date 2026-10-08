# -*- coding: utf-8 -*-
"""measure-headbody.py —— 量「头 vs 身」的明暗 / 高光分布差，用来判断卡面的
「鱼头与身体不一致」是**模型给的结构**问题还是**着色层**的问题。

为什么需要它（2026-10-08，用户报障）：
    用户报「部分鱼的闪光，鱼头部分和身体部分不一样」，怀疑是颜色提示词互相干扰。
    而 `paint-card.py` 的着色是**灰度渐变映射**（`gray = im.convert("L")` → `apply_palette`），
    ⇒ **颜色 = 灰度的函数**。所以「头身颜色不一样」在数学上只可能来自两件事：
      ① 两个区域的**明暗**不同 → 被映射成不同色
      ② 叠加上去的**高光/亮片**分布不同 → 局部亮度被抬高（`add_specular` 的阈值是 118）
    这两个指标就是本脚本量的东西。

跑法（**要 PIL，走 conda 的 python**）：
    C:/Users/15001/miniconda3/python.exe tools/measure-headbody.py

口径：
    · 区域 = 鱼的水平包围盒切三段：头 2%~22%，身 35%~75%（避开尾）
    · 掩膜 = **闪光卡的 alpha**。母版是同种子同提示词（只差颜色句）出的，剪影几乎一致，
      所以同一套掩膜可以套在母版上 —— 这样两档的区域定义**完全一样**，才可比。
    · 只看**同时有母版与闪光卡**的鱼（当前 127 条里只有 17 条满足）。
"""
import io, os, json, statistics as st
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARD = os.path.join(ROOT, 'assets', 'cards')
SPEC_THRESH = 118          # paint-card.py 里 add_specular 的阈值，改那边要同步这里


def _bbox_x(mask):
    W, H = mask.size
    mp = mask.load()
    xs = [x for x in range(W) if any(mp[x, y] for y in range(0, H, 4))]
    return (min(xs), max(xs)) if xs else None


def _band(im, mask, a, b, agg):
    W, H = im.size
    px, mp = im.load(), mask.load()
    bb = _bbox_x(mask)
    if not bb:
        return None
    x0, x1 = bb
    lo, hi = x0 + int((x1 - x0) * a), x0 + int((x1 - x0) * b)
    vals = [px[x, y] for x in range(lo, hi) for y in range(H) if mp[x, y]]
    return agg(vals) if vals else None


def head_body(im, mask):
    """(头中位亮度, 身中位亮度, 头高光占比%, 身高光占比%)"""
    med = lambda v: st.median(v)
    share = lambda v: 100.0 * sum(1 for x in v if x > SPEC_THRESH) / len(v)
    return (_band(im, mask, 0.02, 0.22, med), _band(im, mask, 0.35, 0.75, med),
            _band(im, mask, 0.02, 0.22, share), _band(im, mask, 0.35, 0.75, share))


def main():
    ids = sorted(json.load(io.open(os.path.join(CARD, 'manifest.json'), encoding='utf-8')).keys())
    rows = []
    for i in ids:
        fs, fn = os.path.join(CARD, i + '-shiny.png'), os.path.join(CARD, i + '.png')
        if not (os.path.exists(fs) and os.path.exists(fn)):
            continue
        sh = Image.open(fs)
        if sh.mode != 'RGBA':
            continue
        mask = sh.split()[-1]
        if mask.getextrema()[1] == 0:
            continue
        g_sh = sh.convert('L')
        g_no = Image.open(fn).convert('L').resize(sh.size)
        a, b = head_body(g_sh, mask), head_body(g_no, mask)
        if None in a or None in b:
            continue
        rows.append((i, a, b))

    if not rows:
        print('没有可比样本（需要同一条鱼同时有母版卡与闪光卡）')
        return

    d_sh = [abs(r[1][0] - r[1][1]) for r in rows]
    d_no = [abs(r[2][0] - r[2][1]) for r in rows]
    h_sh = [r[1][3] - r[1][2] for r in rows]
    h_no = [r[2][3] - r[2][2] for r in rows]

    print('可比样本：%d 条' % len(rows))
    print('头/身 中位亮度差 —— 闪光：中位 %.1f 最大 %.0f ｜ 母版：中位 %.1f 最大 %.0f'
          % (st.median(d_sh), max(d_sh), st.median(d_no), max(d_no)))
    print('高光占比「身 − 头」—— 闪光：中位 %+.1fpp 最大 %+.1fpp ｜ 母版：中位 %+.1fpp 最大 %+.1fpp'
          % (st.median(h_sh), max(h_sh), st.median(h_no), max(h_no)))

    bad = [(r[0], r[1][0], r[1][1], abs(r[1][0] - r[1][1]), r[2][0], r[2][1], abs(r[2][0] - r[2][1]),
            r[1][3] - r[1][2], r[2][3] - r[2][2]) for r in rows]
    worst = sorted(bad, key=lambda r: min(r[3] - r[6], r[7] - r[8]), reverse=True)[:10]
    print('\n闪光档比母版更失衡的前 10 条（母版可作对照）：')
    print('  id    亮度 头/身 |Δ|  ｜ 母版 |Δ|  ｜ 高光 身-头  ｜ 母版')
    for r in worst:
        print('  %-4s  %3d/%3d |%3d|  ｜  |%3d|  ｜ %+5.1fpp  ｜ %+5.1fpp'
              % (r[0], r[1], r[2], r[3], r[6], r[7], r[8]))
    print('\n⚠️ 这只是**信号**，不是判据：中位数差一点点可能只是该鱼头部本来就暗。')
    print('   判定「卡面不合格」仍要靠人看图（或先定出阈值再写进 check-cards.py）。')


if __name__ == '__main__':
    main()
