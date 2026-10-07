# -*- coding: utf-8 -*-
"""五档颜色句的**候选对拍 + 抽签分布核对**工具 —— 只出图，**不碰 `assets/cards/`**。

为什么要有它（而不是直接改 `MORPH_POOL` 重跑）：
  档位颜色句现在是一条「候选总表（`gen-art.py:MORPH_CANDIDATES`）+ 每档权重池
  （`MORPH_POOL`）」的结构。要选型 / 换型就必须**同一条鱼、同一个种子、同一个骨架、
  只换颜色句** —— 否则「哪句更好看」根本无从判断，连改几版之后会连自己都分不清
  是哪句改了什么。对拍在同一条鱼上做，选完再由 `gen-art.py` 按鱼 id 稳定抽一套出正式卡面。

用法：
  python tools/prompt-ab.py --list A03                # 出**当前池子**里的句子 + 每档一张对照表
  python tools/prompt-ab.py --list A03 --candidates   # 出**候选总表全部 20 套**（想重新选型时用）
  python tools/prompt-ab.py --list A03 --tier golden  # 只跑黄金档
  python tools/prompt-ab.py --list A03 --master       # 补一张「原色」参照图（对照表会用）
  python tools/prompt-ab.py --list A03 --sheet-only   # 只重拼对照表（**需 conda python**）
  python tools/prompt-ab.py --picks                   # 不出图：打印 362 条鱼抽到的分布
  python tools/prompt-ab.py --matrix                  # 拼**跨体型总览**（一行一体型 / 一列一套句子）

产物（全部在 `docs/images/prompt-ab/`，不进成品目录）：
  <id>-<候选键去斜杠>.png   如 `A03-bright-1.png` 对应候选键 `bright/1`
  <id>-<档>-sheet.png       对照表：原色 + 该档每套句子，每格带编号与短标签（池子模式还带权重）
  shapes-<档>-sheet.png     **跨体型总览**：行 = 9 个体型的代表鱼（`SHAPE_SAMPLES`），列 = 该档每套句子

⚠️ **两个解释器**（本项目的老规矩，见 `.workbuddy/memory/MEMORY.md`）：
  · 出图 / `--picks`：managed python（本文件只用标准库 + 复用 `gen-art.py`）
  · 拼对照表（`--sheet-only`）：**必须用系统 conda**
    （`C:/Users/15001/miniconda3/python.exe`，只有它有 PIL）
  拼表那一步用 PIL 是**延迟导入**的，所以没装 PIL 也不会影响出图。
"""
import argparse, importlib.util, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "docs", "images", "prompt-ab")
CONDA = r"C:/Users/15001/miniconda3/python.exe"


