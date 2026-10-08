# -*- coding: utf-8 -*-
"""接触表（contact sheet）—— 把一个生成批次的全部卡面拼成**一张大图**，一次肉眼过 20~40 张。

为什么要有它（队列 Q6 / 待办 2026-10-08 那条）：
  出图是无人值守跑的。**能自动判的都自动判了**（`check-cards.py` 查几何：占比 / 宽高比 /
  贴边 / 背景漂移），但「画的不是这个物种 / 风格跑偏」这类几何判据**拦不住** ——
  已经发生过一次整批报废（提示词混进 `elaborate/ornate` → 模型画成精细插画，
  几何断言一条都不报红），D08 小龙虾 / A24 章鱼 / A29 牙鲆 也是这么漏掉的。
  而人看图的瓶颈**不是「看不清」而是「翻页慢」**：评审台一条鱼一张卡（430px 起），
  一屏只能过 2~3 条，113 批要翻上百次。

  ⇒ 接触表把「一批」压成一页：缩略图排成矩阵 + 自动判定画成红/黄框。
    自动判定管「哪张明显坏了」，密集排版管「哪张明显不像」。
    **两者互补，不是重复**：评审台负责逐张判决（有按钮、有 localStorage 状态），
    接触表负责「先扫一遍，挑出该细看的那几张」。

口径**不在本文件**（三样都是 importlib 加载现成的工具，见 `_load()`）：
  · 判定（fail / warn / ok + 原因文案）→ `check-cards.py` 的 `analyze()` + **`judge_group()`**
    （`judge_group` = 单张 `judge()` + **跨档一致性**提示 ⑦ —— 必须整条鱼一起判，
     逐张判读不到「这 5 档像不像同一条鱼」）
  · 有哪些鱼、每条鱼有哪些档位文件      → `review-cards.py` 的 `build_rows()`
    （**与评审台同一份口径** —— 连「normal 是母版抠图、不单独列」这种细节都不写第二遍）
  · 批号（第 N 批是哪些鱼）              → `gen-art.py` 的 `make_batches()`（与生图清单一致）
  本文件里**不许出现任何几何阈值 / 判定文案 / 批大小** —— verify 第 ㊷ 节盯着这件事。

用法：
  python tools/contact-sheet.py                  # 全部已出图的鱼，每页 6 条 → 只出第 1 页（并提示共几页）
  python tools/contact-sheet.py --all            # 出全部页
  python tools/contact-sheet.py --batch 21       # 第 21 批（批号与生图清单一致）
  python tools/contact-sheet.py --ids A01,C02    # 点名（逗号或空格分隔）
  python tools/contact-sheet.py --page 2 --per-page 5
  python tools/contact-sheet.py --morph normal   # 只看母版那张（含原色档抠图）
  python tools/contact-sheet.py --list           # 只算不画：打印判定清单，不落盘
  python tools/contact-sheet.py -o 我的表.png --cell 360

输出：默认 `_tmp/contact-sheet-<tag>-p<N>.png`
  ⚠️ 默认落 `_tmp/`（已在 .gitignore）：接触表是**看一次就丢**的评审中间物，
     落进 `docs/` 会让每一轮的 `git status` 都变脏，而「工作区不干净」是本项目
     每轮开工的第一道判据（曾因此整轮放弃）。
  ⚠️ **不带时间戳、不走随机**：同一批卡面跑两次必须逐字节相同（见文件尾「自检」）。

⚠️ 解释器：**系统 conda 的 python**（有 PIL），与 `check-cards.py` / `measure-shine.py` 同一条。
"""
import argparse
import importlib.util
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
CARDS = os.path.join(ROOT, "assets", "cards")
OUT_DIR = os.path.join(ROOT, "_tmp")

from PIL import Image, ImageDraw, ImageFont

# ── 调色板：与 `docs/卡片评审.html` **逐值同一套**（verify 第 ㊷ 节比对，改一边就报红）──
BG     = "#16171a"
CARD   = "#22242a"
LINE   = "#33363e"
FG     = "#e8e9ec"
DIM    = "#9a9ea8"
OK     = "#3f9e6a"
BAD    = "#c0503f"
ACCENT = "#5b8fd6"
WARN   = "#d8a14a"      # 只本表有：提示档的黄框（评审页没有这一档）

CARD_RATIO = 1152.0 / 768.0     # 卡面画布长宽比（1152×768）；只用于排版，不是判据

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",           # 微软雅黑（Win10+ 自带）
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


# ============================ 加载同目录工具（复用口径，不复制） ============================

