# -*- coding: utf-8 -*-
"""图鉴卡面生成管道 —— **由鱼的真实数据驱动**，参数可复现。

为什么要有这个脚本（而不是手动一张张出图）：
  项目硬约束要求「素材来源可复现」—— 换台机器、换个人都要能重做出一模一样的图。
  所以：提示词由 fish.js 的字段拼出来，种子写死，生成参数落进 manifest.json。

输入：src/data/fish.js（362 条）的真实字段
     shape / body(hex) / accent(hex) / rar / tail / spiny / barbels / glow
     / teeth / lure / stripes / spots / minKg / maxKg
输出：assets/cards/<id>.png  +  assets/cards/manifest.json（含提示词 / 种子 / 尺寸）

用法：
  python tools/gen-art.py --list A01            # 出 A01 的**母版 + 5 档**（一条命令全出）
  python tools/gen-art.py --list A01 --masters-only      # 只出母版
  python tools/gen-art.py --list A01,A02 --skip-existing # 断点续跑
  python tools/gen-art.py --limit 12           # 抽样 12 条（跨稀有度）
  python tools/gen-art.py --rar 3              # 只出传说
  python tools/gen-art.py --dry D01,D16        # 只打印提示词，不出图

产物（2026-10-07 口径：**六张一组**）：
  `assets/cards/<id>.png`           母版，RGB 暗底 —— 与 `docs/images/标准/` 对照的「标准外观」
  `assets/cards/<id>-normal.png`    原色档，**RGBA 透明** = 母版的抠图（不重新生成）
  `assets/cards/<id>-bright|albino|golden|shiny.png`   其余四档，**RGBA 透明**

  ⚠️ **五档全部走文生图**（2026-10-07 用户拍板，已弃用图生图）。
     每档提示词 = 母版提示词**只换颜色句**，其余逐字相同（见 `build_morph_prompt`）。
     代价（已量化并接受）：档位之间不再是「同一条鱼换漆」，而是**同一条鱼的不同个体** ——
     剪影 IoU 从图生图的 0.997 降到 0.93（对拍见 `docs/images/card-ab/_t2i-vs-i2i.png`）。
     换来的是：流程只有一套、没有参考图依赖、每档都是完整质量出图、颜色不再被参考图色相牵制。

  ⚠️ 抠图（真 alpha）由 `tools/cutout.py` 在出图后立刻完成，理由见其文件头。

────────────────────────────────────────────────────────────────────────────
提示词结构（2026-10-07 第二轮定稿：**逐字对齐 v8 / v9 的用词**）
────────────────────────────────────────────────────────────────────────────
  BASE  + " of a single " + 形态句 + "." + 构图句 + 颜色句 + LIGHT + GEOM + BG

  ① BASE   —— 风格锚点，v9 原文。**必须在第一句**，放到后面会被内容描述盖过
  ② 形态句 —— 体型描述 + 躯干胖瘦 + 尾型 + 特征位，全是结构词
  ③ 构图句 —— 侧视 / 全身 / 朝向 / 留白 / 稀有度
  ④ 颜色句 —— **只给色调倾向与明暗结构，不锁具体颜色**（见 palette_desc 的说明）
  ⑤ LIGHT / GEOM / BG —— 收尾三块，v9 原文 + v10 的防精细块

五个踩过的坑（v10 前两批全废，逐条对得上）：
  1. **`low poly 3D render` 单独用没用** —— 模型当成「低模风格的写实渲染」，
     照样给细密鳞片 + 柔和渐变。必须叠 GEOM 那句显式描述
     「大平面 / 可见多边形边 / 极少表面细节」。
  2. **负向提示词只在 cfg > 1 时生效** —— Qwen-Image 官方模板给 cfg=1.0，
     照抄 = 没有负向提示词。实测 3.0 有效，>4 配色发白。
  3. **"精细词"会推翻低模口径** —— 写 `elaborate flowing fins` / `ornate` /
     `decorative` 这些词，模型立刻画成精细插画。稀有度递进只能用**结构词**。
  4. **修饰词必须按体型分表** —— 水母没有鳍，鱿鱼没有尾鳍。
     拿一套普通鱼的修饰词套所有体型，会拼出「水母的 fan-shaped tail」这种东西。
     ⚠️ 这条是真 bug 源头：fish.js 里 `tail` 字段对所有鱼都是 "fan"（默认值），
        不能无条件读。同理 `body_ratio` 对鳐 / 水母不成立（没有躯干）。
  5. 🔴 **不许改 v9 的光照 / 背景词** —— 为了让"低模更硬"而把
     `strong rim light` 降成 `soft rim light`、把 `completely empty, no scenery`
     简写成 `plain dark charcoal`，结果是**低模锁住了、图也变丑了**
     （明暗对比垮掉 + 背景漂移成纯黑/深灰/深蓝三种）。
     **v9 那几句是「好看」的来源，是资产不是选项。** 要防精细就加 GEOM，别动它们。
"""
import argparse, hashlib, json, os, re, subprocess, sys, time, colorsys

# 同目录的抠图工具：出图后立刻抠成 RGBA 透明（见 cutout.py 文件头）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cutout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = r"C:/Users/15001/.workbuddy/binaries/python/versions/3.13.12/python.exe"
COMFY = os.path.expanduser(r"~/.workbuddy/comfy/txt2img.py")
OUT = os.path.join(ROOT, "assets", "cards")
MANIFEST = os.path.join(OUT, "manifest.json")
TMP = os.path.join(OUT, "_tmp")       # 五档出图的中间 RGB，抠完即删

SEED = 20261007
W, H, STEPS = 1152, 768, 25           # 3:2 横构图（图鉴卡面比例，UI 容器按这个做）
MODEL = "qwen-image-2.1-int8"
CFG = 3.0                             # ⚠️ 必须 > 1，否则 NEG 不生效（见坑 2）

# ────────────────────────────────────────────────────────────────────────────
# 风格四块（2026-10-07 第二轮：**逐字对齐 v8 / v9 的用词**）
#
# ⚠️ 教训：v10 首版为了锁住「低多边形」，把 v9 的光照 / 质感 / 背景词一起改了，
#    结果是**低模是锁住了，图也变丑了**。v8/v9 那批「好看」的来源恰恰是这几句，
#    它们是资产，不是可选项。正确做法是**只往上面叠「防精细」的几何块**，
#    其余照抄。逐块对照见 docs/生图清单.md。
# ────────────────────────────────────────────────────────────────────────────

# ① 基础风格 —— 逐字取自 v9（`gen9.py` 的 BASE）
BASE = ("low poly 3D render, faceted polygonal surfaces, flat shading per face, "
        "matte material, clean readable silhouette")

# ② 防「写实化」几何块 —— v9 没有、v10 才需要。
#    为什么需要：`low poly 3D render` 单独出现时，模型会理解成「低模风格的写实渲染」，
#    照样给细密鳞片和柔和渐变。
#    🔴 **2026-10-07 修正：这一块曾经写反了。** 原稿是
#       `Built from large flat angular facets, ... minimal surface detail`
#       —— 字面上就是在命令模型「用**大**面片、**尽量少**的表面细节」。
#       结果每张鱼身上只有 30~50 个大块，比 v9 标准图的密集三角网粗糙得多。
#    ⚠️ 关键认识：**这块防的是「写实」，不是「密度」，两者可以同时要** ——
#       `flat shading per facet / no texture / no gradients` 负责防写实，
#       `dense triangular polygon mesh` 负责要密度。
#    量化判据：鱼身剪影内「独立亮度色块」数 ÷ 千像素（`python tools/facet-count.py`）。
#       · v9 标准图 ≈ **3.6**（靶子）
#       · 老稿（large / minimal）≈ 1.5
#       · **本版 ≈ 3.3** ← 最贴靶子
#       · 只写 `hundreds of small facets` ≈ 5.7（过头，块面发碎）
GEOM = ("Finely faceted low-poly surface, a dense triangular polygon mesh covering the body, "
        "crisp visible polygon edges, flat shading per facet with subtle tone variation "
        "between neighbouring facets, no texture, no gradients.")

# ③ 光照 —— 逐字取自 v9（`gen9.py` 的 LIGHT）。用户口径：边缘光、不加环境补光。
#    ⚠️ **绝对不许出现 soft** —— v10 首版把 `strong rim light` 改成
#        `single soft rim light along the top edge`，明暗对比当场垮掉，
#        这是「图变难看」最直接的一条。硬边高对比是这套画风的命。
LIGHT = ("strong rim light along the back and tail, no ambient fill light, "
         "deep unlit shadow side, high contrast between the lit edge and the shadow, "
         "high-end product render look.")

# ④ 背景 —— 逐字取自 v9（`gen9.py` 的 BG）。
#    ⚠️ `completely empty, no scenery, no text, no watermark` 这三句是防**背景漂移**的
#        （v10 首版简写成 `plain dark charcoal background`，结果 10 张里出现了
#         纯黑 / 深灰 / 深蓝三种背景）。
BG = ("Plain dark neutral grey background, completely empty, no scenery, "
      "no text, no watermark.")

NEG = ("smooth surfaces, fine scales, detailed texture, photorealistic, realistic rendering, "
       "painting, illustration, soft gradients, fur, hair, water, background scenery, "
       "text, watermark, signature")

