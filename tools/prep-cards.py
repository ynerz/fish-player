# -*- coding: utf-8 -*-
"""图鉴卡面的**后处理**：把生图出来的 1152×768 抠图，派生成 UI 直接能贴的两档。

为什么要有独立的一步（而不是让游戏侧自己缩放）：

  1. **宽高比口径必须落在同一处**。素材是 **3:2**（1152×768），而展示位是两种**更扁**的框
     （图鉴网格 260×112 = **2.32:1**、详情页 380×190 = **2.00:1**）。
     `src/render/cardart.js` 的 `blit()` 现在走 `contain` ⇒ 1152×768 贴进 380×190
     实际只画出 285×190：**左右各空掉 12.5%**，网格那一格空得更多。
  2. **一次算完、处处直接贴**。派生物统一成 **2:1**（`SPEC["padAspect"]`）：
     贴进 2:1 的框**像素级铺满**，贴进更扁的框只留上下一点点。
     补边一律**透明**（不是白底 / 黑底）⇒ 贴在任何底色上都不留痕。

  🔎 **实测**（A01 原色档，贴进网格格 464×200 = 2.32:1，见 `docs/images/卡面后处理-贴框对比.png`）：
     旧 3:2 贴出 300×200（红区 = 两侧浪费）、新 2:1 贴出 400×200；**主体宽度 268px → 270px（几乎没变）**；
     文件 **495 KB → 110 KB（−78%）**。⇒ 这条派生的收益是「**贴满框 + 体积骤降**」，
     ⚠️ **不是**「鱼画得更大」—— 高度受限时两者主体像素本来就一样（这是同源错觉，别拿它当理由）。
     真要让鱼更大得动 `paint-card.py` 的 `TARGET_FILL`（构图归一的**唯一一处**），
     在这里再归一一次就是第二套缩放规则。
  3. **列表档要单独锐化**。缩到 512 宽之后，线的对比会被均值抹掉，不锐化就是「糊」。
     这是「同一张图的两个用途」，不是「同一张图缩放两次」。

  4. **边缘去污染（Q11）**。抠图在主体边缘留下的一圈半透明像素，RGB 是「主体色 × 覆盖度 +
     背景色 × (1−覆盖度)」的混合物 —— alpha（覆盖度）是对的，**颜色被背景污染了**。
     实测（2026-10-10，8 张样本，量法 = 边缘带平均亮度 − 不透明内圈平均亮度）：
     **Δ 中位 −77 → +2**（等于把污染整圈抹平），而 **alpha 通道逐字节不变**。
     ⚠️ **口径更正**：待办原文猜的是「白边 / 原背景是白底」——实测这批母版的背景是**深灰**
     （紧邻主体的背景像素均值 ≈ RGB 40~50），所以污染是**偏暗**的一圈：在**浅色底**
     （图鉴面板是浅色的）上看起来是深色描边。⚠️ 不是「unpremultiply 一遍就好」——
     反预乘（按已知背景色还原）实测只能把 Δ 从 −77 拉到 −38（背景并非常量：有渐晕），
     而**邻域主体色外扩**能拉到 ≈0 ⇒ 采用后者（`bleed()`，只写 RGB、alpha 原样带回）。

⛔ 源**不许**是母版 `<id>.png`：它是灰底**不透明**图（实测四角 alpha = 255），
   垫透明边会在两侧留下两条灰棒。源一律取**透明抠图** `<id>-<档>[-N].png` ——
   与 `src/render/cardart.js` 的「游戏侧只吃透明抠图」是**同一条口径**（那里也把母版拦掉了）。

⚠️ 输出**不回写** `assets/cards/`（那边随时可能被 `gen-art.py` 写）。
   输出目录 `assets/cards-ui/` 已进 `.gitignore` —— 它是派生物、由本脚本复现，不进版本库。

⚠️ 解释器：**必须用系统 conda 的 python**（有 PIL 12.2），managed 那个没装 Pillow。

用法：
  python tools/prep-cards.py --list A01,D16      # 指定鱼（含它们的全部档）
  python tools/prep-cards.py --all               # 全部已有抠图的鱼
  python tools/prep-cards.py --list A01 --dry    # 只报计划，不写盘

规格（`SPEC` 是**唯一一处**真相，`docs/开发者文档.md` §17.28「卡面后处理：1152×768 抠图 → UI 两档」只描述、不复制数值）：
  · 补边到 2:1 → 详情档 1024×512 → 列表档 512×256（并锐化）
  · `index.json` 落每张的主体包围盒 / 最长边 / 重心 / 占比（N3-3 的体型比例要用）
"""
import argparse
import importlib.util
import io
import json
import os
import sys

