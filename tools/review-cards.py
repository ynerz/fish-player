# -*- coding: utf-8 -*-
"""卡片评审台：把**已出图**的鱼连同中文名并排摆出来，人工逐条判「合格 / 重出」。

为什么需要它：
  出图是无人值守跑的，**没有人在看图**。而 `check-cards.py` 只能查几何（占比 / 宽高比 /
  重心 / 背腹 / 主色），**拦不住「画的不是这个物种」** —— 实测就这么漏掉过
  D08 小龙虾（画成乌贼）、A24 章鱼（画成鱿鱼）、A29 牙鲆（比目鱼画成普通鱼）。
  几何断言永远替代不了眼睛，所以给人一个**顺手到愿意用**的评审界面。

用法：
  python tools/review-cards.py                 # 写 docs/卡片评审.html
  python tools/review-cards.py --only A01,B02  # 只列这几条鱼
  python tools/review-cards.py --serve --open  # 起本地运行器（页面上能直接开跑重出）

产物：`docs/卡片评审.html`（单文件、零依赖，**双击即可打开**；也可起 http 服务看）
  · 每张卡：母版大图 + **可评审单元** —— 口径是「母版含原色档 / 彩虹 / 白化 / 黄金 / 闪光」，
    而**某一档出了几版就占几个单元**（例：传说档的闪光出 2 版 ⇒「闪光」+「闪光·第2版」）。
    槽位**按磁盘上的文件枚举**（见 `morph_slots()`），不是写死 5 个 —— 生成器以后再加版，
    这一页自动跟上；页面上少一个槽 = 那张图「出了但没人看过」。
    外加 id + 中文名 +（有的话）拉丁名 + 形态描述
  · **每个单元各自判**「合格 / 重出」—— 出问题的是单张图，不是整条鱼（用户口径 2026-10-08）
  · **点任意一张图放大到原图**（`#lb` 层；点任意处或 Esc 关闭）。缩略图再大也不够用：
    卡面 1152×768 而鱼只占中间一块，判「头身是不是一个色」这种细节必须能放到接近 1:1
  · 状态存在浏览器 localStorage（键 `fishcard-review-v2`），**刷新不丢**
  · 顶部进度条 + 筛选；「导出重出清单」**按档分组**给出可直接执行的命令
  · 「对照百科」按钮：新窗口搜该物种，方便和真动物比对

⚠️ 五档自 2026-10-07 起是**独立文生图**（同种子、同提示词、只差颜色句；
   曾走图生图，已弃用）⇒ **单档可以独立重出**，不必须连母版一起。
   母版重出会顺带刷新它的 `<id>-normal.png`（原色档就是母版抠图）。
"""
import argparse
import colorsys
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CARDS = os.path.join(ROOT, "assets", "cards")
RAR_CN = ["普通", "稀有", "史诗", "传说"]
MORPH_CN = [("normal", "原色"), ("bright", "彩虹色"), ("albino", "白化"),
            ("golden", "黄金"), ("shiny", "闪光")]
MASTER_LABEL = u"母版（含原色档）"
# 档位键（不含 normal —— 原色档不是独立出图，它是母版抠图，并进 master 那个单元）。
# ⚠️ 这是**派生值**：唯一真相是 `gen-art.py` 的 `MORPH_ORDER`，verify 第 ㊹ 节会
#    双向校验「MORPH_CN 的键集 == {normal} ∪ MORPH_ORDER」——
#    少一个 ⇒ 那一档的卡**永远没人评审**；多一个 ⇒ 死配置。别在这儿手加。
MORPH_KEYS = ("master",) + tuple(k for k, _ in MORPH_CN if k != "normal")

# ---- 形态模板键 → 中文标签（**唯一一处**）--------------------------------------
# 它就是 `src/data/fish.js` 里 `F(id, name, rar, 'fish')` 的**第 4 参**，
# 游戏内由 `src/render/fishart.js` 的 `TPL[fish.shape] || TPL.fish` 取用（拿不到就回落通用鱼形）。
# 为什么要有这张表：评审页原来把这个内部键**裸印**在卡片上（`A03 · 稀有 · fish`），
#   我第一眼看成占位符 / 脏数据 —— 它其实是有信息量的字段（**画法**），
#   而「画法」恰恰是「画错物种」那类问题的根因线索（`shape=squid` 的章鱼、
#   `shape=fish` 的八爪鱼，一眼就能对上病因）。
# ⚠️ 键集必须与 `fishart.js` 的 `TPL.<键>` **逐个对上**（verify 第 ㊸ 节双向校验：
#    少一个 / 多一个都报红）⇒ 将来新增一个模板，必须同时来这里补中文标签。
def load_shape_cn():
    """体型键 → 中文标签。**唯一真相在 `src/data/config.js` 的 `CONFIG.shapeCn`**
    （游戏内图鉴的体型筛选与这个评审页共用同一份）。

    ⚠️ 这里是**读出来**的，不是抄一份 —— 抄一份两边必然漂开，而 `verify` 第 ㊸ 节
       只能验「键集与 `fishart.TPL` 对齐」，**验不出「同一个键两边叫法不同」**。
       2026-10-10 用户要求给图鉴也加体型筛选时，顺势把这份表提到了 config.js。
    """
    src = io.open(os.path.join(ROOT, "src", "data", "config.js"), encoding="utf-8").read()
    m = re.search(r"shapeCn\s*:\s*\{([\s\S]*?)\}", src)
    if not m:
        raise SystemExit("❌ config.js 里找不到 CONFIG.shapeCn —— 评审台的体型标签从那儿读")
    pairs = re.findall(r"([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']*)'", m.group(1))
    if len(pairs) < 5:
        raise SystemExit("❌ CONFIG.shapeCn 只解析出 %d 条 —— config.js 的写法改过就来更新这里"
                         % len(pairs))
    return dict(pairs)


SHAPE_CN = load_shape_cn()

# ---- 钓场键 → 中文标签（**唯一一处**）------------------------------------------
# 用户 2026-10-10 口径：「你可以在图鉴和我的审图合格不合格上加条件赛选，
#   比如可以筛选同一个条件下的所有鱼，我来标记要重出」。
# 这是那个「条件」的第一个维度。**场名只在这里写一次** ——
#   页内 JS 靠 Python 注入的 `<option>` 取文本，绝不在页里再抄一份中文表（第二份真相）。
def load_fields():
    """钓场 id → 中文名（**按 `fields.js` 自己的顺序**，即「由近及远」）。"""
    src = io.open(os.path.join(ROOT, "src", "data", "fields.js"), encoding="utf-8").read()
    out = []
    for m in re.finditer(r"id:\s*'([A-Z]+)'([\s\S]{0,400}?)name:\s*'([^']*)'", src):
        out.append((m.group(1), m.group(3)))
    if len(out) < 5:
        raise SystemExit("❌ fields.js 只解析出 %d 个钓场 —— 写法改过就来更新这个解析" % len(out))
    return out


# 🔴 钓场名的**唯一真相是 `src/data/fields.js`** —— 这里读它，不许手抄。
#    手抄那张表我第一版就写了，而且**七条错了五条**：`fields.js` 的 id 是**倒着排**的
#    （`D` 村口小池塘 → `C` 溪流浅滩 → `B` 湖心半岛 → `A` 深海断崖），
#    我按「A 是第一个钓场」去猜，于是 A 写成「溪流浅滩」（其实是「深海断崖」）、
#    B 写成「混合水域」（其实是「湖心半岛」）… 最要命的是**看上去完全正常**：
#    下拉里有名字、筛出来也有鱼，只有对着游戏看一眼才会发现错了。
FIELD_CN = dict(load_fields())

# ---- 色相带（30° 一档，**唯一一处**）-------------------------------------------
# 「同体型 + 同色相带」是**肉眼最容易觉得像**的那一格 —— 实测 SS 场的
#   「通用鱼形 + 240~270°（蓝）」一格里就挤了 29 条（占该场鱼形的一半）。
# ⚠️ 分箱边界（30°）与 `HUE_BANDS` 的条数必须同源，别在别处再写一遍。
HUE_BANDS = (
    (0, u"红", 0, 30), (1, u"橙", 30, 60), (2, u"金", 60, 90), (3, u"黄绿", 90, 120),
    (4, u"绿", 120, 150), (5, u"青绿", 150, 180), (6, u"青", 180, 210), (7, u"天蓝", 210, 240),
    (8, u"蓝", 240, 270), (9, u"紫", 270, 300), (10, u"洋红", 300, 330), (11, u"粉", 330, 360),
)


def hue_of(hexstr):
    """十六进制色值 → 色相角 0~359（认不出来返回 -1）。走 rgb→hls，与游戏内同一套。"""
    h = (hexstr or "").lstrip("#")
    if len(h) != 6:
        return -1
    try:
        r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return -1
    return int(colorsys.rgb_to_hls(r, g, b)[0] * 360) % 360


def facet_options(items):
    """拼 `<option>` 串 —— 中文名在**这里**算好，页内只读文本、不抄表。

    ⚠️ **不生成空选项**：那个「全部钓场 / 全部体型…」由模板里写死（带各自的上下文词，
    比一个笼统的「全部」好读）。两边都生成的话，下拉里会出现**两个空选项**（实测踩过）。
    """
    return u"".join(u'<option value="%s">%s</option>' % (v, cn) for v, cn in items)


