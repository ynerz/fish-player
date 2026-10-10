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

# 步数**按档**给（用户口径 2026-10-08：「让黄金档和闪光档都使用 35 步来操作」）。
# 只给这两档 +10 步的理由：它们的颜色句最"花"（黄金要金属高光、闪光要细碎亮斑），
# 多一点步数能把材质收稳一点。
# ⚠️ **别把步数当画质旋钮**：实测 25 → 40 步面片密度只 +9%、40 → 60 反而 −3%（已到平台），
#    而耗时是**线性**的（≈1.79 秒/步 + 7.4 秒固定开销）。全表与证据图见
#    `docs/画风与颜色标准.md` §7.4 与 `docs/images/card-ab/steps-ab-*`。
# ⚠️ 改了这里，**已生成的那些并不会自动重出**（`--skip-existing` 只看文件在不在）——
#    所以 `report_stale()` 现在也把「步数与当前口径不符」算作过期。
STEPS_BY_MORPH = {"golden": 35, "shiny": 35}
# 稀有度也参与定步数（用户口径 2026-10-08：「传说级别的鱼使用 35 步，史诗使用 30」）。
# 两者**取 max**：比如「史诗的黄金档」= max(30, 35) = 35；「传说的母版」= 35；普通鱼的母版 = 25。
STEPS_BY_RAR = {3: 35, 2: 30}


def steps_for(f, morph=None):
    """这一张图出多少步。**唯一口径** = max(按稀有度, 按档位)，都没命中就是 `STEPS`。

    ⚠️ 改这里之后，**已生成的卡不会自动重出**（`--skip-existing` 只看文件在不在）——
       `report_stale()` 会拿同一个函数算，把「步数不一致」也算作过期。
    """
    rar = (f or {}).get("rar") if isinstance(f, dict) else f
    return max(STEPS_BY_RAR.get(rar, STEPS), STEPS_BY_MORPH.get(morph or "", STEPS))



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

# ⑤ 闪光档专用面片措辞 —— 只用在**闪光**这一档（用户口径 2026-10-08：
#    「闪光档不用是以前很多面的格式，防止有些部分看起来像小像素块」）。
#    为什么单独给闪光档：它的颜色句本来就要求「布满细碎亮斑」（`sparkling glittering speckles`），
#    再叠一层**密集三角网格**，局部就会碎成「小像素块」。
#    ⇒ 保留低模大块面的读法，但明确**不要**密集网格 / 碎小面。
#    ⚠️ 母版与另两档（彩虹 / 白化）仍是 `GEOM`（那是 v9 标定过的、最贴面片密度靶子 3.6 的措辞）。
#    🔴 2026-10-10 改动（Q29 ②）：这一档原来「掉密度」掉过头了（实测 A44 闪光档 **1.21**，
#       远低于 2.5 的下限）⇒ 加一句 `with a light even subdivision` 把它**往回收一点**。
#       实测同一批对拍：1.21 → **1.49**（+23%）。⚠️ **仍在下限之下** —— 因为压制它的主要不是
#       这句面片措辞，而是颜色句里那层「布满细碎亮斑」；要真到 2.5 就得动颜色句，
#       而那正是用户 2026-10-08 拍过的口径（方案里的 B 选项）⇒ **本轮不碰**，只做这一档能做的。
GEOM_COARSE = ("Broad faceted low-poly surface, clearly separated flat facets of moderate size "
               "with a light even subdivision, crisp straight edges between facets, "
               "even flat shading across each facet, no busy micro-facets, no texture, no gradients.")

# ⑥ 黄金档专用面片措辞（Q29 ①，2026-10-10 用户拍板「就按 A + A 做」）—— 介于 GEOM 与 GEOM_COARSE 之间。
#   为什么黄金档要单开：它的颜色句里有 `sharp brilliant specular reflections across the facets`
#   （在**面片层面**点高光），配上默认那套**密集**三角网 ⇒ 每个面片都被点一块高光，色块被切碎。
#   实测（A44 黄金档 @35 步，同鱼同种子，只差这一句；`tools/facet-count.py`）：
#     默认 `GEOM` **5.16**（>5 = 发碎）→ `GEOM_MEDIUM` **3.68**（靶子 3.56，基本正中）。
GEOM_MEDIUM = ("Moderately faceted low-poly surface, clearly readable flat facets of moderate size, "
               "crisp visible polygon edges, flat shading per facet with subtle tone variation "
               "between neighbouring facets, no dense mesh, no busy micro-facets, no texture, no gradients.")

# 挂哪一档用哪一句：**只有 golden 与 shiny 两档例外**，母版与另两档（彩虹 / 白化）继续走 GEOM。
GEOM_BY_MORPH = {"golden": GEOM_MEDIUM, "shiny": GEOM_COARSE}


def geom_for(morph):
    """这一档用哪套面片措辞。**唯一口径** —— 别在别处再写一份（母版 = None ⇒ 用 GEOM）。"""
    return GEOM_BY_MORPH.get(morph or "", GEOM)


# ③ 光照 —— 逐字取自 v9（`gen9.py` 的 LIGHT）。用户口径：边缘光、不加环境补光。
#    ⚠️ **绝对不许出现 soft** —— v10 首版把 `strong rim light` 改成
#        `single soft rim light along the top edge`，明暗对比当场垮掉，
#        这是「图变难看」最直接的一条。硬边高对比是这套画风的命。
LIGHT = ("strong rim light along the back and tail, no ambient fill light, "
         "deep unlit shadow side, high contrast between the lit edge and the shadow, "
         "high-end product render look.")

# ⚠️ **只换开头那个「部件锚点」**，后面 4 句（no ambient fill light / deep unlit shadow side /
#    high contrast / high-end product render look）逐字不动 —— 它们是「好看」的来源（坑 5），
#    动一个字都会掉明暗对比。为什么必须换：现在的水母提示词在要求
#    「边光打在没有的**背和尾**上」，等于把光说给了一个不存在的部位。
LIGHT_HEAD = "strong rim light along the back and tail"


def light_for(f):
    """这一段用哪句 `LIGHT`。**唯一入口**（默认体型原样返回 `LIGHT`）。

    ⚠️ 收 `f`（整条鱼）而不是 `shape` —— 措辞现在是**两层覆写**：
       默认 → `SHAPE_WORDS[shape]` → `SPECIES_WORDS[id]`（见 `words_for()`）。
    """
    head = shape_word(f, "light")
    return (head + LIGHT[len(LIGHT_HEAD):]) if head else LIGHT

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
                 "thin iridescent rainbow film across the {sides}, metallic hues drifting from teal "
                 "and green into violet and magenta, high-chroma colourful specular highlights, "
                 "colour that changes across the curved facets"),
    "bright/4": ("霓虹荧光条",
                 "electric neon rainbow colouring, glowing saturated stripes in magenta, cyan and "
                 "lime running along the {sides}, fluorescent high-voltage palette, "
                 "luminous coloured edge glow"),
    "bright/5": ("背腹双色域",
                 "the upper body flooded with saturated magenta and red, the lower body with "
                 "electric cyan and deep blue, a hard hue boundary along the {sides}, "
                 "vivid rainbow-tinted {part}"),
    # ── 白化族 ──
    #  ⚠️ `{part}` / `{sides}` / `{under}` / `{over}` / `{surface}` 的**取值随体型变**
    #     （默认值在 `COLOR_TOKEN_DEFAULTS`、覆写在 `SHAPE_WORDS[shape]["tokens"]`）。
    #     眼睛那句**不是占位符**：它整段由 `EYE_CLAUSE_RE` 在无眼体型上摘掉（水母不长鱼眼睛）。
    #     默认体型（fish 等）全部逐字不变 —— 这是「301 条鱼族的卡不许被判成过期」的保证。
    "albino/1": ("奶白（基准）",
                 "albino colouring, pale creamy white body, soft pink translucent {part}, "
                 "pale pink eye"),
    "albino/2": ("冷调冰白",
                 "ice-white albino colouring, snow-pale body, cool desaturated shading deepening "
                 "to pale slate blue in the shadow, milky translucent {part} with a faint cold tint, "
                 "small pink eye"),
    "albino/3": ("暖调象牙",
                 "warm ivory albino colouring, creamy off-white body, soft beige shading in the "
                 "shadow, pearlescent coating over the facets, translucent {part} with a pale rosy "
                 "edge, coral pink eye"),
    "albino/4": ("珍珠白+粉鳍缘",
                 "pearl-white albino colouring, lustrous pale body with a faint silvery sheen, "
                 "translucent {part} washed with soft pink, delicate pink rim along the {partsg} edges, "
                 "deep ruby-pink eye"),
    "albino/5": ("大理石白",
                 "chalky white albino colouring, marble-pale body with faint pale grey markings "
                 "between the facets, low saturation, translucent rose-tinted {part}, pink eye"),
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
    #                        ⚠️ 尾巴那半句「the same glitter carried right across the belly…」是
    #                        2026-10-08 用户口径加的（「肚子没那么闪光」）：候选句原本只写了 `body`，
    #                        而腹部被 `a clearly lighter belly` 提亮成均匀浅色 ⇒ 闪不起来。
    #                        实测这半句把 Δ腹 从 +15.4pp 压到 +5.7pp（配合按档明暗句到 −5pp）。
    "shiny/1":  ("星点（基准）",
                 "iridescent shimmering body covered in sparkling glittering speckles, "
                 "bright specular glints, star-shaped sparkle highlights, prismatic sheen, "
                 "the same glitter carried right across the {under}, "
                 "{under} {surface} sparkling as brightly as the {over}"),
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
                 "thin aurora film coating, green and violet shimmer travelling along the {sides}, "
                 "sharp bright specular streaks, luminous metallic base, "
                 "iridescent sparkle concentrated on the lit edge"),
    # ── 闪光族：**保留本色**的一组（`{base}` = 这条鱼自己的原色句）──────────────
    # 🔴 2026-10-08 用户口径：「不能简单的在原始图片的提示词下加全身闪光特效吗？」
    #    —— 上面 shiny/1~5 都是**把原色句整句删掉**换成一套虹彩材质；
    #    而**游戏内**那一侧根本不是这么做的，见 `src/render/fishpaint.js` 的 shiny 分支：
    #       `// 手段 = 加光效（虹彩 + 移动高光 + 星点）。保留鱼本色的色相，但拉到高明度`
    #       `back: hslToRgb(hd[0], …, 0.62)`   ← hd[0] 就是这条鱼自己的色相
    #    外加 `config.colorMorphs` 里 `shiny.tint = '#9be7ff'`（叠加色，不是替换）。
    #    `docs/画风与颜色标准.md` 也写着两侧「共用同一套颜色口径，这是不分家的保证」——
    #    所以**删掉本色句的那一侧是偏离方**，这里补上「保留本色 + 叠光效」的候选。
    # ⚠️ 文生图里「保留本色」只是**软约束**：写满虹彩/棱镜类词时色相会被拉向银白
    #    （i2i 时代吃过「泛化描述干不过参考图色相」的亏；t2i 里是「词更长 / 越靠后越占优」）。
    #    所以这一组必须实测，别凭联想下结论。对拍见 docs/images/prompt-ab/。
    "shiny/6":  ("本色+细碎闪粉",
                 "{base}, plus a dense dusting of tiny bright sparkling glints over the whole "
                 "surface, fine glittering highlights catching the light on every facet, "
                 "brilliant pinpoint sparkle"),
    "shiny/7":  ("本色+金属亮片",
                 "{base}, sprinkled with hundreds of tiny mirror-bright metallic flecks that "
                 "flash as the light moves, crisp pinpoint specular glints, "
                 "glittering metal-dust finish"),
    "shiny/8":  ("本色+虹彩高光",
                 "{base}, under a thin iridescent film that lights up only in the highlights, "
                 "bright travelling specular glints, sharp sparkling streaks along the lit edge"),
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
    # 「1、7 轮换，比例 1:1」（2026-10-08 用户口径，取代「闪光仅选用 1」）
    "shiny":  [("shiny/1", 1), ("shiny/7", 1)],
}
MORPH_CN = {"bright": "彩虹色", "albino": "白化", "golden": "黄金", "shiny": "闪光"}
MORPH_ORDER = ("bright", "albino", "golden", "shiny")

# ────────────────────────────────────────────────────────────────────────────
# 🔴 **按稀有度覆盖池子**（2026-10-08 用户口径）
#
# 「传说级的是生成 2 版，而且传说级的鱼的白化也是百分之百珍珠白加粉色那一版；
#   黄金是 24k 镜面金；彩虹色是全息镭射膜那一版」
#
# 传说（rar3）是**展示品**：售价 ×100、概率 4~5%，一条鱼才被看到几次 ——
# 同一档在不同传说鱼之间出参差（今天亮金明天古铜金）反而掉价。
# 所以传说档把这四档**定死**，不再走加权轮换。
#
# ⚠️ 只覆盖点名的档：没点名的档（此处没有）继续用 `MORPH_POOL`。
#    覆盖表里的池子**同样只存「候选键 + 权重」**，句子仍从 `MORPH_CANDIDATES` 取
#    —— 这条由 `check_pools()` 与 `verify §33-f` 一起盯。
# ────────────────────────────────────────────────────────────────────────────
MORPH_POOL_BY_RAR = {
    3: {
        "bright": [("shiny/3", 1)],     # 全息镭射膜
        "albino": [("albino/4", 1)],    # 珍珠白 + 粉色鳍缘
        "golden": [("golden/2", 1)],    # 24K 镜面金
    },
}

# 🔴 **一档出几版**
#
# 用户口径（2026-10-08 立，2026-10-10 更正后定稿）：
#   「**只有传说档闪光才需要两档让我选一档**」
#
# 为什么只有传说档：传说是**展示品**（售价 ×100、概率 4~5%，一条鱼玩家才看到几次），
#   同一档在传说鱼之间出参差反而掉价 ⇒ 传说档的四档本来就都「定死」（见 `MORPH_POOL_BY_RAR`），
#   闪光再多给一版候选、由人挑出最好的那张。
#   ⚠️ 2026-10-10 中途试过「**所有稀有度**的闪光都出 2 版」，用户当场更正为**只限传说档** ——
#      那张 `MORPH_VERSIONS` 覆盖表已清空。**别再加回去**：362 条全出两版 = 白跑 335 张图。
#
# ⚠️ 这是全项目唯一「同一条鱼同一档出两张」的地方：
#   第 2 版文件名加 `-N` 后缀（第 1 版仍是 `<id>-<档>.png`），
#   所以清单 / `check-cards.py` / `--skip-existing` / 评审台的既有口径都不用改。
# ⚠️ 两版都只是**候选**：游戏加载的是主文件名 `<id>-shiny.png`。
#   挑完要用 `python tools/pick-card.py <id> shiny 2` 把选中的那版**扶正**
#   （它会把文件与 manifest 里的候选记录一起换 —— **别手工改名**，手工改会让台账与盘上对不上）。
MORPH_VERSIONS = {}

# 按稀有度的覆写：**传说档的闪光出 2 版**（上面那条用户口径）。
# ⚠️ 闪光池本来就备了 2 个候选（`shiny/1` 星点 / `shiny/7` 本色+金属亮片，权重 1:1），
#    而多版走的是**池子顺序前 N 项、不抽样** ⇒ 「2 版」= 把原先按 id 加权二选一的那两个
#    **都出出来**给人挑，**一句颜色句都不用多写**。
# 校验见 `check_pools()`：版数必须 ≤ **该稀有度实际会用的那个池子**的长度。
MORPH_VERSIONS_BY_RAR = {3: {"shiny": 2}}


def pool_for(key, rar=None):
    """这一条鱼、这一档该用哪个池子。

    **唯一入口** —— 别在别处直接读 `MORPH_POOL`，否则「按稀有度覆盖」会被绕过，
    而且**不报错**（传说鱼照旧轮换出参差，图上永远看不出来是哪一步漏了）。
    `verify §33-f` 会盯 `pool_entries()` 必须走这里。
    """
    return MORPH_POOL_BY_RAR.get(rar, {}).get(key, MORPH_POOL[key])


def morph_version_count(rar, key):
    """这条鱼这一档**要出几版** —— **唯一判据**。

    🔴 判据只许有这一处：出图（`morph_versions()`）、清单排期（`write_plan()`）、
       A/B 对拍（`tools/prompt-ab.py`）三处都读它。分开写的话，
       「清单说 6 张、实际出 7 张」这种偏差**不会报错**，只会让工期估计悄悄失真 ——
       而清单是排期与「还剩多少」的唯一依据。
    取法：**按稀有度的覆写 > 每档默认 > 1**。
    现状：按稀有度的表里**只有**「稀有度 3（传说）的闪光 = 2 版」这一条
    （用户口径「只有传说档闪光才需要两档让我选一档」），每档默认表为空。
    """
    return MORPH_VERSIONS_BY_RAR.get(rar, {}).get(key, MORPH_VERSIONS.get(key, 1))


def pool_entries(key, rar=None):
    """把池子展开成 `[(候选键, 标签, 颜色句, 权重), …]` —— 出图、挑选、提示词表都走这里。

    ⚠️ **带上「候选键」**（如 `bright/1`）而不只是标签：提示词表要能回答
       「这条鱼这一档抽中的是**哪一套**」，光有中文标签对不上 `MORPH_CANDIDATES`。
    """
    return [(ck, MORPH_CANDIDATES[ck][0], MORPH_CANDIDATES[ck][1], w)
            for ck, w in pool_for(key, rar)]


def _check_one_pool(key, pairs, where):
    """池子结构自检（`MORPH_POOL` 与按稀有度的覆盖表共用一份逻辑）。"""
    if not pairs:
        raise RuntimeError("%s：%s 档的池子是空的 —— 整档会退化成没有颜色句" % (where, key))
    for ck, w in pairs:
        if ck not in MORPH_CANDIDATES:
            raise RuntimeError("%s：%s 的池子引用了不存在的候选键：%s" % (where, key, ck))
        if not isinstance(w, int) or isinstance(w, bool) or w < 1:
            raise RuntimeError("%s：%s/%s 的权重必须是 ≥1 的整数（≤0 = 这套句子永远抽不到，"
                               "而且不报错）：%r" % (where, key, ck, w))
        if not MORPH_CANDIDATES[ck][1].strip():
            raise RuntimeError("%s：%s/%s 的颜色句是空的" % (where, key, ck))
    tags = [MORPH_CANDIDATES[ck][0] for ck, _w in pairs]
    if len(set(tags)) != len(tags):
        raise RuntimeError("%s：%s 的池子里有重名标签，日志分不清抽到了哪套：%s" % (where, key, tags))


def check_pools():
    """池子自检 —— **模块加载时就跑**，任何一条不满足直接抛。

    为什么不做成「记得手动跑一下」的工具：这几类错误**全都不报错、只出错结果** ——
    权重 ≤0 的句子永远抽不到（静默少一套风格）、候选键打错在抽样时才 KeyError、
    池子空了让整档退化成无颜色句、**按稀有度的覆盖挂到不存在的档上**（那条鱼永远读不到它）。
    而「要记得手动跑检查」正是本项目反复栽跟头的地方。
    """
    for key in MORPH_ORDER:
        if key not in MORPH_POOL:
            raise RuntimeError("颜色句池子缺档位：%s" % key)
        _check_one_pool(key, MORPH_POOL[key], "MORPH_POOL")
    for rar, ov in MORPH_POOL_BY_RAR.items():
        if rar not in (0, 1, 2, 3):
            raise RuntimeError("MORPH_POOL_BY_RAR 里的稀有度不合法：%r" % (rar,))
        for key, pairs in ov.items():
            if key not in MORPH_ORDER:
                raise RuntimeError("MORPH_POOL_BY_RAR[%d] 里挂了不存在的档：%s —— "
                                   "这条鱼永远读不到它，而且不报错" % (rar, key))
            _check_one_pool(key, pairs, "MORPH_POOL_BY_RAR[%d]" % rar)
    for key, n in MORPH_VERSIONS.items():
        if key not in MORPH_ORDER:
            raise RuntimeError("MORPH_VERSIONS 里挂了不存在的档：%s —— "
                               "这条永远读不到，而且不报错" % (key,))
        if not isinstance(n, int) or isinstance(n, bool) or n < 1:
            # n == 1 等价于没有这一条；n < 1 会让这档**一张都不出**
            raise RuntimeError("MORPH_VERSIONS[%s] 必须是 ≥1 的整数：%r"
                               "（<1 会让这一档一张都不出，而且不报错）" % (key, n))
    for rar, ov in MORPH_VERSIONS_BY_RAR.items():
        if rar not in (0, 1, 2, 3):
            raise RuntimeError("MORPH_VERSIONS_BY_RAR 里的稀有度不合法：%r" % (rar,))
        for key, n in ov.items():
            if key not in MORPH_ORDER:
                raise RuntimeError("MORPH_VERSIONS_BY_RAR[%d] 里挂了不存在的档：%s" % (rar, key))
            if not isinstance(n, int) or isinstance(n, bool) or n < 1:
                raise RuntimeError("MORPH_VERSIONS_BY_RAR[%d][%s] 必须是 ≥1 的整数：%r"
                                   "（<1 会让这一档一张都不出，而且不报错）" % (rar, key, n))
    # 🔴 版数必须**逐个稀有度跟它实际会用的那个池子**比。
    #    旧写法只比默认池子 `MORPH_POOL[key]`，于是「`MORPH_POOL_BY_RAR` 把某个档的池子
    #    改短了、而版数还写着 2」这种组合漏网：第 2 版**抽不到**，而且不报错。
    for rar in (0, 1, 2, 3):
        for key in MORPH_ORDER:
            n = morph_version_count(rar, key)
            plen = len(pool_for(key, rar))
            if n > plen:
                raise RuntimeError(
                    "稀有度 %d 的 %s 档要出 %d 版，但它**实际会用**的池子只有 %d 项 —— "
                    "多出来的版本抽不到，而且不报错（池子见 pool_for()）"
                    % (rar, key, n, plen))


