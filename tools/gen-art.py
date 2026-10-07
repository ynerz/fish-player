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
  python tools/gen-art.py --list 0,1,2         # 只出指定 id
  python tools/gen-art.py --limit 12           # 抽样 12 条（跨稀有度）
  python tools/gen-art.py --rar 3              # 只出传说
  python tools/gen-art.py --dry D01,D16        # 只打印提示词，不出图

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
import argparse, hashlib, json, os, re, subprocess, sys, colorsys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = r"C:/Users/15001/.workbuddy/binaries/python/versions/3.13.12/python.exe"
COMFY = os.path.expanduser(r"~/.workbuddy/comfy/txt2img.py")
OUT = os.path.join(ROOT, "assets", "cards")
MANIFEST = os.path.join(OUT, "manifest.json")

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
#    照样给细密鳞片和柔和渐变。必须显式点名「大平面 / 可见多边形边 / 极少表面细节」。
GEOM = ("Built from large flat angular facets, clearly visible polygon edges, "
        "minimal surface detail, no texture.")

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

# ── 个体差异（用户口径：「要有一定的随机性」+「同种生图时加一些小特征来区分」）──
# ⚠️ 随机必须**可复现**：用鱼 id 派生哈希，同一条鱼每次出图结果一样。
#    用真随机会让「重出一张」变成「换一条鱼」，清单和 manifest 立刻失真。
SNOUT = ["short snout", "pointed snout", "blunt rounded snout",
         "slightly upturned mouth", "downward-facing mouth"]
HEAD = ["small head", "medium head", "large head"]
FINBUILD = ["modest fins", "well-developed fins", "long trailing fins"]
# 体表小特征 —— 用户口径「同种（同科属）的鱼要能区分」。
# ⚠️ 与 FEATURE 的特征位**互斥**：鱼本身带 `stripes` / `spots` 时跳过这里，
#    否则会出现「带垂直条纹 + 带竖直斑纹」这种重复描述。
MARKINGS = ["a dark lateral line running along the body",
            "a faint scattering of small dots",
            "subtle vertical barring on the flanks",
            "a single dark spot near the tail base",
            "a clean plain unmarked body",
            "a slightly darker patch behind the gill cover"]
MARKING_KEYS = ("stripes", "spots")


def stable_pick(fid, salt, options):
    """用鱼 id 派生稳定的选择 —— 可复现是硬要求（见上面 FINBUILD 的注释）"""
    h = hashlib.md5((str(fid) + "|" + salt).encode("utf-8")).digest()
    return options[h[0] % len(options)]


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
HEAD_RANDOM = ["a small pointed head", "a medium tapered head",
               "a large blunt head", "a compact rounded head",
               "an elongated head", "a deep heavy head"]

