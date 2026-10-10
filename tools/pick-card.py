# -*- coding: utf-8 -*-
"""tools/pick-card.py —— 把「同一档的某一版」扶正成正式卡。

用户口径（2026-10-10）：「**闪光生成两个版本的，我会选一个最好看的**」。

为什么需要这个工具（而不是让你手工改名）：
  游戏加载的是**主文件名** `<id>-<档>.png`；第 N 版是 `<id>-<档>-N.png`，
  它只是**候选**。手工把候选改名会同时弄坏两处：
    ① `assets/cards/manifest.json` 里 `morphs.<档>` / `morphs.<档>-N` 记着
       **这一版用的候选键、颜色句、步数、实测耗时** —— 改完文件名，台账描述的就是另一张图了；
    ② `docs/生图清单.md` 的勾是「母版 + **每一档每一版**都存在」才算完成，
       删掉落选那版会让这条鱼**永远打不上勾**（下一轮 `--skip-existing` 还会去把它补回来）。
  ⇒ 本工具做的是**对换**：文件对换 + manifest 记录对换。两版都留在盘上，
     条目数不变、清单的勾不受影响，而且**再跑一次就是对换回来**（可反悔）。

用法：
    python tools/pick-card.py --list               # 列出所有还有第 2 版候选的鱼
    python tools/pick-card.py --list --morph shiny # 只看闪光档
    python tools/pick-card.py A44 shiny 2          # 把 A44 的闪光第 2 版扶正
    python tools/pick-card.py A44 shiny 2 --dry    # 只看会发生什么，不落盘

⚠️ 扶正之后那张图会**立刻**成为游戏里显示的那张（`<id>-<档>.png`）；
   评审台的缩略图重新跑一次 `python tools/review-cards.py` 才会刷新。
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "cards")
MANIFEST = os.path.join(OUT, "manifest.json")
TMP = os.path.join(OUT, "_tmp")


def die(msg):
    raise SystemExit("❌ " + msg)


def load_manifest():
    if not os.path.exists(MANIFEST):
        die("找不到 %s —— 还没有出过图？" % os.path.relpath(MANIFEST, ROOT))
    try:
        return json.load(io.open(MANIFEST, encoding="utf-8"))
    except Exception as e:
        die("manifest.json 读不出来（%s）—— 先确认没有别的进程正在写它" % e)


def save_manifest(man, dry=False):
    """原子写：先落临时文件再 replace —— 与 `gen-art.py` 的落盘纪律一致。"""
    if dry:
        print("（--dry：manifest 没有写）")
        return
    tmp = MANIFEST + ".picking"
    io.open(tmp, "w", encoding="utf-8").write(
        json.dumps(man, ensure_ascii=False, indent=1, sort_keys=True))
    os.replace(tmp, MANIFEST)


def version_keys(man, fid, morph):
    """这一条鱼这一档在 manifest 里**出现过**的槽位键（升序：`shiny` → `shiny-2`）。

    ⚠️ 「第 1 版的行键就是档名本身」这条规则与 `gen-art.py` 的 `morph_versions()`、
       `review-cards.py` 的 `morph_slots()` 同源 —— 三处都靠它，别在别处另立一套。
    """
    sub = (man.get(fid) or {}).get("morphs") or {}
    keys = [k for k in sub if k == morph or re.match(r"^%s-\d+$" % re.escape(morph), k)]
    return sorted(keys, key=lambda k: int(k.split("-")[1]) if "-" in k else 1)


def path_of(fid, key):
    return os.path.join(OUT, "%s-%s.png" % (fid, key))


def cmd_list(man, morph_filter, only_missing):
    """按档列出「有第 2 版候选」的鱼 —— 给「挑哪一版」用。"""
    rows = []
    for fid in sorted(man):
        v = man[fid]
        if not isinstance(v, dict):
            continue
        for morph in ("bright", "albino", "golden", "shiny"):
            if morph_filter and morph != morph_filter:
                continue
            ks = version_keys(man, fid, morph)
            if len(ks) < 2:
                continue
            on_disk = [k for k in ks if os.path.exists(path_of(fid, k))]
            if only_missing and len(on_disk) < len(ks):
                continue
            sub = v.get("morphs") or {}
            cands = [v.get("morphVariant", {}).get(k) or (sub.get(k) or {}).get("label") or k
                     for k in ks]
            rows.append((fid, v.get("name", ""), morph, ks, cands))
    if not rows:
        print("（没有「同一档有两版」的鱼 —— 要么还没出，要么已经挑完了）")
        return
    print("有候选可挑的鱼 **%d 条**：\n" % len(rows))
    print("| id | 名字 | 档 | 第 1 版（正式） | 第 2 版（候选） |")
    print("|---|---|---|---|---|")
    for fid, name, morph, ks, cands in rows:
        print("| `%s` | %s | %s | %s | %s |"
              % (fid, name, morph, cands[0], cands[1] if len(cands) > 1 else "—"))
    print("\n把某一版扶正：`python tools/pick-card.py <id> <档> <版号>`（例：`… A44 shiny 2`）")


def cmd_pick(man, fid, morph, ver, dry):
    if fid not in man or not isinstance(man[fid], dict):
        die("manifest 里没有 %s —— id 写错了？（形如 A44 / SS47 / SSS100）" % fid)
    rec = man[fid]
    if morph in ("normal", ""):
        die("母版没有多版，不需要挑")
    key2 = morph if ver == 1 else "%s-%d" % (morph, ver)
    key1 = morph                                    # 第 1 版的行键就是档名本身
    if key2 not in (rec.get("morphs") or {}):
        die("manifest 里 %s 的 %s 档没有这一版（实有：%s）"
            % (fid, morph, "、".join(version_keys(man, fid, morph)) or "无"))
    pa, pb = path_of(fid, key1), path_of(fid, key2)
    for p in (pa, pb):
        if not os.path.exists(p):
            die("盘上缺文件：%s —— 先把这一档出齐再来挑"
                % os.path.relpath(p, ROOT))
    sub = rec["morphs"]
    var = rec.setdefault("morphVariant", {})
    print("%s %s（%s）" % (fid, rec.get("name", ""), morph))
    print("  现在正式：%s  ←  %s" % (sub.get(key1, {}).get("label", "?"),
                                    sub.get(key1, {}).get("candidate", "?")))
    print("  候选  %s：%s  ←  %s" % (key2, sub.get(key2, {}).get("label", "?"),
                                    sub.get(key2, {}).get("candidate", "?")))
    if ver == 1:
        print("\n（第 1 版本来就是正式卡 —— 没有要换的。想换回来就跑同一个命令的第二版。）")
        return
    if dry:
        print("\n（--dry：只打印，不改文件）")
        print("  会把 %s ↔ %s 对换，并同步对换 manifest 里的候选记录"
              % (os.path.basename(pa), os.path.basename(pb)))
        return

    # ① 文件对换（三步 replace：全程不产生「两边都不在」的中间态）
    os.makedirs(TMP, exist_ok=True)
    tmp = os.path.join(TMP, "%s.%s.pick.png" % (fid, morph))
    os.replace(pa, tmp)
    os.replace(pb, pa)
    os.replace(tmp, pb)

    # ② manifest 记录对换 —— 🔴 必须与文件**一起**换：
    #    只换文件的话，`morphs.<档>` 记的提示词/候选键就变成描述另一张图了，
    #    而这份台账正是「可复现」与 `report_stale()` 的依据，且**不会报错**。
    sub[key1], sub[key2] = sub.get(key2), sub.get(key1)
    if key1 in var or key2 in var:
        v1, v2 = var.get(key1), var.get(key2)
        var[key1], var[key2] = v2, v1
    save_manifest(man)

    print("\n✅ 已对换：`%s` 现在是【%s】，落选那版留在 `%s`"
          % (os.path.basename(pa), sub.get(key1, {}).get("label", "?"),
             os.path.basename(pb)))
    print("   · 游戏立刻就用新的那张（读的就是主文件名）")
    print("   · 评审台缩略图要重跑一次才刷新：`python tools/review-cards.py`")
    print("   · **再跑一次同一条命令就换回来**（想反悔不用别的操作）")


def main():
    ap = argparse.ArgumentParser(description="把同一档的某一版扶正成正式卡（对换，可反悔）")
    ap.add_argument("id", nargs="?", default="", help="鱼 id，如 A44 / SS47 / SSS100")
    ap.add_argument("morph", nargs="?", default="", help="档名：bright / albino / golden / shiny")
    ap.add_argument("ver", nargs="?", type=int, default=0, help="版号（第 2 版写 2）")
    ap.add_argument("--list", action="store_true", help="列出所有「同一档有两版」的鱼")
    ap.add_argument("--morph", dest="morph_filter", default="", help="配合 --list：只看某一档")
    ap.add_argument("--only-missing", action="store_true",
                    help="配合 --list：只列「版本没出齐」的（那几条挑不了）")
    ap.add_argument("--dry", action="store_true", help="只打印，不落盘")
    args = ap.parse_args()

    if not os.path.isdir(OUT):
        die("找不到 %s" % os.path.relpath(OUT, ROOT))
    man = load_manifest()

    if args.list or not args.id:
        cmd_list(man, args.morph_filter, args.only_missing)
        return
    if not args.morph or not args.ver:
        die("用法：`python tools/pick-card.py <id> <档> <版号>`，或 `--list` 先看看有哪些")
    cmd_pick(man, args.id, args.morph, args.ver, args.dry)


if __name__ == "__main__":
    main()
