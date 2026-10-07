# -*- coding: utf-8 -*-
"""5 档颜色**独立出图**（图生图）—— 不再用程序化调色派生。

用户口径（2026-10-07）：「**所有版本的鱼都使用生图，而不是简单的变颜色**」。

为什么换成图生图（而不是纯文生图）：
  同一鱼的不同档如果各自独立文生图，**形态会差得很远**（扩散模型每次都在重画）。
  用原色母版当参考图，至少把**构图 / 朝向 / 体型**锚住。

⚠️ 两条铁律（都是实测撞出来的，改之前先读）：
  1. **`denoise` 必须 = 1.0**。这个节点的 latent 是「参考图的编码」而不是干净原图，
     实测 0.65 / 0.45 都会**崩成一片噪点**（不是"保留更多细节"，是彻底跑飞）。
  2. **prompt 必须自带完整风格块**（STYLE + LIGHT + BG）。
     降 denoise 不是保风格的手段 —— **prompt 里不写低多边形，模型就画成写实鱼**
     （第一版只写"把颜色改成金色"，出来一条照片级金鱼）。

用法：
  python tools/gen-morph.py --list A01            # 给 A01 出 5 档
  python tools/gen-morph.py --list A01 --morph golden
  python tools/gen-morph.py --batch 1             # 按生图清单的批次出前 N 条（配合定时任务）

⚠️ 解释器：用 managed python（与 gen-art.py 相同）
"""
import argparse, json, os, shutil, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = r"C:/Users/15001/.workbuddy/binaries/python/versions/3.13.12/python.exe"
CARDS = os.path.join(ROOT, "assets", "cards")

HOST = "http://127.0.0.1:8188"
COMFY_INPUT = r"D:/Comfy-Desktop/ComfyUI-Shared/input"
COMFY_OUTPUT = r"D:/Comfy-Desktop/ComfyUI-Shared/output"

UNET = "qwen_image_2.1_int8_convrot.safetensors"
# 🔴 铁律 3（2026-10-07 实测撞出）：图生图**必须**用 pe_i2i 这个文本编码器。
#    官方 2.1 Image Edit 模板里挂了**两个** CLIPLoader ——
#      `qwen3vl_8b_int8_convrot`        = 文生图用，**喂进去的 images.image_1 会被静默丢弃**
#      `qwen3.5_9b_..._pe_i2i`          = 图生图用，参考图靠它进模型
#    挂错的表现**极隐蔽**：不报错、出图也「像条鱼」，但**所有鱼的同一档位逐像素相同**
#    （实测 A01/A02/A04/A05 四条不同母版 → 5 档图两两完全一致，ComfyUI 输出的哈希按 5 个一循环）。
#    prompt 里那句 "Keep the same shape, pose and framing as the reference image."
#    会让成品看起来「构图确实一致」，从而骗过肉眼。**判别方法：跨鱼比同一档位的像素哈希。**
CLIP = "qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"

SEED = 20261007
STEPS = 25
# ⚠️ **必须是 0**：0 = 「潜变量取参考图自己的尺寸（对齐到 32 的倍数）」→ 出图 = 母版的 1152×768。
#    写 768 时该节点会按 `sqrt(res²·ratio)` 反算，得到的是 768×768 的方图 ——
#    不但与母版 / `docs/images/标准/` 的 3:2 不一致，还会把鱼的鳍尾裁到画面外
#    （check-cards 实测：768 方图那批全部「贴边裁切」FAIL）。
RESOLUTION = 0
DENOISE = 1.0             # ⚠️ 必须是 1.0，见文件头铁律 1
W, H = 1152, 768

# —— 风格块：**每次都要带**，见文件头铁律 2 ——
STYLE = ("low poly 3D render, faceted polygonal surfaces, flat shading per face, "
         "matte material, clean readable silhouette, built from large flat angular facets, "
         "clearly visible polygon edges, minimal surface detail, no texture")
LIGHT = ("strong rim light along the back and tail, no ambient fill light, deep unlit shadow side, "
         "high contrast between the lit edge and the shadow, high-end product render look")
BG = "Plain dark neutral grey background, completely empty, no scenery, no text, no watermark"

