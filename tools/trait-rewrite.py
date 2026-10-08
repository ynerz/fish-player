# -*- coding: utf-8 -*-
"""鱼体描述「视觉化改写」的分批 / 校验 / 合并工具。规范见 tools/trait-rewrite/SPEC.md。

用法（managed python）：
  python tools/trait-rewrite.py --split 5      # 把需要改写的条目切成 5 批 → in-XX.json
  python tools/trait-rewrite.py --status       # 看哪些批已经产出
  python tools/trait-rewrite.py --check        # 校验 out-*.json（硬失败 + 可疑项报告）
  python tools/trait-rewrite.py --merge        # 合回 tools/fish-traits.json（先备份）

⚠️ 校验分两层，别混：
  · **硬失败**：黑名单术语 / 阿拉伯数字 / 句号 / 大写起头 / 超长 / 条目对不上 —— 必须改到过。
  · **可疑项报告**：改写后出现的新词（原文没有的）。「不许新增特征」这条**没法完全自动查**，
    所以工具只把新词列出来给人看，**不当成失败**。别把报告当通过。
"""
import argparse
import glob
import io
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "trait-rewrite")
TRAITS = os.path.join(HERE, "fish-traits.json")
MAX_FORM, MAX_FINS = 300, 200

# 黑名单（口径见 SPEC §1）—— 出现即硬失败
BLACK = [
    r"\bscales?\b", r"\bctenoid\b", r"\bcycloid\b", r"scale rows",
    r"lateral line", r"\bfin rays?\b", r"\brays?\b", r"unbranched", r"branched rays",
    r"\bvertebrae?\b", r"vertebral", r"gill rakers?", r"\brakers?\b", r"gill slits",
    r"interorbital", r"nuchal", r"isthmus", r"caudal peduncle", r"pectoral fin bases",
    r"adipose", r"dentition", r"pharyngeal",
    r"elaborate", r"ornate", r"decorative", r"intricate", r"detailed",
]
# 改写时会用到、但原文可能没有的**连接 / 视觉**词 —— 只影响「可疑项报告」的噪声量
ALLOW = set("""
a an the and or with without that which its of in on at to as is are be by from
narrow thin wide thick gently slightly strongly rather softly clearly sharply deeply broadly
moderately quite very long short small large front rear along side sides forward backward
body bodies form shape outline profile head snout mouth eye eyes fin fins tail back belly
covered pointing upward downward flat rounded slender elongated spindle shaped
""".split())


def load_traits():
    return json.load(io.open(TRAITS, encoding="utf-8"))


def hit_black(s):
    """返回命中的黑名单模式（无命中返回空列表）。数字单独判。"""
    out = []
    if re.search(r"\d", s or ""):
        out.append("数字")
    for pat in BLACK:
        if re.search(pat, s or "", re.I):
            out.append(pat)
    return out


def needs_rewrite(e):
    return bool(hit_black((e or {}).get("form", "")) or hit_black((e or {}).get("fins", "")))


def tokens(s):
    return set(re.findall(r"[a-z][a-z-]{2,}", (s or "").lower()))


# 允许把 form 清空的条目：**原文里除了鳞片 / 侧线 / 数字之外没有任何可用信息**。
# 清空后并不会有空档 —— `gen-art.py` 的 `form_profile()` 会退回到**数据驱动推导**
# （大小档 / 比例 / 尾型 / 头型），而且 `BODY_HINTS_ALWAYS` 还会补上决定性的体型线索
# （如 A29 牙鲆的「侧躺 + 双眼同侧」）。留着这些噪声反而会把模型带偏。
# ⚠️ 这张表要**逐条人工确认过**再往里加，不是「报错就往里塞」。
EMPTY_OK = {
    "A29",  # 牙鲆：原文全是鳞片数与侧线，无体型描述；扁体由 BODY_HINTS_ALWAYS 负责
    "B09",  # 黄尾鲴：原文只有一句「一块不到肛门的腋鳞」
    "B13",  # 中华细鲫：原文只有鳞片与不完整侧线
    "C09",  # 似鮈：原文只有一句「一条完整侧线」
    "D15",  # 圆尾斗鱼：原文只有鳞片类型
    "A10",  # 小黄鱼：原文 fins 只有一句「软背鳍/臀鳍/尾鳍覆小圆鳞」——纯鳞片噪声
}


def do_split(n):
    t = load_traits()
    ids = [k for k in sorted(t) if needs_rewrite(t.get(k))]
    size = (len(ids) + n - 1) // n
    made = []
    for b in range(n):
        part = ids[b * size:(b + 1) * size]
        if not part:
            continue
        items = [{"id": i, "name": (t[i].get("name") or ""),
                  "form": t[i].get("form") or "", "fins": t[i].get("fins") or ""} for i in part]
        p = os.path.join(OUTDIR, "in-%02d.json" % (b + 1))
        io.open(p, "w", encoding="utf-8", newline="\n").write(
            json.dumps({"items": items}, ensure_ascii=False, indent=1))
        made.append((p, len(part)))
    print("需改写 %d 条 → %d 批" % (len(ids), len(made)))
    for p, k in made:
        print("   %s  %d 条" % (os.path.basename(p), k))