TAIL_HINTS = [
    ("鲹",   "a deeply forked tail on a narrow tail base"),
    ("鲭",   "a deeply forked tail"),
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
TAIL_RANDOM = ["a forked tail", "a rounded tail fin", "a crescent tail",
               "a fan-shaped tail", "a truncated square tail",
               "a long trailing tail fin"]

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

    五个维度全部由 `fish.js` 的**真实数据**驱动（不是随手编的）：

      | 维度 | 数据来源 |
      |---|---|
      | 体型大小 | `maxKg`（0.04~20000，跨 5 个数量级） |
      | 身体比例 | `body_ratio`（0.20~0.86） |
      | 头型 | 名字线索优先，找不到用 `stable_pick` 兜底 |
      | 鳍 | 特征位（`spiny`/`barbels`/`lure`…）由调用方另行拼接 |
      | 尾型 | 同上（`tail` 字段 351/362 是 `fan`，**不可用**） |

    ⚠️ 五条都写进提示词会太长、稀释风格锚点，所以这里**只挑最能区分的三条**
       （大小 / 比例 / 尾型），头型重叠时再补一条 —— 见返回值。
    """
    out = []

    # ① 体型大小（maxKg）
    kg = f.get("maxKg") or 0.1
    for lim, desc in SIZE_BANDS:
        if kg < lim:
            out.append(desc)
            break

    # ② 身体比例（body_ratio）—— 只对有躯干的体型
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

    # ③ 尾型（名字线索 → 随机兜底）
    name = f.get("name", "")
    tail = ""
    for key, desc in TAIL_HINTS:
        if key in name:
            tail = desc
            break
    if not tail:
        tail = stable_pick(f["id"], "tail", TAIL_RANDOM)
    out.append(tail)

    # ④ 头型 —— 名字线索能命中就写，命中不了就丢掉（少说一句好过多说一句）
    head = ""
    for key, desc in HEAD_HINTS:
        if key in name:
            head = desc
            break
    if head:
        out.append(head)

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
    hint = name_hint(f)
    if hint:
        bits.append(hint)

    # ② 形态档案 —— 大小 / 比例 / 尾型 / 头型，全部由真实数据驱动
    #    （用户口径：「按身体特征对每条鱼先写一个描述」，让鱼更好分辨）
    bits.append(form_profile(f))

    # ③ 体表小特征（与特征位互斥，避免「带垂直条纹 + 带竖直斑纹」这种重复）
    if shape == "fish" and not any(f.get(k) for k in MARKING_KEYS):
        bits.append(stable_pick(f["id"], "mark", MARKINGS))

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
# 单张出图耗时实测：cfg=3.0 每步跑两次前向 ≈ 55s（cfg=1 时约 28s）
SEC_PER_SHOT = 55
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


def write_plan(fish):
    """生成 docs/生图清单.md —— 带勾选框，供逐批执行与追踪"""
    bs = make_batches(fish)
    total = sum(len(b) for b in bs)
    legend = sum(1 for f in fish if f["rar"] == 3)
    shots = total + legend * (LEGEND_ROUNDS - 1)     # 传说多打的轮次
    hours = shots * SEC_PER_SHOT / 3600.0

    L = []
    L.append("# 图鉴卡面生图清单（%d 条鱼 / %d 批）\n" % (total, len(bs)))
    L.append("> 生成管道 `tools/gen-art.py`（提示词 / 种子 / 参数落进 `assets/cards/manifest.json`，可复现）")
    L.append("> 执行：`python tools/gen-art.py --batch N`　·　全量重跑：`--list` 指定或去掉 `--batch`")
    L.append("> 出图后跑 `python tools/paint-card.py --all` 派生 5 档颜色（纯 CPU，不用 AI）\n")
    L.append("**分批策略**（用户 2026-10-07 口径）：普通 / 稀有 5 条一批 · 史诗 2 条 · 传说 1 条。")
    L.append("传说「一次一张 + 多轮优化到符合名字与体型」，所以单批条数最少、迭代轮数最多。\n")
    L.append("| 项 | 数 |")
    L.append("|---|---|")
    L.append("| 鱼种总数 | %d |" % total)
    L.append("| 批次数 | **%d** |" % len(bs))
    L.append("| 传说鱼 | %d 条，每条按 %d 轮迭代（评审轮次） |" % (legend, LEGEND_ROUNDS))
    L.append("| 出图张数（含传说迭代） | ≈ %d |" % shots)
    L.append("| 纯机器时间 | ≈ **%.1f 小时**（按单张 %ds 估） |" % (hours, SEC_PER_SHOT))
    L.append("")
    L.append("⚠️ 真正的瓶颈不是机器时间，是**评审次数**：%d 批，每批都要「看图 → 判断合格 / 重出」。" % len(bs))
    L.append("传说那 %d 条尤其 ——每条 %d 轮，就是 %d 次判断。\n" % (legend, LEGEND_ROUNDS, legend * LEGEND_ROUNDS))
    L.append("## 批次表\n")
    L.append("| 状态 | 批次 | 档位 | 条数 | 内容 |")
    L.append("|---|---|---|---|---|")
    out = os.path.join(ROOT, "docs", "生图清单.md")

    for i, b in enumerate(bs, 1):
        names = "、".join("%s %s" % (f["id"], f["name"]) for f in b)
        # **只信自动检测**：本批母版全都存在才算完成。
        # ⚠️ 不要读回历史勾选再取或 —— 本轮踩过：口径变更时把旧图移走重跑，
        #    清单却因为「历史勾选还在」显示已完成，会骗过下一轮的执行者。
        #    勾选必须反映**磁盘实际状态**。
        have = all(os.path.exists(os.path.join(OUT, f["id"] + ".png")) for f in b)
        mark = "[x]" if have else "[ ]"
        L.append("| %s | %03d | %s | %d | %s |" % (mark, i, RAR_CN[b[0]["rar"]], len(b), names))
    L.append("")

    open(out, "w", encoding="utf-8").write("\n".join(L))
    print("清单已写出：%s" % out)
    print("共 %d 条 / %d 批；含传说迭代约 %d 张，纯机器时间 ≈ %.1f 小时"
          % (total, len(bs), shots, hours))


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
    ap.add_argument("--batch", type=int, default=0, help="只出第 N 批（从 1 起，见清单）")
    ap.add_argument("--prompt-only", action="store_true", help="只打印提示词，不出图")
    ap.add_argument("--dry", default="", help="（快捷）等价于 --prompt-only --list X")
    args = ap.parse_args()

    if args.dry:
        args.list = args.dry
        args.prompt_only = True

    allfish = load_fish()

    if args.plan:
        write_plan(allfish); return

    if args.forms:
        write_forms(allfish); return

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

    print("待生成 %d 张" % len(fish))
    ok = 0
    for i, f in enumerate(fish, 1):
        path = os.path.join(OUT, f["id"] + ".png")
        prompt = build_prompt(f)
        print("\n[%d/%d] %s %s (rar %d, %s)" % (i, len(fish), f["id"], f["name"], f["rar"], f["shape"]))
        r = subprocess.run([PY, COMFY, "-p", prompt, "-n", NEG, "--cfg", str(CFG),
                            "-o", path,
                            "-W", str(W), "-H", str(H), "--steps", str(STEPS),
                            "--seed", str(SEED)],
                           capture_output=True, text=True, errors="replace")
        if os.path.exists(path):
            ok += 1
            manifest[f["id"]] = {
                "name": f["name"], "rar": f["rar"], "shape": f["shape"],
                "prompt": prompt, "negative": NEG, "seed": SEED, "cfg": CFG,
                "size": [W, H], "steps": STEPS, "model": MODEL
            }
            print("    ok")
        else:
            print("    失败：" + (r.stdout or r.stderr or "")[-200:])

    json.dump(manifest, open(MANIFEST, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
    print("\n" + "=" * 50)
    print("成功 %d / %d，清单 %s（共 %d 条）" % (ok, len(fish), MANIFEST, len(manifest)))


if __name__ == "__main__":
    main()