from PIL import Image, ImageChops, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(ROOT, "assets", "cards")
OUT_DIR = os.path.join(ROOT, "assets", "cards-ui")
LIST_SUB = "list"
INDEX_NAME = "index.json"

# ---- 规格：**全项目唯一一处**（文档只描述、不抄数字；verify 第 53 节会现算对拍）----
# ⚠️ `padAspect` 必须 **≤** 最窄的那个展示位宽高比（实测最窄 = 详情页 380×190 = **2.00:1**）：
#    垫得比展示位还扁的话，`contain` 会变成**宽度受限**、主体反而被缩得更小。
#    （反例：框 1.70:1 时，3:2 源主体 150px / 2:1 源主体只有 127px。）
SPEC = {
    "padAspect": 2.0,                    # 派生物统一到 2:1（补边，绝不裁切 / 绝不拉伸）
    "detail": (1024, 512),               # 详情档：图鉴详情页 / 鱼护详情
    "list": (512, 256),                  # 列表档：网格缩略图（更小 + 锐化）
    "listSharpen": (1.4, 90, 3),         # UnsharpMask 的 radius / percent / threshold
    "alphaMin": 8,                       # 低于它的像素算背景（抠图边缘有羽化，0 会把噪点算进来）
    # Q11 边缘去污染：把不透明像素的颜色往「半透明边缘」外扩多少轮（每轮 8 个方向、1px）
    # ⚠️ 轮数必须 ≥ 边缘羽化宽度（实测这批母版 ≈ 4~5px）；给 0/1 会只抹掉最外一层、
    #    里面那几层仍然是背景色 —— 而且**不报错**（`assert_spec()` 因此要求 rounds ≥ 4）。
    "defringe": {"rounds": 8, "alphaHi": 240},
}

def assert_spec():
    """规格自校验 —— **模块级立即调用 = 加载即校验**（与 `gen-art.py` 同一套做法）。

    规格自相矛盾时宁可 import 就炸，也不要安静地派生出「比例不对」的一整批图：
      · 两档的目标尺寸都必须是 `padAspect` 那个宽高比（写错 ⇒ 补边白补、框里仍是留白）；
      · 源目录与输出目录不许相同（写错 ⇒ 把源图覆盖掉，且**不可逆**）。
    ⚠️ 单独抽成函数是为了让 `verify §53` 能钉住它：判据认的是
       「这函数在 + 它真的被调用」两件事，不是「文本里出现过 raise」。
    """
    for _k in ("detail", "list"):
        _w, _h = SPEC[_k]
        if abs(_w / float(_h) - SPEC["padAspect"]) > 1e-9:
            raise ValueError("%s 档 %r 不是 %r:1 —— 规格自相矛盾" % (_k, SPEC[_k], SPEC["padAspect"]))
    if os.path.abspath(SRC_DIR) == os.path.abspath(OUT_DIR):
        raise ValueError("源目录与输出目录不许是同一个（会把源图覆盖掉）")
    # 去污染：轮数太少只抹最外一层（里面几层仍是背景色，且不报错）；alphaHi ≤ alphaMin
    # 会让「边缘」这个集合空掉 ⇒ `bleed()` 静默什么也不做。
    _d = SPEC["defringe"]
    if not (_d["rounds"] >= 4):
        raise ValueError("defringe.rounds 必须 ≥ 4（实测边缘羽化 4~5px）: %r" % (_d["rounds"],))
    if not (_d["alphaHi"] > SPEC["alphaMin"] > 0):
        raise ValueError("defringe.alphaHi 必须 > alphaMin > 0（否则没有「边缘」可补）")