# —— 五档颜色句（与 docs/画风与颜色标准.md §7.2 逐字一致）——
MORPHS = [
    ("normal", "natural realistic colouring for this species, muted natural palette"),
    ("bright", "vivid bright saturated colours, punchy high-chroma palette, lively"),
    ("albino", "albino colouring, pale creamy white body, soft pink translucent fins, pale pink eye"),
    ("golden", "bright luminous polished metallic gold body, glowing golden highlights, "
               "rich brass and gold tones, brilliant golden sheen, high luminance"),
    ("shiny",  "iridescent shimmering body covered in sparkling glittering speckles, "
               "bright specular glints, star-shaped sparkle highlights, prismatic sheen"),
]
MORPH_CN = {"normal": "原色", "bright": "亮色", "albino": "白化", "golden": "黄金", "shiny": "闪光"}


def build_workflow(ref_name, prompt, seed):
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "QwenImage21Cache",
              "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "10": {"class_type": "LoadImage", "inputs": {"image": ref_name, "upload": "image"}},
        "5": {"class_type": "TextEncodeQwenImage21",
              # 🔴 铁律 4：`images` 是 **Autogrow** 输入，API 里的键名是**点号扁平名**
              #    `images.image_1` —— 写成 `"images": {"image_1": [...]}` 这种嵌套字典
              #    会被**静默丢弃**（节点收到的 images 是空的）。
              #    症状：`latent_w/latent_h` 退化成 `resolution`（方图），参考图完全不进模型。
              #    见 comfy_api/latest/_io.py 的 `Autogrow._expand_schema_for_dynamic()`
              #    → `finalize_prefix()` 用 "." 拼名字。
              "inputs": {"clip": ["3", 0], "prompt": prompt, "negative_prompt": "",
                         "resolution": RESOLUTION,
                         "images.image_1": ["10", 0], "vae": ["4", 0]}},
        "7": {"class_type": "KSampler",
              "inputs": {"model": ["2", 0], "seed": seed, "steps": STEPS, "cfg": 1.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["5", 0], "negative": ["5", 1],
                         "latent_image": ["5", 2], "denoise": DENOISE}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["4", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": "morph"}},
    }


def run_one(master, morph, desc, fish_id):
    """把母版当参考图，生成某一档"""
    ref_name = "%s_master.png" % fish_id
    shutil.copy2(master, os.path.join(COMFY_INPUT, ref_name))

    prompt = ("%s of a single low-poly fish, full side view, whole body visible, facing left, "
              "centered with generous margin, %s. %s. %s. "
              "Keep the same shape, pose and framing as the reference image."
              % (STYLE, desc, LIGHT, BG))

    wf = build_workflow(ref_name, prompt, SEED)
    req = urllib.request.Request(HOST + "/prompt",
                                 data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    pid = json.loads(urllib.request.urlopen(req, timeout=30).read())["prompt_id"]

    for _ in range(300):
        time.sleep(2)
        h = json.loads(urllib.request.urlopen(HOST + "/history/" + pid, timeout=15).read())
        if pid in h:
            imgs = [i for v in h[pid].get("outputs", {}).values() for i in v.get("images", [])]
            if imgs:
                src = os.path.join(COMFY_OUTPUT, imgs[0]["filename"])
                dst = os.path.join(CARDS, "%s-%s.png" % (fish_id, morph))
                shutil.copy2(src, dst)
                return dst
            # 历史里出现但没图 = 执行失败
            for node in h[pid].get("status", {}).get("messages", []):
                if node[0] == "execution_error":
                    print("      执行失败:", str(node[1])[:200])
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="")
    ap.add_argument("--morph", default="", help="只出某一档")
    ap.add_argument("--skip-existing", action="store_true", help="已有成品的档跳过（断点续跑）")
    args = ap.parse_args()

    ids = [x.strip() for x in args.list.split(",") if x.strip()]
    if not ids:
        ap.error("要 --list 指定鱼 id")

    morphs = [m for m in MORPHS if not args.morph or m[0] == args.morph]
    ok = fail = skip = 0
    for fid in ids:
        master = os.path.join(CARDS, fid + ".png")
        if not os.path.exists(master):
            print("  跳过 %s：没有母版" % fid); fail += 1; continue
        print("[%s]" % fid)
        for key, desc in morphs:
            dst = os.path.join(CARDS, "%s-%s.png" % (fid, key))
            if args.skip_existing and os.path.exists(dst):
                print("    %-7s 已存在，跳过" % MORPH_CN[key]); skip += 1; continue
            r = run_one(master, key, desc, fid)
            if r:
                ok += 1; print("    %-7s ok" % MORPH_CN[key])
            else:
                fail += 1; print("    %-7s **失败**" % MORPH_CN[key])

    print("\n成功 %d / 失败 %d / 跳过 %d" % (ok, fail, skip))
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