# ────────────────────────────────────────────────────────────────────────────
# 五档颜色句（**全部走文生图**，2026-10-07 用户口径）
#
# ⚠️ 为什么要显式写出目标色相：**图生图那套「泛化描述干不过参考图本色」的教训在这里同样成立**，
#    而且文生图还会被 `palette_desc` 之外的语义带跑 ——
#    `彩虹色` 只写「更鲜艳」时，模型更倾向于把原色鱼画得饱和一点，而不是真出彩虹。
#    白化 / 黄金 / 闪光本来就有明确色词，所以没问题。
#
# ⚠️ 这五档**不再是「母版改色」**：每档都是一次独立完整出图，
#    所以档位之间是**同一条鱼的不同个体**，不是同一条鱼换了漆（用户已确认接受，见 2026-10-07 对拍记录）。
#
# ────────────────────────────────────────────────────────────────────────────
# 🔴 2026-10-08 定稿：**候选总表 + 每档权重池**（用户口径见下）
#
# 由来：2026-10-07 第三轮先做了「每档 5 套候选」的对拍 —— 同一条鱼（A03 黑鲷）、
#   同一个种子、只换颜色句（工具 `tools/prompt-ab.py`，留痕 `docs/images/prompt-ab/`），
#   用户在对照表上逐档挑定，于是有了本节的「池子 + 权重」。
#
# 两张表的分工（**别合并**）：
#   `MORPH_CANDIDATES` —— **候选总表**，键 = 出处档/编号，值是 (标签, 颜色句)。
#       落选的句子**留在表里不删**：下次想「再换掉彩虹那套太暗的」时，
#       要么直接在池子里调权重，要么回对拍工具重出图，都得有原句。
#   `MORPH_POOL`       —— **正式池子**，每档一串 `(候选键, 权重)`。
#       正式出图只从这里挑。
#   ⚠️ 键名里的档**只是出处，不代表最终归属**：`shiny/3`(全息镭射膜) 与 `shiny/5`(极光薄膜)
#      在用户口径里属于「彩虹色」—— 它们本来就是同一族的虹彩材质，当初做候选时挂在闪光档下
#      而已。所以**不许**按前缀过滤池子（`MORPH_POOL["bright"]` 里有两个 shiny/*）。
#
# 🔴 权重不是装饰：**权重 ≤0 的句子会永远抽不到，而且不报错**（本项目最高频的坑型）。
#   所以模块加载时立刻跑 `check_pools()`，不合格直接抛（见下）。
# ⚠️ 选择必须**按鱼 id 稳定**（`morph_pick()`），不许真随机 —— 真随机 = 同一条鱼重跑就变样，
#   manifest 里的提示词与磁盘上的图对不上，可复现性直接没了。
# ⚠️ 这里的「随机」与已删除的 `stable_pick()`（形态随机池）**不是一回事**：
#   形态随机 = 明确的错误（石首鱼科尾鳍是楔形，抽到新月形就是错）；
#   颜色措辞随机 = **同一档位内**的风格差异、色相口径不变，属于「个体差异」。
# ────────────────────────────────────────────────────────────────────────────
MORPH_CANDIDATES = {
    # ── 彩虹色族 ──
    "bright/1": ("全光谱纵渐变",
                 "full-spectrum rainbow colouring, vivid saturated hues shifting along the body "
                 "length from magenta and orange through yellow and cyan to blue and violet, "
                 "punchy high-chroma palette, lively"),
    "bright/2": ("横向彩虹色带",
                 "rainbow colouring divided into broad saturated bands running from head to tail, "
                 "each band one flat pure hue in the order red, orange, yellow, green, cyan, blue, "
                 "violet, bold colour blocking with crisp edges between the bands"),
    "bright/3": ("虹彩油膜",
                 "thin iridescent rainbow film across the flanks, metallic hues drifting from teal "
                 "and green into violet and magenta, high-chroma colourful specular highlights, "
                 "colour that changes across the curved facets"),
    "bright/4": ("霓虹荧光条",
                 "electric neon rainbow colouring, glowing saturated stripes in magenta, cyan and "
                 "lime running along the flanks, fluorescent high-voltage palette, "
                 "luminous coloured edge glow"),
    "bright/5": ("背腹双色域",
                 "the upper body flooded with saturated magenta and red, the lower body with "
                 "electric cyan and deep blue, a hard hue boundary along the flank, "
                 "vivid rainbow-tinted fins"),
    # ── 白化族 ──
    "albino/1": ("奶白（基准）",
                 "albino colouring, pale creamy white body, soft pink translucent fins, "
                 "pale pink eye"),
    "albino/2": ("冷调冰白",
                 "ice-white albino colouring, snow-pale body, cool desaturated shading deepening "
                 "to pale slate blue in the shadow, milky translucent fins with a faint cold tint, "
                 "small pink eye"),
    "albino/3": ("暖调象牙",
                 "warm ivory albino colouring, creamy off-white body, soft beige shading in the "
                 "shadow, pearlescent coating over the facets, translucent fins with a pale rosy "
                 "edge, coral pink eye"),
    "albino/4": ("珍珠白+粉鳍缘",
                 "pearl-white albino colouring, lustrous pale body with a faint silvery sheen, "
                 "translucent fins washed with soft pink, delicate pink rim along the fin edges, "
                 "deep ruby-pink eye"),
    "albino/5": ("大理石白",
                 "chalky white albino colouring, marble-pale body with faint pale grey markings "
                 "between the facets, low saturation, translucent rose-tinted fins, pink eye"),
    # ── 黄金族 ──
    "golden/1": ("亮金（基准）",
                 "bright luminous polished metallic gold body, glowing golden highlights, "
                 "rich brass and gold tones, brilliant golden sheen, high luminance"),
    "golden/2": ("24K 镜面",
                 "mirror-polished twenty-four-karat gold body, sharp brilliant specular "
                 "reflections across the facets, crisp golden rim light, "
                 "flawless polished metal finish, maximum brilliance"),
    "golden/3": ("古铜暗金",
                 "antique gold colouring, burnished gold body with deep bronze shading in the "
                 "shadow, warm matte gold lustre, muted golden highlights, rich dark metal tone"),
    "golden/4": ("玫瑰金",
                 "polished rose gold metallic body, warm copper-pink gold sheen, luminous rosy "
                 "highlights, delicate pinkish gold lustre, elegant warm metal finish"),
    "golden/5": ("熔金",
                 "molten liquid gold colouring, flowing golden highlights running along the body, "
                 "warm amber and honey gold tones, champagne-bright glints, heavy metallic lustre"),
    # ── 闪光族 ──
    "shiny/1":  ("星点（基准）",
                 "iridescent shimmering body covered in sparkling glittering speckles, "
                 "bright specular glints, star-shaped sparkle highlights, prismatic sheen"),
    "shiny/2":  ("银底亮片",
                 "body densely covered in tiny mirror-bright metallic speckles that catch the "
                 "light like glitter, hundreds of pinpoint specular glints, cool chrome-bright "
                 "sheen, scattered bright highlights"),
    "shiny/3":  ("全息镭射膜",
                 "holographic foil coating over the body, faint rainbow glints appearing only in "
                 "the bright highlights, crisp pinpoint specular flashes, chrome-edged facets, "
                 "the deep base colour kept in the shadow"),
    "shiny/4":  ("星尘光点",
                 "soft glowing specks of light clinging to the body, a scatter of tiny bright "
                 "luminous dots, silvery pearlescent base, gentle prismatic sparkle, "
                 "delicate starlit glints"),
    "shiny/5":  ("极光薄膜",
                 "thin aurora film coating, green and violet shimmer travelling along the flanks, "
                 "sharp bright specular streaks, luminous metallic base, "
                 "iridescent sparkle concentrated on the lit edge"),
}

# 🔴 正式池子（2026-10-08 用户拍板：从 A03 黑鲷的 4 张对照表上逐档挑定）
#    每项 = (候选键, 权重)。**第 0 项 = 基准句**（各档都给了最高权重 5，与旧行为一致）。
MORPH_POOL = {
    # 「1、2、3，外加闪光的 3 和 5」→ 5 套，权重 5:1:2:4:2
    "bright": [("bright/1", 5), ("bright/2", 1), ("bright/3", 2),
               ("shiny/3", 4), ("shiny/5", 2)],
    # 「白化全选用」→ 5 套，权重 5:2:3:5:2
    "albino": [("albino/1", 5), ("albino/2", 2), ("albino/3", 3),
               ("albino/4", 5), ("albino/5", 2)],
    # 「黄金选用 1、2、3、5」→ 4 套，权重 5:4:1:1
    "golden": [("golden/1", 5), ("golden/2", 4), ("golden/3", 1), ("golden/5", 1)],
    # 「闪光仅选用 1」→ 单套（池子可以只有一项，`morph_pick()` 照样成立）
    "shiny":  [("shiny/1", 1)],
}
MORPH_CN = {"bright": "彩虹色", "albino": "白化", "golden": "黄金", "shiny": "闪光"}
MORPH_ORDER = ("bright", "albino", "golden", "shiny")


def pool_entries(key):
    """把池子展开成 `[(候选键, 标签, 颜色句, 权重), …]` —— 出图、挑选、提示词表都走这里。

    ⚠️ **带上「候选键」**（如 `bright/1`）而不只是标签：提示词表要能回答
       「这条鱼这一档抽中的是**哪一套**」，光有中文标签对不上 `MORPH_CANDIDATES`。
    """
    return [(ck, MORPH_CANDIDATES[ck][0], MORPH_CANDIDATES[ck][1], w) for ck, w in MORPH_POOL[key]]


