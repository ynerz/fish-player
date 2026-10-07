# -*- coding: utf-8 -*-
"""AI 批量产特征（每 10 条一批）+ 校验 + 合表。

用户口径（2026-10-08）：「不用等这么久，你只需要每 10 条鱼让 ai 来按标准输出特征就行，
ai 知识库里面有，你可以开多个对话，使用规范化标准格式来问 ai 就行了。」

## 为什么这条路可行，且**不是编造**
本轮联网已经把 **120 条**现实物种的百科形态正文抓到了本地（`tools/.traits-cache/`）。
所以每批输入里，**有原文的鱼会带上原文（`ref`）**，AI 只能做「翻译 + 压缩」；
只有**原文为空**的那批，才允许用模型自身知识，并且必须标 `source: "model"`。
→ 出处是可分辨的：`source` + `ref` 有无，决定了这条能不能算「查证」。

## 三个子命令
  python tools/ai-traits.py --build      # 生成 tools/ai-traits/in-01.json … （每批 10 条）
  python tools/ai-traits.py --check      # 校验 out-*.json（格式 / 颜色词 / 精细词 / 编造）
  python tools/ai-traits.py --merge      # 校验通过后合进 fish-traits.json
⚠️ 解释器：managed python（只用标准库）
"""
import argparse, glob, json, os, re, sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
LIST = os.path.join(TOOLS, "_fishlist.json")
CACHE = os.path.join(TOOLS, ".traits-cache")
TRAITS = os.path.join(TOOLS, "fish-traits.json")
OUTDIR = os.path.join(TOOLS, "ai-traits")

BATCH = 10            # 用户指定：每 10 条一批
FIELDS = ("name", "latin", "form", "fins", "markings", "colour", "source", "unknown")

# `markings` 里的**颜色词黑名单** —— 必须带词边界，否则 `scattered` 里的 `red` 会误报
COLOUR_RE = re.compile(
    r"\b(grey|gray|silver|golden|gold|yellow|black|white|red|brown|blue|green|orange|"
    r"pink|purple|dark|pale|dusky|olive|cream)\b", re.I)
# 出图禁令词：一出现模型就画精细插画（本项目实测整批报废过）
FANCY_RE = re.compile(r"\b(elaborate|ornate|decorative|intricate|detail(?:ed)? texture|filigree)\b", re.I)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# ⚠️ `fictional` 是**独立的一档**，不许和 `model` 混：
#    `model` = 这是一个**现实物种**，凭模型知识写；
#    `fictional` = 这个生物**现实中不存在**，描述的是**设计**，不是动物学事实。
#    混在一起就等于把设计稿伪装成知识 —— 出处字段的意义就是不许这种事发生。
OK_SOURCE = ("grounded", "model", "fictional")

# ⚠️ **输入里的原文本身是垃圾**的白名单（爬虫从旧搜索路径抓错了页）。
#    它们的存在证明一件事：**「有 ref」不等于「ref 是对的」** ——
#    所以不能只凭「ref 非空」就认定 grounded，必须有人（这里是 AI）读一遍内容。
#    这里的条目：AI 没采信原文、改写 model/unknown，属于**正确处理**，不该报警。
REF_JUNK = {
    "A35": "原文是 2008 年电影《旗鱼》的剧情简介（旧搜索路径抓错页）",
    "A46": "原文是广东「大青针岛」的地理/旅游介绍（旧搜索路径抓错页）",
    "S61": "原文是「灯笼草」—— 一种植物（旧搜索路径按字面匹配抓错页）",
    "D08": "原文讲的是「螳螂虾 / 虾蛄 / 皮皮虾」—— 另一个物种（搜狗把「小龙虾」匹配错了）",
}


def is_fictional(fid):
    """与 fetch-traits.py 同口径：SS/SSS 场是设计上虚构的，不走现实特征。"""
    return re.match(r"^S{2,}", fid) is not None


def load_fish():
    fish = json.load(open(LIST, encoding="utf-8"))
    return [f for f in fish if not is_fictional(f["id"])]


def ref_of(fid):
    p = os.path.join(CACHE, fid + ".json")
    if not os.path.exists(p):
        return ""
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:
        return ""
    return d.get("text", "") if d.get("ok") else ""


