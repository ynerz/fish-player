# -*- coding: utf-8 -*-
"""抠图 —— 把卡面背景换成**真 alpha 通道**（RGBA 透明 PNG）。

为什么用这个而不是「提示词里写透明背景」：
  扩散模型输出的是**像素**，它没有「文件格式」这个概念。
  在提示词里写 `standard PNG transparent format` 不会产出 alpha ——
  它只会画出一个**棋盘格**（那是它见过的「透明」的视觉表达）。
  真正能给出 alpha 的是 **BiRefNet**（官方 `Remove Background` 蓝图）：
  一个专门做二分图像分割的模型，输出的是**真 MASK**，不是画出来的。

工作流（照抄官方蓝图 `Remove Background (BiRefNet).json`）：
  LoadImage ─┬──────────────────────────────────────────┐
             │                                          ▼
             └─► RemoveBackground ─► MASK ─► InvertMask ─► JoinImageWithAlpha ─► SaveImage(RGBA)
                    ▲
  LoadBackgroundRemovalModel(birefnet.safetensors)

⚠️ **极性必须反转**（`InvertMask`）：`RemoveBackground` 的 MASK 是
   **亮 = 背景**；而 alpha 要的是**亮 = 主体**。少这一步会得到「鱼透明、底不透明」。
   实测对照：`docs/images/card-ab/_chk-A02-invert.png`（对）vs `_chk-A02-raw.png`（反）。

实测：
  · 每张 1.5~3 秒（含首次模型加载），比生成一张图的 40~55 秒可以忽略。
  · alpha 基本是二值的：77% 全透明 / 21% 实心(254) / 0.2% 软边。
    鱼身内部是 254 不是 255（0.4% 半透）——**肉眼无感，不做归一化**（少一个旋钮少一种故障）。

前置：`birefnet.safetensors`（423 MiB）放
      `D:\\Comfy-Desktop\\ComfyUI-Shared\\models\\background_removal\\`
      来源 `https://hf-mirror.com/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors`

用法：
  python tools/cutout.py --list A01,A02        # 母版 → <id>-normal.png；5 档就地转 RGBA
  python tools/cutout.py --all
  python tools/cutout.py --list A02 --dry      # 只列要处理什么

⚠️ 解释器：managed python（只用标准库，不需要 PIL）
"""
import argparse, json, os, shutil, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "assets", "cards")
HOST = "http://127.0.0.1:8188"
COMFY_INPUT = r"D:/Comfy-Desktop/ComfyUI-Shared/input"
COMFY_OUTPUT = r"D:/Comfy-Desktop/ComfyUI-Shared/output"

BG_MODEL = "birefnet.safetensors"
MORPHS = ("normal", "bright", "albino", "golden", "shiny")


def cut_nodes(image_node, prefix):
    """返回「抠图 → RGBA」的节点片段，merge 进任意工作流即可。

    image_node 形如 ["8", 0]（VAEDecode 的输出）。
    节点 id 用 90+ 段，避开业务工作流的 1~20。
    """
    return {
        "92": {"class_type": "LoadBackgroundRemovalModel",
               "inputs": {"bg_removal_name": BG_MODEL}},
        "93": {"class_type": "RemoveBackground",
               "inputs": {"bg_removal_model": ["92", 0], "image": image_node}},
        "94": {"class_type": "InvertMask", "inputs": {"mask": ["93", 0]}},
        "95": {"class_type": "JoinImageWithAlpha",
               "inputs": {"image": image_node, "alpha": ["94", 0]}},
    }, {"class_type": "SaveImage", "inputs": {"images": ["95", 0], "filename_prefix": prefix}}


def submit(wf):
    req = urllib.request.Request(HOST + "/prompt",
                                 data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["prompt_id"]


def wait(pid, timeout_s=180):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(1.2)
        h = json.loads(urllib.request.urlopen(HOST + "/history/" + pid, timeout=15).read())
        if pid in h:
            imgs = [i for v in h[pid].get("outputs", {}).values() for i in v.get("images", [])]
            if imgs:
                return os.path.join(COMFY_OUTPUT, imgs[0]["filename"])
            for m in h[pid].get("status", {}).get("messages", []):
                if m[0] == "execution_error":
                    print("      执行失败:", str(m[1])[:200])
            return None
    return None


def cut_one(src_path, dst_path):
    """把 src_path 抠成 RGBA 写到 dst_path。"""
    ref = "cutin_" + os.path.basename(src_path)
    shutil.copy2(src_path, os.path.join(COMFY_INPUT, ref))
    frag, save = cut_nodes(["1", 0], "cut_out")
    wf = {"1": {"class_type": "LoadImage", "inputs": {"image": ref, "upload": "image"}}}
    wf.update(frag)
    wf["96"] = save
    out = wait(submit(wf))
    if not out:
        return False
    shutil.copy2(out, dst_path)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    if args.all:
        ids = sorted(f[:-4] for f in os.listdir(CARDS)
                     if f.endswith(".png") and len(f) == 7 and f[:-4].isalnum()
                     and "-" not in f)
    else:
        ids = [x.strip() for x in args.list.split(",") if x.strip()]
    if not ids:
        ap.error("要 --list 或 --all")

    # 前置自检：模型在不在（不在就直说去下哪个文件，别等到跑一半才报错）
    try:
        info = json.loads(urllib.request.urlopen(
            HOST + "/api/object_info/LoadBackgroundRemovalModel", timeout=10).read())
        opts = info["LoadBackgroundRemovalModel"]["input"]["required"]["bg_removal_name"]
        opts = opts[1]["options"] if isinstance(opts, list) else opts["options"]
        if BG_MODEL not in opts:
            print("⛔ 没找到 %s。请下载到 models/background_removal/：" % BG_MODEL)
            print("   https://hf-mirror.com/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors")
            return 1
    except Exception as e:
        print("⛔ 连不上 ComfyUI（%s）：%s" % (HOST, e)); return 1

    ok = fail = 0
    for fid in ids:
        # 母版 → <id>-normal.png（原色档 = 母版的抠图，不再单独生成，省一次出图）
        # 其余 4 档 → 就地转成 RGBA
        jobs = [(fid + ".png", fid + "-normal.png")]
        jobs += [(fid + "-" + k + ".png", fid + "-" + k + ".png") for k in MORPHS[1:]]
        for src, dst in jobs:
            sp, dp = os.path.join(CARDS, src), os.path.join(CARDS, dst)
            if not os.path.exists(sp):
                print("  跳过 %s：不存在" % src); continue
            if args.dry:
                print("  [dry] %-22s -> %s" % (src, dst)); continue
            if cut_one(sp, dp):
                ok += 1; print("  %-22s -> %s" % (src, dst))
            else:
                fail += 1; print("  %-22s **失败**" % src)
    if not args.dry:
        print("\n成功 %d / 失败 %d" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