def check_pools():
    """池子自检 —— **模块加载时就跑**，任何一条不满足直接抛。

    为什么不做成「记得手动跑一下」的工具：这几类错误**全都不报错、只出错结果** ——
    权重 ≤0 的句子永远抽不到（静默少一套风格）、候选键打错在抽样时才 KeyError、
    池子空了让整档退化成无颜色句。而「要记得手动跑检查」正是本项目反复栽跟头的地方。
    """
    for key in MORPH_ORDER:
        if key not in MORPH_POOL:
            raise RuntimeError("颜色句池子缺档位：%s" % key)
        entries = pool_entries(key)
        if not entries:
            raise RuntimeError("%s 档的池子是空的 —— 整档会退化成没有颜色句" % key)
        for ck, w in MORPH_POOL[key]:
            if ck not in MORPH_CANDIDATES:
                raise RuntimeError("%s 的池子引用了不存在的候选键：%s" % (key, ck))
            if not isinstance(w, int) or isinstance(w, bool) or w < 1:
                raise RuntimeError("%s/%s 的权重必须是 ≥1 的整数（≤0 = 这套句子永远抽不到，"
                                   "而且不报错）：%r" % (key, ck, w))
            if not MORPH_CANDIDATES[ck][1].strip():
                raise RuntimeError("%s/%s 的颜色句是空的" % (key, ck))
        tags = [t for _ck, t, _s, _w in entries]
        if len(set(tags)) != len(tags):
            raise RuntimeError("%s 的池子里有重名标签，日志分不清抽到了哪套：%s" % (key, tags))


check_pools()


def morph_pick(fid, key):
    """按鱼 id **稳定加权重**挑一套颜色句 → `(候选键, 标签, 颜色句)`。

    ⚠️ 用 md5 而**不是** Python 内置 `hash()`：`hash()` 带 PYTHONHASHSEED 随机盐，
       **每次进程启动结果都不一样** → 同一条鱼今天出金色、明天出古铜金，
       manifest 里记的提示词与磁盘上的图对不上，可复现性（硬约束）当场失效。

    ⚠️ 「按 id 稳定」≠「每档只有一套」：**不同鱼之间是分散的**（这才是用户要的
       「五档颜色句可以随机抽」），只是同一条鱼重跑必须落到同一套。
    """
    entries = pool_entries(key)
    total = sum(e[3] for e in entries)
    r = int(hashlib.md5(("%s/%s" % (fid, key)).encode("utf-8")).hexdigest()[:8], 16) % total
    for ck, tag, sent, w in entries:
        if r < w:
            return ck, tag, sent
        r -= w
    return entries[-1][0], entries[-1][1], entries[-1][2]      # 不可达，纯防守


# ⚠️ 保留 `MORPHS` 这个名字与「5 档」语义：`morph_keys()`、耗时常量、manifest 都按它算。
#    它就是「各档池子的第 0 项」，**不是**另一份颜色句定义。
MORPHS = [(k, MORPH_CANDIDATES[MORPH_POOL[k][0][0]][1]) for k in MORPH_ORDER]

# —— 体型：形态句 + 「华丽」作用在哪个部件上 + 颜色句里的部件名词 ——
#    `fin` 决定稀有度递进加长哪个部位；水母是触手、鳐是翼、鲸是尾叶。
#    ⚠️ 形态句里**不要写尾型** —— 尾型一律由 `tail` 字段给，否则会拼出
#       「forks tail, a fan-shaped tail」这种自相矛盾的话（实测踩过）。
SHAPES = {
    "fish":    {"d": "streamlined fish with a rounded body and small pectoral fins",
                "fin": "fins", "part": "fins"},
    "eel":     {"d": "long slender eel with a ribbon-like serpentine body and a continuous fin along the back",
                "fin": "dorsal fin", "part": "fins"},
    "ray":     {"d": "flat wide manta ray with a broad diamond body and wing-like fins",
                "fin": "wings", "part": "wings"},
    "squid":   {"d": "squid with an elongated mantle, pointed tip, triangular side fins and a cluster of tentacles",
                "fin": "side fins", "part": "side fins"},
    "jelly":   {"d": "jellyfish with a rounded bell dome and long tentacles hanging below",
                "fin": "tentacles", "part": "tentacles"},
    "oarfish": {"d": "ribbon fish with an extremely long thin body and a tall crest fin running the whole back",
                "fin": "crest fin", "part": "fins"},
    "shark":   {"d": "shark with a torpedo body, pointed snout and a tall triangular dorsal fin",
                "fin": "fins", "part": "fins"},
    "whale":   {"d": "whale with a bulky rounded body, a wide horizontal fluke and a small dorsal fin",
                "fin": "fluke", "part": "fluke"},
    "dragon":  {"d": "serpentine dragon fish with a long sinuous body, spiny dorsal ridge and whisker barbels",
                "fin": "fins", "part": "fins"},
}

# —— 尾型：**只对有独立尾鳍、且 tail 字段说得通的体型成立** ——
#    eel 无独立尾鳍 / ray 是鞭尾且已在体型描述里 / squid 是三角鳍 / jelly 没有 /
#    whale 的 tail 字段给不出 fluke 的正确说法（所以鲸的尾写在形态句里）。
TAIL_SHAPES = ("fish", "shark", "dragon", "oarfish")
TAIL = {"fan": "fan-shaped", "fork": "deeply forked", "lunate": "crescent-shaped",
        "round": "rounded", "whip": "long whip-like"}

# —— 特征位：**按体型过滤**（水母不长背棘、鲸没有须）——
#    glow 是通用的「边缘发光」，其余都要看体型。
FEATURE = {
    "spiny":   ("sharp spines along the back", ("fish", "eel", "dragon", "shark", "oarfish")),
    "barbels": ("long thin whisker barbels", ("fish", "eel", "dragon")),
    "glow":    ("a soft glowing edge along the outer silhouette", tuple(SHAPES)),
    "teeth":   ("small sharp visible teeth", ("fish", "shark")),
    "lure":    ("a glowing lure on a stalk above the head", ("fish", "dragon")),
    "stripes": ("vertical stripes down the body", ("fish", "shark", "eel")),
    "spots":   ("round spots on the body", ("fish", "shark", "ray")),
}

# —— 稀有度：只改**某个部件的长度**，绝不用「精细词」（坑 3）——
#    用户口径：「传说鱼要明显的细节更足、更好看一点」→ 用结构手段实现。
#    ⚠️ rar0 那句**不能写 "clean silhouette"** —— BASE 里已经有
#       `clean readable silhouette`，撞在一起变成「clean silhouette of ... simple clean silhouette」。
#    `{extra}` 只给**有硬棘可长**的体型（鱿鱼不会长背棘）。
RARITY = [
    "simple unadorned form",
    "slightly longer {fin}",
    "long swept-back {fin}",
    "long layered overlapping {fin}{extra}",
]
SPINE_SHAPES = ("fish", "eel", "dragon", "shark", "oarfish")


def color_name(hexstr):
    """十六进制 → 英文色名（AI 看不懂 hex，但认色名）"""
    h = (hexstr or "").lstrip("#")
    if len(h) != 6:
        return "grey"
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, l, s = colorsys.rgb_to_hls(r, g, b)
    deg = hh * 360
    if s < 0.12:
        base = "white" if l > 0.78 else ("light grey" if l > 0.5 else ("dark grey" if l > 0.25 else "near black"))
    elif l < 0.18:
        base = "near black"
    else:
        names = [(15, "red"), (40, "orange"), (65, "golden yellow"), (90, "yellow green"),
                 (150, "green"), (185, "teal"), (210, "sky blue"), (250, "blue"),
                 (280, "violet"), (320, "magenta"), (345, "pink"), (361, "red")]
        base = next(n for lim, n in names if deg < lim)
        if l > 0.72:
            base = "pale " + base
        elif l < 0.38:
            base = "deep " + base
        if s < 0.30:
            base = "muted " + base
    return base


def base_color(name):
    """剥掉明度/饱和副词，得到基础色名。

    ⚠️ 坑：`color_name` 对 body/accent 常给出**语义相同但字符串不同**的结果
       （实测 D01 给出 "muted pale sky blue" / "muted sky blue"）——
       只比字符串相等会漏判，拼出「同一个颜色的身子和鳍」。必须比基础色名。
    """
    for p in ("muted ", "pale ", "deep ", "light ", "dark "):
        name = name.replace(p, "")
    return name.strip()


def luma(hexstr):
    """感知亮度（ITU-R BT.709）—— 用来判断 body/accent 谁深谁浅"""
    h = (hexstr or "").lstrip("#")
    if len(h) != 6:
        return 0.5
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def palette_desc(f):
    """颜色句 —— 用**该鱼自己的色名**。

    🔴 **颜色只由这里管**（2026-10-07 定）。
       真实特征表里的 `markings` 只写**花纹形状**、不许写颜色词，
       真实体色存进 `colour` 字段但**不喂提示词**。
       原因：实测把两者都写进同一句会**打架** ——
       `palette_desc` 说 `muted sky blue body`，查证的花纹却写 `golden yellow lower flank`，
       模型收到两条互斥的颜色指令，出来的颜色不可控。
       **口径：花纹照实，配色保留游戏的夸张体系**（用户已定）。

    用户口径（2026-10-07）：「**鱼的原色提示词要使用鱼本来的颜色和特征**」。

    ⚠️ 但**保留「natural realistic colouring」这句**，不写死色值 —— 原因有两条：
       ① 文生图**控不住精确颜色**（实测三条灰蓝色的鱼被画成同一个浅蓝），
          写死只会让它「装作」服从，反而降低自然度
       ② 卡面成品的颜色**由 `paint-card.py` 的渐变映射决定，那一层只吃灰度** ——
          母版这里锁不锁色对成品毫无影响，所以让母版自然一点更好看

    ⚠️ 唯一必须保住的是**背腹明暗层次**（`clearly lighter belly and darker back`）——
       渐变映射的前提就是「背部暗、腹部亮」。
    """
    body_name = color_name(f["body"])
    accent_name = color_name(f["accent"])
    if base_color(body_name) == base_color(accent_name) or \
            abs(luma(f["body"]) - luma(f["accent"])) < 0.04:
        # 撞名 / 明度接近：只说主色 + 明暗关系，否则会拼出「同色的身子和鳍」
        fin = "darker" if luma(f["accent"]) <= luma(f["body"]) else "lighter"
        fin_desc = fin + " fins"
    else:
        fin_desc = accent_name + " fins"
    return ("natural realistic colouring, %s body with %s, "
            "a clearly lighter belly and a darker back." % (body_name, fin_desc))