# ---- 名字 / 模板交叉提示（**只提示、不报错**）-----------------------------------
# 含义：名字里出现了某个家族词，用的却是**别的**模板 ⇒ 在卡片上提一句，让人看一眼。
# 为什么只提示不报错：模板是**画法**不是**分类** —— 八爪鱼用 `squid` 模板、
#   鲸模板画蛇颈龙 / 鲲，都是**合理**的。硬报错会变成假警报，久了没人看。
# 词表是**量出来的**，不是猜的（2026-10-08 对着 362 条逐词现算）：
#   下表 13 个词每个都真命中（最少的「鳝」1 条），**合计只有 1 条鱼出提示**：
#   S34 深海龙鱼 —— 真实深海鱼（巨目鱼/巨口鱼科），名字带「龙鱼」却用通用鱼形，
#   属于上面说的「合理」那一类，提示一下即可（人看一眼就过）。
# ⚠️ 实测**已排除**、别再加回来的写法（都有实证，加之前请先现算一遍）：
#   · 「鲛」→ 8 条命中里 **3 条是假的**：马鲛 / 蓝点马鲛 / 深海银鲛 都是真实鱼（shape=fish），
#     「鲛」在「马鲛」里根本不是鲨的意思 ⇒ 加进来就是 3 条噪音（我自己加过一遍又撤了）；
#   · 「龙」去掉「鱼」→ 小龙虾 / 龙趸石斑 / 原初蛇颈龙 全被误命中（4 命中 3 条是假的）；
#   · 「鲼」「八爪」「柔鱼」「海蜇」→ 362 条里**一条都不命中** = 零消费死配置，
#     按项目规矩（不加没有消费方的配置）不写进来（test-review-cards.py 第 [9] 节会报红）。
SHAPE_NAME_HINTS = (
    ("shark", ("鲨",)),
    ("eel", ("鳗",)),
    ("ray", ("鳐", "魟")),
    ("squid", ("鱿", "乌贼", "章鱼")),
    ("jelly", ("水母",)),
    ("whale", ("鲸",)),
    ("dragon", ("龙鱼",)),
    ("oarfish", ("皇带",)),
    # 2026-10-10 新增的 3 个体型（词表是**量出来的**：每条都真命中，见 test-review-cards [9] 节）
    ("crab", ("蟹",)),
    ("shell", ("螺",)),
    ("turtle", ("龟", "鳖")),
    ("crinoid", ("海百合",)),
    ("siphonophore", ("管水母",)),
    ("anemone", ("海葵",)),
    # ── 2026-10-10 细分「通用鱼形」后新增 19 个体型，这里补 16 组 ──
    # ⚠️ 只收**名字里真的长这样、而且真属于这个体型**的词。三条纪律：
    #   ① 每条词都必须有**真命中**（`test-review-cards` 的 [9] 节现算死词）；
    #   ② 不许收「看上去像、其实跨界」的词 —— 实测踩过三个：
    #      `鳟`（B10 赤眼鳟是鲤科）、`鲃`（C24 金线鲃是溪流小鱼）、`石斑`（C16 溪石斑是溪流小鱼）
    #      ⇒ 收进去会天天给三条**本来没错**的鱼报警，人就会开始无视提示（狼来了）。
    #      所以那三条改用**完整名**（虹鳟/褐鳟/…）或干脆不收。
    #   ③ 这一层是**纯展示**：只在卡片上写一句「名字含『X』，用的却是『Y』模板」，
    #      永远不参与判定（判定永远是人点的那两个按钮）。
    ("flatfish", ("鲽", "鲆", "鳎")),
    ("sturgeon", ("鲟",)),
    ("pomfret", ("鲳",)),
    ("puffer", ("河鲀", "箱鲀", "鳞鲀", "魨")),
    ("seahorse", ("海马",)),
    ("anglerfish", ("鮟鱇",)),
    ("billfish", ("旗鱼", "剑鱼")),
    ("manta", ("蝠鲼",)),
    ("catfish", ("鲶", "鮠")),
    ("mackerel", ("马鲛", "金枪", "鲯鳅", "竹荚", "鰶", "鲹")),
    ("salmon", ("鲑", "虹鳟", "褐鳟", "山女鳟", "初雪鳟")),
    ("bottom", ("鰕虎", "虾虎", "鳚", "塘鳢", "鲬", "鲉", "鲪", "鳕", "鼬", "狗母")),
    ("fangfish", ("灯笼鱼", "尖牙鱼", "叉齿鱼", "狼牙鲷", "帆蜥鱼", "巨尾鱼", "褶胸鱼",
                  "黑口鱼", "幽灵鳍鱼", "后肛鱼", "管眼鱼")),
    ("minnow", ("鱥", "鳈", "鮈", "䱻", "鱲", "溪哥", "白甲")),
    ("carp", ("鲤", "鲢", "鳙", "草鱼", "鲮")),
    ("reef", ("鲷", "鲻", "鮸")),
    ("deep", ("鳊", "鲂", "鳑鲏")),
    ("slender", ("鳀", "鲚", "鳡", "翘嘴", "白条", "沙丁", "鳉", "鲱")),
)


def shape_note(shape, name):
    """给一条鱼算「形态模板」该显示什么 → `(中文标签, 提示文本或空串)`。

    纯展示口径：**不参与任何判定**（这一页的判定永远是人点的那两个按钮）。
    """
    label = SHAPE_CN.get(shape)
    if label is None:
        # 认不出的键：`fishart.js` 会回落成通用鱼形 ⇒ 画面上与 fish 无异，**必须说出来**，
        # 否则又是一个「不报错但静默失效」（数据写了 shark、画面是鱼）。
        return shape, u"认不出的模板键，画面上会回落成「%s」" % SHAPE_CN["fish"]
    for want, words in SHAPE_NAME_HINTS:
        if want == shape:
            continue
        hit = [w for w in words if w in name]
        if hit:
            return label, u"名字含「%s」，用的却是「%s」模板" % (hit[0], label)
    return label, u""


def field_of(fid):
    """`id` → 钓场键。**与游戏同一条规则**（`fish.js` 的 `F()` 里就是这么算的：
    `id.slice(0, id.search(/\\d/))` —— 数字之前的字母）。
    ⚠️ 这是**第二处实现**，所以 `test-review-cards.py` 有一条交叉校验：
    拿游戏自己跑出来的 `G.FISH[i].field` 与这里逐个对，对不上就报红（防漂移）。
    """
    m = re.match(r"[A-Za-z]+", fid or "")
    return m.group(0) if m else ""


def load_fish():
    src = io.open(os.path.join(ROOT, "src", "data", "fish.js"), encoding="utf-8").read()
    out = []
    # 第 5 个参数就是主色（`body`），筛选「色相带」要用它
    for i, n, r, sh, body in re.findall(
            r"F\('([A-Z0-9]+)',\s*'([^']*)',\s*(\d),\s*'([a-z]+)',\s*'(#[0-9A-Fa-f]{6})'", src):
        out.append({"id": i, "name": n, "rar": int(r), "shape": sh,
                    "body": body, "field": field_of(i)})
    return out


def load_traits():
    try:
        return json.load(io.open(os.path.join(ROOT, "tools", "fish-traits.json"), encoding="utf-8"))
    except Exception:
        return {}


def card_names():
    """`assets/cards/` 下所有 png 的**无扩展名文件名**（一次列目录，逐条鱼复用）。

    为什么不按鱼 id 逐个 `os.path.exists`：一张卡有 6+ 个文件 × 362 条鱼
    = 两千多次系统调用，而这个集合还有一个更要紧的用途 —— 见 `morph_slots()`。
    """
    return set(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(CARDS, "*.png")))


def generated_ids(names=None):
    """有母版的鱼（`<id>.png`，排除 `<id>-<档>.png` / `<id>-<档>-N.png`）。"""
    names = card_names() if names is None else names
    return set(n for n in names if n and "-" not in n)


def morph_versions_of(fid, key, have):
    """这一档在盘上**真实存在**的版本 → `[(版号, 无扩展名文件名), …]`（版号升序）。

    ⚠️ **按文件枚举**，不按「生成器说该出几版」：评审页要覆盖的是「已经出了的每一张」。
       `gen-art.py` 的 `MORPH_VERSIONS_BY_RAR` 只说明**打算**出几版；盘上有第三版、
       或某条鱼只有第 2 版（第 1 版被手删了），这里都要如实列出来 —— 漏一张就是
       「出了但没人看过」，而这一页存在的全部理由就是不让这种事发生。
    """
    base = "%s-%s" % (fid, key)
    ver = {}
    if base in have:
        ver[1] = base
    for name in have:
        m = re.match(r"^%s-(\d+)$" % re.escape(base), name)
        if m:
            ver[int(m.group(1))] = name
    return [(n, ver[n]) for n in sorted(ver)]


def morph_slots(fid, names):
    """一条鱼**要评审的槽位** ← 从它的文件名里枚举（纯函数：不碰磁盘，可直接喂构造数据）。

    返回 `[{"k","label","morph","file"}, …]`，顺序 = 母版 → 各档（`MORPH_CN` 的顺序）→ 各版升序。

    · `k`     —— 槽位键。**第 1 版沿用档名本身**（`bright` / `shiny` …），
                 第 N 版加 `-N`（`shiny-2`）。第 1 版保持老键是**故意的**：
                 评审状态按槽位键落盘（`fishcard-review-v2`），沿用就**不用做状态迁移**
                 —— 老结论原样有效，新加的版本从「未审」开始（这正是想要的）。
    · `morph` —— 这一槽属于哪一档。**重出命令的粒度就是它**（`--only-morph <morph>`）：
                 标记「闪光·第2版」要重出时，跑的是 `--only-morph shiny`（整档重出）。
    · `morphLabel` —— 该档的中文名（不带版号）。页内 JS 用它给重出清单分组打标题，
                 省得页内再抄一份「键 → 中文」（抄了就会漂，且门禁看不出来）。
    · `file`  —— 缩略图用哪个文件。母版那一槽用**抠图**（`<id>-normal.png`），
                 那才是游戏里真正会显示的图；没有抠图就退回原图。
    """
    have = set(names)
    slots = []
    if fid in have:
        cut = fid + "-normal"
        slots.append({"k": "master", "label": MASTER_LABEL, "morph": "master",
                      "morphLabel": MASTER_LABEL,
                      "file": (cut if cut in have else fid) + ".png"})
    for key, cn in MORPH_CN:
        if key == "normal":
            continue
        for ver, name in morph_versions_of(fid, key, have):
            slots.append({"k": key if ver == 1 else "%s-%d" % (key, ver),
                          "label": cn if ver == 1 else u"%s·第%d版" % (cn, ver),
                          "morph": key, "morphLabel": cn, "file": name + ".png"})
    return slots


