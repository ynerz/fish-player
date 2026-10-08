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
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="promptdrift-")
    try:
        old_path = os.path.join(tmp, "gen-art.py")
        blob = subprocess.run(["git", "show", "%s:tools/gen-art.py" % args.rev],
                              cwd=ROOT, capture_output=True, text=True)
        if blob.returncode:
            print("✘ 取不到 %s:tools/gen-art.py —— %s" % (args.rev, blob.stderr.strip()[:120]))
            return 1
        open(old_path, "w", encoding="utf-8", newline="\n").write(blob.stdout)
        # ⚠️ 副本要能读到 traits（按 __file__ 定位）—— 否则对照出来全是假的
        for extra in ("fish-traits.json",):
            src = os.path.join(ROOT, "tools", extra)
            if os.path.exists(src):
                shutil.copy(src, os.path.join(tmp, extra))

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
        if not args.want:
            print("\n（未给 --want：只报告，不判定）")
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
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