# 「躯干胖瘦」（`body_ratio`）对哪些体型成立 —— 鳐是扁平菱形、水母是伞盖，
# **没有「躯干」这回事**（实测踩过：鳐鱼提示词里冒出 `deep-bodied build`）。
# ⚠️ `eel` / `oarfish` 也要排除：**它们是细长形，`body_ratio` 对它们没有意义**，
#    实测海鳗（eel）被写成「deep-bodied build」、裂空皇带（oarfish）同样 —— 荒谬。
TORSO_SHAPES = ("fish", "shark", "whale", "squid", "dragon")


# ────────────────────────────────────────────────────────────────────────────
# 名字族（2026-10-07 用户口径：「体型模板太少、区分度不大」+「符合鱼的名称一点」）
#
# 中文鱼名的**科属字**是白送的形态线索 —— 「鲷」在真实世界里就是高背 + 棘刺，
# 「鲹」就是纺锤形 + 叉尾，「鳕」就是长身 + 三个背鳍。
# fish.js 里的 `shape` 只有 9 个大类，而 362 条鱼的**名字末字有 77 种**，
# 光 Top 25 就覆盖约 80%（实测：鲷 15 / 鲳 12 / 鲽 12 / 鲹 12 / 鳗 11 / 鳕 8 / 鲈 6 / 鮟鱇 6…）。
#
# ⚠️ 匹配规则是**表序即优先级**，长串必须排在短串前面
#    （「鮟鱇」要在「鲇」前、「皇带」要在「带」前），否则会被短串截胡。
# ⚠️ 只在 `shape == "fish"` 时生效 —— 鳐 / 鲸 / 鲨 / 水母 等已有专属模板，
#    名字族再去描述形态会打架。
# ────────────────────────────────────────────────────────────────────────────
NAME_HINTS = [
    # —— 多字专名（必须先匹配）——
    ("鰕虎", "small bottom-dwelling body with a large head and joined pelvic fins"),
    ("罗非", "deep-bodied body with a long spiny dorsal fin"),
    ("鳑鲏", "small laterally compressed body with a bright iridescent stripe"),
    ("草鱼", "elongated cylindrical silvery body"),
    ("鮟鱇", "very large head with a wide mouth and a bulky tapering body"),
    ("皇带", "extremely long ribbon body with a tall crest fin along the whole back"),
    ("灯笼", "small deep-sea fish with rows of tiny glowing photophores along the body"),
    ("飞鱼", "streamlined body with very large wing-like pectoral fins"),
    ("剑鱼", "streamlined body with a long pointed bill extending from the snout"),
    ("旗鱼", "streamlined body with a very tall sail-like dorsal fin"),
    # —— 单字科属 ——
    ("鳢",   "elongated cylindrical body with a long dorsal fin and a large mouth"),
    ("鲶",   "broad flat head with long whisker barbels and smooth scaleless skin"),
    ("鲇",   "broad flat head with long whisker barbels and smooth scaleless skin"),
    ("鳅",   "small slender bottom-dwelling body with short barbels"),
    ("鲀",   "rounded puffer-like body with small fins and a blunt face"),
    ("鲷",   "deep-bodied laterally compressed body with a spiny dorsal fin"),
    ("鲳",   "laterally compressed diamond-shaped body with a small forked tail"),
    ("鲽",   "flat oval body with both eyes close together on the upper side"),
    ("鳎",   "flat elongated tongue-shaped body with fringing fins"),
    ("鲹",   "streamlined fusiform body, narrow tail base, deeply forked tail"),
    ("鳕",   "elongated body with three separate dorsal fins"),
    ("鲈",   "streamlined body with a spiny front dorsal fin and a soft rear fin"),
    ("鳟",   "streamlined torpedo body with small dark spots and a small adipose fin"),
    ("鳉",   "small slim elongated body"),
    ("鲻",   "fusiform body with a small pointed head and a forked tail"),
    ("鳀",   "small slender silvery body"),
    ("鲃",   "laterally compressed body with short barbels"),
    ("鲴",   "laterally compressed body with a blunt snout"),
    ("鮈",   "small bottom-dwelling body with a slightly flattened head"),
    ("鲤",   "deep-bodied scaled body with two pairs of barbels"),
    ("鲫",   "deep-bodied laterally compressed body with a long dorsal fin"),
    ("鲢",   "deep-bodied silvery body with a wide head and low-set eyes"),
    ("鳙",   "large broad head on a deep silvery body"),
    ("鲮",   "small deep-bodied body with a pointed head"),
    ("鳊",   "laterally compressed diamond-shaped body"),
    ("鲂",   "laterally compressed diamond-shaped body with a small head"),
]

# ── ⛔ 这里原本有一组「个体差异随机池」（SNOUT / HEAD / FINBUILD / TAIL_RANDOM / HEAD_RANDOM），
#    **2026-10-07 全部删除**。理由（用户口径「鱼的特征要和现实中的相似度很高」）：
#    那些池子是 `stable_pick` 从几个候选里**按 id 哈希抽一个**，
#    也就是「一条黑鲷可能被画上尾柄一个暗点」「石首鱼可能被画上新月形尾鳍」——
#    **随机 ≠ 个体差异，随机 = 明确的错误**。
#    现在：**查证到的写、查不到的留空**（`fish-traits.json` → `MARK_BY_FAMILY` → 不写）。
#    ⚠️ 要加「个体差异」请往 `fish-traits.json` 加**查证过的**条目，不要再引入随机池。

# ── 体表花纹：**按科属字给真实倾向**（2026-10-07 用户口径）──
# 规则：名字里的科属字命中 → 用该科属**查证过的**花纹特征；
#      **命中不了就不写**（留空不编）—— 少说一句，好过说错一句。
# ⚠️ 本表是**科属级通性**，每条都要有来源。逐种查证由 `fish-traits.json`（Layer B）覆盖，
#    两者冲突时 fish-traits.json 胜。
MARK_BY_FAMILY = [
    # 长串优先（与 NAME_HINTS 同一规矩：表序即优先级）
    ("梅童", "dark patches at the front of the jaws and a single dark spot on top of the eye"),
    ("黄鱼", "a dark patch at the front of the lower jaw"),
    ("竹荚", "irregular scribbled dark lines above the pectoral-fin line and a single dark spot on the upper rear edge of the gill cover"),
    ("鲷",   "several vertical bands down the flanks and one small spot at the start of the lateral line, with dark edges on the fins"),
    ("鲳",   "a dense scatter of tiny dots over the very small scales"),
]
# ⚠️ 这里**故意不收**「黄姑 / 白姑」—— 查到的资料只说了它们的颜色，
#    而颜色归 `palette_desc()` 管（🔴 见它的说明），花纹形状我没查到科属级的，
#    所以**留空不编**。要补就先去查证，别在这里顺手编一句。
MARKING_KEYS = ("stripes", "spots")

# ── 逐条查证的真实形态（Layer B）—— 见 tools/fish-traits.json 的 _schema ──
# 有记录就用**查证过的**形态，没有就退回上面的推导。
# ⚠️ 这是**可以持续追加**的数据文件，适合交给定时任务每轮补几条。
TRAITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fish-traits.json")


def load_traits():
    """读真实特征表。文件缺失/坏掉都不许让出图挂掉，退回空表并提示。"""
    if not os.path.exists(TRAITS_FILE):
        return {}
    try:
        raw = json.load(open(TRAITS_FILE, encoding="utf-8"))
    except Exception as e:
        print("⚠️ fish-traits.json 读不出来（%s），本次退回推导形态" % e)
        return {}
    return {k: v for k, v in raw.items() if not k.startswith("_")}


TRAITS = load_traits()


def trait_of(fid, key):
    """取某条鱼查证过的某一项；没有就返回空串。"""
    v = TRAITS.get(fid, {}).get(key)
    return v.strip() if isinstance(v, str) else ""


def mark_by_family(name):
    """按名字里的科属字取**真实花纹倾向**；命中不了返回空串（留空不编）。"""
    for key, desc in MARK_BY_FAMILY:
        if key in name:
            return desc
    return ""


def stable_pick(fid, salt, options):
    """⚠️ **已废弃，无调用点**（2026-10-07）。保留仅为说明历史：
    它曾用来给「花纹 / 尾型 / 头型」抽一个可复现的随机值。
    但那不是"个体差异"，**是明确的错误**（石首鱼科明明是楔形尾，抽到新月形就是错的）。
    现在改成「查证到的写、查不到的留空」。新代码**不要再调它**。"""
    raise NotImplementedError("stable_pick 已废弃：请往 fish-traits.json 加查证过的条目")