check_pools()


def morph_pick(fid, key, rar=None):
    """按鱼 id **稳定加权重**挑一套颜色句 → `(候选键, 标签, 颜色句)`。

    ⚠️ 用 md5 而**不是** Python 内置 `hash()`：`hash()` 带 PYTHONHASHSEED 随机盐，
       **每次进程启动结果都不一样** → 同一条鱼今天出金色、明天出古铜金，
       manifest 里记的提示词与磁盘上的图对不上，可复现性（硬约束）当场失效。

    ⚠️ 「按 id 稳定」≠「每档只有一套」：**不同鱼之间是分散的**（这才是用户要的
       「五档颜色句可以随机抽」），只是同一条鱼重跑必须落到同一套。
    """
    entries = pool_entries(key, rar)
    total = sum(e[3] for e in entries)
    r = int(hashlib.md5(("%s/%s" % (fid, key)).encode("utf-8")).hexdigest()[:8], 16) % total
    for ck, tag, sent, w in entries:
        if r < w:
            return ck, tag, sent
        r -= w
    return entries[-1][0], entries[-1][1], entries[-1][2]      # 不可达，纯防守


def morph_versions(f, key):
    """这条鱼这一档**要出几版** → `[(候选键, 标签, 颜色句, 文件名后缀), …]`。

    常规 = 按鱼 id 稳定加权抽 **1** 套（后缀 `""`）；
    **传说档的闪光 = 2 版**（后缀 `""` 与 `"-2"`），见 `MORPH_VERSIONS_BY_RAR`。

    ⚠️ 多版走的是**池子顺序前 N 项**、**不抽样** —— 用户要的就是「这两版都给我看」，
       抽样会把「都出」变成「随机出其中一个」。
    ⚠️ 后缀 `""` 的那一版必须留在**主文件名**上（`<id>-<档>.png`），
       否则清单勾选 / `check-cards.py` / `--skip-existing` 的既有口径全部失配。
    """
    entries = pool_entries(key, f.get("rar"))
    n = morph_version_count(f.get("rar"), key)
    if n > 1:
        return [(ck, tag, sent, "" if i == 0 else "-%d" % (i + 1))
                for i, (ck, tag, sent, _w) in enumerate(entries[:n])]
    ck, tag, sent = morph_pick(f["id"], key, f.get("rar"))
    return [(ck, tag, sent, "")]


# ⚠️ 保留 `MORPHS` 这个名字与「5 档」语义：`morph_keys()`、耗时常量、manifest 都按它算。
#    它就是「各档池子的第 0 项」，**不是**另一份颜色句定义。
MORPHS = [(k, MORPH_CANDIDATES[MORPH_POOL[k][0][0]][1]) for k in MORPH_ORDER]

# —— 体型：形态句 + 「华丽」作用在哪个部件上 ——
#    `fin` 决定稀有度递进加长哪个部位；水母是触手、鳐是翼、鲸是尾叶。
#    ⚠️ 形态句里**不要写尾型** —— 尾型一律由 `tail` 字段给，否则会拼出
#       「forks tail, a fan-shaped tail」这种自相矛盾的话（实测踩过）。
#    🔴 2026-10-09 新增 3 个体型（`crustacean` / `star` / `worm`，9 → 12）：
#       它们原来**没有专属体型**，被兜底成 squid / jelly / eel ⇒ 数据模型里写着
#       「小龙虾 = 鱿鱼」，2D 画出来是一只乌贼。工程侧必须同步四处，缺一处就会**静默**
#       回落或报错（都不是「图难看」那么轻）：
#         · `src/render/fishart.js` 的 `TPL`（缺 = 回落 `TPL.fish`，画面与鱼无异）
#         · `tools/review-cards.py` 的 `SHAPE_CN`（缺 = 评审页裸印内部键）
#         · `tools/style-preview.html` 的「全形态总览」代表鱼（缺 = 那节少一种形态）
#         · 文档里的「N 种体型」（`verify §33` 现算比对）
#    ⚠️ **所有** `d` 都只描述构造、**不许点自己的名**（2026-10-08 的教训：写了动物名就是物种指令，
#       实测把小龙虾画成乌贼）。2026-10-09 把老 9 条也改掉了 —— 它们原先写着
#       `squid with…` / `jellyfish with…`，只因为 **362 条鱼全都有查证过的 `form`**
#       （`build_prompt` ⓪ 有 `form` 就整句丢弃）才一句都没输出过：**潜伏坑**，
#       哪天新增一条没有 `form` 的鱼，它就会拿这句当主语、原样复发。
#       ⇒ 判据落在 `verify §33-c` 的 ⑤e（含别名表与判据自检）。
SHAPES = {
    "fish":    {"d": "a streamlined body with a rounded oval outline, a tapering caudal peduncle and small paired fins",
                "fin": "fins", "finSafe": "fins"},
    "eel":     {"d": "a long slender ribbon-like body with a continuous low fin running from the back to the tail tip",
                "fin": "dorsal fin", "finSafe": "fins"},
    "ray":     {"d": "a broad flat diamond-shaped disc formed by the pectoral fins, with a long thin whip-like tail",
                "fin": "wings", "finSafe": "wings"},
    "squid":   {"d": "a soft muscular mantle with a pointed tip and a cluster of long trailing arms",
                "fin": "side fins", "finSafe": "arms"},
    "jelly":   {"d": "a translucent dome-shaped bell with long thin tentacles hanging below it",
                "fin": "tentacles", "finSafe": "tentacles"},
    "oarfish": {"d": "ribbon fish with an extremely long thin body and a tall crest fin running the whole back",
                "fin": "crest fin", "finSafe": "fins"},
    "shark":   {"d": "a torpedo-shaped body with a pointed snout and a tall triangular dorsal fin",
                "fin": "fins", "finSafe": "fins"},
    "whale":   {"d": "a bulky rounded body with a broad horizontal tail fluke and a small set-back dorsal fin",
                "fin": "fluke", "finSafe": "fluke"},
    # 🔴 2026-10-10 用户口径：「**龙之类的提示词可以让其完全不像鱼，显得炫酷一点就好**」
    #    ⇒ 从「有须的蛇」改成「脊柱 + 冠 + 从肩后掠出的长鳍翼」——
    #    三个都是**一眼不像鱼**的部件，且都只写构造、不点物种名。
    #    ⚠️ 改这一条会让**全部 13 条龙**的提示词变化（卡会过期）—— 用户要的就是这个。
    "dragon":  {"d": "a long sinuous serpentine body that coils through the water, a tall crest of spines standing along the whole back, long fin-wings sweeping back from behind the head",
                "fin": "fin-wings", "finSafe": "fin-wings"},
    # ⚠️ 下面 3 条的 `d` **只写构造、不写动物名**（写了就是给模型下物种指令）
    "crustacean": {"d": "a jointed body under a hard segmented shell, a row of small jointed legs beneath it and a fan-shaped tail",
                "fin": "claws", "finSafe": "limbs"},
    "star":    {"d": "a small central disc with five long flexible tapering arms radiating out from it",
                "fin": "arms", "finSafe": "arms"},
    "worm":    {"d": "a soft elongated body, a ring of short tentacles at the front end, small tube feet along the underside",
                "fin": "front tentacles", "finSafe": "tentacles"},
    # ── 2026-10-10 新增 3 个（用户口径：「甲壳类、海蛇尾、软体长形少了…多加一些水生生物品种」） ──
    # ⚠️ 与 `crustacean` 的分工：那个是**虾形**（纵长分节腹 + 尾扇），这个是**蟹形**
    #    （横宽甲壳 + 一对螯）。两者是不同物种，共用一个剪影会画成一个样。
    "crab":    {"d": "a broad flattened shell wider than it is long, two large pincers at the front and short jointed legs along the lower edge",
                "fin": "claws", "finSafe": "claws"},
    "shell":   {"d": "a coiled spiral of stacked whorls carried on a soft muscular foot, a small head with short tentacles at the front",
                "fin": "shell ridge", "finSafe": "shell ridge"},
    "turtle":  {"d": "a domed armoured shell over a flattened body, four broad paddle-shaped limbs and a small head on a short neck",
                "fin": "flippers", "finSafe": "flippers"},
    # ── 2026-10-10 再加 3 个（用户口径：「甲壳类、沙蚕、蟹是不是太多了…改成深海中那种奇形怪状的水生生物」） ──
    # 三个**固着 / 漂浮**的深海奇形：既不是水母（没有伞盖）也不是沙蚕（有柄有冠）。
    "crinoid": {"d": "a long jointed stalk rising from a holdfast, topped by a crown of feathery arms that fan out like a flower",
                "fin": "feathery arms", "finSafe": "arms"},
    "siphonophore": {"d": "a small gas-filled float at the top with a long chain of small swimming bells and trailing threads hanging beneath it",
                "fin": "trailing threads", "finSafe": "trailing threads"},
    "anemone": {"d": "a squat muscular column fixed at the base, topped by one wide crown of thick tapering tentacles",
                "fin": "tentacle crown", "finSafe": "tentacles"},
    # ══════════════════════════════════════════════════════════════════════
    # 🔴 2026-10-10 把「通用鱼形」细分成 17 个体型
    #    用户口径：「通用鱼这个分类也有点大，可以体型再细分画风，例如鲟鱼和普通鱼
    #    长得就不一样。我希望同一个体型的生物最好不要超过 20 个」
    #
    # 为什么非拆不可：`fish` 一个键压着 **185 条**（占全鱼表 51%），而里面既有鲟鱼、
    #   比目鱼、海马、鮟鱇、旗鱼，也有鲤鱼和沙丁鱼 —— 图鉴按体型筛选时「通用鱼形」
    #   一屏 185 条，等于没有分类；程序化剪影也只能全画成「卵圆 + 叉尾」那一种。
    #
    # ⚠️ 三条纪律（改这张表前先读）：
    #   ① 每条 `d` **只写构造、不点自己的名**（`verify §33-c ⑤e` 按词边界扫键名）。
    #      `slender` / `deep` / `bottom` 这几个键本身是常用词，句子要绕开它们。
    #   ② `fin` / `finSafe` 一律写 **"fins"**（`puffer` / `seahorse` 也是 "fins"）——
    #      `finSafe` 只在有查证 `form` 时用，而 `RARITY[rar]` 会把它拼进「加长某个部件」。
    #      写成 `fins` 的唯一好处是：**这 185 条的稀有度句逐字不变**，已出的卡不算过期。
    #   ③ 不往 `SHAPE_WORDS` 里加条目（除 `flatfish` / `manta` 两处**措辞确实错了**的）。
    #      新体型全部走 `COLOR_TOKEN_DEFAULTS` ⇒ 前面五个钓场的提示词**一个字节都不变**，
    #      改的只是「分类」与 SS/SSS 的锚点句。
    # ══════════════════════════════════════════════════════════════════════
    # ── 普通鱼按体深与头部构型分（6 个）──
    "slender": {"d": "a long narrow body tapered at both ends, with a small forked tail and the fins set far back",
                "fin": "fins", "finSafe": "fins"},
    "minnow":  {"d": "a small compact body with a blunt rounded head and a short soft tail",
                "fin": "fins", "finSafe": "fins"},
    "deep":    {"d": "a tall laterally flattened body almost as high as it is long, with a small narrow tail",
                "fin": "fins", "finSafe": "fins"},
    "carp":    {"d": "a heavy thick-set body with large scales, a long dorsal fin and short barbels at the mouth",
                "fin": "fins", "finSafe": "fins"},
    "reef":    {"d": "a stout big-headed body with a heavy jaw, thick lips and a rounded tail",
                "fin": "fins", "finSafe": "fins"},
    "perch":   {"d": "a forward-leaning body with two separate dorsal fins and sharp spiny fin rays",
                "fin": "fins", "finSafe": "fins"},
    # ── 底栖与深海奇形（2 个）──
    "bottom":  {"d": "a broad flattened head with eyes set high on top and wide pectoral fins spread out sideways",
                "fin": "fins", "finSafe": "fins"},
    "fangfish": {"d": "a gaunt narrow body with an enormous gaping jaw of needle teeth and a small tapering tail",
                 "fin": "fins", "finSafe": "fins"},
    # ── 一眼可辨的独立体型（9 个）──
    "flatfish": {"d": "a flat oval body lying on one side, both eyes crowded onto the upper side, a fin fringe running all the way round it",
                 "fin": "fins", "finSafe": "fins"},
    "sturgeon": {"d": "an armoured body with rows of bony plates down the back and flanks, a long pointed snout with barbels beneath it, and a tail that sweeps up into the upper lobe",
                 "fin": "fins", "finSafe": "fins"},
    "mackerel": {"d": "a sleek spindle body with a row of small finlets behind the back and tail fins, and a deeply forked tail",
                 "fin": "fins", "finSafe": "fins"},
    "billfish": {"d": "a long rigid spear-like snout, a tall stiff sail standing on the back, and a slender body",
                 "fin": "fins", "finSafe": "fins"},
    "anglerfish": {"d": "a huge gaping jaw on a short rounded body, with a stalked lure hanging above the head",
                   "fin": "fins", "finSafe": "fins"},
    "puffer":  {"d": "a round inflated body covered in small plates, with tiny fins and almost no tail",
                "fin": "fins", "finSafe": "fins"},
    "seahorse": {"d": "an upright body balanced on a curled grasping tail, with a long tube snout and a small fin at the back",
                 "fin": "fins", "finSafe": "fins"},
    "catfish": {"d": "a wide flat head with long thin barbels trailing from the mouth and a smooth scaleless body",
                "fin": "fins", "finSafe": "fins"},
    # 鲳与鲑单列：鲳是「短圆无叉尾」，鲑是「流线 + 背鳍后一枚小脂鳍」——
    # 两者都常在搜索里被当成通用鱼形，但剪影都各有辨识点（见 `fishart.js` 的 `FISH_VARIANTS`）
    "pomfret":  {"d": "a short deep body with a blunt rounded head and a small tail that is barely forked",
                 "fin": "fins", "finSafe": "fins"},
    "salmon":   {"d": "a streamlined muscular body with a small fleshy fin set far back behind the dorsal fin",
                 "fin": "fins", "finSafe": "fins"},
    "manta":   {"d": "a vast flattened body spread into two wide wings, a pair of horn-like fins before the mouth and a long thin tail",
                "fin": "wings", "finSafe": "wings"},
}

# ────────────────────────────────────────────────────────────────────────────
# 🔴 **「鱼形家族」**（2026-10-10 加）—— 所有「有鳍、有背腹、侧视成立」的鱼形体型。
#
# 为什么要有这张表：把 `fish` 拆成 17 个体型之后，代码里那些 `shape == "fish"` 的门禁
#   全部**静默失效** —— 177 条鱼的比例句 / 科属特征 / 花纹 / 棘 / 须 / 牙齿当场消失，
#   而且不报错（提示词只是「短了一句」）。所以门禁一律改成**按集合判**：
#   比例句、名字族、花纹族、`FEATURE` 的七个特征位、`SPINE_SHAPES`、`TORSO_SHAPES`。
#
# ⚠️ 判据：`verify §33-c` 会静态扫「`== "fish"` 这种写法还在不在 gen-art.py 里」——
#    再加体型时**只改这一张表**，别回去写单键比较。
# ⚠️ `manta` **不在**这里面：它来自 `ray`，走的是鳐的措辞（`SHAPE_WORDS["manta"]`）。
FISH_SHAPES = ("fish", "slender", "minnow", "deep", "carp", "reef", "perch", "bottom",
               "catfish", "fangfish", "flatfish", "sturgeon", "mackerel", "billfish",
               "anglerfish", "puffer", "seahorse", "pomfret", "salmon")
# `fin` 与 `finSafe` 的区别（2026-10-08 加）：
#   · `fin`     —— **没有查证过的 `form` 时**用，可以点具体部位（"side fins" / "crest fin"）；
#   · `finSafe` —— **有查证过的 `form` 时**用，必须是**不点名物种的通用部件词**。
#     为什么：稀有度递进要「加长某个部件」，而 `form` 在场时体型模板已经整体让位
#     （见 `build_prompt` ⓪），此时再说 "slightly longer side fins" 就是给章鱼加长鱿鱼的鳍。
#     ⇒ 一律退回通用词（八腕类给 "arms"、水母给 "tentacles"、其余给 "fins"）。