def cmd_build():
    os.makedirs(OUTDIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUTDIR, "in-*.json")):
        os.remove(old)
    fish = load_fish()
    n_files = 0
    for i in range(0, len(fish), BATCH):
        chunk = fish[i:i + BATCH]
        items = []
        for f in chunk:
            items.append({"id": f["id"], "name": f["name"],
                          "maxKg": f.get("maxKg", 0), "bodyRatio": f.get("body_ratio", 0),
                          "shape": f.get("shape", "fish"),
                          "ref": " ".join(ref_of(f["id"]).split())[:900]})
        n_files += 1
        p = os.path.join(OUTDIR, "in-%02d.json" % n_files)
        json.dump({"batch": n_files, "items": items},
                  open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n_ref = sum(1 for f in fish if ref_of(f["id"]))
    print("已生成 %d 个输入批次（每批 %d 条，共 %d 条现实物种）" % (n_files, BATCH, len(fish)))
    print("其中 **%d 条带百科原文**（ref 非空 → 必须 grounded）／ %d 条只有模型知识"
          % (n_ref, len(fish) - n_ref))


def cmd_build_fictional():
    """为**虚构生物 + 游戏造名**生成输入批次 → `in-fic-NN.json`。

    输入不带 `ref`（它们没有百科原文——本来就不存在），但**必须带 `shape`**：
    提示词会在 form 前面自动接一句体型模板，描述必须和它兼容（见 SPEC 附节 §4）。
    """
    os.makedirs(OUTDIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUTDIR, "in-fic-*.json")):
        os.remove(old)
    allf = json.load(open(LIST, encoding="utf-8"))
    have = {k for k in (json.load(open(TRAITS, encoding="utf-8"))
                        if os.path.exists(TRAITS) else {}) if not k.startswith("_")}
    # ① 设计上虚构的（SS/SSS）  ② 仍未入表的现实物种（游戏造名 / 笼统统称 / 查不到的）
    fic = [f for f in allf if is_fictional(f["id"])]
    left = [f for f in allf if not is_fictional(f["id"]) and f["id"] not in have]
    items = fic + left
    n_files = 0
    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        n_files += 1
        json.dump({"batch": n_files, "kind": "fictional",
                   "items": [{"id": f["id"], "name": f["name"], "shape": f.get("shape", "fish"),
                              "maxKg": f.get("maxKg", 0), "bodyRatio": f.get("body_ratio", 0),
                              "ref": ""} for f in chunk]},
                  open(os.path.join(OUTDIR, "in-fic-%02d.json" % n_files), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    print("虚构/造名共 %d 条（SS/SSS %d + 未入表现实 %d）→ %d 个批次"
          % (len(items), len(fic), len(left), n_files))


def validate(fid, e):
    """返回问题列表（空 = 合格）。每条都是确定性规则，不靠感觉。"""
    errs = []
    for k in FIELDS:
        if k not in e:
            errs.append("缺字段 %s" % k)
    if errs:
        return errs
    if CJK_RE.search(e["form"] or "") or CJK_RE.search(e["fins"] or "") \
            or CJK_RE.search(e["markings"] or ""):
        errs.append("form/fins/markings 里出现了中文（应为英文短语）")
    if e["source"] not in OK_SOURCE:
        errs.append("source 只能是 grounded / model，实为 %r" % e["source"])
    if e["unknown"] and (e["form"] or e["fins"] or e["markings"]):
        errs.append("unknown=true 却给了描述（矛盾）")
    if not e["unknown"] and not e["form"]:
        errs.append("form 为空却没标 unknown")
    # ── 虚构生物专属规则 ──
    if e["source"] == "fictional":
        if (e["latin"] or "").strip():
            errs.append("虚构生物不许有 latin（编学名 = 造假）：%r" % e["latin"])
        if e["unknown"]:
            errs.append("虚构生物是在描述设计，不该标 unknown")
    if e["markings"]:
        hit = COLOUR_RE.search(e["markings"])
        if hit:
            errs.append("markings 含颜色词「%s」（颜色只许进 colour）" % hit.group(0))
    for k in ("form", "fins", "markings"):
        hit = FANCY_RE.search(e[k] or "")
        if hit:
            errs.append("%s 含出图禁令词「%s」（会画成精细插画）" % (k, hit.group(0)))
    if len(e["form"] or "") > 400:
        errs.append("form 超长（%d 字符），提示词会被稀释" % len(e["form"]))
    if e["form"] and not e["form"][0].islower():
        errs.append("form 应以小写起头")
    if (e["form"] or "").rstrip().endswith("."):
        errs.append("form 不该有句号（是短语串不是句子）")
    return errs


def cmd_check():
    # ⚠️ 这里必须用**全表**（含 SS/SSS 虚构），不能用 `load_fish()` ——
    #    否则 `--build-fictional` 产出的条会被判成「不在现实物种表里」，
    #    而 `--merge` 更糟：它会**静默跳过**这些条（不报错、不入表）。
    fish = {f["id"]: f for f in json.load(open(LIST, encoding="utf-8"))}
    need = set(fish)
    seen, bad, warn = set(), [], []
    for p in sorted(glob.glob(os.path.join(OUTDIR, "out-*.json"))):
        base = os.path.basename(p)
        # ⚠️ **有意的二次覆盖轮**，不是撞车：
        #    · `out-extra.json` —— 定向补漏（现实物种第二轮）
        #    · `out-fic-*.json` —— 虚构/造名轮
        #    文件名排序保证它们排在 out-01…out-19 之后 → 后写覆盖先写。
        #    （例：`S01 深海鳕` 在现实轮里是 unknown，在虚构轮里是设计稿，后者才是最终态。）
        is_extra = base == "out-extra.json" or base.startswith("out-fic-")
        try:
            data = json.load(open(p, encoding="utf-8"))
        except Exception as ex:
            bad.append((base, "-", "JSON 解析失败: %s" % ex))
            continue
        for fid, e in data.items():
            if fid not in fish:
                bad.append((base, fid, "不在现实物种表里（虚构？）"))
                continue
            if fid in seen and not is_extra:
                bad.append((base, fid, "重复出现（两条输出撞了）"))
                continue
            seen.add(fid)
            for m in validate(fid, e):
                bad.append((os.path.basename(p), fid, m))
            # ⚠️ 有原文却标 model = 出处造假 → 单独报警（但原文本身是垃圾的除外）
            if e.get("source") == "model" and ref_of(fid) and fid not in REF_JUNK:
                warn.append("%s %s 有百科原文却标 source=model（应 grounded）" % (fid, e.get("name")))
            if e.get("source") == "grounded" and not ref_of(fid):
                warn.append("%s %s 没有原文却标 source=grounded（应 model）" % (fid, e.get("name")))
    print("原文作废（爬虫抓错页，AI 未采信，处理正确）%d 条：%s"
          % (len(REF_JUNK), "；".join("%s %s" % (k, v) for k, v in REF_JUNK.items())))
    print("已产出 %d / %d 条（全表，含 SS/SSS 虚构）" % (len(seen), len(need)))
    print("缺 %d 条：%s" % (len(need - seen), "、".join(sorted(need - seen)[:20])))
    print("格式错误 %d 条" % len(bad))
    for b in bad[:25]:
        print("  ❌ %s %s —— %s" % b)
    print("出处可疑 %d 条" % len(warn))
    for w in warn[:15]:
        print("  ⚠️ %s" % w)
    return 0 if not bad else 1


def cmd_merge():
    have = json.load(open(TRAITS, encoding="utf-8")) if os.path.exists(TRAITS) else {}
    # 同上：合表要用**全表**，虚构条目也要进 `fish-traits.json`（gen-art 只认 id）
    fish = {f["id"]: f for f in json.load(open(LIST, encoding="utf-8"))}
    n_real = len(load_fish())
    added = overwritten = skipped = 0
    for p in sorted(glob.glob(os.path.join(OUTDIR, "out-*.json"))):
        for fid, e in json.load(open(p, encoding="utf-8")).items():
            if fid not in fish or not e.get("form"):
                skipped += 1
                continue
            src = {"grounded": "百科原文归一化（AI）",
                   "model": "模型知识（**未联网查证**）",
                   "fictional": "设计上虚构（**按名字设计，非现实物种**）"}[e["source"]]
            entry = {"name": fish[fid]["name"], "species": e.get("latin", ""),
                     "form": e["form"], "fins": e.get("fins", ""),
                     "markings": e.get("markings", ""), "colour": e.get("colour", ""),
                     "source": src}
            if fid in have:
                # 只在**新条目是 grounded** 时覆盖旧条目（grounded 依据同一批百科原文，
                # 但英文是 AI 直译、比短语表拼出来的通顺）。model 条目不覆盖已有内容。
                if e["source"] == "grounded":
                    have[fid] = entry
                    overwritten += 1
                else:
                    skipped += 1
            else:
                have[fid] = entry
                added += 1
    json.dump(have, open(TRAITS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ks = [k for k in have if not k.startswith("_")]
    fic_n = sum(1 for k in ks if have[k].get("source", "").startswith("设计上虚构"))
    real_n = len(ks) - fic_n
    print("新增 %d ／ 覆盖 %d ／ 跳过 %d" % (added, overwritten, skipped))
    print("特征表现有 %d 条 = 现实查证 %d（占 %d 条现实物种的 %.0f%%）+ 虚构设计 %d"
          % (len(ks), real_n, n_real, 100.0 * real_n / n_real, fic_n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--build-fictional", action="store_true",
                    help="为虚构生物（SS/SSS）+ 游戏造名生成输入批次")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--merge", action="store_true")
    a = ap.parse_args()
    if a.build:
        cmd_build()
    elif a.build_fictional:
        cmd_build_fictional()
    elif a.check:
        sys.exit(cmd_check())
    elif a.merge:
        cmd_merge()
    else:
        sys.exit("要 --build / --check / --merge 之一")


if __name__ == "__main__":
    main()
