# -*- coding: utf-8 -*-
"""图鉴卡面自动验收 —— 把「明显跑偏」的先筛出来，人只看剩下的。

为什么必须有这一步：
  113 批的瓶颈**不是生成**（机器 6.4 小时，可以过夜跑），是**评审**——
  113 批 × 每批判断 = 上百次人工看图。能自动判的全部自动判，
  人的注意力只留给「好不好看」这种判不了的。

六条判据（全部可从像素算出来，不含主观）：
  硬性 FAIL
    ① 背景一致 —— 四角色差超阈值 = 背景漂移（v10 首版出现过纯黑/深灰/深蓝三种）
    ② 贴边裁切 —— 主体包围盒触到画面边缘 = 尾巴/鳍被切了（SS77 踩过）
    ③ 主体占比 —— 太小（构图太远）/ 太大（构图太挤）
  提示 WARN（可能误报，人工复核）
    ④ 朝向   —— 头部在左 → 重心应偏左
    ⑤ 背腹   —— 上半比下半暗（渐变映射的前提；水母/鳐鱼可能不成立）
    ⑥ 主色   —— 只报告不判定：母版是「自然配色」，本来就不等于 config 的色值

用法：
  python tools/check-cards.py                 # 查全部卡片（母版 + 5 档）
  python tools/check-cards.py A01 A02         # 查指定几条（含它们的 5 档）
  python tools/check-cards.py A01 A01-golden  # 也可以直接点名某一张

⚠️ 解释器：系统 conda 的 python（有 PIL）

⚠️ 2026-10-07 修正：原来只扫母版（`MASTER_RE`），于是**档位图没人验收** ——
   档位图现在是**独立出的**（同为文生图，`tools/gen-art.py` 里的 4 档 + 母版抠图出的
   `-normal`），不是从母版算出来的，它们出错的方式（写实金鱼 / 背景漂移 / 裁切）
   和母版完全一样，必须一起进验收。
"""
import os, re, sys

from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "assets", "cards")

MASTER_RE = re.compile(r"^[A-Z]+\d+\.png$")     # 母版 = <id>.png
MORPH_RE = re.compile(r"^[A-Z]+\d+-[a-z_]+\.png$")   # 档位 = <id>-<档>.png（独立产出）

MASK_THRESH = 20          # 与背景色的差异超过它才算主体（与 paint-card.py 同口径）
BG_TOL = 26               # 四角之间允许的最大通道差
AREA_MIN, AREA_MAX = 0.08, 0.55
EDGE_PAD = 3              # 主体距画面边缘小于它算「贴边」


def corners_bg(im):
    w, h = im.size
    return [im.getpixel(p) for p in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3))]