def build_rows(only_ids=None):
    traits = load_traits()
    names = card_names()
    gen = generated_ids(names)
    rows = []
    for f in load_fish():
        if f["id"] not in gen:
            continue
        if only_ids and f["id"] not in only_ids:
            continue
        t = traits.get(f["id"]) or {}
        label, hint = shape_note(f["shape"], f["name"])
        hue = hue_of(f.get("body"))
        rows.append({
            "id": f["id"], "name": f["name"], "lat": (t.get("species") or "").strip(),
            "rar": f["rar"], "shape": f["shape"], "shapeCn": label, "shapeHint": hint,
            "form": (t.get("form") or "").strip(), "fins": (t.get("fins") or "").strip(),
            # 「条件筛选」的维度：钓场 / 体型（= shape + shapeCn）/ 稀有度 / 色相带
            "field": f.get("field") or "", "hue": hue,
            "hueBand": (hue // 30) if hue >= 0 else -1,
            "slots": morph_slots(f["id"], names),
        })
    rows.sort(key=lambda r: r["id"])
    return rows


TEMPLATE = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>卡片评审台 · 钓鱼人生</title>
<style>
  :root { --bg:#16171a; --card:#22242a; --line:#33363e; --fg:#e8e9ec; --dim:#9a9ea8;
          --ok:#3f9e6a; --bad:#c0503f; --accent:#5b8fd6; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:9; background:rgba(22,23,26,.96);
           border-bottom:1px solid var(--line); padding:10px 16px; }
  h1 { font-size:15px; font-weight:500; margin:0 0 6px; }
  .bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  /* 条件筛选行（2026-10-10）：把 362 条按「条件」收窄，一次只看一组。
     ⚠️ 选项的中文名全部由 Python 注入（`__FACET_*__`），页内不抄表。 */
  .flt { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; }
  .flt select { background:#2a2d34; color:var(--fg); border:1px solid var(--line);
                border-radius:6px; padding:4px 8px; font:inherit; cursor:pointer; }
  .flt select.on { border-color:var(--accent); color:#fff; }
  .flt .hit b { color:var(--accent); font-weight:600; }
  .flt .warn2 { color:#d8a657; }
  .prog { flex:1; min-width:180px; height:6px; background:#2a2d34; border-radius:3px; overflow:hidden; }
  .prog i { display:block; height:100%; background:var(--accent); width:0; }
  button { background:#2a2d34; color:var(--fg); border:1px solid var(--line);
           border-radius:6px; padding:5px 12px; font:inherit; cursor:pointer; }
  button:hover { border-color:#5a5f6b; }
  button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .stat { color:var(--dim); }
  .stat b { color:var(--fg); font-weight:500; }
  /* 存储不可用时的横幅（沙箱 iframe / 隐私模式）。默认不显示 ——
     但它必须存在且醒目：**不告诉用户，他刷新一下结果全没了还不知道**。 */
  #warn { display:none; margin-top:6px; padding:6px 10px; border-radius:6px; font-size:12px;
          background:rgba(192,80,63,.18); border:1px solid var(--bad); color:#f2dcd7; }
  #warn.on { display:block; }
  .grid { display:grid; gap:14px; padding:16px;
          grid-template-columns:repeat(auto-fill,minmax(430px,1fr)); }
  .c { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .c.ok  { border-color:var(--ok); }
  .c.bad { border-color:var(--bad); }
  .c > img { width:100%; display:block; background:#2b2b2e; aspect-ratio:3/2; object-fit:contain;
             cursor:zoom-in; }
  /* 可评审单元：**每张都要能看清**。
     原来缩略图写死 76px（用户口径 2026-10-08「其他版本的图太小了，不清晰」）——
     卡面原图是 1152×768、鱼只占中间一部分，76px 下连鳍都数不清。
     现在改成网格：一格里一张，缩略图占满格子宽（≈200px，是原来的 2.6 倍）；
     **点任意一张还能放大到原图**（见 #lb）。 */
  .slots { display:grid; grid-template-columns:repeat(auto-fit,minmax(185px,1fr));
           gap:8px; padding:8px; border-top:1px solid var(--line); }
  .slot { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#1d1f24; }
  .slot.ok  { border-color:var(--ok);  background:rgba(63,158,106,.14); }
  .slot.bad { border-color:var(--bad); background:rgba(192,80,63,.16); }
  .slot img { width:100%; display:block; background:#2b2b2e; aspect-ratio:3/2; object-fit:contain;
              cursor:zoom-in; }
  .sl-label { font-size:12px; padding:5px 8px 0; }
  .sl-acts { display:flex; gap:6px; padding:6px 8px 8px; }
  .sl-acts button { flex:1; min-width:0; padding:4px 0; }

  /* 放大层：评审要靠它看清细节，所以放到「能到 1:1」为止（1152×768 在 1440 屏上基本是原尺寸） */
  #lb { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.9); display:none;
        align-items:center; justify-content:center; cursor:zoom-out; }
  #lb.on { display:flex; }
  #lb img { max-width:97vw; max-height:90vh; object-fit:contain; background:#2b2b2e; }
  #lb .lb-tip { position:absolute; left:0; right:0; bottom:14px; text-align:center;
                color:#c9cdd5; font-size:12px; }
  .m { padding:8px 10px 10px; }
  .nm { font-size:15px; font-weight:500; }
  .nm span { color:var(--dim); font-weight:400; font-size:12px; margin-left:6px; }
  /* 形态模板：中文标签 + 内部键（键保留可核对，但不再裸印 —— 它以前看着像脏数据） */
  .nm span code { background:#16171a; color:#aeb3bd; padding:0 4px; border-radius:3px;
                  font-size:11px; margin-left:4px; }
  .nm span b.hint { color:#e0b25c; font-weight:500; margin-left:6px; cursor:help; }
  .lat { color:var(--dim); font-size:12px; font-style:italic; min-height:18px; }
  details { margin:6px 0 0; }
  summary { color:var(--dim); font-size:12px; cursor:pointer; }
  details p { color:var(--dim); font-size:12px; margin:4px 0 0; }
  .acts { display:flex; gap:8px; margin-top:10px; }
  .acts button { flex:1; }
  .acts .b-ok.on  { background:var(--ok);  border-color:var(--ok);  color:#fff; }
  .acts .b-bad.on { background:var(--bad); border-color:var(--bad); color:#fff; }
  .acts .b-go { flex:0 0 auto; }
  .empty { padding:40px 16px; color:var(--dim); }
  dialog { background:var(--card); color:var(--fg); border:1px solid var(--line);
           border-radius:10px; max-width:640px; width:92%; }
  dialog textarea { width:100%; height:190px; background:#16171a; color:var(--fg);
                    border:1px solid var(--line); border-radius:6px; padding:8px;
                    font:12px/1.5 Consolas,monospace; }
  dialog h2 { font-size:14px; font-weight:500; margin:0 0 8px; }
  dialog p { color:var(--dim); font-size:12px; margin:8px 0; }
  code { background:#16171a; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>卡片评审台 —— 逐条看「画的到底是不是这个物种」</h1>
  <div class="bar">
    <span class="stat">进度 <b id="s-done">0</b>/<b id="s-all">0</b></span>
    <span class="prog"><i id="s-bar"></i></span>
    <span class="stat">合格 <b id="s-ok">0</b> · 重出 <b id="s-bad">0</b></span>
    <button id="f-all" class="on">全部</button>
    <button id="f-pend">未审</button>
    <button id="f-bad">重出</button>
    <button id="exp">导出重出清单</button>
    <button id="rst">清空</button>
    <span class="stat">快捷键：1=合格　2=重出　·　点图放大　·　<span id="runState">检查本地运行器…</span></span>
  </div>
  <div class="flt">
    <span class="stat">按条件筛：</span>
    <select id="q-field"><option value="">全部钓场</option>__FACET_FIELD__</select>
    <select id="q-shape"><option value="">全部体型</option>__FACET_SHAPE__</select>
    <select id="q-rar"><option value="">全部稀有度</option>__FACET_RAR__</select>
    <select id="q-hue"><option value="">全部色相</option>__FACET_HUE__</select>
    <span class="hit">命中 <b id="flt-hit">0</b> / <b id="flt-all">0</b> 条</span>
    <span class="stat" id="flt-note"></span>
    <button id="f-clr">清空条件</button>
  </div>
  <div id="warn"></div>
  <div class="stat" style="margin-top:4px">图片若显示不出来：请用「项目根目录起 http 服务」的方式打开本页（<code>python -m http.server 8765</code> → <code>127.0.0.1:8765/docs/卡片评审.html</code>）。
    想**点一下就直接重出**：双击 <code>tools\评审台.cmd</code>（起本地运行器并自动开浏览器，三种跑法都解锁）。</div>
</header>
<div class="grid" id="grid"></div>

<div id="lb"><img alt=""><div class="lb-tip">点任意处关闭（Esc 也可以）</div></div>

<dialog id="dlg">
  <h2 id="dlgTitle">重出清单（**按单档**给）</h2>
  <p id="dlgTip">五档**是独立文生图**（2026-10-07 起，曾走图生图已弃用），所以**可以只重出其中一张**；
     母版重出会顺带刷新它的 <code>-normal</code>（原色档就是母版抠图）。</p>
  <textarea id="out" readonly></textarea>
  <p id="cmds"></p>
  <div class="acts">
    <button id="cp">复制</button>
    <button id="runWin" disabled>在窗口里开跑（推荐）</button>
    <button id="run" disabled>后台跑</button>
    <button id="close">关闭</button>
  </div>
  <p style="margin-top:6px">
    <label class="stat"><input type="checkbox" id="dryWin"> 先干跑一遍（只打印提示词、不出图，约几秒）</label>
  </p>
  <p>「在窗口里开跑」会**新开一个控制台窗口**跑这些卡（看得见进度、随时关窗口就停，
     不随 AI 会话被回收）；跑完回这一页点下面那个按钮刷图。<br>
     想「**继续补还没出过的**卡」（整批续跑、不是重出标记的这些）→
     <button id="runLoop" disabled style="padding:2px 8px;font-size:12px">打开 gen-art-loop.cmd</button></p>
  <div id="winNote" style="display:none;margin-top:8px;padding:8px 10px;border-radius:6px;
       background:rgba(91,143,214,.14);border:1px solid var(--accent)">
    <span id="winNoteTxt"></span>
    <button id="winDone" style="margin-left:8px">我已跑完 → 刷新图片并清结论</button>
  </div>
</dialog>

<script>
var DATA = __DATA__;
/* `--serve` 打开本页时这里会被换成真 token；静态打开时是空串（运行器也不在）。 */
var TOKEN = '__TOKEN__';
/* 重出之后设成 `?t=…` —— 否则浏览器会把旧图从缓存里拿出来，看着像「没重出」 */
var CACHE_BUST = '';
/* 档位中文名的**唯一来源是 Python 侧的 slot.label / slot.morphLabel**（`MORPH_CN`）。
   这里只建索引，**不另抄一份** —— 抄一份的下场是重出清单里印出英文档名 / 印错版号，
   而且源码扫描看不出来（verify 第 ㊹ 节 ② 专门盯这一条）。 */
var SLOT_LABEL = {}, MORPH_LABEL = {};
DATA.forEach(function (d) { d.slots.forEach(function (s) {
  SLOT_LABEL[s.k] = s.label;
  MORPH_LABEL[s.morph] = s.morphLabel;
}); });
/* v2：状态从「一条鱼一个结论」改成「一条鱼 × **每一档**一个结论」。
   换 key 是为了不把新旧两种结构混在同一个键里。 */
var KEY = 'fishcard-review-v2';
var OLD_KEY = 'fishcard-review-v1';
var state = {};
var memOnly = false;    // localStorage 用不了时退回「只在本页存」（见 save 的注释）

function readStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
try { state = JSON.parse(readStore(KEY) || '{}'); } catch (e) { state = {}; }
/* 迁移：老状态是 `{id:'ok'|'bad'}`（整条鱼一个结论）→ 展开到它的每一档，
   以前审过的结论不白丢。 */
try {
  var older = JSON.parse(readStore(OLD_KEY) || '{}');
  var byId = {};
  DATA.forEach(function (d) { byId[d.id] = d; });
  Object.keys(older).forEach(function (id) {
    if (!older[id] || !byId[id]) return;
    state[id] = state[id] || {};
    byId[id].slots.forEach(function (s) { if (!state[id][s.k]) state[id][s.k] = older[id]; });
  });
} catch (e) { /* 老状态坏了不影响使用 */ }
var filter = 'all';

/* 🔴 条件筛选（2026-10-10，用户口径：「你可以在图鉴和我的审图合格不合格上加条件赛选，
   比如可以筛选同一个条件下的所有鱼，我来标记要重出」）。
   为什么要有它：出图跑完之后人肉一屏一屏翻，**看不出哪些鱼长得像** ——
   实测 362 条里「通用鱼形」占 66%，而 SS 场「通用鱼形 + 蓝色相」那一格就挤了 29 条。
   ⇒ 按 钓场 / 体型 / 稀有度 / 色相带 四个条件收窄，一次只比一组。
   ⚠️ 选项中文名全部由 Python 侧注入（`__FACET_*__`）；页内**不抄中文表**
      （那是第二份真相，本项目反复栽过），摘要文字直接读 `<option>` 的文本。 */
var FLT = { field: '', shape: '', rar: '', hue: '' };
function facetMatch(d) {
  if (FLT.field && d.field !== FLT.field) return false;
  if (FLT.shape && d.shape !== FLT.shape) return false;
  if (FLT.rar !== '' && String(d.rar) !== FLT.rar) return false;
  if (FLT.hue !== '' && String(d.hueBand) !== FLT.hue) return false;
  return true;
}
function fltActive() {
  return !!(FLT.field || FLT.shape || FLT.rar !== '' || FLT.hue !== '');
}
/* 状态（全部/未审/重出）与条件是**两条独立的轴**，两边都要过。 */
function statusMatch(d) {
  if (filter === 'pending' && isDone(d)) return false;
  if (filter === 'bad' && !isBad(d)) return false;
  return true;
}
function selText(id) {
  var s = document.getElementById(id);
  if (!s) return '';
  return s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
}
/* 条件写进 URL hash：可收藏、可贴给别人（`#f=SS,fish,,8`）。存不进去也不影响筛选本身。 */
function syncFlt() {
  try {
    var next = fltActive() ? '#f=' + [FLT.field, FLT.shape, FLT.rar, FLT.hue].join(',') : '#';
    if (location.hash !== next) history.replaceState(null, '', next);
  } catch (e) { /* 沙箱里可能不让改 */ }
}
function readFlt() {
  try {
    var m = /(?:^|[#&])f=([^&]*)/.exec(location.hash || '');
    if (!m) return;
    var p = decodeURIComponent(m[1]).split(',');
    FLT.field = p[0] || ''; FLT.shape = p[1] || ''; FLT.rar = p[2] || ''; FLT.hue = p[3] || '';
  } catch (e) { /* hash 坏了就当没筛 */ }
}
function paintFlt() {
  document.getElementById('q-field').value = FLT.field;
  document.getElementById('q-shape').value = FLT.shape;
  document.getElementById('q-rar').value = FLT.rar;
  document.getElementById('q-hue').value = FLT.hue;
  ['q-field', 'q-shape', 'q-rar', 'q-hue'].forEach(function (id) {
    document.getElementById(id).classList.toggle('on', !!document.getElementById(id).value);
  });
  var parts = [selText('q-field'), selText('q-shape'), selText('q-rar'), selText('q-hue')]
    .filter(function (x) { return x; });
  document.getElementById('flt-note').textContent = parts.length
    ? '只看：' + parts.join(' · ') : '';
}
function updateFilt() {
  var hit = 0;
  DATA.forEach(function (d) { if (facetMatch(d) && statusMatch(d)) hit++; });
  document.getElementById('flt-hit').textContent = hit;
  document.getElementById('flt-all').textContent = DATA.length;
}

/* 🔴 `save()` **绝不许抛**。
   踩过（2026-10-08 用户报「我点了重出后咋没用」）：预览面板把本页放在**沙箱 iframe** 里，
   那里 `localStorage.setItem` 会抛 SecurityError；而 save() 原来排在
   `paintCard()/updateStats()` **之前** —— 异常把整个点击处理中断，
   于是「点了完全没反应」，连按钮高亮都没有，控制台只有一条 SecurityError。
   现在两条防线：
     ① 存不进去就退回「只在本页有效」，**并且显式告诉用户**（否则刷新一下全没了还不知道）；
     ② 调用点一律**先把结果画出来、最后才落盘**（见点击处理）。 */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    if (!memOnly) { memOnly = true; showMemWarning(); }
    return false;
  }
}

function showMemWarning() {
  var w = document.getElementById('warn');
  if (!w) return;
  w.className = 'on';
  w.innerHTML = '⚠️ <b>本页的存储不可用</b>（浏览器沙箱 / 隐私模式 / 无痕）：'
    + '你判的结果<b>只在本页有效，刷新就没了</b>。'
    + '请随时点「导出重出清单」把结果复制走（那个功能不依赖存储）。';
}
function verdict(d, k) { return ((state[d.id] || {})[k]) || ''; }
function verdicts(d) { return d.slots.map(function (s) { return verdict(d, s.k); }); }
function isDone(d) { return verdicts(d).every(function (v) { return !!v; }); }
function isBad(d) { return verdicts(d).indexOf('bad') >= 0; }

/* 形态模板那一格怎么印。
   ⚠️ 这里**只拼字符串**：标签中文名与交叉提示都由 Python 侧算好（`shape_note()` 是唯一真相），
      页内 JS **不许**再写第二份 键→中文 的映射表（写两份必然分家）。
   为什么要改：原来直接把内部键印出来（`A03 · 稀有 · fish`），第一眼看像占位符 / 脏数据。
   提示（`d.shapeHint`）是**提示**不是判定 —— 模板是画法不是分类，八爪鱼用 squid 模板是合理的，
   所以不能报错，只能提醒人看一眼。 */
function shapeTag(d) {
  var t = '形态模板：' + d.shapeCn + '<code>' + d.shape + '</code>';
  if (d.shapeHint) t += '<b class="hint" title="只是提示，不是错误：模板是画法不是分类，判定仍由你点">⚠ ' + d.shapeHint + '</b>';
  return t;
}

function render() {
  var g = document.getElementById('grid');
  g.innerHTML = '';
  var shown = 0;
  DATA.forEach(function (d) {
    if (!statusMatch(d)) return;      // 状态轴（全部 / 未审 / 重出）
    if (!facetMatch(d)) return;       // 条件轴（钓场 / 体型 / 稀有度 / 色相带）
    shown++;
    var el = document.createElement('div');
    el.className = 'c' + (isDone(d) ? ' ok' : '') + (isBad(d) ? ' bad' : '');
    el.setAttribute('data-id', d.id);
    var h = '<img src="../assets/cards/' + d.id + '.png' + CACHE_BUST + '" loading="lazy">';
    h += '<div class="slots">';
    d.slots.forEach(function (s) {
      var v = verdict(d, s.k);
      h += '<div class="slot' + (v ? ' ' + v : '') + '">' +
           '<img src="../assets/cards/' + s.file + CACHE_BUST + '" loading="lazy">' +
           '<div class="sl-label">' + s.label + '</div>' +
           '<div class="sl-acts">' +
             '<button class="b-ok' + (v === 'ok' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="ok" title="记下这张没问题">合格</button>' +
             '<button class="b-bad' + (v === 'bad' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="bad" title="记下这张要重出（**不会立刻重出** —— 之后点「导出重出清单」拿命令去跑）">重出</button>' +
           '</div></div>';
    });
    h += '</div>';
    h += '<div class="m"><div class="nm">' + d.name +
         '<span>' + d.id + ' · ' + d.rarCn + ' · ' + shapeTag(d) + '</span></div>' +
         '<div class="lat">' + (d.lat || '') + '</div>';
    if (d.form || d.fins) {
      h += '<details><summary>形态描述（提示词里用的）</summary><p>' +
           (d.form || '') + (d.fins ? '<br>' + d.fins : '') + '</p></details>';
    }
    h += '<div class="acts">' +
         '<button class="b-go" data-go="' + d.name + '">对照百科</button>' +
         '</div></div>';
    el.innerHTML = h;
    g.appendChild(el);
  });
  if (!shown) {
    var e = document.createElement('div');
    e.className = 'empty';
    e.textContent = fltActive() ? '这个条件下没有卡片 —— 换个条件，或点「清空条件」。'
                               : '这个筛选下没有卡片。';
    g.appendChild(e);
  }
  updateFilt();
  updateStats();
}

function updateStats() {
  var done = 0, ok = 0, bad = 0, all = 0;
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      all++;
      var v = verdict(d, s.k);
      if (!v) return;
      done++;
      if (v === 'ok') ok++; else bad++;
    });
  });
  document.getElementById('s-done').textContent = done;
  document.getElementById('s-all').textContent = all;
  document.getElementById('s-ok').textContent = ok;
  document.getElementById('s-bad').textContent = bad;
  document.getElementById('s-bar').style.width = (all ? done * 100 / all : 0) + '%';
}

/* 只改这一张卡 —— **不要整页重绘**：122 张图重新建元素会全部重新解码、屏幕闪一下，
   而且滚动位置也会跳。筛选/清空才走 render()。 */
function paintCard(id) {
  var el = document.querySelector('.c[data-id="' + id + '"]');
  if (!el) return;
  var d = null;
  DATA.forEach(function (x) { if (x.id === id) d = x; });
  if (!d) return;
  el.className = 'c' + (isDone(d) ? ' ok' : '') + (isBad(d) ? ' bad' : '');
  var boxes = el.querySelectorAll('.slot');
  d.slots.forEach(function (s, i) {
    var v = verdict(d, s.k);
    if (!boxes[i]) return;
    boxes[i].className = 'slot' + (v ? ' ' + v : '');
    boxes[i].querySelector('.b-ok').classList.toggle('on', v === 'ok');
    boxes[i].querySelector('.b-bad').classList.toggle('on', v === 'bad');
  });
}

/* 点任意一张图 → 放大到原图。
   缩略图再大也不够用（用户口径 2026-10-08「其他版本的图太小了，不清晰」）：
   卡面是 1152×768、鱼只占中间一块，评审要判断「头身是不是一个色」这种细节，
   必须能放到接近 1:1。放大层铺满视口，点任意处或 Esc 关闭。 */
var lb = document.getElementById('lb'), lbImg = lb.querySelector('img');
function zoom(src) { lbImg.src = src; lb.classList.add('on'); }
function unzoom() { lb.classList.remove('on'); lbImg.removeAttribute('src'); }
lb.addEventListener('click', unzoom);

document.getElementById('grid').addEventListener('click', function (ev) {
  var b = ev.target.closest('button');
  if (!b) {
    var im = ev.target.closest('img');
    if (im) zoom(im.src);
    return;
  }
  if (b.dataset.go) {
    window.open('https://www.bing.com/search?q=' + encodeURIComponent(b.dataset.go + ' 鱼 形态特征'), '_blank');
    return;
  }
  var id = b.dataset.id, k = b.dataset.k, v = b.dataset.v;
  if (!id || !k) return;
  state[id] = state[id] || {};
  state[id][k] = (state[id][k] === v) ? '' : v;
  if (!state[id][k]) delete state[id][k];
  /* 顺序很重要：**先把结果画出来，最后才落盘** —— 落盘失败也不能让「点了像没反应」。 */
  paintCard(id); updateStats(); save();
});

['all', 'pend', 'bad'].forEach(function (k) {
  var idmap = { all: 'f-all', pend: 'f-pend', bad: 'f-bad' };
  document.getElementById(idmap[k]).onclick = function () {
    filter = k === 'all' ? 'all' : (k === 'pend' ? 'pending' : 'bad');
    ['f-all', 'f-pend', 'f-bad'].forEach(function (x) {
      document.getElementById(x).classList.toggle('on', x === idmap[k]);
    });
    render();
  };
});

/* 条件筛选的四个下拉 + 「清空条件」。
   ⚠️ 只重绘网格（条件变了整页要重排），并把条件同步进 URL hash。 */
[['q-field', 'field'], ['q-shape', 'shape'], ['q-rar', 'rar'], ['q-hue', 'hue']]
  .forEach(function (pair) {
    document.getElementById(pair[0]).onchange = function () {
      FLT[pair[1]] = this.value;
      paintFlt(); syncFlt(); render();
    };
  });
document.getElementById('f-clr').onclick = function () {
  FLT.field = FLT.shape = FLT.rar = FLT.hue = '';
  paintFlt(); syncFlt(); render();
};

document.getElementById('rst').onclick = function () {
  if (confirm('清空全部评审记录？')) { state = {}; save(); render(); }
};

document.getElementById('exp').onclick = function () {
  /* 分组粒度 = **档**（`s.morph`），不是槽位键 —— 重出命令就是按档给的：
     标记「闪光·第2版」跑的是 `--only-morph shiny`，会把该档的每一版一起重出。
     所以同一档被标记了多版时，id 只列一次（否则命令行里会出现 `D16,D16`）。 */
  var by = {}, okN = 0, pendN = 0, allN = 0, order = [];
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      if (order.indexOf(s.morph) < 0) order.push(s.morph);
      allN++;
      var v = verdict(d, s.k);
      if (v === 'ok') okN++;
      if (!v) pendN++;
      if (v === 'bad') {
        var g = by[s.morph] = by[s.morph] || [];
        if (g.indexOf(d.id) < 0) g.push(d.id);
      }
    });
  });
  var keys = order.filter(function (k) { return by[k] && by[k].length; });
  var total = keys.reduce(function (a, k) { return a + by[k].length; }, 0);
  var L = ['# 重出清单：' + total + ' 张（**按单档给**，可以直接执行）',
           '# 五档是独立文生图（2026-10-07 起；曾走图生图，已弃用）⇒ 可以只重出其中一张。',
           '# 分组粒度是**档**：某一档出了多版（如传说闪光有第 2 版）时，',
           '#   这条命令会把该档的每一版一起重出 —— 重出完页面上那几版都要重审。',
           '# 母版那一行会顺带刷新 <id>-normal.png（原色档就是母版抠图）；',
           '# 五档单张重出**不动**别的档。'];
  L.push('');
  keys.forEach(function (k) {
    var ids = by[k].slice().sort();
    L.push('# ' + (MORPH_LABEL[k] || k) + '（' + ids.length + ' 张）');
    L.push('python tools/gen-art.py --list ' + ids.join(',') +
           (k === 'master' ? '' : ' --only-morph ' + k));
    L.push('');
  });
  L.push('# 未判 ' + pendN + ' / 已合格 ' + okN + '（共 ' + allN + ' 个可评审单元）');
  L.push('#');
  L.push('# 另一种更省事的做法：若你只想「把口径改过的卡全部重出」，不用逐条审 ——');
  L.push('#   python tools/gen-art.py --stale');
  L.push('# 它拿当前生成器**现算**提示词去和 manifest 比，直接列出过期的那些（判据不会过期）。');
  document.getElementById('out').value = total ? L.join('\\n') : '（还没有标记为「重出」的）';
  document.getElementById('cmds').innerHTML = total
    ? '把上面 <code>python tools/gen-art.py ⋯</code> 那些行原样跑一遍即可。'
    : '';
  document.getElementById('dlg').showModal();
};

/* =========================================================
   本地运行器：让「重出」真的能跑（用户口径 2026-10-08）
   =========================================================
   页面是静态 HTML，浏览器里**跑不了 python**。要直接跑，得用
   `python tools/review-cards.py --serve` 打开本页 —— 那个小服务提供 `/api/regen`。
   静态打开（file:// 或普通 http.server）时探不到运行器 ⇒ 按钮置灰，只能用「复制」。 */
var RUNNER = false;

function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'X-Token': TOKEN }, opt.headers || {});
  return fetch(path, opt);
}

function runnerNote(txt) { document.getElementById('runState').textContent = txt; }

/* 三种跑法都得跟着运行器在不在 —— 静态打开时**全部置灰**并说明原因，
   否则就是「点了没反应」（这个坑 2026-10-08 已经栽过一次）。 */
var RUN_BTNS = ['runWin', 'run', 'runLoop'];

function setRunner(on) {
  RUNNER = on;
  RUN_BTNS.forEach(function (id) {
    var b = document.getElementById(id);
    b.disabled = !on;
    if (!on) { b.title = '要在「本地运行器」里打开本页才能用（见页面顶部说明）'; }
  });
  document.getElementById('runWin').textContent = on ? '在窗口里开跑（推荐）' : '在窗口里开跑（未连接运行器）';
  document.getElementById('run').textContent = on ? '后台跑' : '后台跑（未连接）';
  runnerNote(on ? '本地运行器：已连接 —— 三种跑法都能用'
                : '本地运行器：未连接 —— 只能「复制」命令去别处跑');
}

api('/api/ping').then(function (r) { return r.ok ? r.json() : null; })
  .then(function (j) { setRunner(!!(j && j.ok)); })
  .catch(function () { setRunner(false); });

/* 把当前标成「重出」的收成 [{morph, ids}] 交给运行器。
   粒度 = **档**（`s.morph`）：`clean_groups()` 的白名单只认档名，
   `--only-morph` 也只认档名 —— 送槽位键（`shiny-2`）过去会被当成「不认识的档名」拒掉，
   表现是「点了没反应 / 弹一句没能开跑」。 */
function collectGroups() {
  var by = {}, order = [];
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      if (order.indexOf(s.morph) < 0) order.push(s.morph);
      if (verdict(d, s.k) === 'bad') {
        var g = by[s.morph] = by[s.morph] || [];
        if (g.indexOf(d.id) < 0) g.push(d.id);
      }
    });
  });
  return order.filter(function (k) { return by[k] && by[k].length; })
              .map(function (k) { return { morph: k, ids: by[k].slice().sort() }; });
}

