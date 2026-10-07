# -*- coding: utf-8 -*-
"""把 `tools/.traits-cache/*.json` 里的**中文形态描述**归一化成 `fish-traits.json` 的
英文标准字段（`form` / `fins` / `markings` / `colour`）。

## 为什么要脚本 + 人工两道
「抓」能全自动，「归一化」需要判断力 —— 但**逐条手写 100+ 条也不现实**。
所以：脚本按**短语表**出一份草稿（`_draft.json`），人工只做「审」不做「译」。
脚本会报告**没命中的从句**，那些就是短语表要补的洞。

## 三条硬口径（来自 `fish-traits.json` 的 `_schema` 与 §17.5）
1. **`markings` 只写花纹形状，不许出现颜色词** —— 颜色只归 `palette_desc()`（游戏里的
   颜色是夸张体系，照搬现实配色会把 5 档配色体系搞坏）。
   所以本脚本**先把颜色词从句子里摘出去**，剩下的才进 `markings`。
2. **`colour` 只存档、不喂提示词** —— 现实配色留着给人看，不参与出图。
3. **查不到就留空** —— 没命中的从句宁可丢，不许猜。

用法：
  python tools/normalize-traits.py --draft      # 出草稿 + 未命中报告（不写特征表）
  python tools/normalize-traits.py --apply      # 把草稿合并进 fish-traits.json（人工审完后跑）
  python tools/normalize-traits.py --miss       # 只看没命中的从句（补短语表用）
⚠️ 解释器：managed python（只用标准库）
"""
import argparse, json, os, re, sys
from collections import Counter

TOOLS = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(TOOLS, ".traits-cache")
TRAITS = os.path.join(TOOLS, "fish-traits.json")
DRAFT = os.path.join(CACHE, "_draft.json")
MISS = os.path.join(CACHE, "_miss.txt")

# ── 颜色词：先摘出去，**不进 markings** ──
# ⚠️ 只收**真正的颜色**。第一版把「色 / 暗 / 深 / 浅 / 淡」也收进来了 ——
#    结果 `colour` 里全是「灰、色、暗、深」这种字符汤，一点用没有。
#    修饰词（暗/深/浅/淡）不是颜色，靠 COLOR_CLAUSE 整句归档解决。
COLOUR_WORDS = ("灰白", "银白", "灰黑", "青灰", "黄褐", "灰褐", "暗褐", "橙黄", "赤红",
                "灰", "白", "黑", "黄", "红", "褐", "青", "蓝", "绿", "橙", "紫",
                "银", "金", "棕", "粉")
# `colour` 的取法改了：**整句归档**（中文原句，仅供人看，不喂提示词）。
# 判据：句子里既有颜色词，又有身体部位词 —— 这样能滤掉「味道鲜美」这种。
COLOUR_CLAUSE = re.compile("体色|体侧|背部|腹部|腹面|头|鳃盖|鳍|尾|颊|各鳍|通体|全身")