def _load(fname, modname):
    """importlib 按**路径**加载同目录的工具脚本（本目录不是包，没有 `__init__.py`）。

    与 `check-prompt-drift.py` 加载 `gen-art.py` 同法。
    ⚠️ 加载期把 stdout 换掉：这些工具万一在 import 期打印，会混进本工具的报表，
       而本工具的报表是要被人当「清单」读的。
    """
    spec = importlib.util.spec_from_file_location(modname, os.path.join(TOOLS, fname))
    mod = importlib.util.module_from_spec(spec)
    buf, old = io.StringIO(), sys.stdout
    sys.stdout = buf
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.stdout = old
    return mod


# ============================ 小工具 ============================

def font(size):
    """中文字体；取不到就返回 None（调用方退到 ASCII 标签，并把这件事写进报表）。"""
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return None


def flatten_ids(argv):
    out = []
    for a in argv:
        out += [x for x in a.replace("，", ",").split(",") if x]
    return out


def hexrgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


# ============================ 选鱼 ============================

def pick(args, rc, ga):
    """返回 (rows, meta)。rows 是**评审台口径**的行（每条鱼 + 它已有的档位文件）。"""
    rows = rc.build_rows()                      # 有母版的鱼，按 id 升序
    have = {r["id"] for r in rows}
    meta = {"title": "全部已出图的鱼", "tag": "all", "missing": []}

    if args.ids:
        want = flatten_ids(args.ids)
        rows = [r for r in rows if r["id"] in set(want)]
        meta["title"], meta["tag"] = "点名 %d 条" % len(want), "ids"
        meta["missing"] = [i for i in want if i not in have]
    elif args.batch:
        bs = ga.make_batches(rc.load_fish())    # 批号口径 = 生图清单（稀有度升序 → id 升序）
        if not (1 <= args.batch <= len(bs)):
            sys.exit("批次号超范围：共 %d 批（%d 条鱼）" % (len(bs), sum(len(b) for b in bs)))
        batch = bs[args.batch - 1]
        want = [f["id"] for f in batch]
        rows = [r for r in rows if r["id"] in set(want)]
        meta["title"] = "第 %d 批（%s ×%d）" % (args.batch, ga.RAR_CN[batch[0]["rar"]], len(batch))
        meta["tag"] = "b%03d" % args.batch
        meta["missing"] = [i for i in want if i not in have]

    if args.morph and args.morph != "all":
        keep = "master" if args.morph in ("normal", "master") else args.morph
        rows = [dict(r, slots=[s for s in r["slots"] if s["k"] == keep]) for r in rows]
        rows = [r for r in rows if r["slots"]]
        meta["title"] += " · 只看 %s" % args.morph
    return rows, meta


# ============================ 画一页 ============================

class Sheet(object):
    """排版 + 绘制 —— 顺手把「字体拿不到怎么办」收在一处。"""

    def __init__(self, size, cols_count):
        self.f = {}
        for k, s in (("title", 24), ("sub", 15), ("id", 21), ("nm", 17),
                     ("rr", 14), ("tag", 16), ("why", 14)):
            self.f[k] = font(s)

    def put(self, d, xy, s, key, color):
        f = self.f[key]
        if f is None:                       # 兜底：PIL 默认位图字体画不了汉字 → 只留 ASCII
            s = "".join(ch for ch in s if ord(ch) < 128)
            f = ImageFont.load_default()
        d.text(xy, s, font=f, fill=hexrgb(color))

    def tw(self, d, s, key):
        f = self.f[key]
        return 0 if f is None else d.textlength(s, font=f)

    def fit(self, s, key, maxw):
        f = self.f[key]
        if f is None:
            return "".join(ch for ch in s if ord(ch) < 128)
        if maxw <= 0 or f.getlength(s) <= maxw:
            return s
        t = s
        while t and f.getlength(t + "…") > maxw:
            t = t[:-1]
        return t + "…"