def name_hint(f):
    """按鱼名匹配合适的形态描述。找不到返回空串（由 body_ratio 兜底）。"""
    if f.get("shape") != "fish":       # 其他体型有专属模板，不掺和
        return ""
    name = f.get("name", "")
    for key, desc in NAME_HINTS:
        if key in name:
            return desc
    return ""


# ── 头型 / 尾型：`tail` 字段**不可用**（实测 351/362 都是 "fan"），
#    所以这两维走「名字线索优先、找不到用稳定随机兜底」。
#    ⚠️ 同样是**表序即优先级**，长串在前（「鮟鱇」要在「鲇」前）。
HEAD_HINTS = [
    ("鮟鱇", "a very large head, nearly half the total body length"),
    ("海豚", "a rounded beak-like snout"),
    ("鲸",   "a huge rounded head"),
    ("鲶",   "a large broad flat head with a wide mouth"),
    ("鲇",   "a large broad flat head with a wide mouth"),
    ("鳢",   "a long snake-like head"),
    ("鳅",   "a small head with a downward mouth"),
    ("鳗",   "a small pointed head"),
    ("鲽",   "a small head set close to one edge of the body"),
    ("鳎",   "a small head with both eyes on one side"),
    ("鲀",   "a large blunt rounded head"),
    ("鲟",   "a long pointed snout with a shovel shape"),
    ("鲛",   "a pointed snout on a streamlined head"),
    ("鲨",   "a pointed snout on a streamlined head"),
]

TAIL_HINTS = [
    ("鲹",   "a deeply forked tail on a narrow tail base"),
    ("鲭",   "a deeply forked tail"),
    ("竹荚", "a deeply forked tail on a narrow tail base"),
    ("鲳",   "a deeply forked tail with the lower lobe longer than the upper"),
    ("黄鱼", "a wedge-shaped tail"),
    ("黄姑", "a wedge-shaped tail"),
    ("白姑", "a wedge-shaped tail"),
    ("沙丁", "a forked tail"),
    ("鳐",   "a long thin whip-like tail"),
    ("魟",   "a long thin whip-like tail"),
    ("鲽",   "a small rounded tail fin"),
    ("鳎",   "the dorsal and anal fins fringing the whole body instead of a distinct tail"),
    ("鲀",   "a small rounded tail fin"),
    ("鳗",   "the tail continuous with the dorsal and anal fins"),
    ("鳝",   "the tail continuous with the dorsal and anal fins"),
    ("鲟",   "a strongly asymmetrical shark-like tail"),
    ("鲸",   "a wide horizontal fluke"),
]

# 体型大小 —— 由 `maxKg` 分档（实测分布：p25=1.2 / p50=4 / p75=40 / max=20000，
# 跨 5 个数量级，是最有效的「个体差异」维度之一）
SIZE_BANDS = [
    (0.5,  "a very small fish"),
    (2.0,  "a small fish"),
    (8.0,  "a medium-sized fish"),
    (60.0, "a large fish"),
    (1e9,  "a huge massive fish"),
]


def form_profile(f):
    """**形态档案** —— 用户口径：「按身体特征对每条鱼先写一个描述」。

    🔴 **优先级（2026-10-07 改）**：
      ① `fish-traits.json` 里**逐条查证过**的 `form` / `fins` —— 有就用它，直接用完就返回
      ② 没有查证记录时，才退回下面的推导（名义上是"由真实数据驱动"，但**是推导不是查证**）

    ⚠️ 退回推导时，数据来源是：
      | 维度 | 来源 |
      |---|---|
      | 体型大小 | `maxKg`（0.04~20000，跨 5 个数量级） |
      | 身体比例 | `body_ratio`（0.20~0.86） |
      | 头型 / 尾型 | 名字科属线索（`TAIL_HINTS` / `HEAD_HINTS`） |

    ⛔ **尾型不再有随机兜底**。旧做法是 `stable_pick` 从 6 个尾型里随机抽一个 ——
       实测「石首鱼科的尾鳍是楔形」，随机抽可能抽到叉形/扇形/新月形，**全错**。
       现在：名字线索命中才写，命中不了**就不写**（`SHAPES[shape]` 的默认里本来就有尾型，
       那是个「不撒谎但也不具体」的兜底）。

    ⚠️ 五条都写进提示词会太长、稀释风格锚点，所以推导路径**只挑最能区分的三条**
       （大小 / 比例 / 尾型），头型重叠时再补一条。
    """
    # ① 查证过的真实形态优先 —— 有就不必再推导
    real_form = trait_of(f["id"], "form")
    if real_form:
        parts = [real_form]
        real_fins = trait_of(f["id"], "fins")
        if real_fins:
            parts.append(real_fins)
        return ", ".join(parts)

    out = []

    # ② 体型大小（maxKg）
    kg = f.get("maxKg") or 0.1
    for lim, desc in SIZE_BANDS:
        if kg < lim:
            out.append(desc)
            break

    # ③ 身体比例（body_ratio）—— 只对有躯干的体型
    shape = f.get("shape", "fish")
    if shape in TORSO_SHAPES:
        r = f.get("body_ratio") or 0.30
        if r < 0.26:
            out.append("a slender elongated body")
        elif r < 0.34:
            out.append("a moderately proportioned body")
        elif r < 0.42:
            out.append("a deep-bodied build")
        else:
            out.append("a very deep rounded body")

    # ④ 尾型 —— **只认名字线索，没有就不写**（⛔ 不许随机兜底，见 docstring）
    name = f.get("name", "")
    for key, desc in TAIL_HINTS:
        if key in name:
            out.append(desc)
            break

    # ⑤ 头型 —— 名字线索能命中就写，命中不了就丢掉（少说一句好过多说一句）
    for key, desc in HEAD_HINTS:
        if key in name:
            out.append(desc)
            break

    return ", ".join(out)


def build_prompt(f):
    """拼提示词。顺序**照 v9**，别改：

        BASE + " of a single <形态句>." + <构图句> + <颜色句> + LIGHT + GEOM + BG

    ⚠️ 三条不能动的：
       1. **BASE 必须是第一句** —— 它是风格锚点，放到后面会被内容描述盖过
       2. **LIGHT / BG 收尾**（v9 的排法），两者挨着，别拆开
       3. 形态句里**不写「精细词」**（elaborate / ornate / decorative）——
          一出现模型立刻画成精细插画（v10 首批 10 张全废在这条）
    """
    shape = f.get("shape", "fish")
    spec = SHAPES.get(shape, SHAPES["fish"])
    bits = [spec["d"]]

    # ① 名字族（科属特征）—— 只在 fish 体型生效，其余体型有专属模板
    #    ⚠️ 有逐条查证记录时**跳过**：查证过的 form/fins 已经把体型说清楚了，
    #       再叠一句科属体形会重复（实测叠完出现「deep-bodied laterally compressed body」
    #       紧跟「elongated oval body, strongly compressed and rather deep」这种自我重复）。
    hint = "" if trait_of(f["id"], "form") else name_hint(f)
    if hint:
        bits.append(hint)

    # ② 形态档案 —— 大小 / 比例 / 尾型 / 头型，全部由真实数据驱动
    #    （用户口径：「按身体特征对每条鱼先写一个描述」，让鱼更好分辨）
    bits.append(form_profile(f))

    # ③ 体表花纹 —— 查证过的逐条特征最优先，其次按科属字给**真实倾向**，
    #    两者都没有就**不写**（⛔ 不许随机抽，见 MARK_BY_FAMILY 的注释）
    if shape == "fish" and not any(f.get(k) for k in MARKING_KEYS):
        mark = trait_of(f["id"], "markings") or mark_by_family(f.get("name", ""))
        if mark:
            bits.append(mark)

    # ④ 特征位（按体型过滤）
    for key, (desc, shapes) in FEATURE.items():
        if f.get(key) and shape in shapes:
            bits.append(desc)

    rar_i = min(3, f.get("rar", 0))
    extra = ", extra spines and streamers" if (rar_i == 3 and shape in SPINE_SHAPES) else ""
    rar = RARITY[rar_i].format(fin=spec["fin"], extra=extra)

    head = BASE + " of a single " + ", ".join(bits) + "."
    frame = ("full side view, whole body visible, facing left, "
             "centered with generous margin, " + rar + ".")
    return " ".join([head, frame, palette_desc(f), LIGHT, GEOM, BG])


def build_morph_prompt(f, color_desc):
    """五档的提示词 = 母版提示词**只换颜色句**，其余逐字相同。

    ⚠️ 别在这里另起一套骨架 —— 那会让「母版」和「五档」两套口径分家，
       最后变成「同一条鱼不同档不像一家人」。做法同 `GEOM`：
       **同一个 `build_prompt`，挖掉原色颜色句，换上该档的颜色句。**
    """
    p = build_prompt(f)
    pd = palette_desc(f)
    if pd not in p:
        raise RuntimeError("颜色句没出现在提示词里 —— build_prompt 的结构改过？")
    # ⚠️ `palette_desc` 自带句号，五档的颜色句没有 —— 补上，
    #    否则会和后面的 LIGHT 黏成「…lively strong rim light…」
    desc = color_desc if color_desc.rstrip().endswith(".") else color_desc.rstrip() + "."
    return p.replace(pd, desc, 1)