# ── 短语表：(中文正则, 英文, 归类) ──
# 归类：form=体型/头/口/鳞/侧线/尾柄 · fins=各鳍 · markings=花纹形状 · colour=配色
# ⚠️ **表序即优先级**，长句在前 —— 「背鳍、臀鳍与尾鳍相连」必须先于「背鳍」命中。
PHRASES = [
    # ───────── 体型 ─────────
    (r"体(?:型)?呈?长?圆?筒形|体呈长圆筒形|躯干部?近?圆筒状", "an elongated cylindrical body", "form"),
    (r"体(?:型)?呈?舌状", "a tongue-shaped flat body", "form"),
    (r"体(?:型)?呈?(?:长)?椭圆形|体呈卵圆形", "an oval body", "form"),
    (r"体(?:型)?呈?菱形", "a diamond-shaped body", "form"),
    (r"体(?:型)?呈?纺锤形", "a spindle-shaped body", "form"),
    (r"体(?:型)?侧扁而延长|体延长[，、]?而?侧扁|体长而侧扁|体(?:型)?侧扁", "a laterally compressed body", "form"),
    (r"体延长|体长形", "an elongated body", "form"),
    (r"体(?:型)?(?:较)?短(?:而)?高", "a short deep body", "form"),
    (r"体高(?:而)?侧扁", "a deep laterally compressed body", "form"),
    (r"体(?:型)?粗壮|身体粗壮", "a stout body", "form"),
    # 裸词（被逗号切开后只剩这两个字）—— 见 clauses() 里「下限是 2」的注释
    (r"^侧扁$", "a laterally compressed body", "form"),
    (r"^延长$|^细长$", "an elongated body", "form"),
    (r"^体高$", "a deep body", "form"),
    (r"^(?:具|有)?硬刺$", "stout fin spines", "fins"),
    # ───────── 背 / 腹 缘 ─────────
    (r"背部?(?:稍|微)?隆起", "a slightly arched back", "form"),
    (r"腹部?(?:钝)?圆|腹缘圆", "a rounded belly", "form"),
    (r"腹部?无棱|腹棱不(?:明)?显|无腹棱", "no ventral keel", "form"),
    (r"腹(?:部)?(?:有|具)棱", "a keeled belly", "form"),
    # ───────── 头 / 吻 / 口 ─────────
    (r"头(?:部)?(?:较)?大", "a large head", "form"),
    (r"头(?:部)?(?:较)?小", "a small head", "form"),
    (r"头(?:部)?中大", "a medium-sized head", "form"),
    (r"头(?:部)?(?:钝|圆钝)", "a blunt rounded head", "form"),
    (r"头(?:部)?呈?锥形", "a conical head", "form"),
    (r"吻(?:部)?(?:稍|略|微)?(?:突|尖)(?:出)?(?:而)?(?:短)?(?:钝)?", "a short blunt protruding snout", "form"),
    (r"吻(?:部)?(?:尖|长)(?:而)?(?:长|尖)?", "a long pointed snout", "form"),
    (r"吻(?:部)?钝圆", "a blunt rounded snout", "form"),
    (r"口大而斜|口(?:较)?大", "a large mouth", "form"),
    (r"口(?:较)?小", "a small mouth", "form"),
    (r"口端位|口(?:前)?位", "a terminal mouth", "form"),
    (r"口下位|口(?:在)?下方", "an inferior mouth", "form"),
    (r"口上位|口(?:在)?上方", "a superior mouth", "form"),
    (r"上颌(?:稍)?长于下颌", "the upper jaw slightly longer than the lower", "form"),
    (r"下颌(?:稍)?长于上颌", "the lower jaw slightly longer than the upper", "form"),
    (r"无须|口无须|无(?:触)?须", "no barbels", "form"),
    (r"(?:具|有)(?:触)?须(?:4|四)?(?:对)?|口角(?:具|有)须", "barbels at the corners of the mouth", "form"),
    (r"眼(?:较)?大|眼(?:睛)?大", "large eyes", "form"),
    (r"眼(?:较)?小", "small eyes", "form"),
    # ───────── 鳞 / 侧线 ─────────
    (r"体被?栉鳞|被栉鳞", "ctenoid scales", "form"),
    (r"体被?圆鳞|被圆鳞", "cycloid scales", "form"),
    (r"鳞(?:片)?(?:较)?大|大圆鳞", "large scales", "form"),
    (r"鳞(?:片)?(?:细)?小", "small scales", "form"),
    # ⚠️ 通用「无鳞」不在这里 —— 它必须排在最后的最后，见文件末尾的注释
    (r"侧线(?:完全)?|侧线完全", "a complete lateral line", "form"),
    (r"侧线(?:略|微)?(?:呈)?弧形|侧线(?:略)?下弯", "a gently curved lateral line", "form"),
    (r"侧线(?:不)?明显|侧线孔明显", "clearly marked lateral-line pores", "form"),
    # ───────── 尾柄 ─────────
    (r"尾柄(?:较)?短", "a short caudal peduncle", "form"),
    (r"尾柄(?:较)?长", "a long caudal peduncle", "form"),
    (r"尾柄(?:细|窄|侧扁)", "a narrow compressed caudal peduncle", "form"),
    # ───────── 各鳍 ─────────
    (r"背鳍[、，]?臀鳍(?:完全)?(?:与|和)?尾鳍(?:完全)?相连|背鳍、臀鳍完全与尾鳍相连",
     "the dorsal and anal fins joined continuously to the tail fin", "fins"),
    (r"背鳍(?:无硬刺|无(?:硬)?棘)", "a dorsal fin without spines", "fins"),
    (r"背鳍(?:起于|始于)[^，。；]{0,10}", "the dorsal fin set far back", "fins"),
    (r"背鳍(?:较)?长", "a long dorsal fin", "fins"),
    (r"背鳍(?:中)?(?:部)?(?:有|具)缺刻", "a dorsal fin with a notch", "fins"),
    (r"背鳍(?:具|有)硬刺", "a dorsal fin with a stout spine", "fins"),
    (r"臀鳍(?:较)?长", "a long anal fin", "fins"),
    (r"臀鳍(?:具|有)硬刺", "an anal fin with a stout spine", "fins"),
    (r"尾鳍(?:深)?(?:叉|分叉)形|尾鳍深叉", "a deeply forked tail fin", "fins"),
    (r"尾鳍浅(?:分)?叉", "a slightly forked tail fin", "fins"),
    (r"尾鳍(?:呈)?(?:圆|圆)形|尾鳍圆", "a rounded tail fin", "fins"),
    (r"尾鳍(?:呈)?(?:尖|尖)形|尾鳍尖", "a pointed tail fin", "fins"),
    (r"尾鳍(?:呈)?(?:楔|楔)形|尾鳍楔", "a wedge-shaped tail fin", "fins"),
    (r"尾鳍(?:末端)?(?:呈)?(?:凹|微凹)", "a slightly concave tail fin", "fins"),
    (r"无胸鳍", "no pectoral fins", "fins"),
    (r"胸鳍(?:较)?长", "long pectoral fins", "fins"),
    (r"胸鳍(?:较)?短", "short pectoral fins", "fins"),
    (r"腹鳍(?:位于|始于)[^，。；]{0,8}", "pelvic fins set well back", "fins"),
    (r"鳍(?:条)?(?:均)?不分支", "fin rays all unbranched", "fins"),
    # ───────── 花纹（**摘掉颜色后的形状**）─────────
    # ⚠️ `[^，。]{0,6}` 是**给修饰词留位**的。第一版写死了「有若干条纵走线」，
    #    于是「体侧有若干条**灰色**纵走线」直接漏配 —— 中文里形容词几乎必然插在中间。
    (r"(?:体侧)?有(?:若干|数)?条?[^，。]{0,6}(?:纵走|纵行)(?:线|纹|带)",
     "longitudinal lines running along the flanks", "markings"),
    (r"(?:体侧)?有(?:若干|数)?条?[^，。]{0,6}(?:横|垂直)(?:带|纹|条)",
     "vertical bands crossing the flanks", "markings"),
    # ⚠️ 原来这条还带 `|纹`，结果给**鲢鱼这种没有花纹的鱼**也安了一条
    #    「a scatter of markings along the flanks」—— 泛规则宁可不要，只要 `斑`。
    (r"(?:体侧)?有(?:若干|数)?(?:条)?[^，。]{0,6}斑", "spots scattered along the flanks", "markings"),
    (r"(?:具|有)?波状(?:斜)?条纹", "wavy diagonal stripes", "markings"),
    (r"(?:具|有)?条纹|纵纹", "stripes", "markings"),
    (r"(?:具|有)?(?:不规则的)?斑点|(?:具|有)点", "spots", "markings"),
    (r"吻端(?:有|具)?(?:1|一)个?斑", "a single spot at the tip of the snout", "markings"),
    (r"尾柄基部?(?:有|具)?(?:1|一)?(?:个)?(?:暗)?斑(?:块)?", "a blotch at the base of the tail", "markings"),
    (r"鳃盖(?:后缘)?(?:有|具)?(?:1|一)?(?:个)?(?:暗)?斑(?:块)?", "a blotch on the gill cover", "markings"),
    (r"眼(?:后)?(?:上)?(?:方)?(?:有|具)?(?:1|一)?个?(?:暗)?斑", "a spot behind the eye", "markings"),
    # ── 第二轮补进来的高频句式（按 `_miss.txt` 的高频榜补，不是拍脑袋加的）──
    (r"颊部(?:裸露)?无鳞|颊部?裸露无鳞", "bare scaleless cheeks", "form"),
    (r"体细长", "a slender elongated body", "form"),
    (r"(?:前|后)部(?:近)?圆筒形|后部侧扁|前部近圆筒形", "a cylindrical front tapering to a compressed rear", "form"),
    (r"吻(?:短钝|圆钝|钝圆)", "a short blunt snout", "form"),
    (r"下颌(?:稍|略)?突出", "a slightly protruding lower jaw", "form"),
    (r"眼中等大", "medium-sized eyes", "form"),
    (r"鼻孔每侧(?:2|二)个", "two nostrils on each side", "form"),
    (r"下咽齿(?:3|三)行", "pharyngeal teeth in three rows", "form"),
    (r"鱼身覆盖细鳞|覆盖细鳞", "small scales", "form"),
    (r"尾部较细|尾部细", "a slender tail", "form"),
    (r"口中等大", "a medium-sized mouth", "form"),
    (r"侧上位", "the mouth set slightly above the midline", "form"),
    (r"无硬刺|无(?:硬)?棘", "no stout spines", "fins"),
    (r"腹鳍短小|腹鳍短", "short small pelvic fins", "fins"),
    (r"每侧有(?:3|三)个纵隆起嵴", "three longitudinal ridges on each side", "form"),
    # ⚠️ **通用「无鳞」必须最后**：第一版把它排在前面，于是「颊部裸露无鳞」被它先抢走，
    #    出现了「ctenoid scales, naked skin with no scales」这种自相矛盾 —— 同类规则**长串在前**。
    (r"身体无鳞|体无鳞|全身无鳞", "naked skin with no scales", "form"),
]