def render(rows, meta, args, cs, rar_cn, cols):
    """把一页鱼画成一张图。**无时间戳、无随机** ⇒ 同一输入逐字节相同。"""
    S = Sheet(args.cell, cols)
    iw = max(80, args.cell)
    ih = int(round(iw / CARD_RATIO))
    inner, gap, lab_w = 6, 14, 208
    cell_h = ih + 2 * inner + 6 + 40          # 图 + 档位名 + 原因行
    pad, head_h, foot_h = 14, 62, 78
    grid_w = cols * (iw + 2 * inner) + (cols - 1) * gap
    W = pad + lab_w + gap + grid_w + pad
    H = head_h + len(rows) * (cell_h + gap) + foot_h + pad

    im = Image.new("RGB", (W, H), hexrgb(BG))
    d = ImageDraw.Draw(im)
    # ⚠️ 「画出来几张」与「这条鱼有几张」是两回事（`--cols` 会截掉多出来的格），
    #    报表数字一律用**真正画出来**的那个数 —— 否则 `--cols 3` 会报「5 张卡」而画面上只有 3 张。
    shown = sum(min(cols, len(r["slots"])) for r in rows)

    # ── 页眉 ──
    S.put(d, (pad, 16), "接触表 · %s" % meta["title"], "title", FG)
    tail = "第 %d/%d 页 · %d 条鱼 · %d 张卡" % (meta["page"], meta["pages"], len(rows), shown)
    S.put(d, (W - pad - S.tw(d, tail, "sub"), 24), tail, "sub", DIM)
    d.line([(pad, head_h - 12), (W - pad, head_h - 12)], fill=hexrgb(LINE), width=1)

    tallies = {"fail": 0, "warn": 0, "ok": 0}
    bad_ids = []
    for ri, r in enumerate(rows):
        y0 = head_h + ri * (cell_h + gap)
        S.put(d, (pad, y0 + 4), r["id"], "id", FG)
        S.put(d, (pad, y0 + 30), r["name"], "nm", FG)
        S.put(d, (pad, y0 + 52), rar_cn[min(3, r["rar"])], "rr", DIM)
        # 判定：**走 check-cards 的唯一口径**（本文件不做任何阈值比较）。
        # ⚠️ 必须**整条鱼一起判**（`judge_group`）而不是逐张 `judge`：
        #    「同一条鱼的各档像不像同一条鱼」是**成组**判据（`check-cards.py` 的 ⑦），
        #    逐张判根本读不到那条跨档提示。
        gj = cs.judge_group([(s["k"], cs.analyze(os.path.join(CARDS, s["file"])))
                             for s in r["slots"]])
        for ci in range(cols):
            x0 = pad + lab_w + gap + ci * (iw + 2 * inner + gap)
            if ci >= len(r["slots"]):
                # 只有第一条「缺」的格子写个字，免得一片空格子被当成「这档本来就该没有」
                if ci == len(r["slots"]):
                    S.put(d, (x0 + inner, y0 + inner + ih // 2 - 8), "（本档未出图）", "why", LINE)
                continue
            s = r["slots"][ci]
            path = os.path.join(CARDS, s["file"])
            j = gj[s["k"]]
            tallies[j["verdict"]] += 1
            if j["verdict"] == "fail":
                bad_ids.append("%s/%s" % (r["id"], s["k"]))
            try:
                src = Image.open(path)
                if src.mode != "RGB":
                    if src.mode != "RGBA":
                        src = src.convert("RGBA")
                    bgc = Image.new("RGBA", src.size, hexrgb(CARD) + (255,))
                    bgc.alpha_composite(src)
                    src = bgc.convert("RGB")
                src.thumbnail((iw, ih), Image.LANCZOS)
                im.paste(src, (x0 + inner + (iw - src.width) // 2,
                               y0 + inner + (ih - src.height) // 2))
                src.close()
            except Exception as e:              # 打不开的图：写原因，别把整页带崩
                S.put(d, (x0 + inner, y0 + inner + ih // 2 - 8),
                      "读不了：%s" % e, "why", BAD)
            d.rectangle([x0, y0, x0 + iw + 2 * inner, y0 + ih + 2 * inner],
                        outline=hexrgb(BAD if j["verdict"] == "fail" else
                                       (WARN if j["verdict"] == "warn" else LINE)),
                        width=3 if j["verdict"] != "ok" else 1)
            col = FG if j["verdict"] == "ok" else (BAD if j["verdict"] == "fail" else WARN)
            S.put(d, (x0 + inner, y0 + ih + 2 * inner + 6), s["label"], "tag", col)
            why = "、".join(j["hard"] + j["soft"])
            if why:
                S.put(d, (x0 + inner, y0 + ih + 2 * inner + 26),
                      S.fit(why, "why", iw), "why", BAD if j["hard"] else WARN)

    # ── 页脚：计数 + 图例 + 「判定口径在哪」 ──
    y = head_h + len(rows) * (cell_h + gap) + 2
    d.line([(pad, y), (W - pad, y)], fill=hexrgb(LINE), width=1)
    S.put(d, (pad, y + 10), "硬性不合格 %d 张 · 提示 %d 张 · 未见异常 %d 张"
          % (tallies["fail"], tallies["warn"], tallies["ok"]), "sub", FG)
    if bad_ids:
        S.put(d, (pad, y + 30), S.fit("需重出：" + "、".join(bad_ids), "sub", W - 2 * pad),
              "sub", BAD)
    lx = pad
    for color, name in ((BAD, "硬性不合格"), (WARN, "提示（可能误报）"), (LINE, "未见异常")):
        d.rectangle([lx, y + 54, lx + 16, y + 66], outline=hexrgb(color),
                    width=3 if color != LINE else 1)
        S.put(d, (lx + 22, y + 52), name, "sub", DIM)
        lx += 30 + S.tw(d, name, "sub")
    note = "判定口径 = tools/check-cards.py（本表不自己判）；档位口径 = tools/review-cards.py"
    S.put(d, (W - pad - S.tw(d, note, "sub"), y + 52), note, "sub", DIM)
    return im, tallies, bad_ids, shown


# ============================ 入口 ============================

def parse_args(argv):
    ap = argparse.ArgumentParser(
        description="把一批卡面拼成一张接触表（自动判定画红/黄框）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ids", nargs="+", help="点名：A01,B02 或 A01 B02")
    ap.add_argument("--batch", type=int, default=0, help="生图批次号（1 起，与清单一致）")
    ap.add_argument("--morph", default="all",
                    help="只看某一档：all（默认）/ normal（母版那张）/ bright|albino|golden|shiny")
    ap.add_argument("--per-page", type=int, default=6, help="每页几条鱼（默认 6 ≈ 30 张卡）")
    ap.add_argument("--page", type=int, default=1, help="出第几页（默认 1）")
    ap.add_argument("--all", action="store_true", help="出全部页")
    ap.add_argument("--cols", type=int, default=0, help="最多几列（默认按该页档位最多的那条鱼）")
    ap.add_argument("--cell", type=int, default=300, help="每张缩略图宽（px，默认 300）")
    ap.add_argument("-o", "--out", default="", help="输出路径（默认 _tmp/contact-sheet-<tag>-p<N>.png）")
    ap.add_argument("--list", action="store_true", help="只算不画：打印判定清单")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    rc = _load("review-cards.py", "review_cards_probe")
    ga = _load("gen-art.py", "gen_art_probe")
    cs = _load("check-cards.py", "check_cards_probe")

    rows, meta = pick(args, rc, ga)
    if not rows:
        extra = ""
        if meta.get("missing"):
            extra = "（这批 %d 条鱼都还没出图：%s）" % (
                len(meta["missing"]), "、".join(meta["missing"][:12]))
        print("没有可渲染的卡面%s —— 先跑 tools/gen-art.py 出图。" % extra)
        return 1

    per = max(1, args.per_page)
    pages = [rows[i:i + per] for i in range(0, len(rows), per)]
    meta["pages"] = len(pages)
    maxslots = max(len(r["slots"]) for r in rows)
    cols = maxslots if not args.cols else min(maxslots, args.cols)
    if args.cols and args.cols < maxslots:
        print("⚠️ --cols %d 装不下该页最多的 %d 档 → 多出来的格子被丢掉了" % (args.cols, maxslots))

    if args.list:
        print("接触表清单 · %s · 共 %d 条鱼 / %d 页" % (meta["title"], len(rows), len(pages)))
        for i, p in enumerate(pages, 1):
            print("\n  第 %d 页" % i)
            for r in p:
                gj = cs.judge_group([(s["k"], cs.analyze(os.path.join(CARDS, s["file"])))
                                     for s in r["slots"]])
                vs = ["%s:%s" % (s["k"], gj[s["k"]]["verdict"]) for s in r["slots"]]
                print("    %-7s %-9s %-4s %s" % (r["id"], r["name"],
                                                rc.RAR_CN[min(3, r["rar"])], " ".join(vs)))
        if meta.get("missing"):
            print("\n  还没出图：%s" % "、".join(meta["missing"]))
        return 0

    want = list(range(1, len(pages) + 1)) if args.all else [args.page]
    for pno in want:
        if not (1 <= pno <= len(pages)):
            sys.exit("页码超范围：共 %d 页" % len(pages))
        meta["page"] = pno
        im, tallies, bad_ids, shown = render(pages[pno - 1], meta, args, cs, rc.RAR_CN, cols)
        if args.out and not args.all:
            out = os.path.abspath(args.out)
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        else:
            os.makedirs(OUT_DIR, exist_ok=True)
            out = os.path.join(OUT_DIR, "contact-sheet-%s-p%d.png" % (meta["tag"], pno))
        im.save(out)
        print("✔ %s  （%d 条鱼 / %d 张卡 · 硬性不合格 %d · 提示 %d · %d×%d）"
              % (out, len(pages[pno - 1]), shown,
                 tallies["fail"], tallies["warn"], im.size[0], im.size[1]))
        if bad_ids:
            print("   需重出：%s" % "、".join(bad_ids))
    if not args.all and len(pages) > 1:
        print("   （共 %d 页，--page K 取第 K 页，--all 一次全出）" % len(pages))
    if meta.get("missing"):
        print("   ⚠️ 还没出图：%s" % "、".join(meta["missing"]))
    if font(12) is None:
        print("   ⚠️ 本机没找到中文字体 → 标签退成 ASCII（只留 id 与档位键名）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