function markedTotal(groups) {
  return groups.reduce(function (a, g) { return a + g.ids.length; }, 0);
}

function markedTip(groups) {
  return groups.map(function (g) {
    return '· ' + (MORPH_LABEL[g.morph] || g.morph) + '：' + g.ids.join(' ');
  }).join('\\n');
}

function showWinNote(txt) {
  document.getElementById('winNote').style.display = '';
  document.getElementById('winNoteTxt').textContent = txt;
}

/* 刷图 = ① 加时间戳绕开缓存（否则浏览器把旧图拿出来，看着像「没重出」）
         ② 清掉这些档的「重出」结论 —— 新图必须重新审
   为什么按**档**清而不是按「被标记的那一版」清：重出命令的粒度就是档
   （`--only-morph shiny` 会把该档每一版一起重出）⇒ 只清被标记的那一版，
   会留下一张**已经换了图、结论却还是旧图**的槽位。 */
function refreshImages() {
  CACHE_BUST = '?t=' + Date.now();
  DATA.forEach(function (d) {
    if (!state[d.id]) return;
    var hit = {};
    d.slots.forEach(function (s) { if (state[d.id][s.k] === 'bad') hit[s.morph] = 1; });
    d.slots.forEach(function (s) { if (hit[s.morph]) delete state[d.id][s.k]; });
    if (!Object.keys(state[d.id]).length) delete state[d.id];
  });
  render(); save();
}