COMPILED = [(re.compile(p), en, bucket) for p, en, bucket in PHRASES]
COLOUR_RE = re.compile("|".join(COLOUR_WORDS))

# ⚠️ 这些从句**明显不是形态**（习性/分布/经济/烹饪），直接丢掉，不报为「未命中」
NOISE_RE = re.compile(
    "分布于|栖息|洄游|产卵|摄食|食性|主食|养殖|产量|价格|食用|营养|做法|经?济价值|"
    "水温|水深|捕捞|钓|个体|繁殖|生长速度|保护级别|IUCN|列入|俗称|别名|学名|拉丁|"
    "原产|引进|驯化|越冬|索饵|含肉|蛋白|脂肪|卡路里|药|功效|海区|沿岸|河口|"
    # ── 第二批（按 `_miss.txt` 高频榜补）：口味 / 年份 / 评级 / 规格 / 标题 ──
    "鲜美|细嫩|口感|含脂|等级|无危|易危|濒危|形态特征|外形特征|物种简介|生活习性|"
    "^(?:19|20)\\d{2}年|^\\d+[~～-]\\d+(?:cm|毫米|厘米|kg|千克|克|g|mm)|"
    "^重\\d|体重\\d|^约\\d|中国(?:东海|南海|黄海|渤海)|钱塘江|长江|珠江|黑龙江|"
    "近吻端|排列|每侧\\d|^有\\d|^具\\d|^\\d+条$")


