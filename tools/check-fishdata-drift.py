# -*- coding: utf-8 -*-
"""check-fishdata-drift.py — 改了**鱼表数据**（名字 / 体型 / 形态描述）之后，确认「只有该变的变了」。

用法（参数面走 argparse，`-h` 看全量用法、未知开关报错退出 2）：
    python tools/check-fishdata-drift.py [rev]      # 默认 HEAD~1

🔴 为什么不能用 `tools/check-prompt-drift.py`：它把**当前**的鱼表喂给新旧两个模块
   （`prompts_of(mod, fish)`）⇒ 「改鱼名 / 改体型 / 改 form」这类**数据侧**的改动它一条都测不出来
   （那是它的设计：它只管 `gen-art.py` 的**代码**口径漂移）。本轮换的恰恰是数据，得自己对。

⚠️ 这个工具 2026-10-10 当场抓到过 3 条「看着换了、其实提示词一字未动」的鱼
   （`SSS87 / SSS91 / SSS97`）—— 它们**同 seed 同提示词 = 同一张图**，重出等于白跑。
   逐鱼逐档对拍是唯一能发现这件事的方式。

对拍：改动前（rev 的 fish.js + fish-traits.json + gen-art.py）vs 现在，逐鱼逐档比提示词。

为什么不能直接用 tools/check-prompt-drift.py：它把**当前**的鱼表喂给新旧两个模块
（`prompts_of(mod, fish)`），于是「改鱼名 / 改体型」这类**数据侧**的改动它一条都测不出来
—— 那是它的设计（它只管 gen-art.py 的代码口径漂移）。本轮换的恰恰是数据 ⇒ 得自己对。

⚠️ 它在 `tools/` 里落一个**一次性中间产物** `_drift_old.py`（旧版 `gen-art.py`，靠 `__file__`
   定位 ROOT 所以必须落在 `tools/`）。见 `main()` 里 `finally` 与 `.gitignore` 的注释（Q92）。
"""
import argparse
import io, os, json, subprocess, importlib.util, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)

NODE = r"C:/Users/15001/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

# 一次性中间产物的**唯一一处路径声明**（写它 / 删它 / 报错文案都读这里）
DRIFT_OLD = os.path.join("tools", "_drift_old.py")


def parse_args(argv=None):
    """参数面走 **argparse**（Q90，2026-10-12 第 58 轮）。

    ⚠️ 原先 `REV = (sys.argv[1] if len(sys.argv) > 1 else "HEAD~1")` —— 挂在本脚本
       **模块顶层**。于是 `--help` 被当成一个 **rev 名**，接着 `git show --help:src/data/fish.js`
       失败 ⇒ **抛 traceback**（不是「打印用法」，也不是「退出 2」）。
       走 argparse 后：`-h/--help` ⇒ 退出 0、未知开关 ⇒ 退出 **2**
       （与 `tools/argv.js` 在 js 侧约定的「2 = 用法错」同源）。
       ⚠️ 解析必须**排在所有真实动作之前** —— 这样 `--help` 在任何文件读写发生之前就退出。
    """
    ap = argparse.ArgumentParser(
        prog="check-fishdata-drift.py",
        description="改了鱼表数据（名字 / 体型 / 形态描述）之后，确认「只有该变的变了」。")
    ap.add_argument("rev", nargs="?", default="HEAD~1", metavar="rev",
                    help="对拍的另一端（默认 HEAD~1）")
    return ap.parse_args(argv)


REV = parse_args().rev                    # ⚠️ 只解析、不做任何动作（见上面的口径）


def die(msg):
    """用户可见的失败出口 —— **唯一一处**（与 `tools/check-prompt-drift.py` 那句
    `✘ 取不到 …` 同源：同一族的两个工具，失败时给人的东西必须长得一样）。

    🔴 这里原本是 `assert r.returncode == 0, …`（两处）。`assert` 不配当校验口，两个理由：
      ① `python -O`（以及任何带 `-O` 的打包/嵌入解释器）会**把 assert 整段剥掉**
         ⇒ 校验静默消失、工具带着脏输入继续跑；
      ② 它的报错形态是**裸 traceback**（`AssertionError: ('src/data/fish.js', "fatal: …")`），
         对一个「拿 rev 名当输入」的工具来说，人根本看不出是 rev 写错了。
    ⚠️ 退出码 1（不是 2）：rev 取不到是**运行期失败**，不是「命令行用错了」——
       用法错（未知开关）走 argparse 自己的退出码 2（§32-x）。
    """
    sys.stderr.write("✘ %s\n" % msg)
    sys.exit(1)


