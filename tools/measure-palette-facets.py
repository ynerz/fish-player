# -*- coding: utf-8 -*-
"""tools/measure-palette-facets.py — 量**传说档配色的色相分布** + **各档的面片密度**。

由来（Q47，2026-10-11 从 `_tmp/measure_q5_q29.py` 搬进库）：
  那是 Q5（传说档配色挤在青蓝一头）与 Q29（黄金档面片发碎 / 闪光档面片偏少）两轮
  「**先量后改**」用的标尺 —— 口径是「**拿数字说话，别只靠眼睛**」。
  当初把它留在 `_tmp/`（gitignore）⇒ 换机器 / 新克隆就没了，而 `docs/配色与面片-方案.md`
  还指着它 ⇒ 照着文档做的人会先撞上一个不存在的文件。现按项目规矩搬进 `tools/`。

两段各自独立，缺输入就跳过（不报错）：
  ① **色相分布**（只要 `src/data/fish.js`）：传说档（`rar == 3`）的 body 色落在 12 个 30° 带里的哪几个 ——
     Q5 之前是「27 条里 23 条挤在 180°~270°、5 个带全空」，改完是「每带 2~3 条、无空档」。
     ⚠️ 现状已由 `verify §52` 钉住（12 带不许有空档、最挤 ≤ 6）；本工具给人看的是**直方图**，用来出方案。
  ② **面片密度**（要 `assets/cards/*.png` + PIL + `tools/facet-count.py`）：各档抽 24 张取中位，
     靶子 = `facet-count.py` 的 `REF`（v9 ≈ 3.6；<2.5 偏少、>5 发碎）。

用法（要 PIL ⇒ **系统 conda** 解释器；参数面走 argparse，`-h` 看全量用法、未知开关报错退出 2）：
    C:/Users/15001/miniconda3/python.exe tools/measure-palette-facets.py
"""
import argparse
import colorsys
import glob
import importlib.util
import io
import os
import random
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CARDS = os.path.join(ROOT, 'assets', 'cards')
SEED = 7          # 样本固定 ⇒ 两次跑逐字相同（本项目对「带随机性的工具」的硬规矩）
N_SAMPLE = 24


def hue_of(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, _l, s = colorsys.rgb_to_hls(r, g, b)
    return hh * 360, s


def band(deg):
    return int(deg // 30) * 30


def read_fish():
    raw = io.open(os.path.join(ROOT, 'src', 'data', 'fish.js'), encoding='utf-8').read()
    rows = re.findall(r"F\('([A-Z]+\d+)', '([^']*)', (\d), '([a-z]+)', '(#[0-9a-fA-F]{6})'", raw)
    if not rows:
        sys.exit('[!] 从 fish.js 里一条都认不出 —— 生成格式变了，先修本工具的正则')
    return [(i, n, int(r), sh, body) for i, n, r, sh, body in rows]


def part_hues(rows):
    leg = [(i, n, body) for i, n, r, _sh, body in rows if r == 3]
    print('=' * 74)
    print('① 传说档（rar 3）body 色的色相分布 —— 共 %d 条' % len(leg))
    c = Counter()
    for _i, _n, body in leg:
        c[band(hue_of(body)[0])] += 1
    for b in range(0, 360, 30):
        if c[b]:
            print('   %3d°~%3d°  %2d 条  %s' % (b, b + 30, c[b], '█' * c[b]))
    blue = sum(v for k, v in c.items() if 180 <= k < 270)
    print('   ⇒ 180°~270°（青/蓝）里 %d / %d = %.0f%%' % (blue, len(leg), 100.0 * blue / len(leg)))
    empty = [b for b in range(0, 360, 30) if not c[b]]
    print('   ⇒ 完全空着的 30° 档：%s' % ('、'.join('%d°' % b for b in empty) or '无'))
    allc = Counter()
    for _i, _n, _r, _sh, body in rows:
        allc[band(hue_of(body)[0])] += 1
    print('\n   全表 %d 条的分布（对照）：%s'
          % (len(rows), ' ／ '.join('%d°:%d' % (b, allc[b]) for b in range(0, 360, 30))))


def part_facets():
    try:
        from PIL import Image                      # noqa: F401 —— 只是探一下能不能用
    except ImportError:
        print('\n（跳过 ②：需要 PIL —— 用系统 conda 解释器跑）')
        return
    spec = importlib.util.spec_from_file_location('fc', os.path.join(HERE, 'facet-count.py'))
    fc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fc)
    random.seed(SEED)
    print('\n' + '=' * 74)
    print('② 面片密度（靶子 v9 ≈ 3.6；<2.5 偏少、>5 发碎）—— 每档抽 %d 张取中位，seed 固定 %d'
          % (N_SAMPLE, SEED))
    for tag in ('golden', 'shiny', 'bright', 'albino'):
        files = sorted(glob.glob(os.path.join(CARDS, '*-%s.png' % tag)))
        if not files:
            print('   %-8s 盘上没有这一档的图，跳过' % tag)
            continue
        pick = random.sample(files, min(N_SAMPLE, len(files)))
        vals = []
        for p in pick:
            n, area, _base = fc.facet_density(p)
            if area:
                vals.append(n / area * 1000)
        if not vals:
            print('   %-8s 样本都量不出面积，跳过' % tag)
            continue
        vals.sort()
        print('   %-8s 样本 %2d 张  中位 **%.2f**  区间 %.2f ~ %.2f'
              % (tag, len(vals), vals[len(vals) // 2], vals[0], vals[-1]))
    if os.path.exists(fc.REF):
        n, area, _b = fc.facet_density(fc.REF)
        print('   %-8s 靶子          **%.2f**' % ('v9', n / area * 1000 if area else 0))
    print('\n（样本每次同一批 —— seed 固定；要扩大样本改本文件顶部的 N_SAMPLE）')


def parse_args(argv=None):
    """参数面走 **argparse**（Q90，2026-10-12 第 58 轮）。

    ⚠️ 原先**完全不看 argv**：`--help`（乃至任何拼错的开关）都被无声忽略、
       然后照常跑完整量测 —— 没有 usage 出口，用的人也看不出自己写错了什么。
       走 argparse 后：`-h/--help` ⇒ 退出 0、未知开关 ⇒ 退出 **2**
       （与 `tools/argv.js` 在 js 侧约定的「2 = 用法错」同源）。
    """
    ap = argparse.ArgumentParser(
        prog="measure-palette-facets.py",
        description="量传说档配色的色相分布（12 个 30° 带）+ 各档的面片密度中位。")
    return ap.parse_args(argv)


def main(argv=None):
    parse_args(argv)                   # 只为用法面（本工具没有开关）；写法错在这里就以 2 退出
    rows = read_fish()
    part_hues(rows)
    part_facets()
    return 0


if __name__ == '__main__':
    sys.exit(main())