def clauses(text):
    """把正文切成候选从句（去编号、去空白）。"""
    t = re.sub(r"\[\s*\d+\s*\]|-->|详情|目录", " ", text)
    t = re.sub(r"\s+", "", t)
    parts = re.split(r"[。；;]", t)
    out = []
    for p in parts:
        for q in re.split(r"[，,、]", p):
            q = q.strip("()（） ")
            # ⚠️ 下限是 **2 不是 3**：中文形态描述里「侧扁」「头小」「口端位」这类
            #    **两字词才是主干**，`体高，侧扁；头小，侧扁` 被逗号切开后全是 2 字。
            #    第一版设 3，直接把「鳊鱼」的体型信息整段过滤掉了（只剩「口端位」）。
            if 2 <= len(q) <= 40:
                out.append(q)
    return out


def norm_one(text):
    """返回 (英文字段 dict, 未命中的从句列表, 颜色原句列表)。

    ⚠️ `colour` **存中文原句**（整句），不是拆出来的颜色字。
       拆字会得到「灰、色、暗、深」这种字符汤；整句（「体色青灰带黄，体侧有灰色纵走线」）
       人才看得懂。反正它**不喂提示词**（见文件头口径 2）。
    """
    buckets = {"form": [], "fins": [], "markings": []}
    unmatched, colour_cl = [], []

    for cl in clauses(text):
        hit = False
        for rx, en, bucket in COMPILED:
            if rx.search(cl):
                if en not in buckets[bucket]:
                    buckets[bucket].append(en)
                hit = True
                break
        if hit:
            continue
        if NOISE_RE.search(cl):
            continue
        # 含颜色词 + 身体部位词 → 当成体色原句归档（不参与 markings）
        if COLOUR_RE.search(cl) and COLOUR_CLAUSE.search(cl):
            if cl not in colour_cl:
                colour_cl.append(cl)
            continue
        if COLOUR_RE.search(cl):
            continue          # 只含颜色词、没有部位 → 丢掉，别当花纹
        unmatched.append(cl)

    # 去重后拼句；**markings 不许出现颜色词**（保险：再滤一遍）
    out = {}
    for k, arr in buckets.items():
        if not arr:
            continue
        if k == "markings":
            arr = [a for a in arr if not COLOUR_RE.search(a)]
            if not arr:
                continue
        out[k] = ", ".join(dict.fromkeys(arr))
    return out, unmatched, colour_cl