# 复用 gen-art.py 的**同一份**常量与函数 —— 对拍的意义就在「其余逐字相同」，
# 这里绝不允许出现第二份 BASE / 骨架 / 颜色句定义（verify §33-e / §33-f 都在盯）。
def _load_genart():
    spec = importlib.util.spec_from_file_location("genart", os.path.join(HERE, "gen-art.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # 顺带跑掉 gen-art.py 的 `check_pools()`
    return mod


GA = _load_genart()
TIERS = list(GA.MORPH_ORDER)

# ────────────────────────────────────────────────────────────────────────────
# 跨体型复核用的**代表鱼**：9 个体型各一条（低稀有度优先 —— 稀有档会给提示词叠
# 「华丽长鳍」，那层噪音对「颜色句适不适配这个身体」没帮助）。
#
# 为什么非要做跨体型复核：颜色句是**全身改写**，而它在不同身体上的表现不一样 ——
# 水母是半透明的钟罩、鳐是一整块大平面、鱿鱼是胴体 + 触手、龙鱼是细长蛇形身，
# 金银/金属反光/彩虹渐变在这几种身上最容易翻车（鱼型上完全看不出来）。
# 顺序：先跑和鱼型差别最大的，最可能出问题的先落袋。
# ────────────────────────────────────────────────────────────────────────────
SHAPE_SAMPLES = [
    ("fish",    "A03"),      # 黑鲷（基准体型，单鱼对拍也是它）
    ("jelly",   "S16"),      # 灯塔水母
    ("ray",     "S14"),      # 深海鳐
    ("squid",   "A33"),      # 鱿鱼
    ("dragon",  "SS41"),     # 幽暗龙鱼
    ("eel",     "A14"),      # 海鳗
    ("oarfish", "SS39"),     # 碎陨皇带
    ("shark",   "S31"),      # 皱鳃鲨
    ("whale",   "SS53"),     # 陨落鲸
]
SHAPE_CN = {"fish": "鱼型", "jelly": "水母", "ray": "鳐", "squid": "鱿鱼", "dragon": "龙鱼",
            "eel": "鳗", "oarfish": "皇带", "shark": "鲨", "whale": "鲸"}


def sel_entries(tier, use_candidates):
    """本轮要出 / 要拼的句子 → `[(候选键, 标签, 颜色句, 权重或 None, 文件名段), …]`"""
    if use_candidates:
        cks = [k for k in GA.MORPH_CANDIDATES if k.startswith(tier + "/")]
        # 键的尾号要按**数值**排，不然 "10" 会排到 "2" 前面
        cks.sort(key=lambda k: int(k.split("/")[1]))
        return [(k, GA.MORPH_CANDIDATES[k][0], GA.MORPH_CANDIDATES[k][1], None, k.replace("/", "-"))
                for k in cks]
    out = []
    for ck, w in GA.MORPH_POOL[tier]:
        tag, sent = GA.MORPH_CANDIDATES[ck]
        out.append((ck, tag, sent, w, ck.replace("/", "-")))
    return out


def img_path(fid, seg):
    return os.path.join(OUT, "%s-%s.png" % (fid, seg))


def run_t2i(prompt, dst):
    """出一张图。返回是否成功。"""
    r = subprocess.run([GA.PY, GA.COMFY, "-p", prompt, "-n", GA.NEG, "--cfg", str(GA.CFG),
                        "-o", dst, "-W", str(GA.W), "-H", str(GA.H),
                        "--steps", str(GA.STEPS), "--seed", str(GA.SEED)],
                       capture_output=True, text=True, errors="replace")
    if not os.path.exists(dst):
        print("    失败：" + (r.stdout or r.stderr or "")[-300:])
        return False
    return True


def _fonts():
    """加载中文字体（对照表 / 矩阵都要）。没有就用 PIL 的默认位图字体兜底。"""
    from PIL import ImageFont
    for cand in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
                 "C:/Windows/Fonts/simhei.ttf"):
        if os.path.exists(cand):
            try:
                return ImageFont.truetype(cand, 22), ImageFont.truetype(cand, 30)
            except Exception:
                pass
    f = ImageFont.load_default()
    return f, f


def make_sheet(fid, tier, name, entries, use_candidates):
    """拼一张对照表：左上「原色」，其余是各套句子。需要 PIL。"""
    from PIL import Image, ImageDraw

    cells = [("原色", os.path.join(OUT, "%s-master.png" % fid))]
    for i, (_ck, tag, _sent, w, seg) in enumerate(entries, 1):
        label = "%d  %s" % (i, tag)
        if w is not None:
            label += "　权重 %d" % w
        cells.append((label, img_path(fid, seg)))

    CW, CH, PAD, BAR = 470, 313, 14, 42          # 单元格宽 / 高 / 间距 / 图注条高
    cols = 3
    rows = max(1, (len(cells) + cols - 1) // cols)
    W = PAD + cols * (CW + PAD)
    H = PAD + 64 + rows * (CH + BAR + PAD)
    sheet = Image.new("RGB", (W, H), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    font, font_big = _fonts()

    d.text((PAD + 2, 16), "%s %s  ·  %s 档%s" % (fid, name, GA.MORPH_CN[tier],
                                                 "候选总表" if use_candidates else "正式池子"),
           fill=(238, 240, 244), font=font_big)
    d.text((PAD + 2, 52), "同一条鱼 / 同一个种子 %d / 只换颜色句" % GA.SEED,
           fill=(150, 156, 166), font=font)

    for idx, (label, path) in enumerate(cells):
        cx = PAD + (idx % cols) * (CW + PAD)
        cy = PAD + 64 + (idx // cols) * (CH + BAR + PAD)
        if not os.path.exists(path):
            d.rectangle([cx, cy, cx + CW, cy + CH], fill=(60, 40, 40))
            d.text((cx + 10, cy + 10), "缺图 " + os.path.basename(path),
                   fill=(255, 200, 200), font=font)
        else:
            sheet.paste(Image.open(path).convert("RGB").resize((CW, CH), Image.LANCZOS), (cx, cy))
            d.rectangle([cx, cy, cx + CW, cy + CH], outline=(70, 74, 82))
            if idx == 0:                      # 原色格加个不显眼的标记，别和候选混了
                d.rectangle([cx, cy, cx + CW, cy + CH], outline=(96, 104, 120), width=2)
        d.rectangle([cx, cy + CH, cx + CW, cy + CH + BAR], fill=(34, 37, 43))
        d.text((cx + 8, cy + CH + 9), label, fill=(226, 230, 238) if idx else (150, 156, 166),
               font=font)

    dst = os.path.join(OUT, "%s-%s-sheet%s.png" % (fid, tier, "-cand" if use_candidates else ""))
    sheet.save(dst)
    return dst


def make_matrix(tier, fish_all):
    """**跨体型总览**：一行一个体型、一列一套句子（第一列是「原色」参照）。

    比「每个体型四张对照表」好用得多 —— 颜色句适不适配某个身体，是**竖着看**出来的：
    同一句在金鱼身上好看，在水母身上可能整条糊掉，横排对照表里看不见这件事。
    缺图的行/列会留空并标出来，方便只跑了一半就先看。
    """
    from PIL import Image, ImageDraw

    entries = sel_entries(tier, False)
    need_segs = [seg for _ck, _t, _s, _w, seg in entries]
    rows, skipped = [], []
    for sh, fid in SHAPE_SAMPLES:
        if fid not in fish_all:
            continue
        # ⚠️ 只收录**这一档的图全齐**的体型 —— 半拉子行会让人误判「这套句子在这个体型上不行」，
        #    其实只是还没出到。缺谁要打出来，不能默默少一行。
        if all(os.path.exists(img_path(fid, s)) for s in need_segs) and \
           os.path.exists(os.path.join(OUT, "%s-master.png" % fid)):
            rows.append((sh, fid, fish_all[fid]["name"]))
        else:
            skipped.append("%s/%s" % (SHAPE_CN.get(sh, sh), fid))
    if not rows:
        return "（%s 档还没有任何一个体型出齐，先跳过）" % tier

    LW, CW, CH, PAD = 132, 330, 220, 8
    cols = [("原色", None)] + [(tag, seg) for _ck, tag, _s, _w, seg in entries]
    W = PAD + LW + len(cols) * (CW + PAD)
    H = PAD + 58 + len(rows) * (CH + PAD)
    sheet = Image.new("RGB", (W, H), (22, 24, 28))
    d = ImageDraw.Draw(sheet)
    font, font_big = _fonts()

    d.text((PAD + 2, 12), "%s 档  ·  跨体型复核（%d/%d 个体型，一行一个体型 / 一列一套句子）"
           % (GA.MORPH_CN[tier], len(rows), len(SHAPE_SAMPLES)),
           fill=(238, 240, 244), font=font_big)
    for ci, (tag, seg) in enumerate(cols):
        label = "原色" if seg is None else "%d %s (w%d)" % (ci, tag, entries[ci - 1][3])
        d.text((PAD + LW + ci * (CW + PAD) + 4, 40), label[:34], fill=(190, 196, 206), font=font)

    for ri, (sh, fid, name) in enumerate(rows):
        y = PAD + 58 + ri * (CH + PAD)
        d.text((PAD + 4, y + 8), SHAPE_CN.get(sh, sh), fill=(226, 230, 238), font=font_big)
        d.text((PAD + 4, y + 44), "%s %s" % (fid, name[:6]), fill=(140, 146, 156), font=font)
        for ci, (_tag, seg) in enumerate(cols):
            x = PAD + LW + ci * (CW + PAD)
            path = os.path.join(OUT, "%s-master.png" % fid) if seg is None else img_path(fid, seg)
            sheet.paste(Image.open(path).convert("RGB").resize((CW, CH), Image.LANCZOS), (x, y))
            d.rectangle([x, y, x + CW, y + CH], outline=(96, 104, 120) if ci == 0 else (66, 70, 78))

    dst = os.path.join(OUT, "shapes-%s-sheet.png" % tier)
    sheet.save(dst)
    if skipped:
        print("   （这些体型还没出齐，本次未收录：%s）" % "、".join(skipped))
    return dst


def report_picks(fish_all):
    """打印「362 条鱼按当前池子抽到的分布」—— 用来核对权重是不是真的生效。

    🔴 为什么要专门看它：权重写错**不报错**。某一套的权重被写成 0（或候选键写错但
       `check_pools()` 漏掉）只会让那套句子在 362 条里**一次都不出现**，
       而没人会去数 362 张图。这里一次性把实际占比打出来。
    """
    ids = sorted(fish_all)
    print("按鱼 id 稳定加权抽取的实际分布（共 %d 条鱼）\n" % len(ids))
    dead = 0
    for tier in TIERS:
        entries = GA.pool_entries(tier)
        total = sum(w for _t, _s, w in entries)
        hit = {}
        for fid in ids:
            tag = GA.morph_pick(fid, tier)[0]
            hit[tag] = hit.get(tag, 0) + 1
        print("== %s（%s）" % (GA.MORPH_CN[tier], tier))
        for tag, _sent, w in entries:
            n = hit.get(tag, 0)
            if n == 0:
                dead += 1
            print("   %-14s 权重 %2d  期望 %5.1f%%  实际 %3d 条 %5.1f%%"
                  % (tag, w, 100.0 * w / total, n, 100.0 * n / len(ids)))
        print()
    if dead:
        print("🔴 有 %d 套句子在 362 条鱼里一次都没抽到 —— 权重或候选键有问题" % dead)
    else:
        print("✔ 每一套句子都真被抽到过（池子里没有「永远抽不到」的死权重）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="", help="鱼 id（逗号分隔，建议一次只给一条）")
    ap.add_argument("--tier", default="", help="只跑某一档：%s" % "/".join(TIERS))
    ap.add_argument("--candidates", action="store_true",
                    help="出**候选总表**全部句子（默认只出当前池子）")
    ap.add_argument("--variants", default="",
                    help="只跑某几套（按屏幕上的编号，1 起，逗号分隔；给了就强制重出）")
    ap.add_argument("--master", action="store_true", help="补一张原色参照图")
    ap.add_argument("--sheet-only", action="store_true",
                    help="不重新出图，只重拼对照表（需 conda python）")
    ap.add_argument("--matrix", action="store_true",
                    help="拼**跨体型总览**（一行一个体型、一列一套句子；需 conda python）")
    ap.add_argument("--picks", action="store_true",
                    help="不出图：打印 362 条鱼按当前池子抽到的分布")
    args = ap.parse_args()

    tiers = [args.tier] if args.tier else TIERS
    for t in tiers:
        if t not in GA.MORPH_POOL:
            sys.exit("档位名不对：%s（可用 %s）" % (t, "/".join(TIERS)))

    os.makedirs(OUT, exist_ok=True)
    fish_all = {f["id"]: f for f in GA.load_fish()}

    if args.picks:
        report_picks(fish_all)
        return

    if args.matrix:
        for t in tiers:
            print("跨体型总览 %s → %s" % (t, make_matrix(t, fish_all)))
        return

    if not args.list:
        sys.exit("要么给 --list <鱼 id>，要么给 --picks / --matrix")
    ids = [x.strip() for x in args.list.split(",") if x.strip()]
    want = set(int(x) for x in args.variants.split(",") if x.strip()) if args.variants else None

    if not args.sheet_only:
        # 先探活 ComfyUI —— 不然几十张会一张一张地失败，白等半小时
        try:
            urllib.request.urlopen("http://127.0.0.1:8188/api/system_stats", timeout=5).read()
        except Exception as e:
            sys.exit("ComfyUI 没在跑（127.0.0.1:8188）：%s" % e)

    for fid in ids:
        if fid not in fish_all:
            sys.exit("没有这条鱼：%s" % fid)
        f = fish_all[fid]
        print("== %s %s（%s）" % (fid, f["name"], f["shape"]))
        master = os.path.join(OUT, "%s-master.png" % fid)
        if not args.sheet_only and args.master and not os.path.exists(master):
            print("   原色参照…", "ok" if run_t2i(GA.build_prompt(f), master) else "失败")
        for tier in tiers:
            entries = sel_entries(tier, args.candidates)
            if args.sheet_only:
                print("   拼表 %s → %s" % (tier, make_sheet(fid, tier, f["name"],
                                                           entries, args.candidates)))
                continue
            for i, (ck, tag, sent, _w, seg) in enumerate(entries, 1):
                if want is not None and i not in want:
                    continue
                dst = img_path(fid, seg)
                if os.path.exists(dst) and want is None:
                    print("   [%s %s] %s 已存在，跳过" % (tier, ck, tag))
                    continue
                print("   [%s %s] %s …" % (tier, ck, tag))
                run_t2i(GA.build_morph_prompt(f, sent), dst)
    print("\n完成 → %s" % OUT)
    if not args.sheet_only:
        print("拼对照表（需 conda python）：\n  %s %s --list %s --sheet-only%s"
              % (CONDA, os.path.join("tools", "prompt-ab.py"), args.list,
                 " --candidates" if args.candidates else ""))


if __name__ == "__main__":
    main()
