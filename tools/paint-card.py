# -*- coding: utf-8 -*-
"""图鉴卡面上色 —— 从 AI 出的原色母版派生 5 种颜色变异（透明底 RGBA）。

为什么要有这一步，而不是每种颜色各出一张 AI 图：

  1. **颜色口径必须与游戏一致** —— 直接调 `src/render/fishpaint.js` 的 `palette()`，
     **不重新实现一遍**（借 node 调用，同一招 `gen-art.py:load_fish()` 已经用过）。
     重写一遍 = 两处同口径 = 迟早分家，这是本项目反复踩过的坑型。
  2. **同一构图** —— 5 档共用一张母版，姿态**逐像素一致**，切换颜色时绝不跳变。
     AI 分别出图一定会跳（扩散模型画不出「同一条鱼换个色」）。
  3. **成本** —— 362 张出图 → 1810 张，靠 CPU 几十秒搞定，一点都不用 AI 重画。

做法（标准的 duotone / gradient map，不是"调色滤镜"）：

    AI 母版 → 灰度（保留光影结构）→ 双色渐变映射（背色 → 腹色）→ 抠背景 → RGBA

  为什么是渐变映射而不是 HSL 直接改：HSL 改色会把阴影一起提亮、把亮部一起压暗，
  整条鱼糊成一块；渐变映射**保住灰度结构**，只换"用什么颜色去表现这个明暗"。

⚠️ 解释器：**必须用系统 conda 的 python**（有 PIL 12.2），managed 那个没有 Pillow。

用法：
  python tools/paint-card.py --list D01,D16      # 指定鱼
  python tools/paint-card.py --all               # 全部已有母版的鱼
  python tools/paint-card.py --list D01 --morph golden   # 只出一档
"""
import argparse, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "assets", "cards")
# ⚠️ 用 conda 的解释器（有 PIL）；managed 的 3.13.12 没装 Pillow
PY = r"C:/Users/15001/miniconda3/python.exe"
NODE = "node"

try:
    from PIL import Image, ImageChops, ImageFilter, ImageOps
except ImportError:
    print("需要 Pillow —— 请用系统 conda 的 python 运行：%s" % PY)
    sys.exit(1)

# —— 抠图参数 ——
# 母版背景是纯黑/近黑（gen-art.py 的 STYLE 要求的），主体带边缘光、明显更亮。
# 阈值不宜太小（会吃掉暗部）也不宜太大（会留下背景噪点）。
MASK_THRESH = 20      # 与背景色的差异超过它才算主体
MASK_FEATHER = 1.4    # 边缘羽化，避免锯齿硬边

# ⚠️ 母版是「暗底 + 边缘光」，灰度整体偏暗（这是为深色卡面选的照明，不是失误）。
#    直接拿它做渐变映射，**大片身体会被压进暗段** —— albino 档最明显：
#    整条鱼落在「淡粉」那一段，出来是一条粉鱼，而不是 v8 那种「白身 + 粉鳍」。
#    所以先做一次伽马提亮，把中调推到中高段，让 back 色只落在**真正暗的地方**
#    （鳍、暗面、外轮廓）。0.62 是实测值：再低身体会过曝丢结构，再高粉压不下去。
GAMMA = 0.62

# 构图归一后的统一占比：主体**最长边**占画面的比例。
# ⚠️ 为什么必须做：不做的话 362 条鱼在图鉴列表里大小差很多 ——
#    实测黄鳝（宽高比 11）主体只占画面 **5%**，普通鱼占 **22%**，差 4 倍，
#    列表里一眼看出「有的鱼大有的鱼小」。归一之后都按最长边对齐，尺寸感一致。
TARGET_FILL = 0.80


def tone_normalize(gray):
    """输入曲线归一：把母版的中调提亮，保证 back 色只吃暗部"""
    if GAMMA == 1.0:
        return gray
    return gray.point(lambda p: int(255.0 * (p / 255.0) ** GAMMA))


