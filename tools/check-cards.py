# -*- coding: utf-8 -*-
"""图鉴卡面自动验收 —— 把「明显跑偏」的先筛出来，人只看剩下的。

为什么必须有这一步：
  113 批的瓶颈**不是生成**（机器 6.4 小时，可以过夜跑），是**评审**——
  113 批 × 每批判断 = 上百次人工看图。能自动判的全部自动判，
  人的注意力只留给「好不好看」这种判不了的。

六条单张判据（全部可从像素算出来，不含主观）：
  硬性 FAIL
    ① 背景一致 —— 四角色差超阈值 = 背景漂移（v10 首版出现过纯黑/深灰/深蓝三种）
    ② 贴边裁切 —— 主体包围盒触到画面边缘 = 尾巴/鳍被切了（SS77 踩过）
    ③ 主体占比 —— 太小（构图太远）/ 太大（构图太挤）
  提示 WARN（可能误报，人工复核）
    ④ 朝向   —— 头部在左 → 重心应偏左
    ⑤ 背腹   —— 上半比下半暗（渐变映射的前提；水母/鳐鱼可能不成立）
    ⑥ 主色   —— 只报告不判定：母版是「自然配色」，本来就不等于 config 的色值

外加一条**成组**判据（要同一批的其它档才能算，不进 `judge()`）：
    ⑦ 跨档一致性 —— 同一条鱼的各档之间比 占比 / 宽高比 / 重心，某档离中位太远 ⇒ 提示
       （「6 张本该是同一条鱼，却长成了两种体型 / 一个朝左一个朝右」原来没有任何判据能发现：
        `analyze()` 只看单张。**只提示、永不 FAIL** —— 五档各自文生图，档间剪影漂移
        0.997→0.93 是已知且接受的代价，见 `DRIFT_*` 的注释与 `docs/改进待办.md`）
       ⚠️ 中位**按档算**：同一档出了多版（传说闪光出 2 版）时每档**只投一票**
       （`morph_key()`），但**每一版**都会被比一遍 —— 见 `drift_warnings()`。
       ⚠️ 成组消费者（`tools/contact-sheet.py`）请走 `judge_group()`，别再自己逐张调 `judge()`。

用法：
  python tools/check-cards.py                 # 查全部卡片（母版 + 5 档）
  python tools/check-cards.py A01 A02         # 查指定几条（**裸 id 会把它的各档一起拉进来**）
  python tools/check-cards.py A01 A01-golden  # 点名某一张：带 `-档` 后缀就只查那一张
  ⚠️ 跨档判据（⑦）要有**同一条鱼的多个档**才算得出来 ⇒ 想看到那条提示，
     就把同一批的几个档一起点名（裸 id 会自动带齐）。

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
# 档位 = <id>-<档>.png（独立产出）+ **第 N 版** `<id>-<档>-N.png`
# ⚠️ 2026-10-08：传说档的闪光会出 2 版（`gen-art.py:MORPH_VERSIONS_BY_RAR`）。
#    正则不认 `-N` 后缀的话，第 2 版**根本不进验收** —— 缺了也照样「查过了」，
#    正是本项目「检测条件 ≠ 交付物」的老坑。
MORPH_RE = re.compile(r"^[A-Z]+\d+-[a-z_]+(-\d+)?\.png$")

MASK_THRESH = 20          # 与背景色的差异超过它才算主体（与 paint-card.py 同口径）
BG_TOL = 26               # 四角之间允许的最大通道差
AREA_MIN, AREA_MAX = 0.08, 0.55
EDGE_PAD = 3              # 主体距画面边缘小于它算「贴边」

# ── ⑦ 跨档一致性（成组判据；**提示级，永不 FAIL**）──────────────────────────
# 背景：`analyze()` 只看单张 ⇒ 「同一条鱼的 5 档本该是同一个体型 / 同一个朝向」这件事
#   没有任何判据能发现。接触表（contact-sheet.py）把 5 档并排铺开后一眼可见，
#   但**人眼仍是唯一判据**。这里补一张提示网。
# ⚠️ 为什么只能是提示：五档是**各自文生图**出来的（2026-10-07 起图生图已弃用），
#   档位之间剪影 IoU 从 0.997 降到 0.93 是**已知且接受的代价**（开发者文档 §17.1）
#   ⇒ 档间本来就允许有漂移，判 FAIL 会把正常出图全否掉。
# 🔎 **阈值来自实测，不是拍脑袋**（口径 = 评审台槽位：原色档 + 4 色档，每条鱼 5 档）：
#   60 条鱼 / 299 张卡，各档与**同鱼中位**的漂移分位数 ——
#     面积占比 rel  p50 0.035 / p90 0.108 / p95 0.129 / p97.5 0.215 / p99 0.242 / max 0.319
#     宽高比   rel  p50 0.018 / p90 0.076 / p95 0.087 / p97.5 0.119 / p99 0.146 / max 0.228
#     重心     abs  p50 0.003 / p90 0.009 / p95 0.014 / p97.5 0.020 / p99 0.030 / max 0.045
#   取在 p99 更外侧（只抓「明显到值得人翻一眼」的），实测命中 8 张 / 7 条鱼
#   —— **不是空集**（空集就是「永不生效的守卫」，见开发者文档 §8 硬规矩第 6 条）。
# ⚠️ 中位**按档算**（2026-10-08 Q33）：同一档出了多版时，每档在「该鱼的中位」里
#   **只投一票** —— 否则中位被候选数拽走，症状是**别的档被误标掉队**。
#   归并后每档恰好一票 ⇒ 与上面那套 **5 档**标定口径一致，阈值**不需要**重新标定。
DRIFT_AREA = 0.30         # 面积占比与同鱼中位的相对差
DRIFT_WH = 0.15           # 宽高比与同鱼中位的相对差
DRIFT_CX = 0.035          # 重心与同鱼中位的绝对差（占画面宽度的比例；1152px 上 ≈ 40px）
DRIFT_TAG = "跨档漂移"     # 提示文案的主词（**唯一一处**；接触表只显示原文，不自己拼）


def morph_key(slot):
    """**槽位键 → 档键**：`shiny` 与 `shiny-2` 同属一档。**全项目唯一一处**定义这条规则。

    ⚠️ 为什么要有这个函数（而不是在 `slot_of()` 里就地折一次）：同一档的多版会被**两条路**
       送进跨档判据 ——
         · 本文件的 CLI 从**文件名**推档键（`slot_of()`）；
         · `tools/contact-sheet.py` 直接把 `review-cards.py` 的**槽位键**喂给 `judge_group()`
           （第 N 版的键是 `<档>-N`，见 `morph_slots()`）。
       规则写两遍，必然有一天只有一边被改（本项目「同一个事实写 N 遍」的老账）。
    ⚠️ 折版规则只有这一条：去掉**结尾**的 `-<数字>`。档名本身不含数字（bright / albino /
       golden / shiny），所以不会误折。
    """
    return re.sub(r"-\d+$", "", slot or "")


def slot_of(path):
    """文件名 → (鱼 id, 档键)。档键口径与评审台 / 接触表**同源**：
    `<id>.png` 与 `<id>-normal.png` 都是**原色档**（槽键 `master`，normal 就是母版抠图）；
    `<id>-<档>[-N].png` 的档键是 `<档>`（第 N 版并入同一档，见 `MORPH_RE` 那条注释）。
    ⚠️ 「折掉版本后缀」这一步走 `morph_key()`，与接触表喂进来的槽位键**同一条规则**。"""
    b = os.path.basename(path)[:-4]
    m = re.match(r"^([A-Z]+\d+)(?:-(.+))?$", b)
    if not m:
        return b, "?"
    suf = morph_key(m.group(2) or "normal")
    return m.group(1), ("master" if suf == "normal" else suf)


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


def drift_warnings(items):
    """⑦ 跨档一致性 —— 同一条鱼各档之间的一致性提示（**只提示，永不 FAIL**）。

    `items` = `[(槽位键, analyze() 结果), ...]`，必须是**同一条鱼**的全部槽位
    （槽位键可能是 `<档>`，也可能是第 N 版的 `<档>-N`，见 `morph_key()`）。

    判据分两层：
      ① **按档归并**：槽位键先经 `morph_key()` 折成档 ⇒ 每个档在「该鱼的中位」里
         **只投一票**（同档多版先各自取中位，再由「档中位」算整条鱼的中位）；
      ② 每个**槽位**（含第 N 版）各自与该中位比 占比 / 宽高比 / 重心，超出 `DRIFT_*`
         ⇒ 给**那一档**一条提示（附带实际值与中位，一眼看出谁掉队）。

    ⚠️ 为什么必须按档归并（Q33，2026-10-08）：传说档的闪光会出 2 版
       （`gen-art.py:MORPH_VERSIONS_BY_RAR`），两版是**都给人看的候选**（颜色句不同）。
       把候选当两个档 ⇒ 组里 6 个样本、其中 2 个同档，**中位被候选数拽偏** ——
       症状是**别的档被误标「掉队」**（谁掉队认错人）。与本文件 `DRIFT_AREA` 上方那条
       「基准不许取原色档」是同一类错：**基准被样本构成污染**。
       ⚠️ 阈值 `0.30 / 0.15 / 0.035` 是拿 **5 档**样本标定的 —— 归并之后每档恰好一票，
          分布口径与标定时**一致**，所以**不需要**重新标定（实测：4 条多版鱼改前改后
          命中集合 **0 处差异**，见 `test-review-cards.py` 第 [10] 节与本文件台账）。
    ⚠️ 归并只影响「投几票」，**不减少覆盖**：第 N 版照样各自被比、照样会被点名
       （「出了但没人看」正是评审台要堵的漏口）。
    ⚠️ 少于 2 个**档**时返回 `{}`：只有一个档时「中位」就是它自己，比不出任何东西
       （注意判的是**档数**不是槽位数：同一档的 2 个版本之间比不出「谁掉队」）。
    ⚠️ 阈值为什么不许 FAIL：见 `DRIFT_AREA` 上面那段（档间漂移是已知代价）。
    ⚠️ 中位数用「取中间那个 / 两个取平均」，**不引 statistics**（本文件一直只用标准库 + PIL）。
    """
    use = [(k, r) for k, r in items if r["ok"]]

    # ① 槽位 → 档（`setdefault` 保持首次出现顺序 ⇒ 报表行序稳定）
    by_morph = {}
    for k, r in use:
        by_morph.setdefault(morph_key(k), []).append(r)
    if len(by_morph) < 2:               # 判**档数**：同档的两个版本比不出「谁掉队」
        return {}

    def med(vals):
        xs = sorted(vals)
        n = len(xs)
        return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0

    def fish_med(key):
        """整条鱼的中位 = 各档中位的中位（同档多版先折成一票）。"""
        return med([med([r[key] for r in rs]) for rs in by_morph.values()])

    ma, mw, mx = fish_med("area"), fish_med("wh"), fish_med("cx")
    out = {}
    for k, r in use:
        msgs = []
        if ma and abs(r["area"] - ma) / ma > DRIFT_AREA:
            msgs.append("%s(占比 %.0f%% vs 中位 %.0f%%)" % (DRIFT_TAG, r["area"] * 100, ma * 100))
        if mw and abs(r["wh"] - mw) / mw > DRIFT_WH:
            msgs.append("%s(宽高比 %.2f vs 中位 %.2f)" % (DRIFT_TAG, r["wh"], mw))
        if abs(r["cx"] - mx) > DRIFT_CX:
            msgs.append("%s(重心 %.2f vs 中位 %.2f)" % (DRIFT_TAG, r["cx"], mx))
        if msgs:
            out[k] = msgs
    return out


def judge_group(items):
    """把**同一条鱼的全部档**一起判：单张判定（`judge()`）+ 跨档一致性提示（⑦）。

    `items` = `[(档键, analyze() 结果), ...]` → `{档键: judge() 的那个 dict}`。
    ⚠️ 跨档提示**只并进 `soft`**：所以它最多把 `ok` 抬成 `warn`，
       **绝不会**产生 hard 理由、也绝不会把 fail 改掉（失败的卡不必再叠提示）。
       这条边界就是「⑦ 是提示级」的可执行表述 —— verify 第 ㊷ 节盯着它。
    ⚠️ 这是「成组消费者」的唯一入口：接触表 / 其它批级工具要跨档提示就必须走这里，
       不要自己逐张调 `judge()` 再拼一遍（那就是判定口径的第二份）。
    """
    drift = drift_warnings(items)
    out = {}
    for k, r in items:
        j = judge(r)
        extra = drift.get(k) or []
        if extra and j["verdict"] != "fail":
            j["soft"] = j["soft"] + extra
            if j["verdict"] == "ok":
                j["verdict"] = "warn"
        out[k] = j
    return out


def main():
    args = sys.argv[1:]
    if args:
        names = []
        for a in args:
            a = a.strip()
            # 裸 id ⇒ 连它的各档一起查（跨档判据要有整组才算得出来，这也是文件头写的用法）
            if re.match(r"^[A-Z]+\d+$", a):
                names += [f[:-4] for f in sorted(os.listdir(CARDS))
                          if f.startswith(a + "-") and MORPH_RE.match(f)]
            names.append(a)
        files = sorted({os.path.join(CARDS, n + ".png") for n in names})
    else:
        files = sorted(os.path.join(CARDS, f) for f in os.listdir(CARDS)
                       if MASTER_RE.match(f) or MORPH_RE.match(f))

    if not files:
        print("assets/cards/ 下没有卡片（<id>.png / <id>-<档>.png）"); return

    # ① 先按鱼归组：跨档判据（⑦）要「同一批的其它档」才算得出来。
    #    顺手把 analyze() 的结果留在 per_path 里 —— 一张图只算一次（它要扫像素，不便宜）。
    per_path, groups, order = {}, {}, []
    for p in files:
        if not os.path.exists(p):
            print("  缺文件：%s" % p); continue
        r = analyze(p)
        per_path[p] = r
        order.append(p)
        fid, k = slot_of(p)
        if k == "?":                    # 认不出档位 ⇒ 自己单独一组，免得跟别人瞎比
            fid, k = os.path.basename(p)[:-4], "?"
        g = groups.setdefault(fid, {})
        # 同一个档位出现两个文件时（`<id>.png` 与 `<id>-normal.png` **都是原色档**）
        # 留**游戏里真正显示的那张**（`-normal` 抠图）：中位数不能把同一个东西数两遍。
        if k not in g or os.path.basename(p).endswith("-normal.png"):
            g[k] = p

    judged = {}
    for fid, g in groups.items():
        gj = judge_group([(k, per_path[p]) for k, p in g.items()])
        for k, p in g.items():
            judged[p] = gj[k]
    # 被挤掉的那个「同档重复」文件（`<id>.png` 与 `<id>-normal.png` 是同一张原色档）
    # 沿用留下那位的判定 —— 否则同一张图在报表里会出现两种判定，看着像 bug。
    for p in order:
        if p not in judged:
            fid, k = slot_of(p)
            judged[p] = judged[groups[fid][k]]

    rows, fails = [], []
    for p in order:
        r = per_path[p]
        j = judged[p]
        r["reasons"] = j["hard"]
        r["soft"] = j["soft"]
        if j["hard"]:
            fails.append((r["id"], j["hard"]))
        rows.append(r)

    print("%-12s %6s %7s %6s %6s %7s  %s" % ("id", "占比", "宽高比", "重心", "背腹", "主色", "判定"))
    print("-" * 78)
    # ⚠️ 「背腹明暗」**只报告不判定** —— 实测这条判据不可靠：v9 的光照是
    #    **边缘光打在背上**（背部反而亮），加上深色鱼与长条鱼，
    #    25 张里 4 张误报（16%）。数值已在「背腹」列显示，人工看趋势就行。
    #    `[待补]` 想找个可靠替代：算主体灰度的 p10~p90 跨度（对比度不足 = 图发平）。
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
    # 跨档一致性**单独列**：它是提示级（不影响上面的 FAIL 计数），
    # 但它是「同一条鱼的 5 档不像同一条鱼」的唯一线索，藏在软提示里会被淹没。
    # ⚠️ 按**槽位**列（不是按文件行）：原色档有两个文件（`<id>.png` / `<id>-normal.png`），
    #    按行会把它同一条提示印两遍。
    drift = []
    for fid in sorted(groups):
        for k, p in groups[fid].items():
            j = judged[p]
            if j["hard"]:
                continue
            msgs = [s for s in j["soft"] if s.startswith(DRIFT_TAG)]
            if msgs:
                drift.append((os.path.basename(p)[:-4], msgs))
    if drift:
        print("跨档一致性提示 %d 张（同鱼各档之间漂移偏大；**只是提示、不是不合格**）：" % len(drift))
        for fid, why in drift:
            print("  ⚠ %s  %s" % (fid, "、".join(why)))


if __name__ == "__main__":
    main()
