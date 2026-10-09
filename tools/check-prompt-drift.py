# -*- coding: utf-8 -*-
"""check-prompt-drift.py —— 改动提示词口径后，确认**只有该变的变了**。

为什么必须有它（2026-10-08 同一天踩了两次）：
    ① 我把 `palette_desc(f)` 拆成 `palette_color(f) + ", " + shade_for(morph)` 时**丢了末尾的句号**
       ⇒ 母版与每一档的提示词全变了（`darker back. strong` → `darker back strong`）。
       后果不是"难看一点"：`--stale` 会把**全项目所有卡**判成过期，而且新出的图与旧图口径不一致。
    ② 改闪光档的面片/明暗/收尾三句时，很容易顺手动到 `build_prompt()` 的**公共段** ——
       那会同时改掉母版与其他三档，而**它不会报任何错**。
    ⇒ 所以「改口径」这件事必须配一条**逐鱼逐档的逐字对照**：把当前 `build_prompt()` 的输出
      与某个 git 版本的输出比，**列出到底哪些 slot 变了**，让"该变的"和"误伤的"一眼可分。

跑法（只用标准库）：
    python tools/check-prompt-drift.py            # 与 HEAD 比
    python tools/check-prompt-drift.py HEAD~1     # 与上上个提交比
    python tools/check-prompt-drift.py <rev> --want shiny        # 断言「只有 shiny 变」
    python tools/check-prompt-drift.py <rev> --want shiny,golden # 断言「只允许 shiny/golden 变」
    python tools/check-prompt-drift.py <rev> --fields SS,SSS     # 断言「只有这两场的鱼变」

⚠️ 两个断言解决的是**不同的**风险面，别只用一个：
    · `--want <slot>` 管**档位**面 —— 公共段（BASE/构图/LIGHT/GEOM/颜色句前半句）被顺手动到，
      会同时改掉母版与其它档，而它**不报任何错**；
    · `--fields <钓场>` 管**钓场**面 —— 改某一个钓场的口径时，最容易顺手带到隔壁钓场
      （同名同体型的鱼很多，「只改 SS/SSS」这句话要靠它来兑现）。
    ⚠️ 2026-10-10 逐条改写 SS/SSS 时实测：5 个档各变 180 条、且**全部落在 SS/SSS**
      —— 那一次就是靠 `--fields SS,SSS` 把「前面五个钓场一个字都没动」这句话变成可验证的。

退出码：0 = 符合预期（或只打印报告）；1 = 出现了预期外的变化 / 认不出构件。

⚠️ 踩过的坑：把 `git show <rev>:tools/gen-art.py` 写到 `_tmp/` 再 import 时，`TRAITS_FILE` 是
   按 `__file__` 定位的 ⇒ 那个副本**读不到 fish-traits.json**，于是「旧版」少掉拉丁名与形态句，
   对照结果全变（我第一次就把它当成"我改坏了"）。本脚本会自动把 `fish-traits.json` 放到副本旁边。
"""
import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLOTS = ["master", "bright", "albino", "golden", "shiny"]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def prompts_of(mod, fish):
    """{slot: {id: prompt}} —— 走模块自己的拼装函数，不复制任何逻辑。

    ⚠️ `fish` 由调用方传进来（**用当前版读一次**），不要让副本自己去读：
       副本在临时目录里跑 `load_fish()` 会**借 node 去 require `src/data/fish.js`** 而失败
       （路径按 `__file__` 定位）—— 第一次跑就是栽在这，报的还是一句 node 的 MODULE_NOT_FOUND。
    """
    out = {k: {} for k in SLOTS}
    for f in fish:
        out["master"][f["id"]] = mod.build_prompt(f)
        for k in ("bright", "albino", "golden", "shiny"):
            # ⚠️ 传 `rar` —— 传说档有按稀有度的覆盖，不传的话漂移检测比的是**另一套句子**
            desc = mod.morph_pick(f["id"], k, f.get("rar"))[2]
            out[k][f["id"]] = mod.build_morph_prompt(f, k, desc)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rev", nargs="?", default="HEAD", help="对照的 git 版本（默认 HEAD）")
    ap.add_argument("--want", default="",
                    help="允许变化的 slot（逗号分隔：master/bright/albino/golden/shiny）；"
                         "给了就当成断言，出现别的变化即退出码 1")
    ap.add_argument("--fields", default="",
                    help="允许变化的钓场（逗号分隔，如 SS,SSS）；给了就当成断言，"
                         "**这两个钓场之外**的鱼只要有一条变了即退出码 1（见文件头的说明）")
    args = ap.parse_args()

    # 🔴 2026-10-09 修：副本必须放在 **`tools/` 下**（与它要替换的 `gen-art.py` 同级）。
    #   放临时目录（原来是 `tempfile.mkdtemp()`）时副本的 `ROOT = dirname(dirname(__file__))`
    #   指向 `%TEMP%`，而 `gen-art.py` 现在**模块级**就会调 `load_fish()`（`check_deep_motifs()`）
    #   ⇒ import 副本的那一刻就去临时目录找 `src/data/config.js`、直接 MODULE_NOT_FOUND，
    #   工具整条跑不起来（而它是「改提示词口径」之后的必跑步骤）。
    #   ⚠️ 事后设 `old.ROOT` 没用 —— 报错发生在 import 期间，那行根本轮不到执行。
    tmp = os.path.join(ROOT, "tools", "_promptdrift_old.py")   # ⚠️ 必须是 tools/ 下的**文件**
    try:
        old_path = tmp
        blob = subprocess.run(["git", "show", "%s:tools/gen-art.py" % args.rev],
                              cwd=ROOT, capture_output=True, text=True)
        if blob.returncode:
            print("✘ 取不到 %s:tools/gen-art.py —— %s" % (args.rev, blob.stderr.strip()[:120]))
            return 1
        open(old_path, "w", encoding="utf-8", newline="\n").write(blob.stdout)
        # 副本就在 `tools/` 下 ⇒ `fish-traits.json` 与 `src/` 原地就能找到，无需再复制。

        new = load(os.path.join(ROOT, "tools", "gen-art.py"), "mod_new")
        old = load(old_path, "mod_old")
        fish = new.load_fish()          # 只读一次（见 prompts_of 的说明）
        a, b = prompts_of(new, fish), prompts_of(old, fish)

        changed = {}
        for slot in SLOTS:
            ids = sorted(k for k in a[slot] if a[slot][k] != b[slot].get(k))
            if ids:
                changed[slot] = ids
        total = sum(len(v) for v in changed.values())
        n = len(a["master"])
        print("逐鱼逐档对照（%d 条鱼 × %d 档 = %d 个提示词）vs %s："
              % (n, len(SLOTS), n * len(SLOTS), args.rev))
        if not total:
            print("  ✔ 没有任何变化（提示词口径与 %s 完全一致）" % args.rev)
            return 0
        for slot in SLOTS:
            if slot in changed:
                ids = changed[slot]
                print("  %-7s 变了 %3d 条   %s%s"
                      % (slot, len(ids), " ".join(ids[:8]), "…" if len(ids) > 8 else ""))
        # 🔴 钓场面断言：变了的那 180 条**必须全在**允许的钓场里。
        #    ⚠️ 判据按 `field` 逐条查（不是「id 前缀」）—— 前缀是显示层的约定，
        #       `field` 才是数据里的那一栏，两者将来可能分家。
        if args.fields:
            ok_fields = set(x.strip() for x in args.fields.split(",") if x.strip())
            field_of = {f["id"]: f.get("field") for f in fish}
            stray = sorted(set(i for slot in changed for i in changed[slot]
                               if field_of.get(i) not in ok_fields))
            if stray:
                print("\n✘ 出现了**预期外**的变化：%d 条鱼落在允许的钓场（%s）之外 —— %s"
                      % (len(stray), "、".join(sorted(ok_fields)), " ".join(stray[:12])))
                print("  改一个钓场的口径时最常犯的就是这个：同名 / 同体型的鱼很多，"
                      "公共段被改到隔壁钓场去了。")
                return 1
            print("\n✔ 变化的 %d 条全部落在预期钓场内（%s）"
                  % (len(set(i for slot in changed for i in changed[slot])),
                     "、".join(sorted(ok_fields))))
        if not args.want:
            print("（未给 --want：档位面只报告，不判定）")
            return 0
        want = set(x.strip() for x in args.want.split(",") if x.strip())
        unexpected = [s for s in changed if s not in want]
        if unexpected:
            print("\n✘ 出现了**预期外**的变化：%s —— 说明公共段（BASE/构图/LIGHT/GEOM/BG 或"
                  "颜色句前半句）被顺手动到了" % "、".join(unexpected))
            print("  公共段一变，母版与其它档的口径就跟着漂：--stale 会把全项目判成过期，"
                  "新图与旧图也不再同源。")
            return 1
        print("\n✔ 只变了预期的 slot（%s）" % "、".join(sorted(want)))
        return 0
    finally:
        # 副本是 `tools/` 下的一个文件 ⇒ 收尾删文件（原来是删临时目录）
        try:
            os.remove(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