def load_ok():
    recs = []
    if not os.path.isdir(CACHE):
        sys.exit("没有缓存目录，先跑 fetch-traits.py")
    for f in sorted(os.listdir(CACHE)):
        if not f.endswith(".json") or f.startswith("_"):
            continue
        d = json.load(open(os.path.join(CACHE, f), encoding="utf-8"))
        if d.get("ok"):
            recs.append(d)
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--miss", action="store_true")
    ap.add_argument("--redo", action="store_true",
                    help="连已入表的也重出（补了短语表后想整体重算时用；--apply 会覆盖同 id）")
    args = ap.parse_args()
    if not (args.draft or args.apply or args.miss or args.redo):
        sys.exit("要 --draft / --apply / --miss / --redo 之一")

    have = json.load(open(TRAITS, encoding="utf-8")) if os.path.exists(TRAITS) else {}
    done = set() if args.redo else {k for k in have if not k.startswith("_")}
    recs = load_ok()

    draft, allmiss = {}, []
    for d in recs:
        if d["id"] in done:
            continue
        got, miss, cs = norm_one(d.get("text", ""))
        if miss:
            allmiss.extend("%s(%s): %s" % (d["id"], d["name"], m) for m in miss)
        if not got.get("form"):
            continue                      # 连体型都提不出来 → 不进草稿（宁缺勿猜）
        entry = {"name": d["name"], "species": "", "form": got.get("form", ""),
                 "fins": got.get("fins", ""), "markings": got.get("markings", ""),
                 "colour": "；".join(cs[:3]) if cs else "",
                 "source": "%s %s" % (d.get("how", "?"), d.get("url", "")[:70])}
        draft[d["id"]] = entry

    open(MISS, "w", encoding="utf-8").write("\n".join(allmiss))
    json.dump(draft, open(DRAFT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print("可归一化（未入表）: %d 条" % len([d for d in recs if d["id"] not in done]))
    print("产出草稿: %d 条 → %s" % (len(draft), DRAFT))
    print("未命中从句: %d 条 → %s（补短语表用）" % (len(allmiss), MISS))
    c = Counter(draft[k].get("fins") == "" and "无鳍描述" or "有鳍描述" for k in draft)
    print("草稿里: 有鳍 %d / 无鳍 %d；有花纹 %d / 无花纹 %d"
          % (c["有鳍描述"], c["无鳍描述"],
             sum(1 for k in draft if draft[k]["markings"]),
             sum(1 for k in draft if not draft[k]["markings"])))

    if args.miss:
        print("\n".join(allmiss[:60]))
    if args.apply:
        n = 0
        for k, v in draft.items():
            have[k] = v
            n += 1
        json.dump(have, open(TRAITS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("已合并 %d 条进 %s" % (n, TRAITS))


if __name__ == "__main__":
    main()
