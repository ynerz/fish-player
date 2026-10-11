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

🔴 **干跑（`--dry`）时可省版号**，默认看「第 2 版」—— `pick-shiny.cmd A44 dry` /
   `pick-shiny.cmd A44 --dry` 这两种写法都走这条路（`pick-shiny.cmd` 把 `%2` 当版号
   原样转过来，所以位置形态的 `dry` 由 `normalize_dry()` 归一）。
   **不带 `--dry` 必须显式给版号** —— 那一步是真的对换文件与台账。

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
    """按档列出「有第 2 版候选」的鱼 —— 给「挑哪一版」用。

    `only_missing=True`（`--only-missing`）时**只列版本没出齐的**：那几条**挑不了**
    （`cmd_pick()` 会在「盘上缺文件」那一步 `die()`），列出来是为了回答
    「清单里那条鱼为什么挑不动」—— 即「缺的是谁」。
    """
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
            # 🔴 2026-10-11 修：这里原先写的是 `len(on_disk) < len(ks)` ⇒ **筛反了** ——
            #    把「残缺的那几条」筛掉、留下「齐的」。而 `--only-missing` 的 help 与
            #    本函数的意图都写着「只列版本没出齐的」，于是参数**接受了却干着相反的事**，
            #    且**不报错**：当前盘上 26 条候选两版全在 ⇒ 加不加这个开关输出一字不差，
            #    这个 bug 在现状里根本看不出来（同族：Q14 的「静默跳过」）。
            #    ⚠️ 判据只许有一种写法：`on_disk ⊆ ks` ⇒ 「齐」就是 `len(on_disk) == len(ks)`。
            if only_missing and len(on_disk) == len(ks):
                continue
            sub = v.get("morphs") or {}
            cands = [v.get("morphVariant", {}).get(k) or (sub.get(k) or {}).get("label") or k
                     for k in ks]
            rows.append((fid, v.get("name", ""), morph, ks, cands))
    if not rows:
        # 「一条都没有」在两种口径下意思完全不同 ⇒ 文案必须分开写：
        # 不筛时是「没有可挑的鱼」，筛残缺时是「没有残缺的鱼」（= 全都齐，这是好消息）。
        print("（没有版本没出齐的鱼 —— 每一档每一版都在盘上）" if only_missing
              else "（没有「同一档有两版」的鱼 —— 要么还没出，要么已经挑完了）")
        return
    print(("%s **%d 条**：\n" % ("版本没出齐（那几条挑不了）的鱼" if only_missing
                                 else "有候选可挑的鱼", len(rows))))
    print("| id | 名字 | 档 | 第 1 版（正式） | 第 2 版（候选） |")
    print("|---|---|---|---|---|")
    for fid, name, morph, ks, cands in rows:
        print("| `%s` | %s | %s | %s | %s |"
              % (fid, name, morph, cands[0], cands[1] if len(cands) > 1 else "—"))
    if only_missing:
        # ⚠️ 这一段**不能**照抄下面那句：这些鱼的某一版**不在盘上**，`cmd_pick()` 会
        #    在「盘上缺文件」那一步 `die()` ⇒ 给一句「把某一版扶正」等于教人撞墙。
        print("\n这些鱼先跑一轮出图补齐（`--skip-existing` 会认「档案缺了哪一版」），"
              "齐了再来挑：`python tools/pick-card.py --list`")
    else:
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


def normalize_dry(argv):
    """把**位置形态**的 `dry` 归一成 `--dry` —— 唯一一处做这件事。

    🔴 为什么（2026-10-11 实测出来的真 bug）：
      `tools/pick-shiny.cmd` 把 `%2` 当**版号**原样转给本脚本
      （`pick-card.py %ID% shiny %VER%`），而它的文件头与 `docs/开发者文档.md`
      都把干跑写成 `pick-shiny.cmd A44 dry` ⇒ 实际到达的是
      `pick-card.py A44 shiny dry` ⇒ argparse 报 `invalid int value: 'dry'`（退出码 2）。
      另一种写法 `pick-shiny.cmd A44 --dry` 能过 argparse，但版号缺了 ⇒
      本脚本报「❌ 用法：<id> <档> <版号>」，**两种广告写法都跑不通**。
    ⚠️ 归一只在这一处做；`.cmd` 里不许再拼参数（它只能纯 ASCII，且本项目的工具
       执行不了 cmd.exe ⇒ 写在那边等于没验证）。
    """
    return ['--dry' if a == 'dry' else a for a in argv]


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
    # 位置形态的 `dry` 在这里归一成 `--dry`，见 normalize_dry() 的注释
    args = ap.parse_args(normalize_dry(sys.argv[1:]))

    if not os.path.isdir(OUT):
        die("找不到 %s" % os.path.relpath(OUT, ROOT))
    man = load_manifest()

    if args.list or not args.id:
        cmd_list(man, args.morph_filter, args.only_missing)
        return
    if not args.morph:
        die("用法：`python tools/pick-card.py <id> <档> <版号>`，或 `--list` 先看看有哪些")
    ver = args.ver
    if not ver and args.dry:
        # 🔴 `--dry` 是**只读路径** ⇒ 允许省版号，默认看「第 2 版」（挑的就是它）。
        #    不带 `--dry` 时**一律要求显式版号** —— 那一步是**真的对换文件与台账**，
        #    让「少打一个数字」直接变成一次落盘，属不可逆的手滑（§9.1 第 4 条）。
        ver = 2
    if not ver:
        die("用法：`python tools/pick-card.py <id> <档> <版号>`"
            + "（只看会发生什么就加 `--dry`，那时版号可省），或 `--list` 先看看有哪些")
    cmd_pick(man, args.id, args.morph, ver, args.dry)


if __name__ == "__main__":
    main()
