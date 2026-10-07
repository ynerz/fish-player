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
import argparse, hashlib, json, os, random, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "assets", "cards")
# ⚠️ 用 conda 的解释器（有 PIL）；managed 的 3.13.12 没装 Pillow
PY = r"C:/Users/15001/miniconda3/python.exe"
NODE = "node"

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
except ImportError:
    print("需要 Pillow —— 请用系统 conda 的 python 运行：%s" % PY)
    sys.exit(1)

# —— 抠图参数 ——
# 母版背景是纯黑/近黑（gen-art.py 的 STYLE 要求的），主体带边缘光、明显更亮。
# 阈值不宜太小（会吃掉暗部）也不宜太大（会留下背景噪点）。
MASK_THRESH = 20      # 与背景色的差异超过它才算主体
MASK_FEATHER = 1.4    # 边缘羽化，避免锯齿硬边

# ⚠️ 母版是「暗底 + 边缘光」，灰度整体偏暗。初版加了一道伽马提亮（0.62）想把中调推上去，
#    结果**整体过曝**：黄金档尤其明显 —— 本该是「深金 → 亮金 → 白热高光」的金属，
#    被推成了「一片发白的淡黄」，跟标准图差得最远。
#    实测对拍 0.62 / 0.85 / 1.0：**1.0（不提亮）在三档上都最好**，
#    而且黄金档的暗部层次只有不提亮才保得住。
#    所以这里保留这条通路但默认关闭 —— 需要时（例如某批母版确实过暗）再调。
GAMMA = 1.0

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


def multi_stops_lut(stops):
    """多色标渐变 → 三个 256 项查找表（给 PIL 的 `point()` 用）。

    ⚠️ `ImageOps.colorize` 只吃**两个**色标，**做不出彩虹** —— 亮色档改成多色相之后
       （用户 2026-10-07 口径）必须手写 LUT。
    stops = [(pos, (r,g,b)), ...]，pos 从 0 到 1 递增。
    """
    luts = [[], [], []]
    n = len(stops)
    for i in range(256):
        t = i / 255.0
        j = 0
        while j < n - 2 and t > stops[j + 1][0]:
            j += 1
        p0, c0 = stops[j]
        p1, c1 = stops[j + 1]
        f = 0.0 if p1 <= p0 else (t - p0) / (p1 - p0)
        f = max(0.0, min(1.0, f))
        for ch in range(3):
            luts[ch].append(int(round(max(0.0, min(1.0, c0[ch] + (c1[ch] - c0[ch]) * f)) * 255)))
    return luts


def apply_palette(gray, pal):
    """灰度 → 上色。

    - **彩虹档**（`pal` 带 `bands`）：多色标 LUT，色相沿亮度走一遍色带
    - 其余档：两色渐变映射（与之前一致）
    两条路都**保留灰度结构**，只换「用什么颜色去表现这个明暗」。
    """
    bands = pal.get("bands")
    if bands and len(bands) > 1:
        n = len(bands)
        stops = [(i / float(n - 1), tuple(bands[i])) for i in range(n)]
        luts = multi_stops_lut(stops)
        return Image.merge("RGB", (gray.point(luts[0]),
                                   gray.point(luts[1]),
                                   gray.point(luts[2])))
    return ImageOps.colorize(gray, to255(pal["back"]), to255(pal["belly"]))


def add_specular(rgb, gray, thresh=118, gain=2.2):
    """**镜面高光层** —— 黄金档靠它出「大片反光」，否则只是「黄色的鱼」。

    ⚠️ 为什么必须有：渐变映射只能给「深金 → 浅金」，**做不出「白热高光」**。
       实测对比标准图，缺了这一层时黄金档完全没有金属感（像塑料）。
    做法：灰度高端（> thresh）线性推到亮，叠一层**略暖的白**。
    ⚠️ `thresh` 必须按**母版的实际灰度分布**定，不能凭感觉：
       本批母版的 5%~95% 分位是 **22~176**，初版取 165 时只有 ~5% 的像素能触发，
       出图几乎看不出高光。118 大致是分位 70% 左右，覆盖面才够。
    """
    hi = gray.point(lambda p: int(min(255, max(0, p - thresh) * gain)))
    warm = Image.merge('RGB', [hi,
                               hi.point(lambda p: int(p * 0.96)),
                               hi.point(lambda p: int(p * 0.84))])
    return ImageChops.add(rgb, warm)