def load_outs():
    res = {}
    for p in sorted(glob.glob(os.path.join(OUTDIR, "out-*.json"))):
        d = json.load(io.open(p, encoding="utf-8"))
        items = d.get("items", d)
        for it in items:
            res[it["id"]] = (it.get("form") or "", it.get("fins") or "")
    return res


def do_status():
    ins = sorted(glob.glob(os.path.join(OUTDIR, "in-*.json")))
    outs = sorted(glob.glob(os.path.join(OUTDIR, "out-*.json")))
    print("批输入 %d 个 / 批输出 %d 个" % (len(ins), len(outs)))
    done = set()
    for p in outs:
        d = json.load(io.open(p, encoding="utf-8"))
        items = d.get("items", d)
        done |= set(x["id"] for x in items)
    want = set()
    for p in ins:
        d = json.load(io.open(p, encoding="utf-8"))
        want |= set(x["id"] for x in d["items"])
    print("  应有 %d 条，已有产出 %d 条，缺 %d 条" % (len(want), len(done), len(want - done)))
    if want - done:
        print("  缺：%s" % ", ".join(sorted(want - done)[:30]))


def do_check(verbose):
    t = load_traits()
    want = set()
    for p in sorted(glob.glob(os.path.join(OUTDIR, "in-*.json"))):
        want |= set(x["id"] for x in json.load(io.open(p, encoding="utf-8"))["items"])
    out = load_outs()
    hard, soft = [], []
    for i in sorted(out):
        if i not in want:
            hard.append((i, "不在应改写清单里（id 对不上或凭空出现）"))
            continue
        nf, nfin = out[i]
        src = t.get(i) or {}
        of, ofin = src.get("form") or "", src.get("fins") or ""
        for label, val, orig, lim in (("form", nf, of, MAX_FORM), ("fins", nfin, ofin, MAX_FINS)):
            # ⚠️ 这里必须用**该字段自己的**原值判断「变空」。
            #    第一版把 fins 也拿 `of`（原文 form）去比 → 误报 30 条「fins 变空了」。
            #    这类错法在本项目查过很多次：**同名变量跨字段复用 = 假报/漏报**。
            if not val and orig and i not in EMPTY_OK:
                hard.append((i, "%s 变空了" % label))
            if len(val) > lim:
                hard.append((i, "%s 超长 %d>%d" % (label, len(val), lim)))
            h = hit_black(val)
            if h:
                hard.append((i, "%s 命中黑名单：%s" % (label, "、".join(sorted(set(h))[:4]))))
            if val.rstrip().endswith("."):
                hard.append((i, "%s 以句号结尾" % label))
            if val[:1].isupper():
                hard.append((i, "%s 大写起头" % label))
        new = (tokens(nf) | tokens(nfin)) - (tokens(of) | tokens(ofin)) - ALLOW
        if new:
            soft.append((i, src.get("name"), sorted(new)[:12]))
    missing = want - set(out)
    print("=" * 66)
    print("应改写 %d 条 / 已有产出 %d 条 / 未产出 %d 条" % (len(want), len(out), len(missing)))
    print("-" * 66)
    print("硬失败 %d 条" % len(hard))
    for i, why in hard[:40]:
        print("   ✗ %-7s %s" % (i, why))
    if len(hard) > 40:
        print("   … 还有 %d 条" % (len(hard) - 40))
    if verbose:
        print("-" * 66)
        print("可疑项（改写后出现的新词，需人工瞄一眼）%d 条" % len(soft))
        for i, nm, ws in soft[:30]:
            print("   ? %-7s %-12s %s" % (i, nm, " ".join(ws)))
    return 0 if not hard and not missing else 1


def do_merge():
    t = load_traits()
    out = load_outs()
    if not out:
        print("没有 out-*.json 可合并"); return 1
    shutil.copyfile(TRAITS, TRAITS + ".bak")
    n = 0
    for i, (nf, nfin) in out.items():
        if i not in t:
            print("  跳过不存在的 id：%s" % i); continue
        if nf:
            t[i]["form"] = nf
        t[i]["fins"] = nfin
        n += 1
    io.open(TRAITS, "w", encoding="utf-8", newline="\n").write(
        json.dumps(t, ensure_ascii=False, indent=1))
    print("已合并 %d 条 → %s（备份 %s.bak）" % (n, TRAITS, TRAITS))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", type=int, default=0)
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--merge", action="store_true")
    a = ap.parse_args()
    os.makedirs(OUTDIR, exist_ok=True)
    if a.split:
        do_split(a.split)
    elif a.status:
        do_status()
    elif a.check:
        sys.exit(do_check(a.verbose))
    elif a.merge:
        sys.exit(do_merge())
    else:
        ap.print_help()