def load_fish():
    """借 node 读 fish.js（它依赖 config/fields）—— 不重复实现一遍解析"""
    js = ("global.window=global;"
          "require('./src/data/config.js');require('./src/data/fields.js');require('./src/data/fish.js');"
          "console.log(JSON.stringify(global.G.FISH));")
    r = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-800:]); sys.exit(1)
    return json.loads(r.stdout)


def pick(fish, args):
    if args.list:
        want = set(x.strip() for x in args.list.split(","))
        return [f for f in fish if f["id"] in want]
    if args.rar is not None:
        return [f for f in fish if f["rar"] == args.rar][:args.limit or 99]
    if args.limit:
        # 跨稀有度均匀抽样（每种稀有度取若干），确定性：按 id 排序后等距取
        out, seen = [], {}
        for f in fish:
            seen.setdefault(f["rar"], []).append(f)
        per = max(1, args.limit // max(1, len(seen)))
        for r in sorted(seen):
            arr = seen[r]
            step = max(1, len(arr) // per)
            out += arr[::step][:per]
        return out[:args.limit]
    return fish


# ────────────────────────────────────────────────────────────────────────────
# 分批策略（用户口径 2026-10-07）
#   「列出一个项目清单，一批批次地生图，比如普通档一批次生成 5 只，
#     免得上下文过长；传说鱼一次只生成一张，且要多次优化成最好看、
#     符合名字与体型的图。」
# 所以：普通/稀有 5 条一批、史诗 2 条、传说 1 条 —— 传说额外走多轮迭代。
# ────────────────────────────────────────────────────────────────────────────
BATCH_SIZE = {0: 5, 1: 5, 2: 2, 3: 1}
RAR_CN = {0: "普通", 1: "稀有", 2: "史诗", 3: "传说"}
# 出图耗时**实测**（2026-10-07，RTX 5060 Laptop，模型已热）：
#   母版 = 文生图 cfg=3.0（每步两次前向）≈ 55s
#   档位 = 图生图 cfg=1.0 ≈ 20s
# ⚠️ 别再用「单张 55s × 条数」估总时间 —— 每条鱼现在是 6 张（1 母版 + 5 档），
#    按旧口径会把工期低估 3 倍（清单头部因此长期写着 6.4 小时，实际 ≈ 15.6 小时）。
SEC_PER_MASTER = 55     # 母版：文生图，25 步（cfg=3.0，每步两次前向），实测 ≈55s
SEC_PER_MORPH = 55      # ⚠️ 五档**2026-10-07 起也是文生图** —— 曾走图生图（≈20s），已弃用。
                        #    所以现在和母版同价，别再按 20s 估。
SEC_PER_CUT = 2         # 母版抠图 → `<id>-normal.png`（本地 BiRefNet，实测 1.5~3s）
# 传说鱼的迭代轮数 —— 是**评审次数**，不是机器时间（见清单文档里的说明）
LEGEND_ROUNDS = 3


def make_batches(fish):
    """按「稀有度升序 → id 升序」切批。

    ⚠️ 排序必须稳定且与输入顺序无关 —— 否则批次号会随 fish.js 的行序漂，
       清单里勾过的进度就对不上了。
    """
    out = []
    for r in sorted(BATCH_SIZE):
        arr = sorted([f for f in fish if f["rar"] == r], key=lambda f: f["id"])
        n = BATCH_SIZE[r]
        for i in range(0, len(arr), n):
            out.append(arr[i:i + n])
    return out


def morph_keys():
    """5 档的键名（normal/bright/albino/golden/shiny）。清单勾选按这 5 个键名找文件。

    🔴 **2026-10-07 修死引用**：原实现是「打开 `tools/gen-morph.py` 正则抠它的 `MORPHS`」
    （动机是怕档位清单写两遍而分家）。但那个脚本**已合并进本文件并删除**，
    而且 `verify §33-d` 明确要求它**必须不存在** —— 也就是说这段代码
    从删除那天起就变成了**必然抛 `FileNotFoundError` 的死引用**，`--plan` 一调就崩。
    （这类「不报错直到被调用」的死引用，正是本项目最高频的坑型，见 MEMORY.md。）
    现在直接读**本文件**的 `MORPHS`：档位清单在本文件里本来就只有一份，就是单一来源。
    `normal` 不在 `MORPHS` 里（它是母版的抠图、不独立出图），但清单要按 5 档找文件，故补上。
    """
    keys = ["normal"] + [k for k, _ in MORPHS]
    if len(keys) < 5:
        sys.exit("gen-art.py：档位只解析出 %d 档，expected >= 5" % len(keys))
    return keys


def write_plan(fish):
    """生成 docs/生图清单.md —— 带勾选框，供逐批执行与追踪"""
    bs = make_batches(fish)
    total = sum(len(b) for b in bs)
    legend = sum(1 for f in fish if f["rar"] == 3)
    nk = len(morph_keys())
    # 每条鱼 = 1 张母版（文生图）+ (nk-1) 张档位（**也是文生图**）+ 1 次抠图（出 `-normal`）
    per_fish = SEC_PER_MASTER + (nk - 1) * SEC_PER_MORPH + SEC_PER_CUT
    shots = total * (1 + nk) + legend * (LEGEND_ROUNDS - 1) * (1 + nk)
    secs = (total + legend * (LEGEND_ROUNDS - 1)) * per_fish

    L = []
    L.append("# 图鉴卡面生图清单（%d 条鱼 / %d 批）\n" % (total, len(bs)))
    L.append("> **一条命令出全部**：`python tools/gen-art.py --list <id...>`")
    L.append("> → 母版 `assets/cards/<id>.png` + **%d 档** `<id>-<档>.png`" % nk)
    L.append("> （`<id>-normal` 是母版的**抠图**，不重新生成；单档重出用 `--morphs-only`，")
    L.append("> 母版跳过已存在的用 `--skip-existing`）")
    L.append("> 验收：`python tools/check-cards.py`。提示词 / 种子 / 参数落进 "
             "`assets/cards/manifest.json`，可复现。")
    L.append("> ⚠️ 勾选 = **母版 + %d 档全部存在**才算完成（自动检测，见 `write_plan()`）；" % nk)
    L.append("> 只有母版的鱼**不再**算完成 —— 否则下一轮会跳过它，档位图再也没人补。\n")
    L.append("**分批策略**（用户 2026-10-07 口径）：普通 / 稀有 5 条一批 · 史诗 2 条 · 传说 1 条。")
    L.append("传说「一次一张 + 多轮优化到符合名字与体型」，所以单批条数最少、迭代轮数最多。\n")
    L.append("| 项 | 数 |")
    L.append("|---|---|")
    L.append("| 鱼种总数 | %d |" % total)
    L.append("| 批次数 | **%d** |" % len(bs))
    L.append("| 传说鱼 | %d 条，每条按 %d 轮迭代（评审轮次） |" % (legend, LEGEND_ROUNDS))
    L.append("| 出图张数（含传说迭代） | ≈ **%d**（每条 %d 张：1 母版 + %d 档） |" % (shots, 1 + nk, nk))
    L.append("| 单条耗时 | ≈ **%d s**（母版 %ds + %d 档 × %ds + 抠图 %ds） |"
             % (per_fish, SEC_PER_MASTER, nk - 1, SEC_PER_MORPH, SEC_PER_CUT))
    L.append("| 纯机器时间 | ≈ **%.1f 小时** |" % (secs / 3600.0))
    L.append("")
    L.append("⚠️ 真正的瓶颈不是机器时间，是**评审次数**：%d 批，每批都要「看图 → 判断合格 / 重出」。" % len(bs))
    L.append("传说那 %d 条尤其 ——每条 %d 轮，就是 %d 次判断。\n" % (legend, LEGEND_ROUNDS, legend * LEGEND_ROUNDS))
    L.append("## 批次表\n")
    L.append("| 状态 | 批次 | 档位 | 条数 | 内容 |")
    L.append("|---|---|---|---|---|")
    out = os.path.join(ROOT, "docs", "生图清单.md")

    for i, b in enumerate(bs, 1):
        names = "、".join("%s %s" % (f["id"], f["name"]) for f in b)
        # **只信自动检测**：母版 + 5 档**全都存在**才算完成。
        # ⚠️ 不要读回历史勾选再取或 —— 本轮踩过：口径变更时把旧图移走重跑，
        #    清单却因为「历史勾选还在」显示已完成，会骗过下一轮的执行者。
        #    勾选必须反映**磁盘实际状态**。
        # 🔴 2026-10-07 修正：原来只看母版 `<id>.png`，于是
        #    「有母版、但 5 档还没出」的批次会被打勾 —— A02 / A05 就是这么漏掉的：
        #    清单说 001 批已完成，实际它们只有母版，下一轮直接跳到 002 批，
        #    这两条鱼的档位图**再也没人补**。交付物是 6 张图，检测条件也必须覆盖 6 张。
        def complete(f):
            return all(os.path.exists(os.path.join(OUT, "%s%s.png" % (f["id"], sfx)))
                       for sfx in ("",) + tuple("-" + k for k in morph_keys()))
        have = all(complete(f) for f in b)
        mark = "[x]" if have else "[ ]"
        L.append("| %s | %03d | %s | %d | %s |" % (mark, i, RAR_CN[b[0]["rar"]], len(b), names))
    L.append("")

    open(out, "w", encoding="utf-8").write("\n".join(L))
    print("清单已写出：%s" % out)
    print("共 %d 条 / %d 批；含传说迭代约 %d 张，纯机器时间 ≈ %.1f 小时"
          % (total, len(bs), shots, secs / 3600.0))


def report_traits(fish):
    """报告**真实特征表（Layer B）的覆盖进度** —— 逐条查证是一件长期活，进度要看得见。

    ⚠️ 这个数**不是 KPI，是诚实度指标**：没查证的就该留空，不许为了刷覆盖率去编。
    """
    # 🔴 **现实与虚构必须分列**（2026-10-08）。`fish-traits.json` 里现在装着两种**性质
    #    完全不同**的东西：现实物种的查证结果，和虚构生物的设计稿。混进同一个百分比，
    #    这个指标就废了 —— 198 条虚构稿会把「查证覆盖率」冲到接近 100%，
    #    看上去像全查完了，实际现实那一半还空着。**分母必须是它真正想量的那部分。**
    # ⚠️ 分列要按 **id 空间**（SS/SSS = 设计上虚构），**不是**按 `source` ——
    #    因为「湖心巨鲤 / 百斤鳡王」这类**游戏造名**坐在普通 id 里，但它们的描述也是设计稿。
    #    按 source 分会把这 18 条从「现实物种」分母里挖掉，得出「现实查证 100%」的假象。
    is_real = lambda f: not re.match(r"^S{2,}", f["id"])
    real = [f for f in fish if is_real(f)]
    fic = [f for f in fish if not is_real(f)]
    r_designed = [f for f in real if trait_of(f["id"], "source").startswith("设计上虚构")]
    r_verified = [f for f in real if f not in r_designed]
    v_have = [f for f in r_verified if trait_of(f["id"], "form")]
    v_miss = [f for f in r_verified if not trait_of(f["id"], "form")]
    fam = [f for f in v_miss if mark_by_family(f.get("name", ""))]
    print("现实物种 %d 条：**查证 %d（%.1f%%）**｜同空间的游戏造名（设计稿）%d｜"
          "退回推导但科属花纹命中 %d｜无花纹留空 %d"
          % (len(real), len(v_have), 100.0 * len(v_have) / max(1, len(real)),
             len(r_designed), len(fam), len(v_miss) - len(fam)))
    print("虚构生物 %d 条（SS/SSS）：按名字设计 %d —— **不是查证结果，不计入上面那个百分比**"
          % (len(fic), len([f for f in fic if trait_of(f["id"], "form")])))
    print("\n现实物种里还没查证的（前 20 条）：%s"
          % "、".join(f["id"] + f["name"] for f in v_miss[:20]))


def write_prompts(fish):
    """导出**全量提示词表**（供人工审阅）—— 用户口径：「先写好每个鱼的提示词让我看一下」。

    ⚠️ 这里用的就是 `build_prompt()` **本体**，不是另写一份 ——
       否则「给人看的」和「实际出图用的」会分家，审阅就失去意义。
       （2026-10-07 修：这里**曾经**复制了一份拼装逻辑，结果分家了，还漏改过一次随机花纹。）
    """
    L = []
    L.append("# 鱼提示词表（%d 条）\n" % len(fish))
    L.append("> 由 `tools/gen-art.py --prompts` 生成，**不要手改**（改口径请改 `build_prompt()`）。")
    L.append("> 每条鱼的提示词由**同一份代码**产出，与实际出图逐字一致。")
    L.append("> 结构：`BASE + 形态句 + 构图句 + 颜色句 + LIGHT + GEOM + BG`，"
             "其中 `LIGHT` / `GEOM` / `BG` 三段是**固定常量**（见 §一）。\n")
    L.append("## 一、固定段落（每条鱼都一样）\n")
    L.append("```")
    L.append("LIGHT = " + LIGHT.strip())
    L.append("GEOM  = " + GEOM.strip())
    L.append("BG    = " + BG.strip())
    L.append("```\n")
    L.append("## 二、母版（原色）提示词 —— 每条鱼独有的部分\n")
    L.append("下表列出**每条鱼独有的部分**（体型 + 形态 + 特征 + 颜色 + 构图）。\n")
    L.append("| id | 名字 | 档 | 体型 | 提示词（已剥掉固定段 LIGHT/GEOM/BG） |")
    L.append("|---|---|---|---|---|")
    for f in fish:
        # ⚠️ **必须调 build_prompt() 本体再剥离固定段**，不许在这里复制一份拼装逻辑 ——
        #    之前就是复制了一份，结果「给人看的表」和「实际出图」分家（还漏改过一次随机花纹）。
        var = build_prompt(f)
        for seg in (LIGHT, GEOM, BG):
            var = var.replace(seg, "")
        var = " ".join(var.split())
        L.append("| %s | %s | %s | %s | %s |" % (
            f["id"], f["name"], RAR_CN.get(f.get("rar", 0), "?"),
            f.get("shape", ""), var))

    # ── 三、五档颜色句：**每条鱼实际会抽到的那一套** ──────────────────────
    # 🔴 这张表存在的理由：颜色句**不再是每档固定一句**。每档有 5 套候选
    #    （`MORPH_CANDIDATES`）、由 `MORPH_POOL` 给权重，出图时 `morph_pick(鱼id, 档)`
    #    **按 md5 稳定加权抽一套**。不给这张表的话，「给人看的提示词表」就不完整 ——
    #    它只说了颜色的一半（母版），另一半（五档）谁也看不见。
    L.append("\n## 三、五档颜色句：**每条鱼实际会抽到的那一套**\n")
    L.append("颜色句每档有 **5 套候选**（`MORPH_CANDIDATES`），`MORPH_POOL` 给权重，")
    L.append("出图时由 `morph_pick(鱼 id, 档)` **按 md5 稳定加权抽一套** —— "
             "同一条鱼重跑永远是同一套（可复现），**不同鱼之间才会不一样**。")
    L.append("下表列的就是**实际会被抽中的那一套**（键 = `候选键 中文标签`）。\n")
    L.append("| id | 名字 | %s |" % " | ".join(MORPH_CN[k] for k in MORPH_ORDER))
    L.append("|---|---|%s" % ("---|" * len(MORPH_ORDER)))
    for f in fish:
        cols = []
        for k in MORPH_ORDER:
            ck, tag, _sent = morph_pick(f["id"], k)
            cols.append("`%s` %s" % (ck, tag))
        L.append("| %s | %s | %s |" % (f["id"], f["name"], " | ".join(cols)))

    L.append("\n### 候选句总表（各档 5 套，`池子权重` 决定抽中概率）\n")
    for k in MORPH_ORDER:
        L.append("**%s**（池子：%s，基准 = 第 0 项）\n" % (
            MORPH_CN[k], " / ".join("%s×%d" % (ck, w) for ck, w in MORPH_POOL[k])))
        L.append("| 候选键 | 标签 | 句子 |")
        L.append("|---|---|---|")
        for ck, (t, s) in MORPH_CANDIDATES.items():
            if not ck.startswith(k + "/"):
                continue
            L.append("| %s | %s | %s |" % (ck, t, s))

    out = os.path.join(ROOT, "docs", "鱼提示词表.md")
    open(out, "w", encoding="utf-8").write("\n".join(L))
    print("提示词表已写出：%s（%d 条；含五档颜色句抽选表）" % (out, len(fish)))


def write_forms(fish):
    """输出**全量形态档案** —— 用户口径：「先按身体特征对每条鱼写一个描述」。

    既给人查阅，也是生图提示词的实际来源（**同一个 `form_profile`**，不会分家）。
    """
    L = []
    L.append("# 鱼形态档案（%d 条）\n" % len(fish))
    L.append("> 由 `tools/gen-art.py --forms` 生成，**不要手改**（改逻辑请改 `form_profile()`）。")
    L.append("> 每条鱼的形态描述从 `fish.js` 的真实数据推导：")
    L.append("> **体型大小 ← `maxKg`** ｜ **身体比例 ← `body_ratio`** ｜ "
             "**尾型 / 头型 ← 名字线索，找不到用稳定随机兜底**。")
    L.append("> ⚠️ `tail` 字段**不可用**（实测 351/362 都是 `fan`），所以尾型不走它。\n")
    L.append("| id | 名字 | 档 | 体型 | 形态描述 |")
    L.append("|---|---|---|---|---|")
    for f in fish:
        L.append("| %s | %s | %s | %s | %s |" % (
            f["id"], f["name"], RAR_CN.get(f.get("rar", 0), "?"),
            f.get("shape", ""), form_profile(f)))
    out = os.path.join(ROOT, "docs", "鱼形态档案.md")
    open(out, "w", encoding="utf-8").write("\n".join(L))
    print("形态档案已写出：%s（%d 条）" % (out, len(fish)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="")
    ap.add_argument("--rar", type=int, default=None)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--plan", action="store_true", help="只写出分批清单 docs/生图清单.md")
    ap.add_argument("--forms", action="store_true", help="只写出形态档案 docs/鱼形态档案.md")
    ap.add_argument("--prompts", action="store_true", help="只写出提示词表 docs/鱼提示词表.md")
    ap.add_argument("--traits", action="store_true", help="只报告真实特征表（Layer B）的覆盖进度")
    ap.add_argument("--batch", type=int, default=0, help="只出第 N 批（从 1 起，见清单）")
    ap.add_argument("--prompt-only", action="store_true", help="只打印提示词，不出图")
    ap.add_argument("--dry", default="", help="（快捷）等价于 --prompt-only --list X")
    ap.add_argument("--masters-only", action="store_true", help="只出母版，不出五档")
    ap.add_argument("--morphs-only", action="store_true", help="只出五档（跳过已有母版）")
    ap.add_argument("--skip-existing", action="store_true", help="已有成品跳过（断点续跑）")
    ap.add_argument("--budget-min", type=float, default=0,
                    help="时间预算（分钟）：到点**在任务边界干净收工**，不等当前这张之外的更多任务。"
                         "0 = 不限。定时任务靠它把单轮压进窗口，长跑靠它约束时长。")
    ap.add_argument("--sleep-check", type=float, default=0,
                    help="每张出完额外歇 N 秒（给 GPU 降降火，也留出被外部打断的窗）")
    ap.add_argument("--img-timeout", type=int, default=300,
                    help="**单张图**的等待上限秒数（正常 ≈62s）。卡死时不再白等 txt2img 的默认 3600s。")
    args = ap.parse_args()

    if args.dry:
        args.list = args.dry
        args.prompt_only = True

    allfish = load_fish()

    if args.plan:
        write_plan(allfish); return

    if args.forms:
        write_forms(allfish); return

    if args.prompts:
        write_prompts(allfish); return

    if args.traits:
        report_traits(allfish); return

    if args.batch:
        bs = make_batches(allfish)
        if not 1 <= args.batch <= len(bs):
            sys.exit("批次号超范围：共 %d 批" % len(bs))
        fish = bs[args.batch - 1]
        print("第 %d 批（%s ×%d）：%s" % (args.batch, RAR_CN[fish[0]["rar"]], len(fish),
                                        "、".join(f["id"] + " " + f["name"] for f in fish)))
    else:
        fish = pick(allfish, args)

    if args.prompt_only:
        for f in fish:
            print("== %s %s  rar%d  %s  %s / %s" %
                  (f["id"], f["name"], f["rar"], f["shape"], f["body"], f["accent"]))
            print(build_prompt(f)); print()
        return

    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    if os.path.exists(MANIFEST):
        manifest = json.load(open(MANIFEST, encoding="utf-8"))

    def run_t2i(prompt, path):
        """出图 + 等落盘。返回 (是否成功, CompletedProcess)。

        ⚠️ **必须给等待设上限**。`txt2img.py` 自己的默认是 **3600 秒** ——
           正常一张只要 62 秒，也就是说**卡住时最坏能白等 1 小时**。
           无人值守长跑时这是致命的：一次静默卡死就吃掉整晚的 1/8。
           实测见过真卡（一张图停在原地 4.5 分钟没动静、ComfyUI 队列却是空的），
           所以这里收到 `--img-timeout`（默认 300 秒 = 正常值的 5 倍，够宽容但有界），
           超时后**重试一次**再判失败 —— 单次抖动不该让一条鱼落空。
        """
        for attempt in (1, 2):
            r = subprocess.run([PY, COMFY, "-p", prompt, "-n", NEG, "--cfg", str(CFG),
                                "-o", path, "-W", str(W), "-H", str(H),
                                "--steps", str(STEPS), "--seed", str(SEED),
                                "--timeout", str(args.img_timeout)],
                               capture_output=True, text=True, errors="replace")
            if os.path.exists(path):
                return True, r
            if attempt == 1:
                print("    …超时/未落盘，重试一次")
        return False, r

    os.makedirs(TMP, exist_ok=True)
    # 任务序列：母版 → 五档（`normal` 不是独立出图，它就是母版的抠图）
    # ⚠️ 五档的任务里**只带档位名**，颜色句在出图那一刻才按鱼 id 挑（`morph_pick`）——
    #    提前挑好会导致「挑一次、后面复用」，manifest 与图反而更容易对不上。
    jobs = []
    for f in fish:
        if not args.morphs_only:
            jobs.append((f, None))
        if not args.masters_only:
            for key, _desc in MORPHS:
                jobs.append((f, key))

    per = len(jobs) // len(fish) if fish else 0
    print("待生成 %d 张（%d 条鱼 × %d 张）" % (len(jobs), len(fish), per))

    # ── 互斥锁：**两个生图进程同时跑会重复出图 + 并发写 manifest.json** ──
    #    这不是假想风险：定时任务（每小时一轮）与长跑本来就会撞上。
    #    判据用「心跳过期」而不是查 pid —— 查进程在本项目沙箱里不可靠（见 MEMORY.md）。
    #    每张图出完刷新一次心跳；超过 STALE 秒没动静 = 上一个进程已死，可以接管。
    LOCK = os.path.join(OUT, ".gen-art.lock")
    STALE = 300

    def lock_write():
        try:
            json.dump({"pid": os.getpid(), "ts": time.time(), "budgetMin": args.budget_min},
                      open(LOCK, "w", encoding="utf-8"))
        except Exception:
            pass

    if not args.plan:
        try:
            d = json.load(open(LOCK, encoding="utf-8"))
        except Exception:
            d = None
        if d and time.time() - d.get("ts", 0) <= STALE:
            print("⏸ 已有生图进程在跑（pid=%s，%d 秒前还有心跳）—— 本轮不重复开工。"
                  % (d.get("pid"), int(time.time() - d.get("ts", 0))))
            print("   避免重复出图、以及两个进程并发写 manifest.json。")
            return
    lock_write()

    # ── manifest 定期落盘 ────────────────────────────────────────────────────
    # 🔴 **不能只在收尾写一次**。长跑（整夜/整天）中途被杀（客户端关闭、崩溃）时，
    #    整本出图台账 —— 提示词、种子、cfg、**该档抽中的颜色句候选键** —— 就全丢了。
    #    图还在磁盘上，但**复现不了、也说不清是哪套颜色句出的**。
    #    用「写临时文件 + os.replace 原子替换」：避免写到一半被杀，留下半个 JSON
    #    （那会让 check-cards.py 直接解析失败）。
    def save_manifest():
        tmp = MANIFEST + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=1, sort_keys=True)
        os.replace(tmp, MANIFEST)

    CHECKPOINT = 10          # 每 10 张（≈10 分钟）落一次
    t_start = time.time()
    ok = fail = skip = 0
    for i, (f, morph) in enumerate(jobs, 1):
        # ⏱ 时间预算：**在任务边界收工**（不打断正在进行的那张），剩余下一轮 --skip-existing 续跑
        if args.budget_min and (time.time() - t_start) / 60.0 >= args.budget_min:
            print("\n⏱ 时间预算 %.0f 分钟已到，干净收工。本轮到第 %d/%d 张，"
                  "剩余下一轮续跑（加 --skip-existing）。" % (args.budget_min, i - 1, len(jobs)))
            break
        fid = f["id"]
        variant_tag = ""
        if morph is None:
            dst, prompt, label = os.path.join(OUT, fid + ".png"), build_prompt(f), "母版"
        else:
            variant_ck, variant_tag, desc = morph_pick(fid, morph)
            dst = os.path.join(OUT, "%s-%s.png" % (fid, morph))
            prompt, label = build_morph_prompt(f, desc), MORPH_CN[morph]

        if args.skip_existing and os.path.exists(dst):
            print("[%d/%d] %s %-7s 已存在，跳过" % (i, len(jobs), fid, label))
            skip += 1
            continue

        print("\n[%d/%d] %s %s   %s%s" % (i, len(jobs), fid, f["name"], label,
                                          ("　[" + variant_tag + "]") if variant_tag else ""))
        if morph is None:
            # 母版：RGB 暗底（与 docs/images/标准/ 一致的外观对照）
            good, r = run_t2i(prompt, dst)
            if good:
                # 原色档 = 母版的抠图（不重新生成：省一次出图，且与母版必然同色）
                cutout.cut_one(dst, os.path.join(OUT, fid + "-normal.png"))
        else:
            raw = os.path.join(TMP, "%s-%s.png" % (fid, morph))
            good, r = run_t2i(prompt, raw)
            if good:
                good = cutout.cut_one(raw, dst)      # 出图后立刻抠成 RGBA
                if os.path.exists(raw):
                    os.remove(raw)

        if good:
            ok += 1
            if morph is None:
                manifest[fid] = {
                    "name": f["name"], "rar": f["rar"], "shape": f["shape"],
                    "prompt": prompt, "negative": NEG, "seed": SEED, "cfg": CFG,
                    "size": [W, H], "steps": STEPS, "model": MODEL,
                }
            else:
                # ⚠️ **必须把「抽中的是哪个候选键」写进 manifest** ——
                #    颜色句现在是从池子里抽的，只记 prompt 就还得反查是哪一套；
                #    记了键，`MORPH_CANDIDATES` 一改就能立刻看出哪些图受影响。
                manifest.setdefault(fid, {}).setdefault("morphs", {})[morph] = {
                    "candidate": variant_ck, "label": variant_tag, "prompt": prompt}
                # 抽到哪一套也记下来 —— 光看提示词能反查，但列出标签便于人核对分布与复现
                manifest.setdefault(fid, {}).setdefault("morphVariant", {})[morph] = variant_tag
            print("    ok")
        else:
            fail += 1
            print("    失败：" + (r.stdout or r.stderr or "")[-200:])
        lock_write()          # 心跳（见上：锁靠心跳过期来自愈，不查 pid）
        if (ok + fail + skip) % CHECKPOINT == 0:
            save_manifest()   # 定期落盘（见上：长跑被杀不能连台账一起丢）

    save_manifest()
    try:
        os.remove(LOCK)       # 正常收工要主动释放；异常中断则靠心跳过期自愈
    except OSError:
        pass
    print("\n" + "=" * 50)
    print("成功 %d / 失败 %d / 跳过 %d，清单 %s（共 %d 条）"
          % (ok, fail, skip, MANIFEST, len(manifest)))
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