document.getElementById('winDone').onclick = function () {
  refreshImages();
  document.getElementById('dlgTitle').textContent = '已刷新';
  document.getElementById('dlgTip').innerHTML = '图已按新文件重取、这些档的结论已清空 —— '
    + '**请重新审这几张**。旧图在 <code>assets/cards/_superseded/</code> 下按本轮时间戳归档。';
};

function pollJob() {
  api('/api/job').then(function (r) { return r.json(); }).then(function (j) {
    var out = document.getElementById('out');
    out.value = (j.log || []).join('\\n');
    out.scrollTop = out.scrollHeight;
    document.getElementById('cmds').innerHTML = (j.running ? '⏳ 正在重出　' : '✅ 跑完　')
      + j.done + ' / ' + j.total + ' 张　（成功 ' + j.ok + ' · 失败 ' + j.fail + '）'
      + (j.cur ? '　当前：' + j.cur : '');
    if (j.running) setTimeout(pollJob, 1200); else onJobDone(j);
  }).catch(function () { setTimeout(pollJob, 2000); });
}

function onJobDone(j) {
  if (!j.ok) return;
  refreshImages();
  document.getElementById('dlgTitle').textContent = '重出完成';
  document.getElementById('dlgTip').innerHTML = '跑完了 ' + j.ok + ' 张（失败 ' + j.fail + '）。'
    + '页面的图已刷新、结论已清空 —— **请重新审这几张**。'
    + '旧图在 <code>assets/cards/_superseded/</code> 下按本轮时间戳归档。';
}