def add_sparkles(rgb, mask, seed, count=200):
    """**星点层** —— 闪光档靠它出「闪烁感」。

    ⚠️ 必须有：标准图的闪光档是「虹彩 + 密集星点」，纯靠颜色映射只能得到一片白。
    ⚠️ **尺寸要按输出分辨率定**：图是 1152×768，但卡面在 UI 里只显示 ~380px 宽，
       所以星点必须画得**比"看起来合适"更大**（6~16px），否则缩放后一个都看不见
       ——初版画的 2~5px 在缩略图里完全消失。
    ⚠️ 用**稳定随机**（种子来自鱼 id）—— 同一条鱼每次出图星点位置一样，可复现。
    """
    rnd = random.Random(hashlib.md5(str(seed).encode('utf-8')).hexdigest())
    w, h = rgb.size
    px = mask.load()
    draw = ImageDraw.Draw(rgb)
    placed, tries = 0, 0
    while placed < count and tries < count * 60:
        tries += 1
        x, y = rnd.randrange(8, w - 8), rnd.randrange(8, h - 8)
        if not px[x, y]:
            continue
        # 避开最外圈（那里是边缘光）
        if not (px[x - 6, y] and px[x + 6, y] and px[x, y - 6] and px[x, y + 6]):
            continue
        placed += 1
        s = rnd.randint(6, 16)
        col = rnd.choice([(255, 255, 255), (255, 250, 215), (205, 232, 255)])
        draw.line([(x - s, y), (x + s, y)], fill=col, width=2)
        draw.line([(x, y - s), (x, y + s)], fill=col, width=2)
        if s >= 10:      # 大星点画四个小斜角，更像星芒
            q = max(2, s // 3)
            draw.line([(x - q, y - q), (x + q, y + q)], fill=col, width=1)
            draw.line([(x - q, y + q), (x + q, y - q)], fill=col, width=1)
    return rgb


def paint_one(src, dst, pal, morph, bg=None):
    im = Image.open(src).convert("RGB")

    # ① 灰度 → 输入曲线归一 → 上色（彩虹档走多色标，其余走两色）
    gray = tone_normalize(im.convert("L"))
    colored = apply_palette(gray, pal)

    # ③ 抠主体：与背景色差异超阈值的算主体
    base = bg or bg_color(im)
    diff = ImageChops.difference(im, Image.new("RGB", im.size, base)).convert("L")
    mask = diff.point(lambda p: 255 if p > MASK_THRESH else 0, "L")
    mask = mask.filter(ImageFilter.MaxFilter(3))          # 膨胀，吃掉主体外圈
    mask = mask.filter(ImageFilter.GaussianBlur(MASK_FEATHER))

    # ④ **叠加层** —— 渐变映射做不出来的「材质与光效」
    #    ⚠️ 这两层是「成品不像标准」的主因：标准里黄金有镜面反光、闪光有星点，
    #       而纯颜色映射只能给出一块平色。必须在**上色之后、合成之前**叠。
    if morph == "golden":
        colored = add_specular(colored, gray)
    elif morph == "shiny":
        colored = add_sparkles(colored, mask, src)

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
            px = paint_one(src, dst, p, k)
            n += 1
            print("  %s %-6s → %s  (主体 %d px)" % (fid, k, os.path.basename(dst), px))
    print("\n共 %d 张" % n)


if __name__ == "__main__":
    main()