# ────────────────────────────────────────────────────────────────────────────
# 🔴 **体型专属的解剖措辞**（2026-10-09 加，用户报障驱动）
#
# 病根：提示词有 5 处公共段写成了**鱼的解剖**，却对**所有体型**无条件生效 ——
#   ① 构图句 `full side view, ... facing left`
#   ② `palette_color()` 的部件词写死 `fins`
#   ③ `PALETTE_SHADE` 的 `a clearly lighter belly and a darker back`
#   ④ `LIGHT` 的 `strong rim light along the back and tail`
#   ⑤ `MORPH_SCOPE` 的 `over the whole fish including the head and the fins`
# 于是水母被要求「长鳍、有背腹、侧视朝左、尾上打边光」。
#
# 实测（用户报障，原图已逐张肉眼确认）：
#   `S16 灯塔水母` / `S17 深海水母` 的**五档彩色卡被画成了鱼**
#   （鱼身 + 眼睛 + 背鳍 + 叉尾鳍，肚子底下还挂着水母触手），而**母版侥幸没跑偏** ——
#   因为 ⑤ 那句 `over the whole fish including the head and the fins` **只有五档有、母版没有**。
#   同族先例：`proportion_line()` 2026-10-08 已按 `shape` 分流（非 `fish` 直接返回空串），
#   这 5 处是漏网的 —— 同一个坑第二次。
#
# ⚠️ **只覆盖「措辞确实错了」的 4 个体型**。`fish` / `shark` / `eel` / `oarfish` / `dragon`
#    一个字节都不许变：它们本来就有鳍、有背腹、有尾，改了等于把 **301 条已出的卡**
#    全部判成过期（`report_stale()` 是逐字比较的）。
# ⚠️ 每个键都**可缺省**（不写 = 保留原句）。缺省才是常态 ——
#    不要为了「统一」把本来成立的地方也换掉（鳐的背腹、鲸的「鳍」都是成立的）。
# ────────────────────────────────────────────────────────────────────────────
SHAPE_WORDS = {
    # 水母：辐射对称，没有鳍 / 背腹 / 头 / 眼，全靠伞盖与触手
    "jelly": {
        "tokens": {"part": "tentacles", "partsg": "tentacle", "sides": "bell", "head": "bell",
                   "under": "lower bell", "over": "bell top", "surface": "facets"},
        "no_eye": True,
        "frame": "full frontal view, whole body visible, radially symmetric",
        "shade": "a clearly lighter {under} margin and a darker {over}",
        "light": "strong rim light along the bell top and the tentacles",
        "scope": "the whole jellyfish including the bell and the tentacles",
    },
    # 八腕 / 十腕 / 甲壳类：部件是「腕」。写 `fins` 会把章鱼画成鱿鱼
    # （实测 `S28 深海章鱼` 的五档卡就是一只鱿鱼：长外套膜 + 三角鳍 + 尾鳍）。
    "squid": {
        "tokens": {"part": "arms", "partsg": "arm", "sides": "body",
                   "under": "lower surface", "surface": "skin"},
        "light": "strong rim light along the upper body and the arms",
        "scope": "the whole creature including the head and the arms",
    },
    # 鳐：`fins` 应作 `wings`。侧视朝向与背腹明暗对鳐都成立（鳐本来就是背深腹浅），故只换这两处。
    "ray": {
        "tokens": {"part": "wings", "partsg": "wing", "sides": "disc",
                   "under": "lower surface", "surface": "skin"},
        "scope": "the whole ray including the head and the wings",
    },
    # 鲸：`fins` 说得通（胸鳍 / 背鳍），错的是 `LIGHT` 的 «tail» 与 `MORPH_SCOPE` 的 «fish»。
    "whale": {
        "tokens": {"sides": "body", "surface": "skin"},
        "light": "strong rim light along the back and the fluke",
        "scope": "the whole whale including the head and the fluke",
    },
    # ── 2026-10-09 新增的 3 个体型（`fish.js` 里那 5 条不再被兜底到别类身上）──
    # 甲壳类：无鳍，部件是**壳与步足**；侧视成立，背腹成立（甲壳类就是背深腹浅）
    "crustacean": {
        "tokens": {"part": "limbs", "partsg": "limb", "sides": "shell", "head": "head",
                   "under": "lower body", "over": "upper body", "surface": "shell"},
        "light": "strong rim light along the shell and the limbs",
        "scope": "the whole creature including the head and the limbs",
    },
    # 棘皮·五辐射：**没有头 / 尾 / 背腹**，顶视才是它的正脸；且**没有眼**
    "star": {
        "tokens": {"part": "arms", "partsg": "arm", "sides": "disc", "head": "central disc",
                   "under": "lower surface", "over": "upper surface", "surface": "plates"},
        "no_eye": True,
        "frame": "full top view, whole body visible, five-fold symmetric",
        "shade": "a clearly lighter lower surface and a darker upper surface",
        "light": "strong rim light along the upper surface and the arms",
        "scope": "the whole creature including the central disc and the arms",
    },
    # 软长形无脊椎：口端一圈短触手，腹面管足；没有尾，也**没有眼**。
    # ⚠️ 这一条是**通用层**（海猪 / 管虫共用），两条各自的专门部件词留在 `SPECIES_WORDS`
    #    —— 这正是「体型层 = 剪影原型、物种层 = 专门词汇」的分工。
    "worm": {
        "tokens": {"part": "front tentacles", "partsg": "tentacle", "sides": "body",
                   "head": "front end", "under": "lower body", "over": "back",
                   "surface": "skin"},
        "no_eye": True,
        "light": "strong rim light along the body and the front tentacles",
        "scope": "the whole creature including the body and the front tentacles",
    },
    # ── 2026-10-10 新增 3 个（用户口径：「甲壳类、海蛇尾、软体长形少了…多加一些水生生物品种」） ──
    "crab": {
        "tokens": {"part": "claws", "partsg": "claw", "sides": "shell", "head": "front",
                   "under": "lower body", "over": "upper shell", "surface": "shell"},
        "light": "strong rim light along the shell and the claws",
        "scope": "the whole creature including the shell and the claws",
    },
    "shell": {
        "tokens": {"part": "shell ridge", "partsg": "ridge", "sides": "shell",
                   "head": "front end", "under": "foot", "over": "upper shell",
                   "surface": "shell"},
        "light": "strong rim light along the shell and the foot",
        "scope": "the whole creature including the shell and the foot",
    },
    "turtle": {
        "tokens": {"part": "flippers", "partsg": "flipper", "sides": "shell",
                   "head": "head", "under": "lower shell", "over": "carapace",
                   "surface": "plates"},
        "light": "strong rim light along the carapace and the flippers",
        "scope": "the whole creature including the head and the flippers",
    },
    # ── 2026-10-10 再加 3 个（用户口径：「甲壳类、沙蚕、蟹是不是太多了…改成深海中那种奇形怪状的水生生物」） ──
    # 三个都**没有眼**（海百合 / 管水母 / 海葵都不长眼睛），朝向也各不相同：
    #   海百合「冠朝上」、管水母「竖直垂挂」、海葵「坐在底上」。
    "crinoid": {
        "tokens": {"part": "feathery arms", "partsg": "arm", "sides": "stalk",
                   "head": "crown", "under": "lower stalk", "over": "upper stalk",
                   "surface": "plates"},
        "no_eye": True,
        "frame": "full side view, whole creature visible, the crown held up",
        "light": "strong rim light along the crown and the stalk",
        "scope": "the whole creature including the crown and the stalk",
    },
    "siphonophore": {
        "tokens": {"part": "trailing threads", "partsg": "thread", "sides": "chain",
                   "head": "float", "under": "lower chain", "over": "upper chain",
                   "surface": "bells"},
        "no_eye": True,
        "frame": "full side view, whole creature visible, hanging vertically",
        "light": "strong rim light along the float and the chain",
        "scope": "the whole creature including the float and the chain",
    },
    "anemone": {
        "tokens": {"part": "tentacles", "partsg": "tentacle", "sides": "column",
                   "head": "crown", "under": "base", "over": "upper column",
                   "surface": "column"},
        "no_eye": True,
        "frame": "full side view, whole creature visible, seated on the bottom",
        "light": "strong rim light along the crown and the column",
        "scope": "the whole creature including the crown and the column",
    },
    # 龙（2026-10-10 用户口径：完全不像鱼、炫酷）—— 之前它走的是 `fish` 的默认值（"fins"）
    "dragon": {
        "tokens": {"part": "fin-wings", "partsg": "fin-wing", "sides": "flanks",
                   "head": "head", "under": "belly", "over": "back",
                   "surface": "scales"},
        "light": "strong rim light along the crest and the fin-wings",
        "scope": "the whole creature including the head, the crest and the fin-wings",
    },
    # ── 2026-10-10 新增：**只有措辞确实错了的**两条才覆写（其余 17 个新体型走默认值，
    #    这样前面五个钓场的 185 条提示词逐字不变，已出的卡不算过期）──
    # 比目鱼：它**躺在海底**，朝上那面是「有眼面」、贴地那面是「盲面」；
    # 默认的「浅腹 + 深背」对它是错的 —— 实测这类句子会让模型画成一条立着的鱼。
    # ⚠️ 措辞里**不许出现 `eye` 这个词**：`check_shape_words()` 会把任何 `… eye` 的句子
    #    当成「无眼物种照抄了一只鱼眼睛」而报错（那条判据管的是 `EYE_CLAUSE_RE` 的粉眼句）。
    #    所以这里用「upper side / lower side」表达同一件事。
    "flatfish": {
        "tokens": {"part": "fin fringe", "partsg": "fin ray", "sides": "upper side",
                   "head": "head", "under": "lower side", "over": "upper side",
                   "surface": "plates"},
        "shade": "a clearly lighter lower side and a darker upper side",
        "light": "strong rim light along the upper side and the fin fringe",
        "scope": "the whole creature including the head and the fin fringe",
    },
    # 蝠鲼：从 `ray` 拆出来的翼状版，措辞与 `ray` 同源（不是「盘」而是「翼」）
    "manta": {
        "tokens": {"part": "wings", "partsg": "wing", "sides": "body",
                   "under": "lower surface", "surface": "skin"},
        "scope": "the whole creature including the head and the wings",
    },
}

# 颜色句里的占位符默认值 —— **`fish` / `shark` / `eel` / `oarfish` / `dragon` 全走默认值**，
# 于是它们的提示词逐字不变（这是「不许把 301 条鱼族的卡判成过期」的实现方式）。
# ⚠️ 默认值就是**改动前那些字**，别顺手改 —— 改一个词，全项目已出的母版卡都会变成陈旧。
COLOR_TOKEN_DEFAULTS = {"part": "fins", "partsg": "fin", "sides": "flanks", "head": "head",
                        "under": "belly", "over": "back", "surface": "scales"}


# 🔴 **逐条物种覆写**（2026-10-09 加，第三次修订 —— **只留 2 条**）
#
# 这条时间线值得留着，因为它演示了「同一个症状的两种修法，正确的那种会把另一种吃掉」：
#   ① 第一版：`D08` / `S21` / `S19` / `S20` / `S22` 全走 `SPECIES_WORDS`。
#      原因：`shape` 只是**几何模板**，这 5 条被兜底到「最接近但不同类」的体型上
#      （甲壳类→squid、海参类→jelly、棘皮/环节→eel）⇒ 拿到 arms / tentacles / fins
#      这些**不属于自己**的部件词，光换体型层的词救不回来。
#   ② 第二版（用户口径「体型表也要改」）：给它们补了专属体型
#      `crustacean` / `star` / `worm` ⇒ **上面 3 条（D08 / S21 / S20）的覆写就该删掉了**，
#      留着反而是第二份真相（体型层已经说对，物种层再重复一遍只会漂）。
#   ③ 现在只剩 `worm` **内部**要分开说的两条 —— 这就是本层真正的用途：
#      **体型层给剪影原型、物种层给专门词汇**（通用层说「front tentacles」，
#      海参是「tube feet」、管虫是「feathery crown」）。
#
# ⚠️ 覆写是**逐键合并**：没写的键继续吃体型层与默认值（所以不必把 7 个占位符抄全）。
# ⚠️ 每一条的覆写理由都写在自己那行上面：**这是「按物种的解剖事实」改，不是为了好看**。
# ⚠️ 它**不许**覆盖「鱼形家族」（`FISH_SHAPES`）里的条目（`verify §33-c` 的 ⑤b3 盯着）——
#    鱼族的提示词逐字不变是「已出的卡不被误判成过期」的前提。
SPECIES_WORDS = {
    # 🔴 2026-10-09 第二轮：这 5 条**已经有了自己的体型**（`crustacean` / `star` / `worm`），
    #    所以物种层只剩 `worm` 内部的两条需要分开说 —— 「体型层给剪影原型、
    #    物种层给专门词汇」，两层各司其职：
    #      · 海猪（海参类）：口端那圈是**管足**，不是触手；
    #      · 管虫（环节）：口端那圈是**羽毛状鳃冠**（比通用层说得更具体）。
    #    其余三条（D08 / S21 / S20）的专门词汇已经写在体型层，**不再需要逐条覆写**。
    # 海猪（海参类，走 `worm`）：靠腹面几对管足爬行，口端是短的口触手
    "S19": {
        "tokens": {"part": "tube feet", "partsg": "tube foot",
                   "under": "lower surface", "over": "upper surface"},
        "light": "strong rim light along the back and the tube feet",
        "scope": "the whole creature including the body and the tube feet",
    },
    # 管虫（环节，走 `worm`）：前端是羽毛状鳃冠，没有尾
    "S22": {
        "tokens": {"part": "feathery crown", "partsg": "crown"},
        "light": "strong rim light along the body and the crown",
        "scope": "the whole creature including the body and the crown",
    },
}


def words_for(f):
    """这一条鱼的措辞 —— **默认 → 体型 → 物种** 逐层覆写（唯一入口）。

    ⚠️ 三层里只有「默认」是常量：`fish` / `shark` / `eel` / `oarfish` / `dragon` 且不在
       `SPECIES_WORDS` 里的鱼，三层都不命中 ⇒ 逐字等于改动前的原句。
    """
    w = dict(SHAPE_WORDS.get((f or {}).get("shape") or "", {}))
    sp = SPECIES_WORDS.get((f or {}).get("id") or "")
    if sp:
        w.update({k: v for k, v in sp.items() if k != "tokens"})
        if sp.get("tokens"):
            t = dict(w.get("tokens") or {})
            t.update(sp["tokens"])
            w["tokens"] = t
    return w


def shape_word(f, key, default=""):
    """取这一条鱼在覆写表里的那一项措辞。**唯一入口** —— 别在别处再读这两张表。"""
    return words_for(f).get(key) or default


def color_tokens(f):
    """这一条鱼的颜色句占位符取值（默认值 + 体型覆写 + 物种覆写）。"""
    t = dict(COLOR_TOKEN_DEFAULTS)
    t.update(words_for(f).get("tokens") or {})
    return t


def fill_color_tokens(f, text):
    """把颜色句里的 `{part}` / `{sides}` / `{under}` / `{over}` / `{surface}` 换成本鱼的词。

    ⚠️ 对默认体型这必须是**恒等变换** —— `palette_color()` 与母版提示词逐字不变的保证就在这。
    """
    for k, v in color_tokens(f).items():
        text = text.replace("{" + k + "}", v)
    return text


# 眼睛从句：**只有 `albino/*` 五个候选带**（`pale pink eye` / `small pink eye` / …）。
# 水母没有可见的眼，带去会让它长出一只鱼眼睛（实测 `S16-albino.png` 就是粉眼睛的鱼）。
# ⇒ 无眼体型用一个**只做删除**的正则把它整段拿掉，而不是在候选句里插占位符 ——
#   占位符方案要求「带前导逗号的整段」随候选不同而不同，得给 `build_morph_prompt` 再加一个
#   `候选键` 参数，调用点（含 `check-prompt-drift.py`）全要跟着改，收益不值这个复杂度。
EYE_CLAUSE_RE = re.compile(r",\s*(?:pale pink|small pink|coral pink|deep ruby-pink|pink)\s+eye")


def check_shape_words():
    """体型 / 物种措辞表自检 —— **模块加载时就跑**（和 `check_pools()` 同一个套路）。

    拦的是四类「不报错、只出错结果」的写法：
      ① 体型名 / 鱼 id 打错（覆写永远读不到，那条鱼照旧收到鱼类措辞）；
      ② `tokens` 里写了没人消费的占位符键；
      ③ **任何**措辞句里出现没人替换的 `{xxx}` —— 它会原样写进提示词，模型照样照办；
      ④ 措辞句里的 `... eye` 不在 `EYE_CLAUSE_RE` 覆盖内 —— 无眼物种会照抄一只鱼眼睛。
    ⚠️ 扫描面 = `MORPH_CANDIDATES` + `PALETTE_SHADE_BY_MORPH` + `EXTRA_BY_MORPH` +
      两张覆写表的句值。**只扫候选总表是不够的**（2026-10-09 自己发现：明暗句与收尾句
      也被改成了带占位符的模板，却漏在扫描面之外 —— 写错 `{undar}` 一样不报错）。
    """
    ALLOWED_KEYS = ("tokens", "no_eye", "frame", "shade", "light", "scope")
    for sh, ov in SHAPE_WORDS.items():
        if sh not in SHAPES:
            raise RuntimeError("SHAPE_WORDS 里有不存在的体型：%s" % sh)
        for k in ov:
            if k not in ALLOWED_KEYS:
                raise RuntimeError("SHAPE_WORDS[%s] 有未知的键：%s（只许 %s）"
                                   % (sh, k, "、".join(ALLOWED_KEYS)))
    for fid, ov in SPECIES_WORDS.items():
        if not re.match(r"^[A-Z]{1,3}\d+$", fid):
            raise RuntimeError("SPECIES_WORDS 的键必须是鱼 id（形如 D08 / SS17）：%r" % (fid,))
        for k in ov:
            if k not in ALLOWED_KEYS:
                raise RuntimeError("SPECIES_WORDS[%s] 有未知的键：%s（只许 %s）"
                                   % (fid, k, "、".join(ALLOWED_KEYS)))
    for where, ov in (("SHAPE_WORDS", SHAPE_WORDS), ("SPECIES_WORDS", SPECIES_WORDS)):
        for key, body in ov.items():
            for k in (body.get("tokens") or {}):
                if k not in COLOR_TOKEN_DEFAULTS:
                    raise RuntimeError("%s[%s]['tokens'] 有未知占位符：%s（只许 %s）"
                                       % (where, key, k, "、".join(sorted(COLOR_TOKEN_DEFAULTS))))
    # ③④ 所有会写进提示词的句子统一过一遍。
    #    ⚠️ 「按档」那两句（明暗 / 收尾）**走实际调用取样本**，不在自检里点名引用那两张表 ——
    #       `verify §33-e` 盯着「按档例外只许出现两处」（定义 + 在 `xxx_for()` 里引用），
    #       这里再点一次名就会被判成「有人可能把它加到别的档上」。
    #       扫**填好占位符之后**的输出同样有效：没人替换的 `{undar}` 会原样留下来。
    allowed = set(COLOR_TOKEN_DEFAULTS) | {"base"}
    sentences = [("MORPH_CANDIDATES[%s]" % ck, sent)
                 for ck, (_tag, sent) in MORPH_CANDIDATES.items()]
    for m in (None,) + tuple(MORPH_ORDER):
        for sh in list(SHAPES):
            probe = {"id": "", "shape": sh}
            sentences.append(("shade_for(%r, %s)" % (m, sh), shade_for(m, probe)))
            sentences.append(("extra_for(%r, %s)" % (m, sh), extra_for(m, probe)))
    for where, ov in (("SHAPE_WORDS", SHAPE_WORDS), ("SPECIES_WORDS", SPECIES_WORDS)):
        for key, body in ov.items():
            for k in ("frame", "shade", "light", "scope"):
                if body.get(k):
                    sentences.append(("%s[%s][%s]" % (where, key, k), body[k]))
    for where, sent in sentences:
        for ph in re.findall(r"\{([a-z_]+)\}", sent):
            if ph not in allowed:
                raise RuntimeError("%s 里有没人替换的占位符 {%s} —— "
                                   "它会原样写进提示词（允许：%s）"
                                   % (where, ph, "、".join(sorted(allowed))))
        if " eye" in EYE_CLAUSE_RE.sub("", sent):
            raise RuntimeError("%s 里有一句 `… eye` 不在 EYE_CLAUSE_RE 覆盖内：%s"
                               " —— 改句子就要同步改正则，否则无眼物种会照抄这只眼睛"
                               % (where, sent))



# —— 尾型：**只对有独立尾鳍、且 tail 字段说得通的体型成立** ——
#    eel 无独立尾鳍 / ray 是鞭尾且已在体型描述里 / squid 是三角鳍 / jelly 没有 /
#    whale 的 tail 字段给不出 fluke 的正确说法（所以鲸的尾写在形态句里）。
# ⚠️ 2026-10-10 起按 `FISH_SHAPES` **集合**取（原先只写 `"fish"`）——
#    细分体型后单键比较会把 180 条鱼的尾型判断整体绕过。海马没有尾鳍，单独排除。
TAIL_SHAPES = tuple(s for s in FISH_SHAPES if s != "seahorse") + ("shark", "dragon", "oarfish")
TAIL = {"fan": "fan-shaped", "fork": "deeply forked", "lunate": "crescent-shaped",
        "round": "rounded", "whip": "long whip-like"}