function postRegen(body, onOk) {
  api('/api/regen', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res.ok) { alert('没能开跑：' + (res.msg || '未知原因')); return; }
    onOk(res);
  }).catch(function (e) { alert('连不上运行器：' + e); });
}

function noMark() {
  alert('还没有把任何一张标成「重出」——先在卡片上点「重出」再来。');
}

/* ① 在窗口里开跑：新开一个**用户自己的**控制台窗口（用户口径 2026-10-08）。
   为什么这条路更靠谱：AI 会话起的进程会随回合结束被回收（tools/gen-art-loop.cmd
   开头那段备注就是这个结论），而生图是几十分钟量级 —— 看得见进度、能随时关掉。 */
document.getElementById('runWin').onclick = function () {
  var groups = collectGroups(), total = markedTotal(groups);
  if (!total) { noMark(); return; }
  var dry = document.getElementById('dryWin').checked;
  if (!confirm('要在**新窗口**里' + (dry ? '干跑' : '重出') + '这 ' + total + ' 张吗？\\n\\n'
      + markedTip(groups)
      + '\\n\\n' + (dry ? '干跑：只打印提示词、**不出图**，几秒就完。'
                       : '每张约 50 秒（共约 ' + Math.max(1, Math.round(total * 50 / 60)) + ' 分钟）。')
      + '\\n旧图**不会**被覆盖，会移进 assets/cards/_superseded/<本轮时间戳>/。\\n'
      + '窗口归你：关掉它就停，跑完的图会留下。')) return;
  document.getElementById('out').value = '正在生成窗口脚本…';
  postRegen({ mode: 'window', groups: groups, dry: dry }, function (res) {
    document.getElementById('dlgTitle').textContent = dry ? '已开窗口（干跑）' : '已开窗口，正在跑…';
    document.getElementById('dlgTip').innerHTML = dry
      ? '窗口里只打印提示词，不会出图。看完关掉即可。'
      : '跑到哪一张窗口里实时可见；**关掉窗口就停**。跑完回这一页点下面那个按钮刷图。';
    document.getElementById('out').value =
      '窗口脚本（这个文件可以双击重跑）：\\n' + res.script
      + '\\n\\n' + (res.dry ? '（干跑模式）' : '')
      + '下面是这批的口径 —— 与窗口里跑的是同一条命令：\\n'
      + groups.map(function (g) {
          return 'gen-art.py --list ' + g.ids.join(',')
               + (g.morph === 'master' ? '' : ' --only-morph ' + g.morph);
        }).join('\\n');
    showWinNote(dry ? '干跑窗口已打开（不出图）——看完提示词关掉它就行。'
                    : '窗口里在跑 ' + res.total + ' 张（约 '
                      + Math.max(1, Math.round(res.total * 50 / 60)) + ' 分钟）。跑完回来点右边按钮。');
    if (res.rejected && res.rejected.length) {
      alert('有 ' + res.rejected.length + ' 项被拒（不合法的 id / 档名）：\\n' + res.rejected.join('\\n'));
    }
  });
};

/* ② 后台跑：服务里跑，页面轮询日志、跑完自动刷图（不用切窗口；但关掉服务窗就断） */
document.getElementById('run').onclick = function () {
  var groups = collectGroups(), total = markedTotal(groups);
  if (!total) { noMark(); return; }
  if (!confirm('要在**后台**跑这 ' + total + ' 张吗？（不弹窗，日志显示在这里）\\n\\n'
      + markedTip(groups)
      + '\\n\\n每张约 50 秒；旧图**不会**被覆盖，会移进 assets/cards/_superseded/<本轮时间戳>/。\\n'
      + '跑完这些档的结论会被清掉，等你重新审。\\n'
      + '⚠️ 关掉运行器窗口会把这一轮一起带走 —— 要稳就用「在窗口里开跑」。')) return;
  document.getElementById('dlgTitle').textContent = '正在重出…';
  document.getElementById('dlgTip').innerHTML = '每张约 50 秒，可以放着不管；跑完会自动刷新图片。';
  document.getElementById('out').value = '正在启动…';
  postRegen({ mode: 'bg', groups: groups }, function () { pollJob(); });
};

/* ③ 打开 gen-art-loop.cmd：那是 `--skip-existing` 的**整批续跑**，
   补的是「还没出过的」——**不会**重出你标记的这些（它们已经存在）。 */
document.getElementById('runLoop').onclick = function () {
  if (!confirm('打开 tools/gen-art-loop.cmd？\\n\\n'
      + '⚠️ 它是 `--skip-existing` 的**整批续跑**：只补「**还没出过**」的卡，\\n'
      + '不会重出你已经标记的这些（它们已经存在、会被跳过）。\\n\\n'
      + '要重出标记的这些 → 用「在窗口里开跑」。\\n'
      + '要顺手把整批没出完的补上 → 就是它。\\n\\n确定打开？')) return;
  postRegen({ mode: 'loop' }, function () {
    document.getElementById('dlgTitle').textContent = '已打开 gen-art-loop.cmd';
    document.getElementById('dlgTip').innerHTML = '整批续跑已在**新窗口**里开始（补还没出过的卡）。'
      + '关掉那个窗口就停。它**不会**动你标记的这些 —— 那些用左边的按钮。';
    showWinNote('gen-art-loop.cmd 窗口已打开（整批续跑）。');
  });
};

document.getElementById('close').onclick = function () { document.getElementById('dlg').close(); };document.getElementById('cp').onclick = function () {
  var t = document.getElementById('out');
  t.select(); document.execCommand('copy');
};

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && lb.classList.contains('on')) { unzoom(); return; }
  if (e.key === '1' || e.key === 'y') { var b = document.querySelector('.b-ok:not(.on)'); if (b) b.click(); }
  if (e.key === '2' || e.key === 'n') { var c = document.querySelector('.b-bad:not(.on)'); if (c) c.click(); }
});