def normalize_frame(rgb, mask, target=TARGET_FILL):
    """构图归一：按主体包围盒裁出 → 等比缩放到统一占比 → 居中贴回原尺寸透明画布。

    输入 rgb（上色后的图）与 mask（主体蒙版），输出 RGBA。
    ⚠️ 缩放用 LANCZOS，蒙版也要跟着缩放并用它当 alpha，
       否则边缘会出现一圈硬边（蒙版没缩、图缩了）。
    """
    W, H = rgb.size
    bbox = mask.getbbox()
    if not bbox:
        return Image.new("RGBA", (W, H), (0, 0, 0, 0))

    sub, sub_mask = rgb.crop(bbox), mask.crop(bbox)
    bw, bh = sub.size
    k = min(W * target / bw, H * target / bh)
    nw, nh = max(1, int(round(bw * k))), max(1, int(round(bh * k)))

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(sub.resize((nw, nh), Image.LANCZOS),
              ((W - nw) // 2, (H - nh) // 2),
              sub_mask.resize((nw, nh), Image.LANCZOS))
    return out


def load_palettes(ids):
    """借 node 调 FishPaint.palette() —— 颜色口径的**唯一来源**在 JS 那边"""
    js = ("global.window=global;"
          "require('./src/data/config.js');require('./src/data/fields.js');"
          "require('./src/data/fish.js');require('./src/render/fishpaint.js');"
          "var want=%s,out={};"
          "G.FISH.forEach(function(f){ if(want.indexOf(f.id)<0) return;"
          "  var o={};"
          "  G.FishPaint.MORPH_KEYS.forEach(function(k){"
          "    o[k]=G.FishPaint.palette(f.body,f.accent,k); });"
          "  out[f.id]={name:f.name,rar:f.rar,morphs:o}; });"
          "console.log(JSON.stringify(out));" % json.dumps(ids))
    r = subprocess.run([NODE, "-e", js], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-800:]); sys.exit(1)
    return json.loads(r.stdout)


def to255(c):
    """fishpaint 返回 0~1 的浮点 RGB → PIL 要的 0~255 整数三元组"""
    return tuple(max(0, min(255, int(round(v * 255)))) for v in c[:3])


def bg_color(im):
    """取背景基准色：画面四条边中段的中位色（不碰中间，中间是主体）"""
    w, h = im.size
    px = im.load()
    samples = []
    for x in range(0, w, max(1, w // 60)):
        samples.append(px[x, 1]); samples.append(px[x, h - 2])
    for y in range(0, h, max(1, h // 40)):
        samples.append(px[1, y]); samples.append(px[w - 2, y])
    samples.sort(key=lambda c: sum(c))
    return samples[len(samples) // 2]


def paint_one(src, dst, back, belly, bg=None):
    im = Image.open(src).convert("RGB")

    # ① 灰度 → 输入曲线归一 → 双色渐变映射（暗部=背色，亮部=腹色）
    gray = tone_normalize(im.convert("L"))
    colored = ImageOps.colorize(gray, to255(back), to255(belly))

    # ② 抠主体：与背景色差异超阈值的算主体
    base = bg or bg_color(im)
    diff = ImageChops.difference(im, Image.new("RGB", im.size, base)).convert("L")
    mask = diff.point(lambda p: 255 if p > MASK_THRESH else 0, "L")
    mask = mask.filter(ImageFilter.MaxFilter(3))          # 膨胀，吃掉主体外圈
    mask = mask.filter(ImageFilter.GaussianBlur(MASK_FEATHER))

    # ③ 构图归一 + 合成到透明底
    out = normalize_frame(colored, mask)
    out.save(dst)
    return sum(mask.histogram()[128:])                    # 主体像素数（不触发 getdata 弃用告警）


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--morph", default="", help="只出某一档（默认全出 5 档）")
    args = ap.parse_args()

    if args.all:
        ids = sorted(f[:-4] for f in os.listdir(CARDS)
                     if f.endswith(".png") and not f.startswith("_"))
    elif args.list:
        ids = [x.strip() for x in args.list.split(",") if x.strip()]
    else:
        ap.error("要 --list 或 --all")

    ids = [i for i in ids if os.path.exists(os.path.join(CARDS, i + ".png"))]
    if not ids:
        print("没有可用的母版（assets/cards/<id>.png）"); return

    pal = load_palettes(ids)
    keys = ["normal", "bright", "albino", "golden", "shiny"]
    if args.morph:
        keys = [args.morph]

    print("母版 %d 张，颜色档 %s" % (len(ids), "/".join(keys)))
    n = 0
    for fid in ids:
        info = pal.get(fid)
        if not info:
            print("  %s 没有配色信息，跳过" % fid); continue
        src = os.path.join(CARDS, fid + ".png")
        for k in keys:
            p = info["morphs"][k]
            dst = os.path.join(CARDS, "%s-%s.png" % (fid, k))
            px = paint_one(src, dst, p["back"], p["belly"])
            n += 1
            print("  %s %-6s → %s  (主体 %d px)" % (fid, k, os.path.basename(dst), px))
    print("\n共 %d 张" % n)


if __name__ == "__main__":
    main()