def analyze(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    gray = im.convert("L")

    # ① 背景一致：四角色差
    cs = corners_bg(im)
    bg_drift = max(max(c[i] for c in cs) - min(c[i] for c in cs) for i in range(3))

    # 掩膜（主体）
    bg = tuple(sorted(cs, key=sum)[len(cs) // 2])          # 四角中位色当基准
    diff = ImageChops.difference(im, Image.new("RGB", im.size, bg)).convert("L")
    mask = diff.point(lambda p: 255 if p > MASK_THRESH else 0, "L")
    bbox = mask.getbbox()
    if not bbox:
        return {"id": os.path.basename(path)[:-4], "ok": False, "reasons": ["空图（没有主体）"]}

    px = mask.load()
    area = sum(1 for p in mask.getdata() if p) / float(w * h)

    # ② 贴边：包围盒距边缘的距离
    l, t, r, b = bbox
    clipped = (l <= EDGE_PAD) or (t <= EDGE_PAD) or (r >= w - EDGE_PAD) or (b >= h - EDGE_PAD)

    # ④ 朝向 + ⑤ 背腹：主体像素质心 / 上下半亮度
    sx = sy = n = 0
    up = dn = un = dn_n = 0
    mid = h // 2
    for y in range(t, b, 3):
        for x in range(l, r, 3):
            if not px[x, y]:
                continue
            sx += x; sy += y; n += 1
            g = gray.getpixel((x, y))
            if y < mid:
                up += g; un += 1
            else:
                dn += g; dn_n += 1
            # ⑥ 主色：累加 RGB
    col = [0, 0, 0]; cn = 0
    for y in range(t, b, 5):
        for x in range(l, r, 5):
            if px[x, y]:
                c = im.getpixel((x, y))
                col[0] += c[0]; col[1] += c[1]; col[2] += c[2]; cn += 1

    return {
        "id": os.path.basename(path)[:-4],
        "bg_drift": bg_drift,
        "area": area,
        "wh": (r - l) / float(b - t) if b > t else 0,
        "clipped": clipped,
        "cx": (sx / float(n) / w) if n else 0.5,          # 0=最左 1=最右
        "lit": (up / float(un)) - (dn / float(dn_n)) if (un and dn_n) else 0,
        "rgb": tuple(c // cn for c in col) if cn else (0, 0, 0),
        "ok": True,
        "reasons": [],
    }


def judge(r):
    """把 `analyze()` 的数值定成 ok / warn / fail —— **判定口径的唯一一处**。

    ⚠️ 2026-10-08：这段原来inline在 `main()` 里。`tools/contact-sheet.py`（接触表）要在
       缩略图上画红/黄框，如果它自己再判一遍，就会出现「评审台说合格、接触表说红框」
       这种两套口径 —— 所以抽成函数，接触表直接 import 本函数（verify 第 ㊷ 节盯着
       「本文件的判定文案只许出现一次」）。
    ⚠️ 本函数**只读** `r`，不改它（`main()` 做完自己想记的字段再调它）。
    """
    if not r["ok"]:
        return {"hard": list(r["reasons"]), "soft": [], "verdict": "fail"}

    hard = []
    if r["bg_drift"] > BG_TOL:
        hard.append("背景漂移(Δ%d)" % r["bg_drift"])
    if r["clipped"]:
        hard.append("贴边裁切")
    # ⚠️ 超细长鱼（鳗类，宽高比 > 5）单独放宽下限 —— 它们在图里天然是一条细线，
    #    构图占比已由 paint-card.py 的「构图归一」按最长边统一处理，
    #    这里只用来抓「真的画崩了」。实测 A14 海鳗 7% / D11 黄鳝 5%。
    amin = 0.03 if r["wh"] > 5 else AREA_MIN
    if not (amin <= r["area"] <= AREA_MAX):
        hard.append("主体占比越界(%.0f%%)" % (r["area"] * 100))

    soft = []
    if r["cx"] > 0.56:
        soft.append("重心偏右(朝向?)")
    return {"hard": hard, "soft": soft,
            "verdict": "fail" if hard else ("warn" if soft else "ok")}


def main():
    args = sys.argv[1:]
    if args:
        files = [os.path.join(CARDS, a + ".png") for a in args]
    else:
        files = sorted(os.path.join(CARDS, f) for f in os.listdir(CARDS)
                       if MASTER_RE.match(f) or MORPH_RE.match(f))

    if not files:
        print("assets/cards/ 下没有卡片（<id>.png / <id>-<档>.png）"); return

    rows, fails = [], []
    for p in files:
        if not os.path.exists(p):
            print("  缺文件：%s" % p); continue
        r = analyze(p)
        if not r["ok"]:
            j = judge(r)
            fails.append((r["id"], j["hard"])); rows.append(r); continue
        # ⚠️ 「背腹明暗」**只报告不判定** —— 实测这条判据不可靠：v9 的光照是
        #    **边缘光打在背上**（背部反而亮），加上深色鱼与长条鱼，
        #    25 张里 4 张误报（16%）。数值已在「背腹」列显示，人工看趋势就行。
        #    `[待补]` 想找个可靠替代：算主体灰度的 p10~p90 跨度（对比度不足 = 图发平）。
        j = judge(r)
        r["reasons"] = j["hard"]
        r["soft"] = j["soft"]
        if j["hard"]:
            fails.append((r["id"], j["hard"]))
        rows.append(r)

    print("%-12s %6s %7s %6s %6s %7s  %s" % ("id", "占比", "宽高比", "重心", "背腹", "主色", "判定"))
    print("-" * 78)
    for r in rows:
        if not r["ok"]:
            print("%-12s  %s" % (r["id"], "、".join(r["reasons"]))); continue
        hard = r["reasons"]
        soft = r.get("soft") or []
        mark = "FAIL" if hard else ("warn" if soft else "ok")
        note = "、".join(hard + soft)
        print("%-12s %5.0f%% %7.2f %6.2f %+6.1f  #%02x%02x%02x  %-4s %s"
              % (r["id"], r["area"] * 100, r["wh"], r["cx"], r["lit"],
                 r["rgb"][0], r["rgb"][1], r["rgb"][2], mark, note))

    print("-" * 78)
    print("共 %d 张，硬性不合格 %d 张" % (len(rows), len(fails)))
    for fid, why in fails:
        print("  ✗ %s  %s" % (fid, "、".join(why)))


if __name__ == "__main__":
    main()