DATA.forEach(function (d) { d.rarCn = d.rarCn || ''; });
readFlt();      // 先读 URL hash（可收藏 / 可贴给别人的那个「条件」）
paintFlt();
render();
</script>
</body>
</html>
"""


def check_inline_js(html):
    """生成物自带语法门禁：把页内 <script> 抠出来，交给 node --check 真跑一遍。

    为什么必须有（回归 2026-10-08，用户报「咋现在卡片评审台打不开了？」）：
      `TEMPLATE` 是 Python 三引号**非 raw** 字符串，所以页内 JS 里写的 `'\\n'`
      会被 Python **提前**解释成真换行 —— 字符串字面量被截断成跨行，
      整段 `<script>` 语法失效，浏览器打开就是一片空白（且不报任何服务端错误）。
      这个坑在**写完文件、打开浏览器之前完全看不出来**，只能真 check 一遍才拦得住。
      教训：拼装 HTML 的工具，落盘前必须验一遍产物的脚本语法。
    """
    node = shutil.which("node")
    if not node:
        return          # 没有 node 就别把工具链卡死（本项目门禁本来就依赖 node）
    blocks = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    tmpdir = os.path.join(ROOT, "_tmp")
    if not os.path.isdir(tmpdir):
        os.makedirs(tmpdir)
    for i, code in enumerate(blocks):
        tmp = os.path.join(tmpdir, "inline-js-%d.js" % i)
        io.open(tmp, "w", encoding="utf-8", newline="\n").write(code)
        p = subprocess.run([node, "--check", tmp], capture_output=True, text=True)
        if p.returncode:
            lines = code.split("\n")
            m = re.search(r"inline-js-\d+\.js:(\d+)", p.stderr or "")
            ln = int(m.group(1)) if m else 0
            raise SystemExit(
                "✘ 页内脚本第 %d 段有语法错误 —— **拒绝写出**（写成空白页更糟）。\n"
                "  大概位置：第 %d 行\n     %s\n%s"
                % (i + 1, ln, (lines[ln - 1].strip() if 0 < ln <= len(lines) else "?"),
                   (p.stderr or "").strip()[:600]))
        os.remove(tmp)


def build_page(only):
    """把评审页拼出来 —— 写文件与 `--serve` 共用同一份口径。"""
    rows = build_rows(only)
    for r in rows:
        r["rarCn"] = RAR_CN[min(3, r["rar"])]
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    # 分面选项只列**本页真出现过**的取值：列出来却一条都筛不到 = 死选项（没人会去点）
    # ⚠️ 钓场的顺序走 `fields.js` 自己的顺序（由近及远），不按字母排 ——
    #    `A` 其实是**最深**的那个场，按字母排会把顺序整个讲反。
    seen_f = set(r["field"] for r in rows if r["field"])
    flds = [k for k, _n in load_fields() if k in seen_f]
    shps = sorted(set(r["shape"] for r in rows if r["shape"] in SHAPE_CN))
    bands = sorted(set(r["hueBand"] for r in rows if r["hueBand"] >= 0))
    facets = {
        "__FACET_FIELD__": facet_options([(x, FIELD_CN.get(x, x)) for x in flds]),
        "__FACET_SHAPE__": facet_options([(k, SHAPE_CN[k]) for k in shps]),
        "__FACET_RAR__": facet_options([(str(i), RAR_CN[i])
                                        for i in sorted(set(r["rar"] for r in rows))]),
        "__FACET_HUE__": facet_options([(str(b), u"%s %d~%d°" % (cn, lo, hi))
                                        for b, cn, lo, hi in HUE_BANDS if b in bands]),
    }
    html = TEMPLATE
    for k, v in facets.items():
        html = html.replace(k, v)
    html = html.replace("__DATA__", data)
    check_inline_js(html)
    return html, len(rows)


# ======================= 重出：命令口径 + 两种跑法 =======================
# 用户口径 2026-10-08：「你就不能让我点击后自动打开 gen-art-loop.cmd 重新生图吗」。
# ⇒ 页面上的按钮要能**真的把生图开起来**，而且要开在**用户自己拥有的窗口**里：
#    `tools/gen-art-loop.cmd` 开头那段备注就是这个结论（AI 会话起的进程会随回合结束
#    被回收），而生图是几十分钟量级 —— 看得见进度、能随时 Ctrl-C 比页面轮询踏实。
#
# 两种跑法共用**同一条命令口径**（`regen_argv`）：
#   · 后台跑（`mode:"bg"`）  ：服务里开线程逐个跑子进程，页面轮询日志、跑完自动刷图
#   · 窗口跑（`mode:"window"`）：写一个 .cmd（可双击重跑），`startfile` 开新控制台窗口
# 口径要是分家，「页面显示的命令」和「真的跑的命令」就是两回事 —— 本项目最忌这个。

# `MORPH_KEYS`（档位白名单，`clean_groups()` 用它挡「凭猜写进命令行」）定义在文件头部
# —— 与 `MORPH_CN` 挨着，两处只有一个来源。⚠️ 它**不含** `shiny-2` 这类多版槽位键：
#   重出命令的粒度是**档**（`--only-morph shiny` 会把该档的每一版都重出），
#   所以页面送过来的是槽位的 `morph` 字段，不是槽位键本身（见 `morph_slots()` 的注释）。
# 窗口脚本里用的 ASCII 档名 —— **不许**用 MORPH_CN 那套中文：
#   cmd.exe 按系统 ANSI 代码页读 .cmd，中文会被拆成乱命令（`gen-art-loop.cmd` 的注释就是这条教训）。
#   2026-10-08 我第一版真把「闪光」写进去了，被 tools/test-review-cards.py 当场逮住。
MORPH_EN = {"master": "master(+normal)", "bright": "rainbow", "albino": "albino",
            "golden": "golden", "shiny": "glitter"}
# id 的真实形状就是 `[A-Z]数字`（见 fish.js），这里放宽到「字母数字下划线短横」并限长
ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,16}$")


def regen_argv(morph, ids):
    """一个档（可含多张）的 gen-art.py 命令行。"""
    cmd = [sys.executable, os.path.join("tools", "gen-art.py"), "--list", ",".join(ids)]
    if morph != "master":
        cmd += ["--only-morph", morph]
    return cmd


def clean_groups(raw):
    """把请求里的 `[{morph, ids}]` 洗成可信的 `[{"morph","ids","cmd"}]`。

    🔴 **必须洗，不能信**：窗口模式下这些值会被**写进 .cmd 文件**、再交给 cmd.exe
       以用户权限执行 —— 一个 id 里塞 `& del /f /q …` 就是命令注入。
       页面虽然只绑回环 + 带一次性 token，但「把外部字符串拼进 shell 命令」这条路
       本身就不该留（token 防的是别的网页，防不住这个）。
    返回 `(groups, rejected)`：被拒的原样返回、不静默丢 —— 用户得看见自己点了什么。
    """
    out, bad = [], []
    for g in (raw or []):
        if not isinstance(g, dict):
            bad.append(repr(g)[:40])
            continue
        morph = str(g.get("morph") or "master")
        if morph not in MORPH_KEYS:
            bad.append("morph=%s" % morph)
            continue
        ids = []
        for x in (g.get("ids") or []):
            x = str(x)
            if ID_OK.match(x):
                if x not in ids:
                    ids.append(x)
            else:
                bad.append("id=%s" % x[:24])
        if ids:
            out.append({"morph": morph, "ids": ids, "cmd": regen_argv(morph, ids)})
    return out, bad


def build_console_script(groups, dry=False):
    """生成一个**双击也能重跑**的 .cmd 内容。

    ⚠️ 内容**全 ASCII**：cmd.exe 按系统 ANSI 代码页读 .cmd 文件，UTF-8 中文会被
       拆成乱命令 —— 这条教训是 `tools/gen-art-loop.cmd` 用血换来的（它开头就写着）。
       Python 那侧的中文输出不受影响（`chcp 65001` + `PYTHONUTF8=1` 两行罩着）。
    🔴 **echo 文本里不许出现 `>` `<` `&` `|` `^`**（cmd 的控制字符）：
       我第一版图省事写了 `echo [1/4] glitter x1  ->  C01,D12` —— `>` 是**重定向**，
       而 `,` 又是 cmd 的分隔符 ⇒ 这句话的效果是「**在仓库根写出一个叫 `C01` 的文件**，
       内容是 `[1/4] glitter x1  -,D12`」，而且**不报错**。实测复现 + 已在测试里钉死。
       要分隔就用 `:`，不要用箭头。
    """
    n = sum(len(g["ids"]) for g in groups)
    L = ["@echo off",
         "rem " + "=" * 73,
         "rem  Re-render cards marked on the review page.",
         "rem  Generated by tools/review-cards.py --serve -- do not hand-edit,",
         "rem  this window is disposable (re-run it any time).",
         "rem  Old images are NOT overwritten: they move into",
         "rem  assets\\cards\\_superseded\\<round-timestamp>\\",
         "rem " + "=" * 73,
         "setlocal",
         "chcp 65001 >nul",
         "set PYTHONUTF8=1",
         'cd /d "%s"' % ROOT,
         'set "PY=%s"' % sys.executable,
         'title re-render %d card slot%s%s'
         % (n, "" if n == 1 else "s", " (DRY RUN)" if dry else ""),
         "echo " + "=" * 63,
         "echo   Re-render %d card slot%s%s"
         % (n, "" if n == 1 else "s", "  -- DRY RUN, no image is written" if dry else ""),
         "echo   workdir : %CD%",
         "echo   speed   : about 60 s per image",
         "echo   close this window to stop  --  finished images are kept",
         "echo " + "=" * 63,
         "echo."]
    for i, g in enumerate(groups, 1):
        label = MORPH_EN.get(g["morph"], g["morph"])     # ASCII（见 MORPH_EN 的说明）
        cmd = g["cmd"] + (["--prompt-only"] if dry else [])
        # 参数里若出现绝对路径，打印成相对 ROOT 的更短好读。
        # 🔴 必须 try：解释器在 C:、项目在 D: —— 跨盘符时 `relpath` 直接抛 ValueError
        #    （2026-10-08 被 tools/test-review-cards.py 当场逮住：点「在窗口里开跑」会 500）。
        shown = []
        for x in cmd:
            try:
                shown.append(os.path.relpath(x, ROOT) if os.path.isabs(x) else x)
            except ValueError:
                shown.append(x)
        L.append("echo [%d/%d] %s x%d   :   %s"
                 % (i, len(groups), label, len(g["ids"]), ",".join(g["ids"])))
        # `-u` 是为了让 Python 的输出**即时**刷进 cmd 窗口（不然要等缓冲满）
        L.append('"%PY%" -u ' + " ".join('"%s"' % c if " " in c else c for c in shown[1:]))
        L.append("echo   exit=%ERRORLEVEL%")
        L.append("echo.")
    L += ["echo " + "=" * 63,
          "echo   Done.  images : assets\\cards\\",
          "echo          ledger : assets\\cards\\manifest.json",
          "echo          old    : assets\\cards\\_superseded\\ (by round)",
          "echo   back on the review page: click the refresh button --",
          "echo   it reloads the new images and clears those verdicts.",
          "echo " + "=" * 63,
          "pause"]
    return "\r\n".join(L) + "\r\n"


def launch_console(script):
    """用一个**用户自己的新控制台窗口**跑脚本（等价于双击它）。

    为什么不是后台 Popen：会话起的进程会随回合结束被回收（gen-art-loop.cmd 的备注），
    而且那样用户看不见进度、也没法等它跑完再看。
    ⚠️ 测试钩子：环境变量 `REVIEW_NO_LAUNCH=1` 时只写脚本不开窗口
       —— 否则「开窗口」这条路根本没法自动化验证（会真的弹窗、还要 pause）。
    """
    if os.environ.get("REVIEW_NO_LAUNCH"):
        print("  （REVIEW_NO_LAUNCH=1：只生成脚本，不开窗口）")
        return False
    try:
        os.startfile(script)                      # Windows：ShellExecute，起新控制台
    except AttributeError:                        # 非 Windows 兜底（本工具只在 Windows 用）
        subprocess.Popen(["cmd", "/c", "start", "", script], cwd=ROOT)
    return True


def write_console_script(groups, dry=False):
    """把窗口脚本写到 `_tmp/`（不会进版本库）并返回路径。

    🔴 `newline=""`：**不要写 `newline="\\r\\n"`** —— `build_console_script()` 返回的
       文本里已经是 `\\r\\n`，再用 `newline="\\r\\n"` 写会把 `\\n` 又转一遍 ⇒ 盘上是 `\\r\\r\\n`
       （实测 33 行全中）。cmd 拿到多余的 `\\r` 会把它当成行内容的一部分，而且
       「把结尾 pause 删掉再跑」这类加工会静默失配（我的测试就是这么卡住的）。
    """
    tmpdir = os.path.join(ROOT, "_tmp")
    if not os.path.isdir(tmpdir):
        os.makedirs(tmpdir)
    path = os.path.join(tmpdir, "regen-%s.cmd" % time.strftime("%Y%m%d-%H%M%S"))
    io.open(path, "w", encoding="ascii", newline="").write(
        build_console_script(groups, dry))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "卡片评审.html"))
    ap.add_argument("--only", default="", help="只列这些 id（逗号分隔）")
    ap.add_argument("--serve", action="store_true",
                    help="起**本地运行器**：页面上能直接「重出」（真的跑 gen-art.py）")
    ap.add_argument("--port", type=int, default=8770, help="--serve 的端口（只绑 127.0.0.1）")
    ap.add_argument("--open", action="store_true",
                    help="--serve 起来后自动用默认浏览器打开本页（给「双击就能用」的启动器配的）")
    args = ap.parse_args()

    only = set(x.strip() for x in args.only.split(",") if x.strip()) if args.only else None

    if args.serve:
        serve(args.port, only, open_browser=args.open)
        return

    html, n = build_page(only)
    io.open(args.out, "w", encoding="utf-8", newline="\n").write(html)
    print("评审台已写出：%s" % args.out)
    print("  卡片 %d 张（已出图的鱼）；形态描述与拉丁名一并嵌入" % n)
    print("  ⚠️ 静态打开**不能**在页里直接重出（浏览器跑不了 python）。")
    print("     要能直接跑：双击 tools\\评审台.cmd，或 python tools/review-cards.py --serve --open")


def serve(port, only, open_browser=False):
    """本地运行器：把评审页发出去，并开一个**能真的跑重出**的口子。

    为什么需要它（用户口径 2026-10-08：「导出重出清单时，它自己能直接跑起来」）：
      评审页是静态 HTML，浏览器里**跑不了 python**。所以给一个只绑本机回环的小服务：
        GET  /            → 评审页（内存里现拼，把 token 嵌进去）
        GET  /assets/...  → 直接喂卡的图（不用再另开一个 http.server）
        GET  /api/ping    → 运行器在不在（页面据此启用按钮）
        GET  /api/job     → 当前任务状态 + 日志尾部（页面轮询）
        POST /api/regen   → 真的开跑，三种 mode：
                            · `bg`     ：后台线程逐档跑子进程（页面轮询日志、跑完自动刷图）
                            · `window` ：写一个 .cmd + `startfile` 开**新控制台窗口**跑
                                         （用户口径 2026-10-08：「点击后自动打开 … 重新生图」）
                            · `loop`   ：开他本来的 `tools/gen-art-loop.cmd`（整批续跑）

    ⚠️ 安全：**只绑 127.0.0.1**，且 `/api/regen` 要带页面内嵌的一次性 token ——
       否则本机任意网页都能往这里 POST、触发跑命令。**另外**请求里的 id / 档名会被
       写进 .cmd 再交给 cmd.exe 执行 ⇒ 一律过 `clean_groups()` 白名单（token 防的是
       别的网页，防不住命令注入）。
    ⚠️ 出图是**逐个跑子进程**（不 import 进来）：失败只是一个子进程非 0 退出，不会把服务带崩。
    """
    import http.server, socketserver, threading, uuid
    from urllib.parse import urlparse, unquote

    token = uuid.uuid4().hex[:16]
    job = {"running": False, "log": [], "cur": "", "done": 0, "total": 0, "ok": 0, "fail": 0}
    lock = threading.Lock()

    def worker(groups):
        try:
            for g in groups:
                morph, ids = g["morph"], g["ids"]
                cmd = g["cmd"]                    # 与「窗口跑」共用同一份口径（见 regen_argv）
                job["cur"] = "%s ×%d" % (morph, len(ids))
                job["log"].append("$ " + " ".join(cmd))
                try:
                    p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True,
                                         errors="replace", bufsize=1)
                    for line in p.stdout:
                        job["log"].append(line.rstrip())
                        del job["log"][:-500]      # 只留尾部，别把内存吃光
                    rc = p.wait()
                except Exception as e:
                    job["log"].append("!! 起不来：%s" % e)
                    rc = -1
                (job.__setitem__("ok", job["ok"] + len(ids)) if rc == 0
                 else job.__setitem__("fail", job["fail"] + len(ids)))
                job["done"] += len(ids)
        finally:
            job["running"] = False
            job["cur"] = ""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):      # 别把每个请求都刷到控制台
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            b = body if isinstance(body, bytes) else str(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/index.html"):
                html, _n = build_page(only)
                return self._send(200, html.replace("__TOKEN__", token),
                                  "text/html; charset=utf-8")
            if path == "/api/ping":
                return self._send(200, json.dumps({"ok": True}))
            if path == "/api/job":
                return self._send(200, json.dumps(job, ensure_ascii=False))
            if path.startswith("/assets/"):
                root = os.path.abspath(os.path.join(ROOT, "assets"))
                fp = os.path.abspath(os.path.join(ROOT, path.lstrip("/")))
                if fp.startswith(root) and os.path.isfile(fp):
                    ct = "image/png" if fp.endswith(".png") else "application/octet-stream"
                    return self._send(200, open(fp, "rb").read(), ct)
            return self._send(404, "not found", "text/plain; charset=utf-8")

        def do_POST(self):
            if urlparse(self.path).path != "/api/regen":
                return self._send(404, json.dumps({"ok": False, "msg": "没有这个接口"}))
            if self.headers.get("X-Token") != token:
                return self._send(403, json.dumps({"ok": False, "msg": "token 不对"}))
            if job["running"]:
                return self._send(409, json.dumps({"ok": False, "msg": "已经有一轮在跑了"}))
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                return self._send(400, json.dumps({"ok": False, "msg": "body 读不出来：%s" % e}))

            mode = str(body.get("mode") or "bg")

            # ---- 路 A：开用户自己的 gen-art-loop.cmd 窗口（用户点名要的那条）----
            # ⚠️ 语义要讲清楚：那是 `--skip-existing` 的**续跑**，补的是「还没出过的」，
            #    不会重出已经存在的卡 —— 所以它**不是**「重出我标记的这些」。
            if mode == "loop":
                loop = os.path.join(ROOT, "tools", "gen-art-loop.cmd")
                if not os.path.exists(loop):
                    return self._send(404, json.dumps({"ok": False, "msg": "找不到 tools/gen-art-loop.cmd"}))
                launched = launch_console(loop)
                return self._send(200, json.dumps(
                    {"ok": True, "mode": "loop", "launched": launched, "script": loop}))

            groups, rejected = clean_groups(body.get("groups"))
            if not groups:
                return self._send(400, json.dumps(
                    {"ok": False, "msg": "没有要重出的（或参数不合法）", "rejected": rejected[:5]}))

            # ---- 路 B：写成 .cmd，开新控制台窗口跑（可见、可 Ctrl-C、不随会话回收）----
            if mode == "window":
                dry = bool(body.get("dry"))
                script = write_console_script(groups, dry)
                launched = launch_console(script)
                return self._send(200, json.dumps(
                    {"ok": True, "mode": "window", "launched": launched, "dry": dry,
                     "script": script,
                     "total": sum(len(g["ids"]) for g in groups),
                     "rejected": rejected[:5]}))

            # ---- 路 C：后台跑（老路）：服务里开线程逐档跑，页面轮询日志 ----
            with lock:
                job.update({"running": True, "cur": "排队中", "log": [], "done": 0,
                            "ok": 0, "fail": 0,
                            "total": sum(len(g["ids"]) for g in groups)})
            threading.Thread(target=worker, args=(groups,), daemon=True).start()
            return self._send(200, json.dumps({"ok": True, "mode": "bg", "total": job["total"]}))

    # 开机自检：拿 `--stale` 试跑一次 gen-art.py（**不联网、不出图**），
    # 把「解释器不对 / 管线坏了」在第一次重出**之前**就告诉人。
    try:
        chk = subprocess.run([sys.executable, os.path.join("tools", "gen-art.py"), "--stale"],
                             cwd=ROOT, capture_output=True, text=True,
                             errors="replace", timeout=180)
        if chk.returncode != 0:
            print("⚠️ 自检跑不动 gen-art.py（退出码 %d）：\n%s"
                  % (chk.returncode, (chk.stderr or "")[-400:]))
            print("   重出会失败 —— 换个解释器再启动（见 docs/开发者文档.md 的工具表）。")
    except Exception as e:
        print("⚠️ 自检异常：%s" % e)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        url = "http://127.0.0.1:%d/" % port
        print("评审台运行器已启动：%s" % url)
        print("   · 标记「重出」后点按钮就会真的跑（逐张约 50 秒）")
        print("   · 「在窗口里开跑」= 新开一个你自己的控制台窗口（可关窗口停、不随会话回收）")
        print("   · 「打开 gen-art-loop.cmd」= 整批续跑（补还没出过的卡，不是重出你标记的）")
        print("   · 旧图不会被覆盖：移进 assets/cards/_superseded/<本轮时间戳>/")
        print("   · 只绑本机回环；Ctrl-C 退出")
        if open_browser:
            # 服务**已经 bind 好**再开浏览器 —— 否则页面先到、`/api/ping` 探不到运行器，
            # 三个按钮全灰，用户以为「点了没用」（就是 2026-10-08 那个报障的形状）。
            try:
                import webbrowser
                webbrowser.open(url)
                print("   · 已用默认浏览器打开本页")
            except Exception as e:
                print("   · 自动开浏览器失败（%s）—— 手动开 %s 即可" % (e, url))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已退出。")


if __name__ == "__main__":
    main()
