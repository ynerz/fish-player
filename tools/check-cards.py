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

判定 / 归并的**单位**（三者别混，Q34 立的规矩）：
  · **判定**的单位 = **槽位**（`slot_key()`）：一槽一份判定。原色档那一对
    （`<id>.png` / `<id>-normal.png`）是**同一个槽位**（评审台一槽一张图）；
    而同一档的**多版**是**两个槽位**（每版都是要给人看的候选）⇒ 各判各的。
  · **中位**的单位 = **档**（`morph_key()`/`slot_of()`）：每档只投一票。
  · **报表段落**的单位 = **槽位**（`slot_tally()`）：硬性不合格清单与跨档提示段都是
    「一个槽位一行」—— 原色档那一对同槽 ⇒ 只印一行、头条计数也只算一次
    （原来 FAIL 段按**文件**累加 ⇒ 1 个坏槽被印成两行、计数还双计，见 Q35）。
  · 把「判定」按**档**归并 = 「同一档的多版只判其中一个、另一个沿用别人的结论」——
    留下那张 ok、被挤掉那张本该 fail 也照样写 ok（验收工具里的假阴性通道）。见 `slot_verdicts()`。

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


def slot_key(path):
    """文件名 → (鱼 id, **槽位键**) —— 与评审台 / 接触表的**槽位口径同源**。

    · `<id>.png` 与 `<id>-normal.png` → **同一个槽位** `master`
      （`-normal` 是母版的抠图；评审台那一槽的图**就是**它，见 `review-cards.morph_slots()`）。
    · `<id>-<档>.png` → 槽位 `<档>`；`<id>-<档>-N.png` → 槽位 `<档>-N`
      （评审台自 Q32 起**每一版一个槽位** —— 每一版都是要给人看的候选）。

    ⚠️ 本函数**故意不折版本后缀**：折版（槽位键 → 档键）是 `morph_key()` 的事，
       那条规则（结尾 `-<数字>`）只许有**一处**定义 —— verify 第 ㊷ 节盯的就是这个。
       「**判定按槽位、中位按档**」是本文件的核心口径，两者由 `slot_of()` 串起来。
    """
    b = os.path.basename(path)[:-4]
    m = re.match(r"^([A-Z]+\d+)(?:-(.+))?$", b)
    if not m:
        return b, "?"
    suf = m.group(2) or "normal"
    return m.group(1), ("master" if suf == "normal" else suf)


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
    ⚠️ 它**只管「中位投几票」**，不管「判定按哪个单位」—— 后者是 `slot_key()`。
       拿 `morph_key()` 去归并**判定**就是要堵的那个假阴性通道（见 `slot_verdicts()`）。
    """
    return re.sub(r"-\d+$", "", slot or "")


def slot_of(path):
    """文件名 → (鱼 id, **档键**) = `morph_key(slot_key(path))`。档键口径与跨档判据 / 接触表
    **同源**：`<id>.png` 与 `<id>-normal.png` 都是**原色档**（槽键 `master`，normal 就是母版抠图）；
    `<id>-<档>[-N].png` 的档键是 `<档>`（第 N 版并入同一档，见 `MORPH_RE` 那条注释）。
    ⚠️ 「折掉版本后缀」这一步走 `morph_key()`，与接触表喂进来的槽位键**同一条规则**。
    ⚠️ 只有**中位 / 跨档判据**该用档键；**判定**请用 `slot_key()`（每版各自判，见 `slot_verdicts()`）。"""
    fid, s = slot_key(path)
    return fid, morph_key(s)


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

    `items` = `[(槽位键, analyze() 结果), ...]` → `{槽位键: judge() 的那个 dict}`。
    ⚠️ **槽位键**（`slot_key()` 的口径）而不是档键：同一档的多版各自是一个槽位、
       各自要有一份自己的判定（否则被挤掉那版会沿用别人的结论，见 `slot_verdicts()`）；
       而 `drift_warnings()` 内部会把槽位键折成档再算中位（每档只投一票）。
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


def slot_verdicts(per_path):
    """`{文件路径: analyze() 结果}` → `(每个文件的判定, 槽位代表文件)`。

    返回：
      · `verdicts` = `{文件路径: judge_group() 给出的那个 dict}` —— **报表里每个文件都有一份**
        （数字是它自己的、判定也是它自己的）；
      · `slots`    = `{鱼 id: {槽位键: 代表文件}}` —— 跨档提示段按它逐**槽位**列一遍
        （原色档那一对同槽位 ⇒ 只列一行，不会把同一条提示印两遍）。

    ⚠️ **判定的单位是「槽位」，不是「文件」，也不是「档」**（Q34，2026-10-09）：
      · 按**档**归并（原实现）会把**同一档的多版**（传说闪光 `<id>-shiny.png` /
        `<id>-shiny-2.png`）折成一个键，于是只判**其中一个**、另一个"沿用"它的判定 ——
        而被挤掉那行印的仍是**自己的数字** ⇒ 报表里出现「自己的数字 + 别人的判定」。
        留下的那张 ok、被挤掉的那张若单独判本该 fail，**报表照样写 ok**：
        这是验收工具里的一条**假阴性通道**（「留下了但没人看」正是这一页存在的唯一理由）。
      · 按**槽位**归并两边都对：多版各判各的（每版一槽 —— 评审台自 Q32 起就是一槽一张图），
        原色档那一对（`<id>.png` / `<id>-normal.png`）仍共用一份判定，
        因为它们是**同一个槽位**，同一槽位判出两种结论才是「看着像 bug」的那种不一致。
        ⚠️ 这不是「凑巧无差别」：实测**全部 104 组**原色档，两张图的 `area` / `cx` 差
        **恰好 0**、`bg_drift` 逐组相同（抠图保留底色像素 ⇒ 掩膜一样）——
        共用在**信息上**也不丢东西（探针 `_tmp/probe-q34b.py` 的口径）。
      · 槽位的代表文件取「游戏里真正显示的那张」（`-normal` 抠图）：中位数不能把同一个
        东西数两遍。多版各占一槽 ⇒ 每一版都会进中位，而 `drift_warnings()` 里每档只投一票。
    """
    slots, by_file = {}, {}
    for p in sorted(per_path):
        fid, k = slot_key(p)
        if k == "?":                    # 认不出档位 ⇒ 自己单独一组，免得跟别人瞎比
            fid, k = os.path.basename(p)[:-4], "?"
        by_file[p] = (fid, k)
        g = slots.setdefault(fid, {})
        # 同一个槽位出现两个文件时（`<id>.png` 与 `<id>-normal.png` 都是 `master`）
        # 留**游戏里真正显示的那张**（`-normal` 抠图）：中位数不能把同一个东西数两遍。
        if k not in g or os.path.basename(p).endswith("-normal.png"):
            g[k] = p

    out = {}
    for fid, g in slots.items():
        gj = judge_group([(k, per_path[p]) for k, p in g.items()])
        for k, p in g.items():
            out[p] = gj[k]
    # 同一槽位的**其它**文件沿用该槽位的判定（只有原色档那一对会走到这里）
    for p, (fid, k) in by_file.items():
        if p not in out:
            out[p] = out[slots[fid][k]]
    return out, slots


def slot_tally(slots, verdicts):
    """`slot_verdicts()` 的两份产物 → `(fails, drift)`，两个清单**各是「一个槽位一行」**。

    返回：
      · `fails` = `[(代表文件名, hard 理由), …]` —— 报表的「✗ …」清单与头条计数都读它；
      · `drift` = `[(代表文件名, 跨档提示原文), …]` —— 跨档一致性提示段。

    ⚠️ 为什么要有这个函数（Q35，2026-10-09）：这两段本来是**两处各写一遍**的遍历 ——
      FAIL 清单在 `main()` 的 `for p in order`（按**文件**）里累加，跨档提示段在
      `for fid in sorted(slots)`（按**槽位**）里累加。原色档那一对
      （`<id>.png` / `<id>-normal.png`）是**同一个槽位、两个文件** ⇒ 一个坏槽被印成两行、
      头条「硬性不合格 N 张」也双计（实测：把 A01 的母版与抠图都裁到贴边 ⇒ 报 2 张）。
      两段口径合一到一个遍历 ⇒ 「一个槽位一行」只有一处真相。
    ⚠️ **行数 ≠ 扫过的文件数**：原色档那一对同槽（只出一行），而**同一档的多版各占一槽**
      （各出一行，见 `slot_key()`）。所以报表头写「共 N 张」时指的是**扫了几张图**，
      与这里的行数是两回事 —— 别拿 `len(fails)` 去当「几张图坏了」。
    """
    fails, drift = [], []
    for fid in sorted(slots):
        for k, p in slots[fid].items():
            j = verdicts[p]
            name = os.path.basename(p)[:-4]
            if j["hard"]:
                fails.append((name, j["hard"]))
                continue
            msgs = [s for s in j["soft"] if s.startswith(DRIFT_TAG)]
            if msgs:
                drift.append((name, msgs))
    return fails, drift


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

    # ① 先把每张图算一遍（`analyze()` 要扫像素，不便宜 ⇒ 一张图只算一次），
    #    ② 再按**鱼 → 槽位**归组判（跨档判据要「同一批的其它档」才算得出来）。
    per_path, order = {}, []
    for p in files:
        if not os.path.exists(p):
            print("  缺文件：%s" % p); continue
        per_path[p] = analyze(p)
        order.append(p)
    judged, slots = slot_verdicts(per_path)

    rows = []
    for p in order:
        r = per_path[p]
        j = judged[p]
        r["reasons"] = j["hard"]
        r["soft"] = j["soft"]
        rows.append(r)

    # ⚠️ FAIL 清单与跨档提示段**共用 `slot_tally()` 的槽位口径**（Q35，2026-10-09）：
    #    原来 `fails` 是在上面那个 `for p in order`（按**文件**）里累加的 ⇒ 原色档那一对
    #    同槽位、两个文件都计入 ⇒ 「1 个坏槽」被印成两行，头条数字也双计。
    #    现在两段都从同一个「一个槽位一行」的遍历出来（`slot_tally()` 是唯一一处）。
    fails, drift = slot_tally(slots, judged)

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
    # ⚠️ 两个数的口径不同，文案必须写清（Q35）：`共 N 张` 是**扫了几张图**（一文件一张），
    #    而「不合格」按**槽位**数 —— 原色档那一对是同一个槽位（`<id>.png` / `<id>-normal.png`），
    #    它坏了只算 1 个槽位、清单也只列 1 行（原来按文件加 ⇒ 1 个坏槽说成 2 张）。
    print("共 %d 张（按文件计），硬性不合格 %d 个槽位" % (len(rows), len(fails)))
    for fid, why in fails:
        print("  ✗ %s  %s" % (fid, "、".join(why)))
    # 跨档一致性**单独列**：它是提示级（不影响上面的 FAIL 计数），
    # 但它是「同一条鱼的 5 档不像同一条鱼」的唯一线索，藏在软提示里会被淹没。
    # ⚠️ 与 FAIL 清单一样按**槽位**列（`slot_tally()` 一个遍历出两段）：原色档有两个文件
    #    （`<id>.png` / `<id>-normal.png`，同一个槽位）⇒ 按文件列会把它同一条提示印两遍；
    #    而**同一档的多版是两个槽位** ⇒ 第 2 版有自己的一行（Q34）。
    if drift:
        print("跨档一致性提示 %d 张（同鱼各档之间漂移偏大；**只是提示、不是不合格**）：" % len(drift))
        for fid, why in drift:
            print("  ⚠ %s  %s" % (fid, "、".join(why)))


if __name__ == "__main__":
    main()