# —— 特征位：**按体型过滤**（水母不长背棘、鲸没有须）——
#    glow 是通用的「边缘发光」，其余都要看体型。
# ⚠️ 2026-10-10 起「鱼形家族」一律写 `FISH_SHAPES` 而不是 `"fish"`：
#    细分体型后写单键 ⇒ 鲶鱼的须、鲤鱼的棘、比目鱼的斑点会**静默消失**（不报错）。
#    `FINNED` 就是「有鳍、能有背棘」的那批（鱼形 + 鳗 + 龙 + 鲨 + 皇带）。
FINNED = FISH_SHAPES + ("eel", "dragon", "shark", "oarfish")
FEATURE = {
    "spiny":   ("sharp spines along the back", FINNED),
    "barbels": ("long thin whisker barbels", FISH_SHAPES + ("eel", "dragon")),
    "glow":    ("a soft glowing edge along the outer silhouette", tuple(SHAPES)),
    "teeth":   ("small sharp visible teeth", FISH_SHAPES + ("shark",)),
    "lure":    ("a glowing lure on a stalk above the head", FISH_SHAPES + ("dragon",)),
    "stripes": ("vertical stripes down the body", FISH_SHAPES + ("shark", "eel")),
    # ⚠️ `manta` 要跟着 `ray` 一起加上：从鳐拆出去之后，斑点句只认 `ray` 会把蝠鲼的斑点丢掉
    "spots":   ("round spots on the body", FISH_SHAPES + ("shark", "ray", "manta")),
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
SPINE_SHAPES = FINNED

# ────────────────────────────────────────────────────────────────────────────
# 🔴 **传说级（rar == 3）的「点题奇幻元素」**（2026-10-09，用户口径：
#    「传说级别的鱼的提示词仔细检查，根据其名字可以加一些奇幻元素」）
#
# 为什么只挂传说档：传说鱼售价 ×100、概率 4~5%，是**展示品**，一条才被看到几次。
#   档位本身只有 `RARITY[3] = long layered overlapping {fin}` 这一条结构递进，
#   于是 27 条传说鱼彼此之间除了体型与配色**没有任何区别** —— 而它们的名字
#   （星陨 / 虚空 / 混沌 / 时之 / 终焉 / 创世）本来就写着奇幻设定，提示词里一个字都没兑现。
#
# ⚠️ 三条硬约束（都是本项目栽过的坑）：
#   ① 只用**结构 / 材质**词 —— `elaborate` / `ornate` / `decorative` 一出现就画成精细插画（坑 3）；
#   ② 不许引入**新物件或新场景** —— `BG` 要求 `completely empty`，
#      写「星星 / 光环 / 云雾」就是让背景漂移；所以一律写成**体表自身或剪影**的性质；
#   ③ 表序即优先级、**命中即止、一条鱼最多加一句** —— 叠两句就成词沙拉，模型只会全部忽略。
#      关键词按长度从长到短排（「星陨终焉」要让「星陨」先命中，「海沟之主」不要被「主」截胡）。
#
# 覆盖自查（27 条传说全部命中恰好一条，改表时请重跑 `--dry` 逐条目视）：
#   星陨族 4 · 时之/终焉族 6 · 虚空族 2 · 混沌/创世族 4 · 幽灵族 3 · 王者族 7 · 灵 1
# ────────────────────────────────────────────────────────────────────────────
FANTASY_MOTIFS = [
    (("星陨", "噬星", "星尘"),
     "a faint drifting scatter of tiny pale luminous stardust specks across the body"),
    (("时之", "尘时", "逆时", "残时", "时光", "纪元", "终焉", "终末", "终章", "忘川"),
     "thin concentric ring bands cut into the surface"),
    (("虚空", "无相", "空之", "裂空", "无光", "永夜"),
     "the outer surface deepening into a soft matte void-dark core along the back"),
    (("混沌", "初源", "最初", "原始", "创世"),
     "a few irregular broken facets interrupting the otherwise regular surface"),
    (("幽灵", "幽魂", "鬼", "幽蓝"),
     "the front section partly translucent, fading into the shadow"),
    (("塘主", "之神", "之王", "之主", "月神", "王座", "皇", "神", "王", "巨"),
     "a noticeably heavier individual than an ordinary one, with a stronger sense of mass"),
    (("灵",),
     "a soft pale luminous sheen running along the flanks"),
]


def fantasy_motif(name):
    """按名字里的意象词取一句奇幻点题句（`rar == 3` 专用）。命中即止，没有就返回空串。

    ⚠️ **只有传说档调用它**（`build_prompt` 里那道 `f.get("rar") == 3` 是唯一的门）。
       给普通鱼加奇幻句 = 362 条卡的口径全变，而且「稀有度递进」这个卖点当场作废。
    """
    for keys, sentence in FANTASY_MOTIFS:
        if any(k in (name or "") for k in keys):
            return sentence
    return ""


# ────────────────────────────────────────────────────────────────────────────
# 🔴 **SS / SSS 钓场的「分场奇幻语汇」**（2026-10-09 晚，用户口径：
#    「SS 鱼场和 SSS 渔场的鱼的名字基本都不是现实中的鱼了，都有一定的奇幻元素，
#      看看现有的提示词是不是还是不够奇幻，一定要符合它的名称，
#      使生成的图看起来就比前面渔场的要高级」）
#
# 🔎 **先量后改（改动前的实测，不是感觉）**：
#   · SS(80) + SSS(100) = **180 条**，稀有度分布 普通 84 / 稀有 50 / 史诗 31 / 传说 15；
#   · 名字能命中旧 `FANTASY_MOTIFS` 的有 **59 条**，但旧表唯一的门是 `rar == 3`
#     ⇒ **只有 15 条真的加上了句子，另外 165 条一个字奇幻元素都没有**；
#   · 星磷鱼 / 陨铁鲷 / 真空鳐 / 时砂小鱼 / 溯流鲑 这些名字里的设定，提示词里完全没兑现。
#   ⇒ 问题**不是「句子写得不够奇幻」，是「门开得太小 + 语汇没覆盖这两场的名字」**。
#
# **两场的气质本来就分得开**（从 180 个名字里数出来的）：
#   · **SS = 星空 · 陨铁 · 深渊**（星磷 / 陨铁 / 陨尘 / 暗星 / 夜穹 / 渊影 / 霜鳞 …）
#     ⇒ 材质语汇 = **嵌在体表的矿物与发光微粒**
#   · **SSS = 时间 · 纪元 · 遗迹 · 褶皱**（时砂 / 溯流 / 年轮 / 残页 / 刹那 / 终焉 …）
#     ⇒ 材质语汇 = **被时间磨过的层次与结晶**
#   ⇒ 于是 SSS 天然比 SS 高一级（SS 是「表面有一层东西」，SSS 是「内部有层次、整块在发光」），
#     **这正是用户要的「比前面渔场高级」**，而且不需要靠加更多修饰词去堆。
#
# ⚠️ 与 `FANTASY_MOTIFS` 同一套三条硬约束（都在 §17.7 / §17.15 栽过）：
#   ① 只用**结构 / 材质**词（`elaborate` / `ornate` 一出现就画成精细插画）；
#   ② **不许引入新物件或新场景** —— `BG` 是 `completely empty`，
#      所以「星」是**体表光点**、「沙」是**体表颗粒**、「页」是**磨平的斑块**，不许出现天空 / 道具；
#   ③ 每条鱼**最多一句**（叠两句=词沙拉），表序 = 优先级，长键在前。
#
# ⚠️ **两张表各自独立、不做共用兜底**：同一个词（虚空 / 原初 / 星尘）在两场的句子**必须不同**，
#    共用一张表会让 SSS 的「虚空鲽」与 SS 的「虚空鳗」长得一样 ⇒ 「更高一级」当场破功。
#    ⇒ 因此 `check_deep_motifs()`（**加载即校验**）要求：**两场各自的每条鱼都必须命中**，
#      且**表里不许有在该场一次都没命中的死行**（写了没人读 = 本项目最忌的那类数据）。
# ────────────────────────────────────────────────────────────────────────────
# ────────────────────────────────────────────────────────────────────────────
# 🔴 **SS / SSS 两场的「逐条奇幻描述」**（2026-10-10 用户口径：
#    「你对 sss 和 ss 渔场的鱼每一个的生成提示词都重新修改一下，让其非常符合其名称设定，
#      认真一个一个的对照修改」）
#
# 与上一版（16 + 21 行的**共用意象表**）的区别：那张表一行要服务 6~12 条鱼 ⇒ 同族鱼长一个样。
# 现在**每条鱼各写两句**，意象直接来自**它自己的名字**（星磷 / 陨砾 / 时砂 / 残页 / 千面 …）。
#
# 骨架（`build_deep_prompt`）—— 用户 2026-10-09 22:42 定的「简化原则」：
#   名字 + 身份句 + 体型锚点 + **这条鱼自己的两句** + 风格句 + 颜色句
#   （≈ 60~90 词；旧版 206 词，奇幻被解剖描述淹没了）
#
# 三条硬约束（都有实测）：
#   ① 不许用「这两场人人都有」的词（glow / luminous / translucent / ring …，见 §17.18）；
#   ② **闪烁族**（sparkle / glitter / glint）留给闪光档，原色档先用掉就没有递进了；
#   ③ ⛔ **不许用否定式描述「身体缺什么」**：`with no legs` 实测**反而让龙长出腿** ——
#      要改形态就换**正面的物种词**（`coiling sea-serpent` 而不是 `dragon`）。
# ────────────────────────────────────────────────────────────────────────────
DEEP_LINES = {
    # ── SS 80 ──────────────────────────────────────────────────────────────
    'SS01': 'A starlight-phosphor fish, its whole body lit by countless pale flecks. Tiny pale flakes carry their own light, strewn evenly from the head to the very tip of the tail.',
    'SS02': 'A smoking-iron crab armoured in crude fallen metal. Raw dark ore is fused over its entire shell, breaking the surface into hard black chips.',
    'SS03': 'A vacuum ray holding an emptiness at the centre of its disk. The middle of its body is bare grey, the colour simply gone from it.',
    'SS04': 'A deep-sea star-eel, a cold thread drawn out of the dark. Its back cools to near-black with a grey slate sheen along the whole length.',
    'SS05': 'A cold-light shrimp carrying a thin sliver of chill in front of its feelers. Its shell is matte near-black and a cold slate band lies along its upper body.',
    'SS06': 'A deep blue ghost jelly, drifting without hurry. Its dome sinks to a deep matte blue, darkest at the centre and thinning at the rim.',
    'SS07': 'A meteoric ash-shell dusted with the grit of a burned-out world. Fine grey mineral dust settles over every coil and packs into the seams of the shell.',
    'SS08': 'A dark-star shell with its outer coil sunk into the deep. The upper whorls are matte near-black and the lip of the shell stays pale and clean.',
    'SS09': 'A star-dust anchovy, the smallest drifting fragment of a dead star. A fine scatter of pale mineral flakes floats just beneath its skin.',
    'SS10': 'A gravel-meteor brittle star built out of broken stone. Loose chips of dark rock are lodged all over its arms, thickest near the central disc.',
    'SS11': 'A star-line bream, ruled across the body with bright mineral lines. Thin pale veins run straight from head to tail, cutting across every facet.',
    'SS12': 'A meteor-bass carrying a fallen star in its chest. One heavy lump of star-stone swells under its ribs and splits the plates around it.',
    'SS13': 'A dim-light cod holding a thin breath of light under the skin. A single faint line of pale flakes runs the length of its midline.',
    'SS14': 'A star-fragment goby, rough with the crumbs of a broken sky. Sharp little chips of pale stone are pressed into its hide from head to tail.',
    'SS15': 'A sand-meteor killifish with ground stone packed into it. Coarse mineral grit runs over its whole body in fine bands.',
    'SS16': 'A dim-star flounder, cold and flat on the bottom. Its flat body is deep cool blue, deepening rather than lightening toward the tail.',
    'SS17': 'A star-dust jelly, drifting like a torn fragment of night sky. Pale flakes are suspended in its soft dome, packed thickest in the middle.',
    'SS18': 'A stony tube-worm plated like a meteorite crust. Its crown of gills is made of thick slabs of stone with dark metal packed into the seams.',
    'SS19': 'A night-sheen ragworm, a long polished line of night. Its back runs matte black with a slate sheen and its underside stays pale.',
    'SS20': 'A broken-star ray whose disk has splintered. Its wing plates are cracked and chipped, several pieces broken clean away.',
    'SS21': 'A still anemone, an unnaturally quiet thing. Its column is ghost-pale and almost entirely unmarked.',
    'SS22': 'A rime-scaled salmon, cold to the touch. A frost-white film creeps over its whole body, every plate sealed under rime.',
    'SS23': 'A phantom brittle star, more suggestion than body. Its arms are pale and soft-edged, the pattern barely present at all.',
    'SS24': 'A star-fragment seahorse, brittle as a dried crumb of light. Its ridged plates are pale and crumbly, flecked with tiny bright chips.',
    'SS25': 'A falling-light anglerfish that lures with a shard of meteor. A blunt shard of bright metal hangs before its jaws and a pale band runs along its flank.',
    'SS26': 'A deep blue triggerfish, plated and cold. Its plates are deep matte blue, cooling further along the back.',
    'SS27': 'A star-sand flounder that has settled into the sea floor. Grit of pale star-sand is packed across its whole flat body.',
    'SS28': 'A meteor-line crab striped with the grain of fallen metal. Dark metallic lines are drawn across the full width of its shell.',
    'SS29': 'A night-sky sailfish, its body the colour of the deep. Long pale lines run down its flank, thin as thread.',
    'SS30': 'A starflare scad with one hard core of light. A cut-stone core sits deep in its chest, its facets meeting at one sharp point.',
    'SS31': 'A void-eel, thin as a line drawn through nothing. Its body fades out at every edge into bare grey.',
    'SS32': 'A falling-light brittle star, a long arm of burning metal. A pale metallic band is fused along the entire length of every arm.',
    'SS33': 'A nebula-ray carrying a cloud inside its wings. Drifts of pale colour are held inside its wing plates and gather near the centre.',
    'SS34': 'A trench-shadow crab, crawling as a moving dark. Its shell is matte black, the only relief a hollow set into one side.',
    'SS35': 'A deep-star octopus, patient and heavy. Its mantle is dark layered stone, the outer skin smooth and cold.',
    'SS36': 'A fallen-lantern shell, dulled and dented by its descent. Dented plates are jammed together around the whole coil.',
    'SS37': 'A star-eclipse crab, the dark where a star used to be. A wide dark patch eats into one side of the shell, swallowing the colour as it spreads.',
    'SS38': 'A hollow-hour pomfret, old before its own shape was settled. Its whole surface is dulled and ancient, the plates worn down to soft bevels.',
    'SS39': 'A shattered-meteor sea lily, its long stalk broken in places. Long cracks cross its papery stem with raw dark ore showing along them.',
    'SS40': 'A star-gauze jelly, a veil of thin colour. Its dome is made of layered pale sheets with colour suspended between them.',
    'SS41': 'A dim sea-dragon, a long cold thing of the deep. Its body is deep dull blue, darkening along the spine.',
    'SS42': 'A flat meteor-core flounder with its heavy centre exposed. A dark stone core sits in the middle of its body and the flat plates radiate outward from it.',
    'SS43': 'A void-light anglerfish carrying a thin splinter of emptiness. A narrow cold band runs down its flank and its skin is grey and empty.',
    'SS44': 'A dark-matter ray made of what nothing else is made of. Its disc is matte black with a cold grey edge and no pattern at all.',
    'SS45': 'A fallen-star ray, gliding as if it were still dropping. Its disk is layered dark stone and the edge plates are bent back.',
    'SS46': 'A void siphonophore whose long chain does not quite hold together. Its outline dissolves at the edges into colourless grey.',
    'SS47': 'An armoured meteor-sturgeon, ridged and plated along the whole back. Ranks of stone scutes run down its spine, each one chipped at the edge.',
    'SS48': 'A star-fragment octopus wrapped in a mantle of debris. Pale chips of stone are stuck all over its mantle in irregular rows.',
    'SS49': 'A falling-star sailfish whose bill is a splinter of meteor. The bill is one long shard of dark stone and its body is plated in chips.',
    'SS50': 'A star-core dragonfish with a stone heart. The core shows through as a bright polygon set deep inside its body.',
    'SS51': 'A sky-tearing ragworm with a single long split down its back. The split widens toward the rear and its edges are bared as raw stone.',
    'SS52': 'The trench-eyed giant crab, one eye opening into depth. A deep hollow is set behind the front edge of the shell, opening into black.',
    'SS53': 'A fallen leviathan that landed once and never quite recovered. Its hide is crushed stone, roughly layered with dark ore packed into the creases.',
    'SS54': 'A first-age sea lily, older than the sea it stands in. Its hide is rough weathered stone with the grain running along its length.',
    'SS55': 'A fallen-star colossal squid. Its mantle is a single dark slab of stone and its arms are layered pale metal.',
    'SS56': 'The void-jelly sovereign, drifting as a hollow crown. Its dome is bare grey, emptied of colour from the crown to the edge.',
    'SS57': 'An iron-meteor shark whose jaws are set with slabs of ore. Metal-stone slabs are wedged along its jawline and dark chips break out across its hide.',
    'SS58': 'The eclipse-ray king, its disc half swallowed by dark. A wide black crescent covers one wing with a soft edge.',
    'SS59': 'A falling-light sea-dragon, ridged along the whole spine. A pale metal band runs from its snout to its tail over overlapping plates.',
    'SS60': 'A small iron-meteor shrimp, dense as a struck anvil. Dark metal inclusions are packed tightly over its entire shell.',
    'SS61': 'A star-veined killifish with a mineral vein under the skin. One pale vein branches through its body and splits into finer threads at the tail.',
    'SS62': 'A void-flounder lying flat in emptiness. Its flat body is drained of colour with the bare structure showing through.',
    'SS63': 'A deep blue anchovy, a small cold spark in the dark. Its body is deep cool blue and paler on the belly.',
    'SS64': 'A star-fragment herring that swims in loose shoals of light. Its scales are pale flecks, gathered thickest along the belly.',
    'SS65': 'A grit-meteor seabass with sand fused into its scales. Ground mineral grit is welded over its flanks in rough plates.',
    'SS66': 'A faint-glimmer pomfret barely holding its own light. Only a thin wash of pale flecks remains on its flanks.',
    'SS67': 'A dark-reef anemone, stone-coloured and still. Its column is rough dark stone with the plates held tight together.',
    'SS68': 'A fallen-star eel, a thin dark seam of the sky. Broken facet edges run down its whole length.',
    'SS69': 'A fallen ray, heavy and grounded. Its disc is packed with dark ore and chipped at the rims.',
    'SS70': 'A void-pomfret, weightless and colourless. Its body thins away at the edges until only bare grey remains.',
    'SS71': 'A small eclipse-anemone, half of it gone dark. One side of the column is swallowed by a black patch that thins toward the base.',
    'SS72': 'The iron-meteor shark-king, a single mass of fused metal. Its whole body is one dark ore mass and the outer slabs split into hard chips.',
    'SS73': 'A star-core oarfish, a long ribbon with a hard centre. A single bright polygon is set deep in its chest and the ribbon body runs past it.',
    'SS74': 'A colossal deep blue ray, gliding very slowly. Its wings are matte deep blue with the colour thickening outward.',
    'SS75': 'A fallen-star leviathan carrying the end of the sky inside it. Its hide is polished star-stone and long dark seams of dead metal run its full length.',
    'SS76': 'The scaled sovereign of the fallen stars, crowned along the spine. Every plate of its hide is a slab of dark sky-stone laid in overlapping ranks.',
    'SS77': 'A pale moon-deity gliding on wide wings over the trench floor. Its wings are thin silver stone veined with cold mineral seams.',
    'SS78': 'A crown-anemone of the fallen sky, its column split by one long crack. The crack runs the whole length of it with the break bared as raw dark ore.',
    'SS79': 'The last chapter of the abyss, wearing a hide of swallowed stars. Clusters of pale points are packed into its chest plates, fading toward the tail.',
    'SS80': 'A ray that rules the endless night, half its mass given to emptiness. Its skin is matte void-black stone, cooling to a grey edge along the wings.',
    # ── SSS 100 ────────────────────────────────────────────────────────────
    'SSS01': 'A small time-sand fish that keeps the hour. Pale sand-grain drifts over its whole body and gathers in every crease.',
    'SSS02': 'A back-current salmon swimming against its own time. Thin pale lines run backwards along its body in even rows.',
    'SSS03': 'A zero-degree butterflyfish, cold past freezing. A pale frost-white film lies across its body with every plate sealed.',
    'SSS04': 'A yesterday shell, worn by the day that has just ended. Great patches of its coil are rubbed smooth and pale.',
    'SSS05': 'A relic killifish, small and worn down. Its surface is rubbed pale in patches from nose to tail.',
    'SSS06': 'An empty-hour anemone whose column never filled in. Its middle never took any colour, leaving a column of bare grey stone.',
    'SSS07': 'A single-instant bitterling, caught mid-motion. Its whole surface is held still, frozen in the middle of a move.',
    'SSS08': 'A fleeting-moment brittle star. Its arms are frozen mid-turn with the surface held unnaturally still.',
    'SSS09': 'A blink jelly. Its whole bell is caught mid-motion and held perfectly still.',
    'SSS10': 'A single-quarter-hour siphonophore. Its whole chain is held still, as if time had stopped inside it.',
    'SSS11': 'A passing-time ray. Long slow bands of light lie along its flat disc.',
    'SSS12': 'An amber bream holding something inside it. A deep amber core lies within its plates, thick and slowly deepening.',
    'SSS13': 'A relic grouper, heavy with age. Whole regions of its hide are worn away to smooth pale stone.',
    'SSS14': 'A last-echo siphonophore still carrying a sound that has ended. Widening pale bands ripple back down its chain.',
    'SSS15': 'A silent shell with its markings held back. Its surface is still and almost unmarked.',
    'SSS16': 'A dust-hour ragworm packed with the fine grit of passing time. Grey sand-grain is packed over its segments in even layers.',
    'SSS17': 'A first-snow trout. A pale frost-white film covers its body, cleaner along the back.',
    'SSS18': 'An hourglass jelly, narrow at the waist. Pale grain runs through its bell, pinched thinner in the middle.',
    'SSS19': 'An echo bass answering itself. Pale bands repeat down its body and weaken with every return.',
    'SSS20': 'An old-day sea lily. Its feathery crown is worn smooth and pale in broad patches.',
    'SSS21': 'A bream carved out of its own years. Deep age-bands are cut straight through its whole body, band after band.',
    'SSS22': 'An unfinished-hour anemone with its last band still forming. The bands on its column fade out before they reach the crown.',
    'SSS23': 'A star-track brittle star whose arms are a line of travel. A long pale line runs the whole length of every arm and fades at the tips.',
    'SSS24': 'A void jelly. Its outline fades at the edges into empty grey.',
    'SSS25': 'A yesterday ragworm, already faded though its day has just passed. Pale worn patches cover much of its hide in broad soft shapes.',
    'SSS26': 'A far-view pomfret, receding while you look at it. Its far plates fade pale, as if the body were receding away.',
    'SSS27': 'A resounding mullet. Even rows of pale lines double back along its whole length.',
    'SSS28': 'A first-light shell, the colour of a first morning. A thin dusty film of light lies over its coil, worn thinner at the lip.',
    'SSS29': 'A relic ray. Its wings are worn smooth in patches with the pattern rubbed away.',
    'SSS30': 'A dust-light jelly drifting in thin suspended light. A film of pale light lies on its dome, worn away at the rim.',
    'SSS31': 'A left-light ray carrying light that was abandoned. A dusty pale film lies over its disc, rubbed away in places.',
    'SSS32': 'A hollow-hour cod, its body a shell of its own hour. The flank has gone colourless and hollow, with the ribs reading through as grey ridges.',
    'SSS33': 'A reverse-time eel running the years backwards. Thin echo lines run backwards down its ribbon body.',
    'SSS34': 'A thousand-year fish with every year cut into it. Countless fine bands are stacked through its whole body.',
    'SSS35': 'A void sailfish. Its body fades out at the edges and its bill thins into nothing.',
    'SSS36': 'An era-sturgeon plated with centuries. Deep bands run through its scutes, one for each age.',
    'SSS37': 'A dusk ray gliding at the end of the light. Its whole disk deepens to a flat dusk-dark tone.',
    'SSS38': 'A dark-matter jelly. Dark ore is suspended in thick layers inside its dome.',
    'SSS39': 'A resounding bream. Pale bands repeat across its flank in even steps.',
    'SSS40': 'A living fold in space-time, folded through its own body. Layered plates of its hide stack in deep folds that never line up.',
    'SSS41': 'A counter-current sea-dragon. Long pale lines run the wrong way down its body.',
    'SSS42': 'A last-time ragworm, the end of a long ribbon of years. Its papery body is scored with pale backward lines.',
    'SSS43': 'An empty-hour anglerfish whose bright lure went out long ago. The rod above its eyes hangs slack with a pinched grey thread at the end.',
    'SSS44': 'A thousand-faced octopus with no two parts alike. Every plate on its mantle holds a different tone from its neighbours.',
    'SSS45': 'A reverse-void shark. Pale lines reverse along its flanks into flat grey.',
    'SSS46': 'A light-tracing anemone following light back to its source. Pale lines run back down its column and thin out at the base.',
    'SSS47': 'An old-day jelly. Its dome is worn thin and pale, fraying along one side.',
    'SSS48': 'A shadow-hour brittle star. A soft shadow band drifts slowly along its arms.',
    'SSS49': 'A loop-time shell whose years close into a circle. A thick pale loop is wound round the middle of its coil and the two ends meet in a seam.',
    'SSS50': 'A mute giant-mouth ragworm. Its long body is still and unpatterned, dark over pale.',
    'SSS51': 'A star-track ray. A pale line is cut across its wings from front to back.',
    'SSS52': 'An hour-marked pomfret. A single deep band cuts across the middle of its body.',
    'SSS53': 'A time-dragon whose length is ruled by years. Deep bands run the whole length of its body, even and close.',
    'SSS54': 'The crab at the very end. Its shell narrows and converges toward a dark point at the rear.',
    'SSS55': 'An eternal shell, one unbroken coil. Its whole surface is sealed under a continuous dark stone skin.',
    'SSS56': 'A first-source shelled swimmer that has not yet formed. Its surface is pale and almost colourless, a shape without a pattern.',
    'SSS57': 'A colossal star-dust ray. Pale dust is held in thick layers inside its wings.',
    'SSS58': 'A time-folded leviathan with centuries creased into it. Its hide is stacked in hundreds of thin plates, one for every age.',
    'SSS59': 'An era-folded abyssal sea lily, its whole stalk layered. Hundreds of thin plates pile along the stem, each one pressed under the last.',
    'SSS60': 'A colossal reverse-entropy squid. Its mantle is layered pale stone and the layers reverse direction midway.',
    'SSS61': 'A last-echo sea-dragon, still carrying the sound of something finished. Pale wave-lines run back along its long body and weaken toward the tail.',
    'SSS62': 'A void-winged ray. Its wings are bare grey with the colour gone from them.',
    'SSS63': 'A passing-time wide-mouthed anemone. Slow bands of light run across its column in order.',
    'SSS64': 'A time-scarred flounder, marked where the years crossed it. Thin pale grit-lines cross its flat body in long scored bands.',
    'SSS65': 'A reverse-light cod with its light running the wrong way. Thin light-lines travel backwards along its flanks from tail to head.',
    'SSS66': 'A year-reckoning ragworm. Fine even bands are cut across its segments from front to rear.',
    'SSS67': 'A time-tracing mullet following the years upstream. Pale back-running lines are cut into its sides.',
    'SSS68': 'A torn-page bream with its history half rubbed away. Its flat flanks are worn smooth in large pale patches.',
    'SSS69': 'A blank-page sea lily with everything erased from it. Its whole crown is rubbed down to bare pale stone.',
    'SSS70': 'A forgotten shell, worn where nobody has looked at it. Patches of pale worn stone cover its coil in uneven shapes.',
    'SSS71': 'A dust-of-the-past siphonophore. Fine pale grit lies over its bells in drifts.',
    'SSS72': 'A late-hour siphonophore. Its float is worn pale at the front and darkens toward the end of the chain.',
    'SSS73': 'A light-gathering brittle star hoarding what others left behind. Thin pale light is caught along its arms, thickest near the disc.',
    'SSS74': 'A reverse-journey flounder travelling back the way it came. Pale lines run backwards across its flat body in even rows.',
    'SSS75': 'A flowing-year siphonophore. Pale bands flow down its long chain one after another.',
    'SSS76': 'A hollow-stemmed sea lily. Its stem is bare grey stone, worn through in places to show what lies under.',
    'SSS77': 'A hush-hour ragworm. Almost no marking crosses its segments, only a still grey surface.',
    'SSS78': 'A time-sturgeon. Long deep bands run the length of its plated body.',
    'SSS79': 'A back-current ragworm, the longest ribbon of returning water. Back-running pale lines score its whole body.',
    'SSS80': 'A reverse-entropy ray whose own order is running down. Pale lines reverse outward across its wings and fade at the tips.',
    'SSS81': 'A hollow-hour sea lily. Its crown is colourless grey, the plates worn down to soft bevels.',
    'SSS82': 'A thousand-year ray whose disk is a record of ages. Deep age-bands are cut across the whole disk, one inside the next.',
    'SSS83': 'A time-gauze jelly, a thin drifting veil. Fine pale grain is suspended in its dome like cloth.',
    'SSS84': 'An empty-year octopus. Its mantle fades at the edges and its arms thin away into grey.',
    'SSS85': 'A reverse-journey crab. Pale back-running lines cross its shell and its front limbs end in dull stone knobs.',
    'SSS86': 'An era-giant shark. Deep bands run along its flanks with dark metal packed between them.',
    'SSS87': 'A passing-time candle-dragon, its body a long wick of slow years. Light-bands travel the whole length of it and gather in one band behind the head.',
    'SSS88': 'A thousand-year shell grown older than its sea. Deep bands run the whole length of its coil, band after band.',
    'SSS89': 'A counter-current sea lily. Long pale lines run backwards the full length of its stalk.',
    'SSS90': 'A siphonophore folded out of empty time. Its float is layered pale grey stone and the folds widen toward the tail of the chain.',
    'SSS91': 'An era-ribbon worm, older than the count it carries. Bands of advancing years are cut down its long soft body, one behind the next.',
    'SSS92': 'The final point of time, vast and shapeless. Its mass is one unbroken slab of dark stone, blank from end to end.',
    'SSS93': 'The shadow of the first source, a serpent of raw chaos. Its hide is broken into irregular plates that do not fit together.',
    'SSS94': 'An era of endings, standing in the river of forgetting. Its stalk is layered grey stone worn pale in long bands.',
    'SSS95': 'The end of time, drifting alone as a vast shapeless mass. Its body is one mass of stacked pale plates with light held between them.',
    'SSS96': 'The first scale of creation, still hardening. Its hide is hardening out of colourless primordial stone with faint light moving inside it.',
    'SSS97': 'The shadow of the last fisherman, still holding its line. Its body is pale layered stone thinned into one long drifting shadow.',
    'SSS98': 'The shell at the end of all eras. Its whorls are layered grey stone and the hollow of the coil shows through.',
    'SSS99': 'The first scale born out of chaos. Its plates never settle into a pattern, each one a different shape.',
    'SSS100': 'The shadow of the end crossing the river of forgetting. Its chain is worn grey stone faded to pale bands along the upper edge.',
}


# 🔴 **两场的「身份句」**（2026-10-09 22:42 用户口径：「奇幻的表述要多一点，宏大一点」）。
#    位置紧跟物种名：先让模型知道**它不是一条普通的鱼**，再看材质句。
DEEP_LEAD = {
    "SS": "a mythic creature of the abyss, unmistakably not an ordinary fish",
    "SSS": "an elder being from a forgotten age, unmistakably not an ordinary fish",
}

# 哪些钓场走「逐条」骨架（前面五个钓场的口径**一个字都不动**）
DEEP_FIELDS = ("SS", "SSS")

# 两场的颜色句抬头（替掉前面钓场的 `natural realistic colouring`）——
# SS 是深渊异界矿物生物、SSS 是走过漫长岁月的老东西，同一个抬头会把两场糊成一层。
DEEP_COLOR_HEAD = {"SS": "unearthly colouring", "SSS": "primeval colouring"}

# 体型锚点：**奇幻词，不是解剖词**（实测：不点体型时「无相巨鲲」被画成一条普通大鱼）。
DEEP_ANCHOR = {
    "fish": "a fish-like creature of the deep",
    "eel": "a long eel-bodied serpent",
    "shark": "a heavy shark-bodied beast",
    "whale": "a colossal leviathan",
    "dragon": "a colossal coiling sea-serpent, all spine and crest, with long fin-wings sweeping back from its shoulders",
    "squid": "a many-armed creature of the deep",
    "ray": "a broad winged ray-like being",
    "jelly": "a drifting jelly-mass",
    "oarfish": "a ribbon-like serpent of the open water",
    "crustacean": "an armoured crawling beast",
    "star": "a five-armed star-being",
    "worm": "a soft long-bodied creature",
    "crab": "a broad armoured bottom-crawler",
    "shell": "a coiled shell-creature",
    "turtle": "an armoured shelled swimmer",
    "crinoid": "a feathered stalk-creature of the deep",
    "siphonophore": "a long drifting chain-creature",
    "anemone": "a rooted flower-beast of the deep",
    # ── 2026-10-10 细分「通用鱼形」后新增的 17 条（口径见 `SHAPES` 的注释）──
    # 每条都要**短而具体**：它进的是 SS/SSS 提示词的第三句（体型锚点），太长会盖过风格句。
    # ⚠️ `manta` 是鳐的翼状版，锚点里要说「翼」而不是「盘」—— 那是它唯一与 `ray` 的区别。
    "slender": "a long narrow-bodied fish of the open water",
    "minnow": "a small compact-bodied fish",
    "deep": "a tall flat-sided fish, as high as it is long",
    "carp": "a heavy thick-bodied bottom-feeder",
    "reef": "a stout big-headed dweller of the rocks",
    "perch": "a spiny-finned hunting fish",
    "bottom": "a broad-headed fish resting on the seabed",
    "catfish": "a whiskered flat-headed bottom-feeder",
    "fangfish": "a gaunt wide-jawed creature of the abyss",
    "flatfish": "a flat one-sided creature that lies on the seabed",
    "sturgeon": "an armoured plated creature with a long snout and barbels",
    "mackerel": "a sleek swift-bodied fish of the open water",
    "billfish": "a long-billed racer with a tall sail on its back",
    "anglerfish": "a huge-jawed creature with a lure hung over its head",
    "puffer": "a round inflated creature with tiny fins",
    "seahorse": "an upright creature with a curled tail and a tube snout",
    "manta": "a vast winged ray-like being with horns before its mouth",
    "pomfret": "a short deep-bodied fish with a tiny tail",
    "salmon": "a sleek muscular fish with a small fleshy fin behind its back",
}

# 🔴 用词纪律（机器强制，判据在 `check_deep_motifs()` 与 `verify` 第 ㊾ 节，按词边界扫）
DEEP_MOTIF_BANNED = ("glow", "glowing", "luminous", "translucent", "crystalline",
                     "concentric", "ring", "rings",
                     "sparkle", "sparkling", "glitter", "glittering", "glint", "scintillating")

# ⛔ 「否定式描述身体缺什么」的判据只认「否定词 + 身体部位」，避免误伤 without hurry 这类正常说法
DEEP_BANNED_NEG = ("legs", "limbs", "arms", "fins", "eye", "eyes", "mouth",
                   "tail", "head", "jaw", "scales")

# 判据用的三个正则（**只写一处**，`verify` 第 ㊾ 节按同样的口径做静态扫描）
BAN_RE = lambda w: r"\b" + w + r"\b"
NEG_RE = r"\b(with no|without|legless)\b"
BODY_RE = r"\b(" + "|".join(DEEP_BANNED_NEG) + r")\b"


def deep_lead(f):
    """SS / SSS 的身份句（其他钓场返回空串）。"""
    return DEEP_LEAD.get(f.get("field"), "")


def deep_lines(f):
    """**这条鱼自己的两句**描述（逐条写，不再按意象族共用）。"""
    return DEEP_LINES.get(f.get("id"), "")


def build_deep_prompt(f, morph=None):
    """SS / SSS 的骨架：名字 + 身份句 + 体型锚点 + 逐条两句 + 风格句 + 颜色句。

    ⚠️ **颜色句必须是 `palette_color(f)` 原样** —— 五档靠 `build_morph_prompt()` 替换那半句
       （`p.replace(pc, …)`），少一个字就替换不上、会直接抛 RuntimeError。
    ⚠️ 稀有度递进（`RARITY[rar_i]` 的鳍部措辞）**保留**在风格句里 ——
       它管「档位越高鳍越复杂」，删掉会让 SS/SSS 场内的递进一起没了。
    """
    shape = f.get("shape", "fish")
    spec = SHAPES.get(shape, SHAPES["fish"])
    verified = trait_of(f["id"], "form") or ""
    fin_word = spec.get("finSafe", spec["fin"]) if verified else spec["fin"]
    rar_i = min(3, f.get("rar", 0))
    rar = RARITY[rar_i].format(fin=fin_word, extra=extra_for(morph, f))
    frame_head = shape_word(f, "frame", "full side view, whole body visible, facing left")

    parts = [
        "low poly 3D fantasy creature named %s, %s, %s." % (
            f["name"], deep_lead(f) or "a creature of the deep",
            DEEP_ANCHOR.get(shape, DEEP_ANCHOR["fish"])),
        deep_lines(f),
        "Faceted low-poly stylisation, %s, flat shading, %s, centered with generous margin, "
        "empty dark background." % (rar, frame_head),
        palette_color(f) + ", " + shade_for(morph, f) + ".",
    ]
    return " ".join(p for p in parts if p)


# 🔴 **加载即校验**：逐条表必须**恰好覆盖**两场 180 条（漏一条 / 多一条都报错），
#    且不许踩用词纪律与「否定式描述缺失」。
#    （与 `check_pools()` / `check_shape_words()` 同一套路：不合格直接抛，不静默放行。）
def check_deep_motifs():
    fish = load_fish()
    deep = {f["id"]: f for f in fish if f.get("field") in DEEP_FIELDS}
    missing = sorted(set(deep) - set(DEEP_LINES))
    extra = sorted(set(DEEP_LINES) - set(deep))
    if missing or extra:
        raise SystemExit(
            "❌ SS / SSS 逐条表与鱼表对不上：缺 %d 条 %s / 多 %d 条 %s"
            % (len(missing), missing[:12], len(extra), extra[:12]))
    for fid, txt in DEEP_LINES.items():
        low = txt.lower()
        hit = [w for w in DEEP_MOTIF_BANNED if re.search(BAN_RE(w), low)]
        if hit:
            raise SystemExit("❌ %s 的描述用了禁用词 %s：%s" % (fid, "、".join(hit), txt[:110]))
        if re.search(NEG_RE, low) and re.search(BODY_RE, low):
            raise SystemExit(
                "❌ %s 用**否定式**描述身体缺什么（实测 with no legs 反而画出腿）：%s"
                % (fid, txt[:110]))
        if len(txt.split()) < 12:
            raise SystemExit("❌ %s 的描述太短（<12 词），起不到定形作用：%s" % (fid, txt))
    print("  · SS/SSS 逐条描述 %d 条，覆盖与用词纪律全部通过" % len(DEEP_LINES))


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


# 颜色句的**后半句**：背腹明暗。
# 🔴 提成常量是因为它必须**同时**出现在母版与五档里 —— 写两遍必然分家，
#    而 `paint-card.py` 的渐变映射（颜色 = 灰度的函数）就靠这一句撑着。
PALETTE_SHADE = "a clearly lighter belly and a darker back"

# 🔴 闪光档专用的「明暗句」（2026-10-08 用户报障：「闪光的问题在于肚子没那么闪光」）。
#    为什么默认那句在闪光档上是**负作用**：`a clearly lighter belly` 命令腹部变成**一块更亮的均匀色**，
#    而闪光的视觉本质是「局部高对比的亮点」——把腹部整体提亮等于**把局部对比洗掉**。
#    实测（`tools/measure-shine.py`，Δ = 背 − 腹，正数 = 腹更不闪）：改前 Δ腹 **+14~+17pp**，
#    腹部**比背部更亮**（166 vs 147）却只有**一半的闪度**（9% vs 27%）⇒ 又亮又平 = 不闪。
#    换成这句后 Δ腹 → **−4.5~−9.0pp**（腹部反而比背更闪）。
PALETTE_SHADE_BY_MORPH = {
    "shiny": "a {under} only slightly lighter and still covered in the same bright glitter, "
             "a darker {over}",
}

    # 🔴 体型专属的明暗句（2026-10-09）：水母没有 belly / back —— `PALETTE_SHADE` 对它是**错的解剖**。
    #    注意它**写在 `SHAPE_WORDS["jelly"]` 里**、不另开一张表：明暗句现在与其它 4 处措辞一起
    #    走同一套「默认 → 体型 → 物种」的覆写链（`shade_for()`），另开表就是第二份真相。
    #    ⚠️ 但它承担着「上暗下亮」的**灰度梯度**语义（`paint-card.py` 的着色是灰度渐变映射，
    #       颜色 = 灰度的函数），所以只能**换措辞、不能删**。
    #    ⚠️ 目前只有水母在体型层需要：鳐 / 鲸 / 章鱼的背腹明暗都成立。


def shade_for(morph, f=None):
    """这一档、这一条鱼用哪句「背腹明暗」。**唯一口径**。

    ⚠️ **档位优先于体型/物种**：闪光档那句是用户口径（「闪光的问题在于肚子没那么闪光」），
       任何体型都不许被它盖掉 —— 否则闪光档的腹部又会亮成一块均匀浅色、闪不起来。
       ⚠️ 但**句子里的部位词仍按这条鱼填**（水母 → `lower bell` / `bell top`），
          否则水母的闪光档又会被写回 `belly` / `back`（实测就是这么漏的）。
    """
    text = (PALETTE_SHADE_BY_MORPH.get(morph) if morph else None) \
        or shape_word(f, "shade", PALETTE_SHADE)
    return fill_color_tokens(f, text)

# 🔴 闪光档专用的「收尾句」，插在 `LIGHT` **之后**。
#    为什么必须排在 LIGHT 后面（后说者赢）：`LIGHT` 写的是「光只在背和尾 + 深阴面」，
#    而亮处（被 rim light 照亮的**头部**、被"lighter belly"提亮的**腹部**）正是闪不起来的两个地方。
#    `MORPH_SCOPE` 虽然写了 `including the head and the fins`，但它**排在 LIGHT 之前**，压不住 ——
#    实测头部 Δ **+10.6~+15.8pp**（D14/D16/C02）。加上这句之后 Δ头 → **+3.2~+6.3pp**。
EXTRA_BY_MORPH = {
    "shiny": "sparkling glints spread evenly across the {head} and the {under} as well, "
             "every area glittering, no flat dull patches",
}


def extra_for(morph, f=None):
    """插在 LIGHT 之后的那句（大多数档为空字符串）。**唯一口径**。

    ⚠️ 同样要按这条鱼填部位词 —— 写死 `head and the belly` 的话，水母的闪光档会收到
       「头」与「腹」，等于把这句话在做的补偿（给没被边光照到的区域补闪）指到不存在的部位上。
    """
    return fill_color_tokens(f, EXTRA_BY_MORPH.get(morph or "", ""))


# ⚠️ 自检**必须放在所有会被它扫描的表定义之后**（`MORPH_CANDIDATES` / `PALETTE_SHADE_BY_MORPH` /
#    `EXTRA_BY_MORPH` / `SHAPE_WORDS` / `SPECIES_WORDS`）—— 第一版放在 `SHAPE_WORDS` 旁边，
#    模块一 import 就 `NameError: PALETTE_SHADE_BY_MORPH is not defined`（当场被自己抓到）。
check_shape_words()


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
       🔴 2026-10-08：它现在被提成常量 `PALETTE_SHADE`，**母版与五档共用同一份** ——
          五档以前是整句替换 `palette_desc`，把这半句一起换掉了（实测五档 **0/508** 条含它），
          于是「背腹明暗」这个前提在五档里整个消失。见 `build_morph_prompt` 的注释。
    """
    return palette_color(f) + ", " + PALETTE_SHADE + "."


def palette_color(f):
    """颜色句的**前半句**：主色 + 部件色。不带末尾句号，也不含背腹明暗。

    ⚠️ 拆两半的唯一原因，是五档要**只换这半句**（见 `build_morph_prompt`）。
       这一段的输出**必须与拆分前逐字一致** —— 改了它，已出的**全部母版卡**都会变成陈旧。

    🔴 2026-10-09：部件词不再写死 `fins` —— 走 `COLOR_TOKEN_DEFAULTS` / `SHAPE_WORDS` 的
       `tokens["part"]`（水母 `tentacles` / 八腕 `arms` / 鳐 `wings` / 其余 `fins`）。
       为什么：这半句原本对所有体型都说 `... body with <色> fins`，
       水母的提示词于是直接下令「长鳍」，实测五档彩色卡被画成了鱼。
    """
    shape = f.get("shape", "fish")
    part = color_tokens(f)["part"]
    body_name = color_name(f["body"])
    accent_name = color_name(f["accent"])
    if base_color(body_name) == base_color(accent_name) or \
            abs(luma(f["body"]) - luma(f["accent"])) < 0.04:
        # 撞名 / 明度接近：只说主色 + 明暗关系，否则会拼出「同色的身子和鳍」
        fin = "darker" if luma(f["accent"]) <= luma(f["body"]) else "lighter"
        fin_desc = fin + " " + part
    else:
        fin_desc = accent_name + " " + part
    # 🔴 2026-10-09 22:42 用户口径：「**弱化原色的颜色提示词**」——
    #   前面钓场照旧说 `natural realistic colouring`（那是它们的卖点：真实的鱼）；
    #   但 SS / SSS 是奇幻生物，说「写实自然配色」等于把它按回现实鱼。
    #   ⚠️ **色名仍然照实取**（`color_name(f["body"] / f["accent"])`，数据驱动），
    #      只换**框**：颜色值不许在这里改，五档的递进与游戏内配色都依赖它。
    head = DEEP_COLOR_HEAD.get(f.get("field"), "natural realistic colouring")
    return "%s, %s body with %s" % (head, body_name, fin_desc)


# 「躯干胖瘦」（`body_ratio`）对哪些体型成立 —— 鳐是扁平菱形、水母是伞盖，
# **没有「躯干」这回事**（实测踩过：鳐鱼提示词里冒出 `deep-bodied build`）。
# ⚠️ `eel` / `oarfish` 也要排除：**它们是细长形，`body_ratio` 对它们没有意义**，
#    实测海鳗（eel）被写成「deep-bodied build」、裂空皇带（oarfish）同样 —— 荒谬。
# ⚠️ 2026-10-10：按 `FISH_SHAPES` 集合取（原先只有 `"fish"`）；海马没有「体深」，
#    `pomfret` / `flatfish` 的体深也不是「躯干胖瘦」的意思 —— 三个都排除。
TORSO_SHAPES = tuple(s for s in FISH_SHAPES
                     if s not in ("seahorse", "flatfish")) + ("shark", "whale", "squid", "dragon")


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
# ⚠️ 只在**鱼形家族**（`FISH_SHAPES`，含细分出来的 19 个新体型）时生效 ——
#    鳐 / 鲸 / 鲨 / 水母 等已有专属模板，名字族再去描述形态会打架。
#    ⚠️ 判据是集合不是单键：写 `== "fish"` 会让 180 条鱼的科属特征句静默消失（2026-10-10）
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
    ("剑鱼", "streamlined body with a long pointed bill extending from the snout"),
    ("旗鱼", "streamlined body with a very tall sail-like dorsal fin"),
    # —— 单字科属 ——
    ("鳢",   "elongated cylindrical body with a long dorsal fin and a large mouth"),
    ("鲶",   "broad flat head with long whisker barbels and smooth scaleless skin"),
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
    if f.get("shape") not in FISH_SHAPES:   # 其他体型有专属模板，不掺和
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

# 体型大小 —— 由 `maxKg` 分档（实测分布：p25=1.2 / p50=4 / p75=40 / max=2e18，
# 跨 5 个数量级，是最有效的「个体差异」维度之一）
#
# ⚠️ 这五句里那个**名词留空（`%s`），由 `size_band()` 现填** ——
#    362 条里有 **177 条不是鱼**（螺 / 蟹 / 甲壳 / 海蛇尾 / 水母 / 龟 / 虫…），
#    一律写 "fish" 是**类别错误**（理由与代价见 `size_band()` 的注释）。
SIZE_BANDS = [
    (0.5,  "a very small %s"),
    (2.0,  "a small %s"),
    (8.0,  "a medium-sized %s"),
    (60.0, "a large %s"),
    (1e9,  "a huge massive %s"),
]


def size_band(f):
    """**体型大小档** —— `SIZE_BANDS` 的**唯一消费方**（2026-10-10 提出来）。

    🔴 **为什么必须单独成一个函数**：`form_profile()` 原来在「有查证过的 `form`」时**提前
       return**（`if real_form: return [real_form, fins]`）—— 而 **362 条全都有 `form`**
       ⇒ 大小档**一条都没写进提示词**，`SIZE_BANDS` 整张表成了死代码。
       结果是一条 **0.04 kg 的食蚊鱼**和一条 **2e18 kg 的「时之终点·无相龟」**在提示词里
       **完全同尺寸**（实测：两边的 `form_profile()` 输出都不含任何大小档）。
       提出来之后，`form_profile()` 的两条分支共用这一处实现 ⇒
       「大小档」这个事实**只有一处真相**（这也是 Q13 的正解）。

    🔴 **为什么档位的名词要现填而不是写死 "fish"**：362 条里 **177 条不是鱼**。
       给「塘泥螺」写 "a very small fish" 是**类别错误** —— 本项目因为同一类错误栽过一次
       （`proportion_line()` 曾把章鱼写成 "a moderately slender fish"）。
       判据用**集合** `FISH_SHAPES`（不许写 `shape == "fish"` 那种单键比较 ——
       通用鱼形拆成 19 个体型之后它会**静默失效**，见那张表的注释）。
       ⚠️ 代价：`eel` / `oarfish` / `ray` / `manta` / `shark` **不在** `FISH_SHAPES` 里
       （它们是鱼，只是不适用「体深 ÷ 体长」那套框架）⇒ 会说成 "creature"。
       这是**有意**的方向选择：`creature` 对它们**成立**（只是不如 "fish" 具体），
       而对螺 / 蟹 / 水母 / 龟是**唯一正确**的说法 —— **宁可说得笼统，不说错**。

    ⚠️ **超出最后一档必须兜底**：SS / SSS 里 **64 条**的 `maxKg` 从 1.1e9 一直到 2e18，
       连 `SIZE_BANDS` 最后那档（1e9）都够不着 —— 循环 `kg < lim` 走完**一个都不命中**。
       不兜底就又是「不报错、只是静默少一句」，所以直接取最后一档。
    """
    noun = "fish" if f.get("shape", "fish") in FISH_SHAPES else "creature"
    kg = f.get("maxKg") or 0.1
    desc = SIZE_BANDS[-1][1]
    for lim, tpl in SIZE_BANDS:
        if kg < lim:
            desc = tpl
            break
    return desc % noun


def form_profile(f):
    """**形态档案** —— 用户口径：「按身体特征对每条鱼先写一个描述」。

    🔴 **优先级（2026-10-07 改）**：
      ① `fish-traits.json` 里**逐条查证过**的 `form` / `fins` —— 有就用它
      ② 没有查证记录时，才退回下面的推导（名义上是"由真实数据驱动"，但**是推导不是查证**）

    🔴 **大小档两条路都写**（2026-10-10 修，见 Q13）：原来①这一支是**提前 return**，
       把大小档一起吃掉了 —— 而 362 条全都有 `form` ⇒ **一条都没写过尺寸**。
       现在① = `大小档 + form + fins`，② 也走同一个 `size_band()`（唯一实现）。

    ⚠️ 退回推导时，数据来源是：
      | 维度 | 来源 |
      |---|---|
      | 体型大小 | `maxKg`（0.04~2e18，跨 5 个以上数量级）—— 见 `size_band()` |
      | 身体比例 | `body_ratio`（0.20~0.86） |
      | 头型 / 尾型 | 名字科属线索（`TAIL_HINTS` / `HEAD_HINTS`） |

    ⛔ **尾型不再有随机兜底**。旧做法是 `stable_pick` 从 6 个尾型里随机抽一个 ——
       实测「石首鱼科的尾鳍是楔形」，随机抽可能抽到叉形/扇形/新月形，**全错**。
       现在：名字线索命中才写，命中不了**就不写**（`SHAPES[shape]` 的默认里本来就有尾型，
       那是个「不撒谎但也不具体」的兜底）。

    ⚠️ 五条都写进提示词会太长、稀释风格锚点，所以推导路径**只挑最能区分的三条**
       （大小 / 比例 / 尾型），头型重叠时再补一条。

    ⚠️ **推导路径当前是死代码**（362/362 都有查证过的 `form`，一进函数就从①返回）——
       留着是为了「将来加一条没查证过的鱼」时不至于报错，但**别指望它被跑到**。
       Q13 的病根恰恰就是「唯一被跑到的那条分支漏了大小档」。
    """
    # ① 查证过的真实形态优先（**大小档照样要写** —— 见 docstring / Q13）
    real_form = trait_of(f["id"], "form")
    if real_form:
        parts = [size_band(f), real_form]
        real_fins = trait_of(f["id"], "fins")
        if real_fins:
            parts.append(real_fins)
        return ", ".join(parts)

    out = []

    # ② 体型大小（maxKg）—— 唯一实现见 `size_band()`
    out.append(size_band(f))

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


# —— 体型决定性线索：**即使有查证过的 `form` 也照样输出** ——
#   为什么单独开一张表：`form` 描述的不一定是体型。实测 A29「牙鲆」的 `form` 整段是
#   「鳞片 108~120 片 / 椎骨 11+25~28」—— 因为抓到的百科原文里**本来就没有体型描述**
#   （`tools/ai-traits/in-11.json` 可查）。于是 name_hint 被抑制后，整条鱼只剩
#   `SHAPES['fish']` 的「streamlined fish with a rounded body」→ **比目鱼被画成了普通鱼**。
#   而「侧躺 + 双眼同侧」是比目鱼的**辨识核心**，丢了就不是这个物种了。
#   ⚠️ 只收「丢了就画错物种」的线索；普通科属特征仍走 `name_hint`，不要往这里堆。
BODY_HINTS_ALWAYS = [
    ("鲆", "a flat oval body lying on one side with both eyes on the same side of the head"),
    ("鲽", "a flat oval body lying on one side with both eyes on the same side of the head"),
    ("鳎", "a flat elongated tongue-shaped body lying on one side with both eyes on the same side"),
]


def body_hint_always(f):
    """体型决定性线索（口径见 BODY_HINTS_ALWAYS）。命中不了返回空串。"""
    name = f.get("name", "")
    for key, desc in BODY_HINTS_ALWAYS:
        if key in name:
            return desc
    return ""


# —— 物种名进提示词（2026-10-08 用户拍板：「物种名进提示词」）——
#   为什么：在此之前提示词里**完全没有生物名**（中文名与拉丁名都不进，实测确认），
#   模型只知道「一条鱼」而不知道是**哪一种** —— 于是「鲢鱼 / 沙丁鱼」都只能画成一条普通鱼。
#   加一个名字能直接调出模型对物种的先验知识，**比再加三个形容词有效得多**。
#   代价：名字是中文（Qwen-Image 是双语的，认）；180 条虚构名（SS/SSS）对模型无意义，
#   但无害 —— 只是没有增益，不会画错。
#   `off` / `cn` / `cn_latin` 三挡**只用于 A/B 对拍**（见 `docs/images/name-ab/`），
#   对拍定稿后正式出图固定用 `cn_latin`。
NAME_MODE = "cn_latin"


def species_tag(f):
    """提示词里的物种名标签（口径见 NAME_MODE）。返回空串表示不加名字。

    ⚠️ 名字里可能带**游戏造名前缀**：26 条带 `·`（如「海沟幽灵·大王乌贼」）。
    只取 `·` 之后的部分 —— 否则「海沟幽灵」这四个字会被模型当成画面内容画进去。
    """
    if NAME_MODE == "off":
        return ""
    name = (f.get("name") or "").split("·")[-1].strip()
    if not name:
        return ""
    if NAME_MODE == "cn_latin":
        sp = (trait_of(f["id"], "species") or "").strip()
        if sp:
            return "%s (%s)" % (name, sp)
    return name


# —— 显式比例句（2026-10-08，用户报障「都像普通鱼，实际是更细长的鱼」）——
#   🔴 为什么必需：`form` 里的 "laterally compressed" / "fusiform" / "keeled belly" 是
#      **鱼类学术语**，扩散模型读不懂 —— 更糟的是 "laterally compressed"（侧扁）在它那里
#      会读成「身体被压扁」，反而把鱼画厚。实测：D02 白条 的 form 明明写着
#      "an elongated laterally compressed body"，出图却是约 2.9:1 的厚实鱼；
#      加一句**可量的视觉比例**后立刻变细长（对照 docs/images/prompt-fix/）。
#   🔴 为什么以前完全没用上：`form_profile()` 在「有查证过的 form」时**提前 return**，
#      于是 `body_ratio` 这条推导路径对 **362 条鱼全部失效**（而 362 条都有 form）。
#      `body_ratio` 恰恰是唯一直接编码「细长 vs 粗壮」的数值：白条 0.22、河鲀 0.78、
#      翻车鱼 0.86。本函数把它从失效路径里救出来。
#   ⚠️ **位置很重要**：必须紧跟**物种名之后**、其它形态描述之前 —— 实测放前面才压得住
#      「普通鱼」这个先验，放到后面会被淹掉。
def proportion_line(f):
    """由 `body_ratio`（≈ 体深 / 体长）生成显式比例句。返回空串表示不写。

    ⚠️ **只对「鱼形家族」`FISH_SHAPES` 生效**。比例句的引导词写的是「a slender elongated **fish**」，
       所以对**非鱼**的体型用它会造成两个错误：
       ① **类别错误** —— 章鱼 / 鱿鱼 / 水母 / 鲸 都不是鱼（实测拼出过「章鱼 = a moderately
          slender fish」）；
       ② **框架不成立** —— 鳐是扁盘、水母没有「体深」、鳗 / 皇带是长带，
          「体深占体长几分之几」对它们没有意义。
       非鱼形体型的鱼靠**物种名 + 已清洗的 form** 描述即可（它们的名字本身就带形态线索：
       「鲨」「鲸」「鳐」「水母」「皇带」「章鱼」）。
    🔴 判据是**集合**不是单键（2026-10-10）：原先写的是 `!= "fish"`，把通用鱼形拆成 19 个
       体型之后，那 180 条的比例句会**当场全部消失**且不报错（提示词只是少一句）。
    """
    if f.get("shape", "fish") not in FISH_SHAPES:
        return ""
    r = f.get("body_ratio")
    if not r or r <= 0:
        return ""
    ratio = 1.0 / r
    if ratio >= 4.5:
        lead, frac = "an extremely slender elongated fish", "only about one fifth of its total length"
    elif ratio >= 3.5:
        lead, frac = "a slender elongated fish", "only about one fourth of its total length"
    elif ratio >= 2.8:
        lead, frac = "a moderately slender fish", "about one third of its total length"
    elif ratio >= 2.2:
        lead, frac = "a fish of moderate build", "about two fifths of its total length"
    elif ratio >= 1.8:
        lead, frac = "a deep-bodied fish", "about half of its total length"
    else:
        lead, frac = "a very deep rounded fish", "more than half of its total length"
    return "%s, its body depth %s, " % (lead, frac)


def build_prompt(f, morph=None):
    """拼提示词。顺序**照 v9**，别改：

        BASE + " of <主语>." + <构图句> + <颜色句> + LIGHT + GEOM + BG

    ⚠️ 头部引导（2026-10-08 起，见 `species_tag` / `proportion_line` / ⓪ 的说明）：
       主语 = 物种名 > 类目词（仅 fish）> 体型模板；**紧接着插「比例句」**，
       再接真正的形态描述：
       · **有物种名**（默认）→ `of a 鲢鱼 (Hypophthalmichthys molitrix), <比例句><形态句>.`
         名字当主语名词，类目词让位（"a 鲢鱼" 本身就是名词短语）
       · 无物种名 + **有**查证过的 `form` → `of a fish` 或 `of <form…>`：体型模板让位，
         物种描述当主体 —— 否则体型模板会把「几何兜底」说成「物种」（小龙虾画成乌贼）
       · 无物种名 + **没有** `form` → `of a single <体型模板>.`（体型模板当主体）

    ⚠️ 三条不能动的：
       1. **BASE 必须是第一句** —— 它是风格锚点，放到后面会被内容描述盖过
       2. **LIGHT / BG 收尾**（v9 的排法），两者挨着，别拆开
       3. 形态句里**不写「精细词」**（elaborate / ornate / decorative）——
          一出现模型立刻画成精细插画（v10 首批 10 张全废在这条）
    """
    # 🔴 SS / SSS 走**逐条骨架**（`build_deep_prompt`，2026-10-10 用户口径：简化 + 逐条对着名字写）。
    #    前面五个钓场一路不动 —— 它们仍是「解剖档案 + 稀有度递进」的原口径。
    if f.get("field") in DEEP_FIELDS:
        return build_deep_prompt(f, morph)

    shape = f.get("shape", "fish")
    spec = SHAPES.get(shape, SHAPES["fish"])
    verified = trait_of(f["id"], "form") or ""

    # ⓪ 头部引导 —— **查证过的物种描述优先于体型模板**（2026-10-08 修正，原本是反的）
    #    🔴 `SHAPES[shape]["d"]` 描述的**不是几何形状，而是某个具体物种的身体**：
    #       `squid` = "squid with an elongated mantle, pointed tip, triangular side fins and a
    #       cluster of tentacles"。而 `shape` 只是生成器给的**几何兜底模板** ——
    #       「甲壳类 / 八腕类 / 棘皮类」都没有专属体型，全被兜底成最接近的那一个，
    #       于是提示词的第一句就在命令模型画错物种。
    #       实测（原图已肉眼确认）：**D08 小龙虾、A24 章鱼 都被画成了乌贼。**
    #    ⇒ 有查证过的 `form` 时：
    #       · `fish` 只留类目词（被标成 fish 的确实是鱼，安全）；
    #       · 其余 8 个体型的模板都**点名了具体动物**（squid / jellyfish / manta ray / …），
    #         对被兜底进来的鱼会说谎 → **整句丢弃**，身体完全交给 `form` 描述。
    #       冠词必须跟着换：`form` 自带 "a …"，再写 "a single" 会拼出
    #       "of a single a cylindrical body…" 这种双冠词。
    #    物种名（如果有）按 `species_tag` 的规则当**主语名词**，此时连类目词都不必写 ——
    #    "a 鲢鱼" 本身就是个名词短语，再写 "fish" 是重复。
    name_tag = species_tag(f)
    prop = proportion_line(f)

    # ⓪a 主语：物种名 > 类目词（仅 fish）> 体型模板
    if name_tag:
        subject, bits = "a " + name_tag + ", ", []
    elif verified:
        # ⚠️ 类目词只给**鱼形家族**（判集合，别判单键 —— 见 `FISH_SHAPES` 的注释）
        subject, bits = ("a fish, " if shape in FISH_SHAPES else ""), []
    elif prop:
        # 比例句自带冠词（"a slender elongated fish…"），此时不能再写 "a single"
        subject, bits = "", [spec["d"]]
    else:
        subject, bits = "a single ", [spec["d"]]
    # ⓪b 比例句**紧跟主语**（位置为什么重要见 `proportion_line` 的注释）
    if prop:
        subject += prop

    # ⓪ c **身份句** —— 2026-10-09 22:42 用户口径：「奇幻的表述要多一点，宏大一点」，
    #   原话例子「这是个奇幻生物，它的皮肤不同于普通的鱼」。
    #   位置：物种名与比例句**之后**、形态档案**之前** —— 先让模型知道它不是普通的鱼，
    #   再看后面的材质句，出来才不会被「鱼类解剖」拉回现实。
    #   ⚠️ 只挂 SS / SSS 两场（见 `DEEP_LEAD`）；它说的是**这条生物的身份**，
    #     不引入任何新物件或背景（§17.7 三条硬约束不冲突）。
    lead = deep_lead(f)
    if lead:
        subject += lead + ", "

    # ① 体型决定性线索 —— **有 `form` 也照样输出**（为什么单独一张表见 BODY_HINTS_ALWAYS）
    #    `form` 已经说了「flat」就跳过，免得同一件事讲两遍。
    decisive = body_hint_always(f)
    if decisive and "flat" not in verified.lower():
        bits.append(decisive)

    # ② 名字族（科属特征）—— 只在 fish 体型生效，其余体型有专属模板
    #    ⚠️ 有逐条查证记录时**跳过**：查证过的 form/fins 已经把体型说清楚了，
    #       再叠一句科属体形会重复（实测叠完出现「deep-bodied laterally compressed body」
    #       紧跟「elongated oval body, strongly compressed and rather deep」这种自我重复）。
    hint = "" if verified else name_hint(f)
    if hint:
        bits.append(hint)

    # ③ 形态档案 —— 大小 / 比例 / 尾型 / 头型，全部由真实数据驱动
    #    （用户口径：「按身体特征对每条鱼先写一个描述」，让鱼更好分辨）
    bits.append(form_profile(f))

    # ③b 点题 —— 两道门，**互斥**，一条鱼最多一句：
    #     ① **SS / SSS 两场**（任何稀有度）→ **函数开头就 return 了**（`build_deep_prompt`，
    #        逐条对着名字写的两句，见 `DEEP_LINES`）。这两场 180 条名字全是奇幻设定，
    #        不能只有其中的传说鱼兑现（改动前实测：165/180 一条都没有）；
    #     ② **前面钓场的传说鱼**（rar == 3）→ 原来的 `fantasy_motif()`。
    #     ⚠️ 顺序不许反：① 必须**在** ② 之前（它是提前 return 的）——
    #        反了 SS/SSS 那 15 条传说鱼会掉进旧表，逐条描述静默少 15 条（能跑，所以更危险）。
    #        ⛔ 前面钓场的普通 / 稀有 / 史诗鱼**一个字都不加** —— 那是「稀有度递进」的卖点，也是
    #           「SS/SSS 看起来比前面高级」这句话的另一半（只有两场变强，对比才成立）。
    #     位置紧贴形态档案：它是「这条鱼身上长什么样」的一部分，
    #     排在花纹 / 特征位之前、颜色句之前，才不会把颜色与 LIGHT 收尾冲淡。
    #     ⚠️ `rar_i` 在这里就要定下来（后面 ④⑤ 与收尾句都还要用），别在下面再赋值一次。
    rar_i = min(3, f.get("rar", 0))
    if rar_i == 3:
        motif = fantasy_motif(f.get("name", ""))
        if motif:
            bits.append(motif)

    # ④ 体表花纹 —— 查证过的逐条特征最优先，其次按科属字给**真实倾向**，
    #    两者都没有就**不写**（⛔ 不许随机抽，见 MARK_BY_FAMILY 的注释）
    if shape in FISH_SHAPES and not any(f.get(k) for k in MARKING_KEYS):
        mark = trait_of(f["id"], "markings") or mark_by_family(f.get("name", ""))
        if mark:
            bits.append(mark)

    # ⑤ 特征位（按体型过滤）
    for key, (desc, shapes) in FEATURE.items():
        if f.get(key) and shape in shapes:
            bits.append(desc)

    extra = ", extra spines and streamers" if (rar_i == 3 and shape in SPINE_SHAPES) else ""
    # 稀有度要「加长某个部件」—— `form` 在场时体型模板已经让位，部件名必须用通用词，
    # 否则会给章鱼加长 "side fins"（见 SHAPES 的 `finSafe` 注释）。
    fin_word = spec.get("finSafe", spec["fin"]) if verified else spec["fin"]
    rar = RARITY[rar_i].format(fin=fin_word, extra=extra)

    head = BASE + " of " + subject + ", ".join([b for b in bits if b]) + "."
    # 构图句的**朝向词按体型（再按物种）换**（水母是辐射对称，没有「侧视朝左」这回事）
    frame_head = shape_word(f, "frame", "full side view, whole body visible, facing left")
    frame = frame_head + ", centered with generous margin, " + rar + "."
    # 面片措辞**按档取**（闪光档用 `GEOM_COARSE`，见 `geom_for()`）；母版传 None ⇒ 用 GEOM
    # 颜色句 = `palette_color` + **按档 + 按体型/物种**的明暗句
    #          （闪光档例外见 `PALETTE_SHADE_BY_MORPH`，水母见 `PALETTE_SHADE_BY_SHAPE`）；
    # 收尾 = LIGHT（**按体型/物种**取，见 `light_for()`）+ **按档**的补句 + GEOM + BG
    # ⚠️ 末尾那个 "." 不能丢：`palette_desc()` 原本返回
    #    `palette_color(f) + ", " + PALETTE_SHADE + "."` —— 少了它**母版与每一档的提示词都会变**
    #    （实测母版第 662 字由 "darker back. strong" 变成 "darker back strong"），
    #    于是全项目所有卡被误判成过期。我第一版就丢过一次，靠"母版与 manifest 逐字相同"这条自检抓回来。
    parts = [head, frame,
             palette_color(f) + ", " + shade_for(morph, f) + ".",
             light_for(f)]
    if extra_for(morph, f):
        parts.append(extra_for(morph, f))
    parts += [geom_for(morph), BG]
    return " ".join(parts)


def build_morph_prompt(f, morph, color_desc):
    """五档的提示词 = 母版提示词**只换颜色句的前半句**，其余逐字相同。

    ⚠️ 别在这里另起一套骨架 —— 那会让「母版」和「五档」两套口径分家，
       最后变成「同一条鱼不同档不像一家人」。做法同 `GEOM`：
       **同一个 `build_prompt`，挖掉主色那半句，换上该档的颜色句。**

    🔴 2026-10-08 修（用户报障「部分鱼的闪光，鱼头部分和身体部分不一样」）：
       这里原来是整句替换 `palette_desc`，把 `PALETTE_SHADE`（背腹明暗）**一起换掉了**
       —— 实测五档提示词 **0/508** 条含它，而母版 122/127 条有。
       后果不是"少一句形容词"：`paint-card.py` 的着色是**灰度渐变映射**
       （`gray = im.convert("L")` → `apply_palette`，**颜色 = 灰度的函数**），
       「背腹明暗」正是它的前提。前提没了 ⇒ 模型对**头部**与**躯干**的明暗处理不再受约束
       ⇒ **明暗差直接变成颜色差**。实测 D07 头/身中位亮度差被放大到 68（母版只有 25）。
       ⇒ 现在只换 `palette_color()` 那半句，`PALETTE_SHADE` 一律保留（两档共用同一份常量）。
    """
    p = build_prompt(f, morph)
    pc = palette_color(f)
    if pc not in p:
        raise RuntimeError("颜色句前半句没出现在提示词里 —— build_prompt 的结构改过？")
    # ⚠️ 候选句带不带末尾句号都要能接上后半句，先统一去掉
    desc = color_desc.strip().rstrip(".")
    # 🔴 `{base}` = **这条鱼自己的原色句** → 用于「保留本色 + 叠加效果」型的档位
    #    （目前只有闪光族在用，见 `MORPH_CANDIDATES` 里 shiny/6~8 的说明）。
    #    为什么要有这条通道：游戏内 `fishpaint.js` 的 shiny 分支明确「保留鱼本色的色相、
    #    只加光效」，而五档这边的默认做法是**把原色句整句换掉** ——
    #    两边就此分家（文档写着「共用同一套颜色口径，这是不分家的保证」）。
    #    ⚠️ 替换是**一次性的**：`str.replace` 不会再扫描替换进去的内容，
    #       所以 `pc` 出现在 `desc` 里不会被二次替换掉。
    if "{base}" in desc:
        desc = desc.replace("{base}", pc)
    # 🔴 颜色句里的部件词 / 部位词**按这条鱼**落地（水母 `tentacles`、八腕 `arms`、
    #    鳐 `wings`、小龙虾 `claws`…）；对默认体型是**恒等变换** ⇒ 鱼族的五档提示词逐字不变。
    desc = fill_color_tokens(f, desc)
    # 无眼体型摘掉「… pink eye」那句（连前导逗号一起），否则水母会长出一只鱼眼睛
    if shape_word(f, "no_eye"):
        desc = EYE_CLAUSE_RE.sub("", desc)
    # ⚠️ 收尾从句按**体型/物种**取（`scope_for`）—— 写死 `MORPH_SCOPE` 会让水母的彩色档
    #    又收到「the whole fish ... the fins」，正是 2026-10-09 那次报障。
    return p.replace(pc, desc + ", " + scope_for(f), 1)


# 五档颜色句的**统一作用范围**，追加在每一档后面 —— 与 `GEOM` / `LIGHT` 同一个套路：
# 共享从句挂**一处**，不让十几个候选句各写各的（本次出问题的地方正是「各写各的」：
# `albino/1` 点到了 body+fins+eye，而 `shiny/1` 只写了 body）。
#
# 🔴 为什么必须有它：候选句大多只写 `body`（`shiny/1`：「iridescent shimmering **body**
#    covered in sparkling glittering speckles」），而提示词里**头部与鳍是独立描述的区域**
#    （83/127 条的形态句里有 `head`，如 `a large broad flat head`）。于是亮片 / 薄膜只落在躯干，
#    头部没有 —— 又因为颜色是灰度的函数，躯干亮度被抬高、头部没有
#    ⇒ **明暗差直接变成颜色差**，看起来就是「头身不是一个色」。
#    实测 6/17 条可比样本的闪光卡「身−头 高光占比」比自己的母版失衡 ≥10 个百分点。
#
# 🔴 2026-10-09：`the whole fish ... the fins` 里的两个词也要按体型换
#    （**这是本次报障的直接元凶**）—— 这一句**只有五档有、母版没有**，
#    所以同一份骨架下「水母的母版还是水母、四档彩色全变成了鱼」。
#    ⇒ `MORPH_SCOPE` 只留作默认值，实际一律走 `scope_for()`。
MORPH_SCOPE_TAIL = "the whole fish including the head and the fins"
MORPH_SCOPE = "with the same treatment over " + MORPH_SCOPE_TAIL


def scope_for(f):
    """五档的收尾从句 —— 按体型（再按物种）换掉 `fish` / `fins` 两个词。**唯一入口**。"""
    return "with the same treatment over " + shape_word(f, "scope", MORPH_SCOPE_TAIL)


def load_fish():
    """借 node 读 fish.js（它依赖 config/fields）—— 不重复实现一遍解析"""
    js = ("global.window=global;"
          "require('./src/data/config.js');require('./src/data/fields.js');require('./src/data/fish.js');"
          "console.log(JSON.stringify(global.G.FISH));")
    r = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-800:]); sys.exit(1)
    return json.loads(r.stdout)


# SS / SSS 两场的奇幻表：**加载即校验**（漏词 / 死行都不许静默放行）。
# ⚠️ 只能放在 `load_fish` 定义之后（它要读鱼名），所以不能跟顶部那几处校验并排。
check_deep_motifs()


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
# ⏱ 每张图多少秒 —— ⚠️ 这两个数是**兜底常数**，只在 manifest 还没有足够实测样本时用。
#    `write_plan()` 现在优先用 `measured_sec()`（manifest 里逐张记的 `sec` 取中位）。
#    为什么要有实测：这两个常数是手填的，换台机器 / 改了步数 / GPU 被别的任务占着
#    就会悄悄过期，而清单是「还剩多少、还要多久」的唯一依据（Q16）。
#    实测区间（1152×768 / 25 步 / cfg 3.0）：**48.2~51.3 s**（2026-10-10，RTX 5060 Laptop，
#    连出 9 张）、**55~68 s**（2026-10-07 那批，机器同时在做别的事）⇒ 取 55 作兜底（偏保守）。
SEC_PER_MASTER = 55     # 母版：文生图，25 步（cfg=3.0，每步两次前向）
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


SEC_SAMPLE_MIN = 20     # 实测样本少于此数就退回常数（中位不稳，别拿 3 个样本去排期）


# ────────────────────────────────────────────────────────────────────────────
# 🔴 **生图互斥锁**：两个生图进程同时跑会重复出图 + 并发写 manifest.json。
#    这不是假想风险：定时任务（每小时一轮）与长跑本来就会撞上。
#
# ⚠️ 判据**只许有这一处**：`main()` 决定「要不要接管」、一键启动器（`tools/rerender.py`）
#    决定「能不能开跑」、`--who` 决定「现在忙不忙」—— 三处共用下面这两个函数。
#    分成两份的话，启动器必然**比出图脚本更严或更松**：更严 = 明明可以接管却白等一轮；
#    更松 = 两个进程同时跑、并发写台账。两种都**不报错**。
# ────────────────────────────────────────────────────────────────────────────
LOCK_STALE_SEC = 300          # 心跳超过这么久没动静 = 上一个进程已死（配合 pid 判据）


def lock_path():
    return os.path.join(OUT, ".gen-art.lock")


def lock_alive(pid):
    """那个 pid 是否**真的还活着**。

    🔴 为什么必须有这一步：锁如果只靠「心跳时间戳」判过期，那么一个**死掉的进程**
       会把锁留在磁盘上，最长 STALE 秒内**挡住下一轮生图**。而定时任务**每小时**才触发一次
       —— 挡一次就是整整一小时白等，而且**不报错**（正是本项目最高频的坑型）。
    实测：本环境会在轮次结束时回收进程（`DETACHED_PROCESS` 也逃不掉，疑似 Job Object），
       所以「非正常退出、留下陈旧锁」是**常态而不是例外**。
    查不到进程表时返回 True（当作还活着），退回时间戳判据 —— 宁可少开一轮，也不重复出图。
    """
    try:
        r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
                           capture_output=True, text=True, errors="replace", timeout=15)
        return str(pid) in (r.stdout or "")
    except Exception:
        return True


def lock_state():
    """当前锁的状态 → `{"pid", "age", "busy"}`；没有锁 / 读不出来返回 `None`。

    `busy=True` 表示「**确实有活着的进程在出图**」——
    pid 已经不存在、或心跳超过 `LOCK_STALE_SEC`，都判定为**可以接管**（不算 busy）。
    """
    try:
        d = json.load(open(lock_path(), encoding="utf-8"))
    except Exception:
        return None
    pid = int(d.get("pid", 0) or 0)
    age = int(time.time() - d.get("ts", 0))
    if pid and not lock_alive(pid):
        return {"pid": pid, "age": age, "busy": False}
    return {"pid": pid, "age": age, "busy": age <= LOCK_STALE_SEC}
def measured_sec(man=None):
    """manifest 里逐张记的 `sec` 的**中位**数；样本不足返回 `(None, n)`。

    🔴 为什么要有它（Q16）：清单里那个「单条耗时 ≈ 277 s」是**手填常数** ——
       换台机器、改了步数、或者 GPU 被别的任务占着，它就悄悄过期了，
       而清单是「还剩多少、还要多久」的唯一依据。有真实样本时以样本为准。

    ⚠️ 取**中位**不取均值：出图耗时会被偶发的卡顿（超时重试一次 = 5 分钟）拉出长尾，
       均值会被一两条离群值带偏，而中位不受影响。
    """
    if man is None:
        if not os.path.exists(MANIFEST):
            return None, 0
        try:
            man = json.load(open(MANIFEST, encoding="utf-8"))
        except Exception:
            return None, 0
    vals = []
    for rec in man.values():
        if not isinstance(rec, dict):
            continue
        if isinstance(rec.get("sec"), (int, float)):
            vals.append(float(rec["sec"]))
        for sub in (rec.get("morphs") or {}).values():
            if isinstance(sub, dict) and isinstance(sub.get("sec"), (int, float)):
                vals.append(float(sub["sec"]))
    n = len(vals)
    if n < SEC_SAMPLE_MIN:
        return None, n
    vals.sort()
    return (vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2.0), n


def write_plan(fish):
    """生成 docs/生图清单.md —— 带勾选框，供逐批执行与追踪"""
    bs = make_batches(fish)
    total = sum(len(b) for b in bs)
    legend = sum(1 for f in fish if f["rar"] == 3)
    nk = len(morph_keys())
    # 每条鱼 = 1 张母版（文生图）+ (nk-1) 张档位（**也是文生图**）+ 1 次抠图（出 `-normal`）
    # 📏 每张多少秒：**实测优先**（manifest 的 `sec` 中位），没有足够样本才退回常数。
    #    每条鱼 = 1 张母版 + (nk-1) 张档位 = nk 张，每张都已经含各自那一次抠图。
    m, m_n = measured_sec()
    if m:
        per_fish = m * nk
        sec_note = "实测中位 **%.1f s** × %d 张（manifest 样本 %d 张）" % (m, nk, m_n)
    else:
        per_fish = SEC_PER_MASTER + (nk - 1) * SEC_PER_MORPH + SEC_PER_CUT
        sec_note = ("常数估计（母版 %ds + %d 档 × %ds + 抠图 %ds；实测样本 %d 张，未达 %d）"
                    % (SEC_PER_MASTER, nk - 1, SEC_PER_MORPH, SEC_PER_CUT, m_n, SEC_SAMPLE_MIN))
    # 🔴 一档可能出**多版**（传说档闪光 = 2 版，`MORPH_VERSIONS_BY_RAR`）——
    #    漏算的话清单会**低估工期**，而清单是排期与「还剩多少」的唯一依据。
    #    ⚠️ 版数走 `morph_version_count()`（唯一判据），别在这里另算一遍。
    cnt_rar, rounds = {}, lambda r: LEGEND_ROUNDS if r == 3 else 1
    for f in fish:
        cnt_rar[f["rar"]] = cnt_rar.get(f["rar"], 0) + 1
    extra_shots = sum(cnt_rar[r] * rounds(r)
                      * sum(morph_version_count(r, k) - 1 for k in MORPH_ORDER)
                      for r in cnt_rar)
    shots = total * (1 + nk) + legend * (LEGEND_ROUNDS - 1) * (1 + nk) + extra_shots
    secs = ((total + legend * (LEGEND_ROUNDS - 1)) * per_fish
            + extra_shots * (m or SEC_PER_MORPH))

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
    L.append("| 出图张数（含传说迭代） | ≈ **%d**（每条 %d 张：1 母版 + %d 档；"
             "另**传说档每条多 %d 张** —— 传说的闪光出 2 版供人挑） |"
             % (shots, 1 + nk, nk, sum(morph_version_count(3, k) - 1 for k in MORPH_ORDER)))
    L.append("| 单条耗时 | ≈ **%.0f s**（%s） |" % (per_fish, sec_note))
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
            """母版 + 每一档的**每一版**都存在才算完成。

            ⚠️ 只按固定档名找文件的话，传说档闪光**第 2 版**（`<id>-shiny-2.png`）
               永远不参与判定 —— 缺了也照样打勾，而清单的勾是「下一轮跳不跳」的依据。
               交付物是「母版 1 张 + 每一档每一版」，检测条件就必须覆盖它们。
            """
            names = [f["id"] + ".png", f["id"] + "-normal.png"]
            for key, _d in MORPHS:
                names += ["%s-%s%s.png" % (f["id"], key, v[3])
                          for v in morph_versions(f, key)]
            return all(os.path.exists(os.path.join(OUT, n)) for n in names)
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
             "其中 `LIGHT` / `GEOM` / `BG` 三段是**公共常量**（见 §一）。\n")
    L.append("## 一、固定段落（每条鱼都一样）\n")
    L.append("```")
    L.append("LIGHT = " + LIGHT.strip())
    L.append("GEOM  = " + GEOM.strip())
    L.append("BG    = " + BG.strip())
    L.append("```")
    L.append("⚠️ `GEOM` 在**闪光档**换成更粗的大块面措辞（防小像素块）；`LIGHT` 只对**非鱼体型**"
             "换掉开头的部件锚点（水母 / 八腕 / 鲸，见下表），后半 4 句逐字不变。\n")
    L.append("### 体型与物种专属措辞（`SHAPE_WORDS` → `SPECIES_WORDS`）\n")
    L.append("公共段里有 5 处原本写成了「鱼的解剖」，对**所有类型**无条件生效 ——"
             "2026-10-09 修：水母的彩色档曾被这些词画成鱼。"
             "现在是**两层覆写**：默认 → 体型（下表）→ 物种（`SPECIES_WORDS`，按鱼 id）。"
             "没列到的体型（`fish` / `shark` / `eel` / `oarfish` / `dragon`）一律用默认值"
             "（`fins` / `flanks` / `belly` / `back` / `scales`，即改动前的原句）。\n")
    L.append("| 层 | 键 | 颜色句占位符 | 构图句朝向 | 明暗句 | LIGHT 锚点 | 五档收尾从句 |")
    L.append("|---|---|---|---|---|---|---|")
    for sh in sorted(SHAPE_WORDS):
        w = SHAPE_WORDS[sh]
        toks = w.get("tokens") or {}
        L.append("| 体型 | `%s` | %s | %s | %s | %s | %s |" % (
            sh,
            "、".join("`%s`=%s" % (k, v) for k, v in sorted(toks.items())) or "（默认）",
            w.get("frame") or "默认 侧视朝左",
            w.get("shade") or "默认 背腹",
            w.get("light") or "默认 背与尾",
            w.get("scope") or "默认 the whole fish…",
        ))
    for fid in sorted(SPECIES_WORDS):
        w = SPECIES_WORDS[fid]
        toks = w.get("tokens") or {}
        L.append("| 物种 | `%s` | %s | %s | %s | %s | %s |" % (
            fid,
            "、".join("`%s`=%s" % (k, v) for k, v in sorted(toks.items())) or "（继承）",
            w.get("frame") or "（继承）",
            w.get("shade") or "（继承）",
            w.get("light") or "（继承）",
            w.get("scope") or "（继承）",
        ))
    L.append("")

    L.append("\n### 传说级点题（`FANTASY_MOTIFS`，只有 `rar == 3`）\n")
    L.append("按名字里的意象词给传说鱼补**一句**结构化的奇幻描述（体表 / 剪影层面，不引入场景）。"
             "表序即优先级、命中即止。\n")
    L.append("| 意象词 | 追加的句子 |")
    L.append("|---|---|")
    for keys, sentence in FANTASY_MOTIFS:
        L.append("| %s | %s |" % (" / ".join(keys), sentence))
    L.append("")
    L.append("## 二、母版（原色）提示词 —— 每条鱼独有的部分\n")
    L.append("下表列出**每条鱼独有的部分**（体型 + 形态 + 特征 + 颜色 + 构图）。\n")
    L.append("| id | 名字 | 档 | 体型 | 提示词（已剥掉固定段 LIGHT/GEOM/BG） |")
    L.append("|---|---|---|---|---|")
    for f in fish:
        # ⚠️ **必须调 build_prompt() 本体再剥离固定段**，不许在这里复制一份拼装逻辑 ——
        #    之前就是复制了一份，结果「给人看的表」和「实际出图」分家（还漏改过一次随机花纹）。
        var = build_prompt(f)
        # ⚠️ `LIGHT` 现在是**按体型**取的（水母 / 八腕 / 鲸 与默认不同），
        #    这里必须用同一个 `light_for()` 去剥，否则非鱼体型那几行的固定段剥不干净
        for seg in (light_for(f), geom_for(None), BG):
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
    L.append("下表列的就是**实际会被抽中的那一套**（键 = `候选键 中文标签`）。")
    L.append("⚠️ **传说档例外**：彩虹/白化/黄金**定死**一套，闪光**出 2 版** ——")
    L.append("下表列的是第 1 版；**传说档的闪光还有第 2 版**（`MORPH_VERSIONS_BY_RAR`，供人挑）——"
             "挑完跑 `python tools/pick-card.py <id> shiny 2` 扶正（开发者文档 §17.12.0）。\n")
    L.append("| id | 名字 | %s |" % " | ".join(MORPH_CN[k] for k in MORPH_ORDER))
    L.append("|---|---|%s" % ("---|" * len(MORPH_ORDER)))
    for f in fish:
        cols = []
        for k in MORPH_ORDER:
            # ⚠️ **必须传 rar** —— 传说档有按稀有度的覆盖（定死四档），
            #    漏了它这张表就会把传说鱼的实际用句写错，而且看不出来
            #    （表里照样有值，只是值与真正出图用的不是同一套）。
            ck, tag, _sent = morph_pick(f["id"], k, f.get("rar"))
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
    L.append("> **有查证过的 `form`（现在 362/362 都有）时**：本条 = `大小档 + form + fins`；")
    L.append("> 没有时退回推导：**体型大小 ← `maxKg`**（`size_band()`）｜ "
             "**身体比例 ← `body_ratio`** ｜ **尾型 / 头型 ← 名字线索，找不到就`不写`**。")
    L.append("> 🔴 **大小档两条路都写**（2026-10-10 修 Q13 —— 修之前它被提前 return 吃掉，"
             "362 条全无尺寸）。")
    L.append("> ⚠️ 大小档那个名词按体型族现填：**非鱼写 `creature`**"
             "（362 条里 177 条不是鱼，一律写 `fish` 是类别错误）。")
    L.append("> ⛔ 尾型 / 头型**没有随机兜底**，命中不了就不写（旧版这里写着「稳定随机兜底」，早已作废）。")
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


def card_state(f, morph, vi, man):
    """这张卡相对**当前生成口径**的状态。

    返回 `None` = 已是最新（`--skip-existing` 可以安全跳过）；
    否则返回一个短原因标签。`无文件` 是「还没出过图」= 待出，**不属于过期**。

    🔴 **唯一判据** —— `--skip-existing` 与 `--stale` 必须共用它。
       Q14 的病根正是这两处各判各的：`--skip-existing` 判「文件在不在」、
       `--stale` 判「内容对不对」。口径一改，前者照旧**静默跳过**、后者报过期 ——
       两份判据分家，而图上完全看不出来（文件在、图也不坏，只是**不是这一版口径**）。
       实测代价：2026-10-10 全部 362 条卡都出齐了，其中 **373 张**其实还是旧口径。

    标签含义：
      `无文件`    还没出过图（待出）
      `派生缺失`  母版在、`<id>-normal.png` 不在。⚠️ **Q28**：`-normal` 是母版抠图的
                  **派生、不占一个任务**，所以单独删它之后母版任务会「文件在 ⇒ 跳过」，
                  5 个任务全跳完也补不回来 —— 游戏里那张图就永久退化成程序化绘制。
      `无台账`    文件在，但 manifest 里没有可比的记录 ⇒ **证明不了**它是当前口径。
                  ⚠️ 实测 12 张（`SS07` 整条鱼 + `C24` 的两版闪光 + `SS18`/`SS19`/`SS56`
                  各两档）：manifest 曾被并发写覆盖掉一部分记录。这类卡必须重出
                  （顺手把台账补回来，否则「可复现」这条硬约束在它们身上是空的）。
      `提示词已变` / `步数已变`  台账记的与现算的不一致 ⇒ 重出。
    """
    fid = f["id"]
    if morph is None:
        dst = os.path.join(OUT, fid + ".png")
        want, steps = build_prompt(f), steps_for(f, None)
    else:
        _ck, _tag, _sent, sfx = morph_versions(f, morph)[vi]
        dst = os.path.join(OUT, "%s-%s%s.png" % (fid, morph, sfx))
        want, steps = build_morph_prompt(f, morph, _sent), steps_for(f, morph)
    if not os.path.exists(dst):
        return "无文件"
    # 母版这一个任务同时产出 `-normal` ⇒ 派生缺了就等于这个任务没做完（Q28）
    if morph is None and not os.path.exists(os.path.join(OUT, fid + "-normal.png")):
        return "派生缺失"
    rec = man.get(fid) or {}
    if morph is None:
        old, old_steps = rec.get("prompt"), rec.get("steps", STEPS)
    else:
        sub = (rec.get("morphs") or {}).get(morph + (sfx or "")) or {}
        old, old_steps = sub.get("prompt"), sub.get("steps", STEPS)
    if not old:
        return "无台账"
    if old != want:
        return "提示词已变"
    # ⚠️ 步数也要比：只比提示词的话，「改步数」会**静默漏掉已生成的卡**
    #    （既存在、又不会被列为过期）。
    if old_steps != steps:
        return "步数已变"
    return None


def skip_note(f, morph, vi, man, enabled=True):
    """`--skip-existing` 该不该跳过这张卡：`None` = 跳过；否则返回「为什么不能跳过」。

    ⚠️ 判据**本体**在 `card_state()` —— 这里只是把「开关 + 判据」收成一个**有名字的入口**：
       ① 语义更清楚（不启用跳过时一律当作「要出图」）；
       ② 门禁能按**定义形态**切到它（`verify` 第 51 节不按位置切片，那是本项目踩过的坑）。
    """
    if not enabled:
        return "无文件"        # 不启用跳过 ⇒ 一律当作「要出图」
    return card_state(f, morph, vi, man)


def card_jobs_of(f):
    """这条鱼的全部出图任务（母版 + 每一档的每一版），与 main() 的 jobs 顺序同源。"""
    return [(None, 0)] + [(k, vi) for k, _d in MORPHS
                          for vi in range(len(morph_versions(f, k)))]


def card_state_label(f, morph, vi, man):
    """(归档键, 原因标签 或 None) —— 键 `母版` / `bright` / `shiny-2`，与 manifest 同源。"""
    st = card_state(f, morph, vi, man)
    if morph is None:
        return "母版", st
    return morph + (morph_versions(f, morph)[vi][3] or ""), st


def report_stale(fish, brief=False):
    """列出「**已出图、但与当前生成口径不一致**」的卡片，并给出可执行的命令。

    `brief=True` 只打印**摘要三行**（总数 + 原因分布 + 按档分布）——
    双击的启动器（`tools/gen-art-loop.cmd`）要的是一眼能看懂，而不是把控制台刷满几百行 id。


    ⚠️ 判据**与 `--skip-existing` 是同一份**（`card_state`）—— 见它的说明。
       两张表分家就是这个报告存在的理由，所以这里绝不许再写第二份判据。
    """
    if not os.path.exists(MANIFEST):
        print("还没有 %s，无法比较（先跑一轮生图）" % os.path.basename(MANIFEST))
        return
    try:
        man = json.load(open(MANIFEST, encoding="utf-8"))
    except Exception as e:
        print("manifest 读不出来：%s" % e)
        return

    groups, reasons = {}, {}
    for f in fish:
        for k, vi in card_jobs_of(f):
            key, st = card_state_label(f, k, vi, man)
            if st is None or st == "无文件":
                continue                      # 「无文件」是待出，不是过期
            groups.setdefault(key, []).append(f["id"])
            reasons[st] = reasons.get(st, 0) + 1

    total = sum(len(v) for v in groups.values())
    if not total:
        print("✔ 没有过期卡片 —— 已出图的提示词 / 步数 / 派生文件都与当前生成口径一致")
        return
    print("过期卡片共 %d 张（已出图、但与当前生成口径不一致 ⇒ 需要重出）：" % total)
    print("  原因：%s" % " ／ ".join("%s %d" % (k, v)
                                     for k, v in sorted(reasons.items(), key=lambda x: -x[1])))
    if brief:
        print("  按档：%s" % " ／ ".join("%s %d" % (k, len(groups[k]))
                                        for k in ["母版"] + [x for k2, _ in MORPHS for x in (k2, k2 + "-2")]
                                        if k in groups))
        print("\n（--brief：只打摘要。要看逐条 id 就去掉 --brief）")
        return
    print()
    known = ["母版"]
    for x, _ in MORPHS:
        known += [x, x + "-2"]          # 一档多版时 manifest 键带 `-2` 后缀
    for k in known:
        ids = sorted(groups.get(k) or [])
        if not ids:
            continue
        print("  %-7s %3d 条" % (k, len(ids)))
        print("          %s" % " ".join(ids))
        print("          重出：python tools/gen-art.py --list %s%s\n"
              % (",".join(ids), "" if k == "母版" else " --only-morph " + k))
    print("⚠️ 母版重出会顺带刷新它的 `-normal`（原色档就是母版的抠图）；"
          "五档是独立文生图，单档重出只影响那一张，不会连带动别的档。")
    print("💡 建议**加** `--skip-existing` 跑上面那些命令（断点续跑）：跳过判据与这里同源，"
          "\n   所以它只会跳过「已经是最新口径」的卡，上面这些照样会重出。"
          "⚠️ 2026-10-10 之前不是这样 —— 那时它只看文件在不在，这些卡会被**静默跳过**。")


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
    ap.add_argument("--only-morph", default="",
                    help="只出这些档（逗号分隔，如 shiny 或 shiny,albino）。"
                         "⚠️ 给了它就**不再出母版** —— 你要的就是那几张单档卡")
    ap.add_argument("--stale", action="store_true",
                    help="只报告「已出图但提示词已过期」的卡片（口径改过之后该重出哪些）")
    ap.add_argument("--who", action="store_true",
                    help="只回答「现在能不能开跑」：free 退出码 0 / busy 退出码 3。"
                         "判据与出图时的互斥锁**同一份**（lock_state）—— 一键启动器读它")
    ap.add_argument("--brief", action="store_true",
                    help="配合 --stale：只打摘要（数量 + 按档分布），不打逐条 id —— 启动器用")
    ap.add_argument("--skip-existing", action="store_true", help="已有成品跳过（断点续跑）")
    ap.add_argument("--budget-min", type=float, default=0,
                    help="时间预算（分钟）：到点**在任务边界干净收工**，不等当前这张之外的更多任务。"
                         "0 = 不限。定时任务靠它把单轮压进窗口，长跑靠它约束时长。")
    ap.add_argument("--sleep-check", type=float, default=0,
                    help="每张出完额外歇 N 秒（给 GPU 降降火，也留出被外部打断的窗）")
    ap.add_argument("--img-timeout", type=int, default=300,
                    help="**单张图**的等待上限秒数（正常 ≈62s）。卡死时不再白等 txt2img 的默认 3600s。")
    args = ap.parse_args()

    if args.who:
        st = lock_state()
        if st is None:
            print("free ｜ 没有锁文件"); sys.exit(0)
        if st["busy"]:
            print("busy ｜ pid %s，%d 秒前还有心跳" % (st["pid"], st["age"])); sys.exit(3)
        print("free ｜ pid %s 已不再出图（心跳停在 %d 秒前）—— 下一轮接管"
              % (st["pid"], st["age"])); sys.exit(0)

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

    if args.stale:
        report_stale(fish, brief=args.brief)
        return

    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    if os.path.exists(MANIFEST):
        manifest = json.load(open(MANIFEST, encoding="utf-8"))

    def run_t2i(prompt, path, steps):
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
                                "--steps", str(steps), "--seed", str(SEED),
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
    only = [x.strip() for x in (args.only_morph or "").split(",") if x.strip()]
    known = [k for k, _ in MORPHS]
    unknown = [x for x in only if x not in known]
    if unknown:
        sys.exit("--only-morph 里有不认识的档：%s（可选：%s）"
                 % (",".join(unknown), "/".join(known)))
    for f in fish:
        if not args.morphs_only and not only:
            jobs.append((f, None, 0))
        if not args.masters_only:
            for key, _desc in MORPHS:
                if only and key not in only:
                    continue
                # 一档可能出**多版**（传说档闪光 2 版，见 `MORPH_VERSIONS_BY_RAR`）
                for vi in range(len(morph_versions(f, key))):
                    jobs.append((f, key, vi))
    if not jobs:
        sys.exit("没有要出的图 —— 检查 --only-morph / --masters-only / --morphs-only 的组合")
    if only:
        print("只出档位：%s（不出母版）" % "/".join(only))

    per = len(jobs) // len(fish) if fish else 0
    print("待生成 %d 张（%d 条鱼 × %d 张）" % (len(jobs), len(fish), per))

    # ── 互斥锁（判据在模块级 `lock_state()` / `lock_alive()`，**只此一处**）──
    def lock_write():
        try:
            json.dump({"pid": os.getpid(), "ts": time.time(), "budgetMin": args.budget_min},
                      open(lock_path(), "w", encoding="utf-8"))
        except Exception:
            pass

    if not args.plan:
        st = lock_state()
        if st and st["busy"]:
            print("⏸ 已有生图进程在跑（pid=%s，%d 秒前还有心跳）—— 本轮不重复开工。"
                  % (st["pid"], st["age"]))
            print("   避免重复出图、以及两个进程并发写 manifest.json。")
            return
        if st:
            print("……上一个生图进程（pid=%s）已不存在或心跳过期（%d 秒前），本轮接管。"
                  % (st["pid"], st["age"]))
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

    # ── 「重出」= 把旧图**移走归档**，再把新图放回去 ─────────────────────────
    # 用户口径（2026-10-08）：「移动废旧图片，生成新的图片替换它」。
    # 以前是直接写 `dst`，旧图**当场被覆盖、找不回来** —— 而「重出」恰恰是最常走这条路的地方
    # （重出就是「因为旧的不好所以才重来」），一旦新图更差，连回退的余地都没有。
    #
    # ⚠️ 两条硬约束：
    #   ① **新图确实出来了**才动旧的 —— 出图失败却先把旧图移走，等于任务失败还把资产弄丢；
    #      所以出图一律先落 `_tmp/`，成功了再 `supersede()` 换上去。
    #   ② 归档按**本轮时间戳**分子目录（`_superseded/20261008-1430/`），
    #      不覆盖上一轮归档 —— 否则「移走」等于换个地方丢。
    # `_superseded/` 已在 .gitignore 里（AI 素材产物不进版本库）。
    SUPERSEDED = os.path.join(OUT, "_superseded", time.strftime("%Y%m%d-%H%M%S"))

    def archive_only(path):
        """把 path 移进本轮归档目录（不补新文件）。"""
        if not os.path.exists(path):
            return
        try:
            os.makedirs(SUPERSEDED, exist_ok=True)
            os.replace(path, os.path.join(SUPERSEDED, os.path.basename(path)))
        except OSError as e:
            print("    ⚠️ 旧图归档失败（%s），继续" % e)

    def supersede(dst, new_tmp):
        """用 new_tmp 替换 dst；dst 原来那张先移进本轮归档目录。

        ⚠️ 必须在**新图已经落盘**之后调用 —— 这个函数一执行，旧图就不在原位了。
        """
        archive_only(dst)
        os.replace(new_tmp, dst)
        print("    ↻ 已替换（旧图归档到 %s）" % os.path.relpath(SUPERSEDED, ROOT))

    CHECKPOINT = 10          # 每 10 张（≈10 分钟）落一次
    t_start = time.time()
    ok = fail = skip = 0
    for i, (f, morph, vi) in enumerate(jobs, 1):
        # ⏱ 时间预算：**在任务边界收工**（不打断正在进行的那张），剩余下一轮 --skip-existing 续跑
        if args.budget_min and (time.time() - t_start) / 60.0 >= args.budget_min:
            print("\n⏱ 时间预算 %.0f 分钟已到，干净收工。本轮到第 %d/%d 张，"
                  "剩余下一轮续跑（加 --skip-existing）。" % (args.budget_min, i - 1, len(jobs)))
            break
        fid = f["id"]
        variant_tag = ""
        mkey = None                      # manifest 里的键 = 档位 + 版本后缀
        if morph is None:
            dst, prompt, label = os.path.join(OUT, fid + ".png"), build_prompt(f), "母版"
        else:
            variant_ck, variant_tag, _sent, sfx = morph_versions(f, morph)[vi]
            mkey = morph + sfx
            dst = os.path.join(OUT, "%s-%s%s.png" % (fid, morph, sfx))
            prompt = build_morph_prompt(f, morph, _sent)
            label = MORPH_CN[morph] + (("　第%d版" % (vi + 1)) if sfx else "")
        # 步数 = max(按稀有度, 按档位) —— 见 `steps_for()`
        steps = steps_for(f, morph)

        # 🔴 跳过判据 = **内容指纹**（`skip_note` → `card_state`），**不是**「文件在不在」（Q14）。
        #    文件在、但台账对不上 / 没有台账 / 派生缺了 ⇒ **必须重出**。
        #    旧实现只看文件在不在 ⇒ 口径一改，旧卡被静默跳过、**永不重出**，
        #    而图上完全看不出来（文件在、图也不坏，只是不是这一版口径）。
        st = skip_note(f, morph, vi, manifest, args.skip_existing)
        if st is None:
            print("[%d/%d] %s %-7s 已存在且口径一致，跳过" % (i, len(jobs), fid, label))
            skip += 1
            continue
        if st != "无文件":
            print("    ↻ %s 已存在，但%s ⇒ 重出" % (label, st))

        print("\n[%d/%d] %s %s   %s%s" % (i, len(jobs), fid, f["name"], label,
                                          ("　[" + variant_tag + "]") if variant_tag else ""))
        # ⏱ 逐张计时 —— 落进 manifest 的 `sec`，供 `write_plan()` 用**实测中位**排期。
        #    为什么必须记：清单里那个「单条耗时」原来是手填常数，换机器 / 改步数 /
        #    GPU 被占着就会悄悄过期，而清单是「还剩多少、还要多久」的唯一依据。
        t_card = time.time()
        if morph is None:
            # 母版：RGB 暗底（与 docs/images/标准/ 一致的外观对照）
            # ⚠️ 先出到 `_tmp/`、成功之后才 `supersede()` —— 见上面那段注释：
            #    直接写 dst 的话，出图失败就把旧母版留成半张废图（或被覆盖掉）。
            tmp_master = os.path.join(TMP, "%s.master.png" % fid)
            good, r = run_t2i(prompt, tmp_master, steps)
            if good:
                supersede(dst, tmp_master)
                # 原色档 = 母版的抠图（不重新生成：省一次出图，且与母版必然同色）
                # 旧的抠图也要归档，否则它就成了「上一版母版」的孤儿
                archive_only(os.path.join(OUT, fid + "-normal.png"))
                cutout.cut_one(dst, os.path.join(OUT, fid + "-normal.png"))
        else:
            raw = os.path.join(TMP, "%s-%s%s.png" % (fid, morph, sfx))
            good, r = run_t2i(prompt, raw, steps)
            if good:
                # 出图后立刻抠成 RGBA —— 但**先抠到 _tmp/**，成功了再替换原位
                tmp_cut = os.path.join(TMP, "%s-%s%s.rgba.png" % (fid, morph, sfx))
                good = cutout.cut_one(raw, tmp_cut)
                if good:
                    supersede(dst, tmp_cut)
                if os.path.exists(raw):
                    os.remove(raw)

        if good:
            ok += 1
            sec = round(time.time() - t_card, 1)
            if morph is None:
                manifest[fid] = {
                    "name": f["name"], "rar": f["rar"], "shape": f["shape"],
                    "prompt": prompt, "negative": NEG, "seed": SEED, "cfg": CFG,
                    "size": [W, H], "steps": steps, "model": MODEL,
                    # 实测耗时（秒）：母版这一步**含抠图**（它要顺带出 `-normal`）
                    "sec": sec,
                }
            else:
                # ⚠️ **必须把「抽中的是哪个候选键」写进 manifest** ——
                #    颜色句现在是从池子里抽的，只记 prompt 就还得反查是哪一套；
                #    记了键，`MORPH_CANDIDATES` 一改就能立刻看出哪些图受影响。
                manifest.setdefault(fid, {}).setdefault("morphs", {})[mkey] = {
                    "candidate": variant_ck, "label": variant_tag, "prompt": prompt,
                    # 每个档也记步数（各档步数不再相同了）—— 供 `report_stale()` 与人工核对
                    "steps": steps,
                    # 实测耗时（秒）—— 供 `write_plan()` 现算「每张多少秒」
                    "sec": sec}
                # 抽到哪一套也记下来 —— 光看提示词能反查，但列出标签便于人核对分布与复现
                manifest.setdefault(fid, {}).setdefault("morphVariant", {})[mkey] = variant_tag
            print("    ok")
        else:
            fail += 1
            print("    失败：" + (r.stdout or r.stderr or "")[-200:])
        lock_write()          # 心跳（见上：锁靠心跳过期来自愈，不查 pid）
        if (ok + fail + skip) % CHECKPOINT == 0:
            save_manifest()   # 定期落盘（见上：长跑被杀不能连台账一起丢）

    save_manifest()
    try:
        os.remove(lock_path())   # 正常收工要主动释放；异常中断则靠心跳过期自愈
    except OSError:
        pass
    print("\n" + "=" * 50)
    print("成功 %d / 失败 %d / 跳过 %d，台账 %s（共 %d 条）"
          % (ok, fail, skip, MANIFEST, len(manifest)))

    # 📋 收尾顺手刷新生图清单：`[x]` 是按**磁盘实际状态**现算的，不刷新它会一直停在旧状态。
    #    实测（2026-10-10）：362 条鱼的卡全出齐了，清单里还有 **81 批**打着「未完成」——
    #    而清单的勾正是「下一轮跳不跳」的依据，停在旧状态会让人以为还有一大堆活没干。
    #    ✅ 内容已是最新时逐字节相同 ⇒ **不会把工作区弄脏**（只有真的过期了才会写变）。
    try:
        write_plan(allfish)
        print("📋 docs/生图清单.md 已按磁盘实际状态刷新（共 %d 批）"
              % len(make_batches(allfish)))
    except Exception as e:
        print("⚠️ 清单刷新失败（不影响出图）：%s" % e)

    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