def git_show(rel):
    r = subprocess.run(["git", "show", "%s:%s" % (REV, rel)], capture_output=True, text=True,
                       errors="replace", cwd=".")
    if r.returncode != 0:
        die("取不到 %s:%s —— %s" % (REV, rel, r.stderr.strip()[:200]))
    return r.stdout


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def main():
    """🔴 整段包在 `try/finally` 里（Q92，2026-10-12 第 58 轮）。

    原来写清理的地方是**最后一行** `os.remove("tools/_drift_old.py")` ——
    中途任何一处抛异常（`git show` 的 assert / node 起不来 / `import` 旧版 gen-art 失败）
    都会把那个**未被 .gitignore 覆盖**的文件留在盘上 ⇒ `git status` 从此一直脏，
    而它长得就像一个「有人手滑加进来的新工具」。⇒ 两处双保险：
      ① 这里 `try/finally`（**异常路径也清理**）；
      ② `.gitignore` 补 `tools/_drift_old.py`（真被 SIGKILL 掉也脏不到 `git status`）。
    """
    try:
        # ① 旧 fish.js → node 求值成 JSON（不换磁盘上的文件）
        old_fish_js = git_show("src/data/fish.js")
        io.open(os.path.join("_tmp", "old-fish.js"), "w", encoding="utf-8",
                newline="\n").write(old_fish_js)
        r = subprocess.run([NODE, "-e",
            "global.window={};global.G={};"
            "new Function(require('fs').readFileSync('_tmp/old-fish.js','utf8')).call(global);"
            "console.log(JSON.stringify(global.G.FISH));"],
            capture_output=True, text=True, errors="replace", cwd=".")
        if r.returncode != 0:
            die("node 求值 `%s` 版 fish.js 失败 —— %s" % (REV, (r.stderr or "").strip()[:300]))
        OLD_FISH = json.loads(r.stdout.strip().splitlines()[-1])

        # ② 旧 gen-art.py → 放到 tools/ 下（ROOT 靠 __file__ 定位），并覆写它的 TRAITS
        io.open(DRIFT_OLD, "w", encoding="utf-8", newline="\n").write(git_show("tools/gen-art.py"))
        OLD = load(DRIFT_OLD, "mod_old")
        NEW = load(os.path.join("tools", "gen-art.py"), "mod_new")
        NEW_FISH = NEW.load_fish()
        OLD_TRAITS = json.loads(git_show("tools/fish-traits.json"))
        OLD.TRAITS.clear(); OLD.TRAITS.update(OLD_TRAITS)   # 关键：旧模块也要用**旧的** traits

        # ③ 逐鱼逐档比
        SLOTS = ["master", "bright", "albino", "golden", "shiny"]

        def prompts_of(mod, fish):
            out = {k: {} for k in SLOTS}
            for f in fish:
                out["master"][f["id"]] = mod.build_prompt(f)
                for k in ("bright", "albino", "golden", "shiny"):
                    desc = mod.morph_pick(f["id"], k, f.get("rar"))[2]
                    out[k][f["id"]] = mod.build_morph_prompt(f, k, desc)
            return out

        NEW_FISH_BY_ID = {f["id"]: f for f in NEW_FISH}
        a = prompts_of(NEW, NEW_FISH)
        b = prompts_of(OLD, OLD_FISH)
        changed_any, per_slot = set(), {}
        for s in SLOTS:
            ids = sorted(k for k in a[s] if a[s][k] != b[s].get(k))
            per_slot[s] = ids
            changed_any |= set(ids)

        print("改动前后逐鱼逐档对拍（%d 条 × %d 档 = %d 个提示词）"
              % (len(NEW_FISH), len(SLOTS), len(NEW_FISH) * len(SLOTS)))
        for s in SLOTS:
            print("  %-7s 变了 %3d 条" % (s, len(per_slot[s])))
        print()
        print("  变了提示词的鱼（去重）= %d 条" % len(changed_any))

        print()
        print("  ✅ 没被波及的鱼 = %d 条" % (len(NEW_FISH) - len(changed_any)))
        print("  变了名字的鱼里，新名字**没**进提示词的：%s" % (
            [i for i in sorted(changed_any)
             if NEW_FISH_BY_ID[i]["name"] not in a["master"][i]] or "（无）"))
        print()
        print("  ⚠️ 判据：**要重出**的鱼必须出现在上面那张变化清单里 —— "
              "同 seed 同提示词 = 同一张图，没变的鱼重出等于白跑。")
        return 0
    finally:
        if os.path.exists(DRIFT_OLD):
            os.remove(DRIFT_OLD)


if __name__ == "__main__":
    sys.exit(main())
