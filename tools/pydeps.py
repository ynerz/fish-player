# -*- coding: utf-8 -*-
"""pydeps.py — `tools/` 里**缺第三方依赖时的唯一出口**（纯库模块，第 63 轮）。

为什么要有它：`tools/` 有 9 个脚本要 PIL（Pillow），而**本机两个解释器分工不同** ——
managed python 只带标准库、conda 那个才装了 Pillow。用错解释器时，原来每个脚本各写各的：

  · 6 个直接 `from PIL import …` ⇒ **裸 traceback**（`ModuleNotFoundError: No module
    named 'PIL'`，指到 import 那一行），人得自己猜「该换哪个解释器、它装在哪」；
  · 3 个有守卫，但**两种措辞**、而且 conda 路径**三处各写一遍**
    （`facet-count.py` 写进文案 / `paint-card.py` 的 `PY` / `prompt-ab.py` 的 `CONDA`）。

⇒ 收成这一处：**文案一句、路径一处、退出码一致**。
⚠️ 这是「同一事实写 N 遍」那条纪律的具体一例（TRAPS 里记过同族：钓场配色 3 份、离线上限 3 份）。

用法（**模块顶层、`from PIL import` 之前**调一次就够）：

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import pydeps                                     # noqa: E402
    pydeps.need_pil("check-cards.py")                 # 抢在下面这句前面
    from PIL import Image, ImageChops

⚠️ 必须**排在 `from PIL import` 之前** —— 守卫唯一的作用就是抢在那个 `ImportError` 前面说话。
⚠️ 可选依赖（缺了也能跑完别的部分）别用 `need_pil()`：那种情况要**明说跳过哪一段**
   （例：`measure-palette-facets.py` 的面片密度那半），见队列 §4「要么报错要么明说」。
⚠️ 本文件是**纯库模块**：没有 `__main__` 入口（`verify §32-x` 按「有没有入口」这个身份免检）。
"""
import sys

# 带 Pillow 的解释器：**唯一一处**声明（工具文案里不再各写一遍）
CONDA_PY = r"C:/Users/15001/miniconda3/python.exe"


def need_pil(where=""):
    """没有 Pillow 就**干净地**退出：一行说清「缺什么 + 去哪换」，不抛 traceback。

    🔴 为什么不用 `assert` / 裸 import：
      ① `assert` 会被 `python -O` 整段剥掉（校验静默消失）；
      ② 裸 import 的报错是 traceback —— 对「换了台机器 / 忘了切解释器」这种
         **环境**问题，人需要的是这一行话，不是八行调用栈。
    ⚠️ 退出码 **1**（运行期失败），不是 2（2 是「命令行用错了」，见 `tools/argv.js` 的口径）。
    """
    try:
        import PIL          # noqa: F401  —— 只探「能不能用」，不在这里用它的任何东西
    except ImportError:
        sys.stderr.write(
            "✘ %s需要 Pillow（PIL）—— 本机装了它的解释器是：%s\n"
            % (("%s：" % where) if where else "", CONDA_PY))
        sys.exit(1)