assert_spec()


def load_review():
    """按路径加载 `tools/review-cards.py`（文件名带短横，不能直接 import）。

    为什么要复用它、而不是自己扫一遍目录：卡面文件名 → 槽位（`<id>-<档>[-N].png`）
    的**枚举规则**只能有一处（Q32 已把它收进 `card_names()` / `morph_versions_of()` /
    `morph_slots()`）。这里再写一遍 = 第二份真相：生成器多出一版时两边就开始各说各话。
    """
    spec = importlib.util.spec_from_file_location(
        "review_cards", os.path.join(HERE, "review-cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_check():
    """加载 `tools/check-cards.py`：`index.json` 里的「主体在哪」复用它的 `analyze()`。

    ⚠️ 为什么不自己按 alpha 通道算一遍：**主体在哪**这件事只能有一个口径。
       `analyze()` 的口径是「与四角中位色的差 > `MASK_THRESH`」—— 它必须能同时吃
       **灰底母版**（没有 alpha 通道），所以天生不是 alpha 口径；另写一套 alpha 版
       必然与它漂开（本项目的经典坑型）。这里直接吃它的结果。
    """
    spec = importlib.util.spec_from_file_location(
        "check_cards", os.path.join(HERE, "check-cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def is_cutout(name):
    """文件名（无扩展名）是不是**透明抠图**。

    母版就是 `<id>`（没有 `-`），抠图一律带 `-<档>` —— 这条判据与
    `check-cards.slot_key()` 的分支、`cardart.js` 的「空档位 = 母版 ⇒ 拒」同源。
    """
    return "-" in name


def pad_canvas(w, h, aspect=None):
    """把 `w×h` 中置到一张宽高比 = `aspect` 的透明画布上。

    返回 `(画布宽, 画布高, 源图左上角 x, 源图左上角 y)`。

    · 比 aspect **窄**（1152×768 = 1.5 < 2）⇒ 左右补边：`192 + 1152 + 192 = 1536`；
    · 比 aspect **宽**（例如 2.5:1）⇒ 上下补边；
    · 恰好相等 ⇒ 零补边（**幂等**：对已经是 2:1 的图再跑一次不该再长一层）。
    一律**不裁切、不拉伸** —— 所以补边只能是透明的，任何底色上都不留痕。
    """
    aspect = SPEC["padAspect"] if aspect is None else aspect
    if h <= 0 or w <= 0:
        raise ValueError("尺寸不合法：%r" % ((w, h),))
    if w / float(h) < aspect:                       # 太窄 ⇒ 左右补
        nw, nh = int(round(h * aspect)), h
    elif w / float(h) > aspect:                     # 太宽 ⇒ 上下补
        nw, nh = w, int(round(w / aspect))
    else:
        nw, nh = w, h
    return nw, nh, (nw - w) // 2, (nh - h) // 2


# 8 邻域（含对角）：外扩一轮 = 把「已知颜色」朝 8 个方向各推 1px
BLEED_DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1))


def bleed(im, rounds=None):
    """Q11 边缘去污染：把**不透明像素的颜色**往「半透明边缘」外扩。**alpha 一个都不动**。

    为什么是这个做法（而不是反预乘 unpremultiply）：
      · 边缘像素 = 主体色 × 覆盖度 + 背景色 × (1−覆盖度)，而 **alpha 就是覆盖度**
        ⇒ 缺的只是「去掉背景那一份」，把颜色换成最近的**主体色**最直接；
      · 反预乘需要知道**背景色**，而这批母版的背景**不是常量**（有渐晕 / 明暗过渡）
        ⇒ 实测只能把污染度从 −77 拉到 −38，外扩能拉到 ≈0（见文件头第 4 条）。
      · 🔴 换的是 RGB，**alpha 必须原样带回**（`split() + (al,)`）：动了 alpha 就等于
        改了抠图轮廓 —— 主体会胖一圈或瘦一圈，而且**没有任何断言看得见**。

    实现走 PIL 的 `paste(..., mask=...)` 与 `ImageChops.offset`（都是 C 层）：
    逐像素 Python 循环在这里不可行（885k 像素 × 1837 张）。`offset` 会环绕，
    但环绕带进来的是对侧边界的颜色，而 `take` 只在「对侧那边真有已知颜色」时才写
    ⇒ 主体不贴边时（本项目的构图归一保证了这一点）不会有事。

    `rounds` 默认取 `SPEC["defringe"]["rounds"]`（**唯一一处**）；`alphaHi` 与 `alphaMin`
    同理 —— `alphaMin` 以前是个**零消费**的规格键，这里才第一次真读它。
    """
    rounds = SPEC["defringe"]["rounds"] if rounds is None else rounds
    hi, lo = SPEC["defringe"]["alphaHi"], SPEC["alphaMin"]
    al = im.getchannel("A")
    opaque = al.point(lambda v: 255 if v >= hi else 0)
    fill = al.point(lambda v: 255 if lo < v < hi else 0)      # 只有「看得见的边缘」才补色
    rgb = im.convert("RGB")
    known = opaque
    for _ in range(rounds):
        if fill.getbbox() is None:
            break                                             # 补完了（早退：省下剩余轮数）
        for dx, dy in BLEED_DIRS:
            take = ImageChops.multiply(fill, ImageChops.offset(known, dx, dy))
            if take.getbbox() is None:
                continue
            rgb.paste(ImageChops.offset(rgb, dx, dy), (0, 0), take)
            known = ImageChops.lighter(known, take)
            fill = ImageChops.subtract(fill, take)
    return Image.merge("RGBA", rgb.split() + (al,))


def plan_slots(only_ids=None):
    """要派生的槽位清单（**只读**，不写盘）。

    ⚠️ 母版（无 `-` 的名字）在 `morph_slots()` 里是「母版槽」的候选——
       它有抠图时 `file` 就是抠图（正常），**没有抠图时 `file` 会退回母版本身** ⇒
       这里必须再拦一道（`is_cutout()`），否则灰底母版会被垫上透明边。
    """
    R = load_review()
    names = R.card_names()
    ids = sorted(only_ids) if only_ids else sorted(R.generated_ids(names))
    out = []
    for fid in ids:
        for s in R.morph_slots(fid, names):
            name = s["file"][:-4]                   # 去掉 ".png"
            if not is_cutout(name):
                continue                            # 母版：灰底，不进派生（见文件头）
            out.append({"id": fid, "slot": s["k"], "morph": s["morph"], "name": name,
                        "src": os.path.join(SRC_DIR, s["file"])})
    return out


def out_paths(name):
    """槽位名 → (详情档路径, 列表档路径)。**文件名与源一一对应**（不另立一套命名规则）。"""
    return (os.path.join(OUT_DIR, name + ".png"),
            os.path.join(OUT_DIR, LIST_SUB, name + ".png"))


_CC = []                                        # check-cards 模块的惰性缓存


def check_mod():
    if not _CC:
        _CC.append(load_check())
    return _CC[0]


def stats_of(path):
    """派生物 → 落进 `index.json` 的主体度量（**唯一一处**）。

    返回 `None` 表示这张派生出来是空图（调用方应当报错，而不是安静地记一条全 0）。
    ⚠️ 一切数值都来自 `check-cards.analyze()` —— 本函数只做「取字段 + 定精度」，
       不自己按 alpha 再算一遍（见 `load_check()` 的注释）。
    """
    r = check_mod().analyze(path)
    if not r.get("ok"):
        return None
    return {"area": round(r["area"], 5), "wh": round(r["wh"], 4),
            "cx": round(r["cx"], 4), "cy": round(r["cy"], 4),
            "bbox": r["bbox"], "long": r["long"]}


def render(slot):
    """读源 → **边缘去污染** → 补边 → 两个档位。返回 `(detail 图, list 图, 补边信息)`；**不写盘**。

    ⚠️ 去污染必须在**补边 / 缩放之前**：LANCZOS 会把被污染的颜色往主体里混，
        先缩小再补色等于把污染摊进更宽的带里（补完还有残余）。
    """
    im = bleed(Image.open(slot["src"]).convert("RGBA"))
    src_size = [im.width, im.height]
    nw, nh, ox, oy = pad_canvas(im.width, im.height)
    canvas = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
    canvas.paste(im, (ox, oy))                      # 只补透明边，一个源像素都不动
    detail = canvas.resize(SPEC["detail"], Image.LANCZOS)
    small = canvas.resize(SPEC["list"], Image.LANCZOS)
    # ⚠️ 只锐化 RGB、**alpha 用未锐化的那一份**：锐化 alpha 会在边缘振出半透明的「光晕」
    #    （列表档在浅色底上看着像一圈毛边），那是 Q11 要治的 halo 反过来被我们造出来。
    rgb = small.convert("RGB").filter(ImageFilter.UnsharpMask(*SPEC["listSharpen"]))
    lst = Image.merge("RGBA", rgb.split() + (small.getchannel("A"),))
    return detail, lst, {"srcSize": src_size, "padSize": [nw, nh], "padOffset": [ox, oy]}


def load_index():
    """读上一次的 `index.json`（没有 / 坏了都当空 —— 它是派生物，不配让整批跑失败）。"""
    p = os.path.join(OUT_DIR, INDEX_NAME)
    try:
        with io.open(p, encoding="utf-8") as f:
            d = json.load(f)
        return d.get("cards") or {}
    except Exception:
        return {}


def on_disk():
    """`OUT_DIR` 里**现在真实存在**的详情档（无扩展名名字，已排序）。

    ⚠️ 索引按**现状**枚举，不按「本次打算写哪些」（开发者文档 §8 硬规矩 17）：
       跑 `--list A01` 只写一张，但索引里**不许**因此把别的卡丢掉 ——
       否则「索引说什么在盘上」这件事会当场变成假话，而 Q9 就是照它取图的。
    """
    if not os.path.isdir(OUT_DIR):
        return []
    out = []
    for n in os.listdir(OUT_DIR):
        if n.endswith(".png") and os.path.isfile(os.path.join(OUT_DIR, n)):
            out.append(n[:-4])
    return sorted(out)


def main():
    ap = argparse.ArgumentParser(description="卡面后处理：抠图 → cards-ui/ 两档")
    ap.add_argument("--list", dest="ids", default="",
                    help="逗号分隔的鱼 id（如 A01,D16）")
    ap.add_argument("--all", action="store_true", help="全部已有抠图的鱼")
    ap.add_argument("--dry", action="store_true", help="只报计划，不写盘")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张（调试用）")
    args = ap.parse_args()

    if not args.ids and not args.all:
        ap.error("要么 --list <ids>，要么 --all")
    ids = [x.strip() for x in args.ids.split(",") if x.strip()] or None
    slots = plan_slots(ids)
    if args.limit:
        slots = slots[:args.limit]
    # 「一张都没排到」不是正常情况（多半是 id 写错 / 母版还没出）⇒ 直接报错，别安静地成功
    if not slots:
        print("✖ 没有排到任何槽位（id 写错？还是没有抠图？）")
        return 1

    src_bytes = sum(os.path.getsize(s["src"]) for s in slots)
    print("· 源 %d 张（%.1f MB）；目标：详情 %d×%d / 列表 %d×%d（锐化 %r）、补边到 %r:1、"
          "边缘去污染 %d 轮（alpha ≥ %d）"
          % (len(slots), src_bytes / 1048576.0,
             SPEC["detail"][0], SPEC["detail"][1], SPEC["list"][0], SPEC["list"][1],
             SPEC["listSharpen"], SPEC["padAspect"],
             SPEC["defringe"]["rounds"], SPEC["defringe"]["alphaHi"]))
    if args.dry:
        for s in slots[:8]:
            print("   %s  ← %s" % (s["name"], os.path.basename(s["src"])))
        if len(slots) > 8:
            print("   …… 另 %d 张" % (len(slots) - 8))
        print("（--dry：没写盘）")
        return 0

    for sub in (OUT_DIR, os.path.join(OUT_DIR, LIST_SUB)):
        if not os.path.isdir(sub):
            os.makedirs(sub)

    prev = load_index()
    cards = {}
    out_bytes = 0
    for s in slots:
        detail, lst, pad = render(s)
        dp, lp = out_paths(s["name"])
        detail.save(dp, "PNG", optimize=True)
        lst.save(lp, "PNG", optimize=True)
        out_bytes += os.path.getsize(dp) + os.path.getsize(lp)
        # 主体度量：**在派生物本身上**量（占比的分母是输出画布，那才是 UI 看到的事实）
        st = stats_of(dp)
        if st is None:
            print("✖ %s 派生出来是空图（占比 / 包围盒都读不出来）" % s["name"])
            return 1
        cards[s["name"]] = dict(st, **{
            "id": s["id"], "slot": s["slot"], "morph": s["morph"],
            "src": os.path.relpath(s["src"], ROOT).replace("\\", "/"),
            "srcSize": pad["srcSize"], "padSize": pad["padSize"], "padOffset": pad["padOffset"],
        })

    # 按**现状**补齐索引：盘上有、这次没写的那些，先用上一份索引的条目；连上一份也没有
    # （手工拷进来的 / 上一份被删了）就现算一次 —— 索引不许与磁盘各说各话。
    names = on_disk()
    reused = 0
    for n in names:
        if n in cards:
            continue
        if n in prev:
            cards[n] = prev[n]
        else:
            st = stats_of(out_paths(n)[0]) or {}
            cards[n] = dict(st, **{"id": n.split("-")[0], "slot": None, "morph": None,
                                   "src": None, "srcSize": None, "padSize": None,
                                   "padOffset": None})
        reused += 1

    # 先拼好字符串再写盘（`io.open(p,'w').write(表达式)` 那种写法一旦表达式抛异常，
    # 文件已经被截成 0 字节 —— 本项目真踩过，见开发者文档 §17.19）
    doc = {"spec": dict(SPEC, detail=list(SPEC["detail"]), list=list(SPEC["list"])),
           "count": len(cards), "cards": cards}
    text = json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    io.open(os.path.join(OUT_DIR, INDEX_NAME), "w", encoding="utf-8", newline="\n").write(text)

    print("✔ 写出 %d 张 × 2 档（%.1f MB，源 %.1f MB）" 
          % (len(slots), out_bytes / 1048576.0, src_bytes / 1048576.0))
    print("  索引：%s 共 %d 条（其中沿用上一份 %d 条 = 盘上有、本次没写）"
          % (INDEX_NAME, len(cards), reused))
    print("  目录：%s" % os.path.relpath(OUT_DIR, ROOT).replace("\\", "/"))
    if len(slots) < len(cards):
        print("  ⚠️ 这是**部分**产出：要全量请跑 --all（游戏侧取图请以 --all 的结果为准）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
