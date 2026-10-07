# -*- coding: utf-8 -*-
"""批量抓取真实鱼类的形态描述（**只抓取与缓存，不做归一化**）。

为什么要拆成两步：
  362 条的活不是一个对话任务。**抓取能脚本化**（Bing 搜索 + 科普站文章页都能 curl），
  但「把中文形态描述归一化成英文标准字段」需要判断力 —— 那一步交给分批的归一化处理。
  所以本脚本只负责**把资料抓到本地缓存**，归一化再读缓存，互不阻塞。

数据源（2026-10-07 实测，省得再试）：
  ✅ Bing `cn.bing.com/search?q=`    → HTTP 200，10 条结果
  ✅ 科普中国 `kepuchina.cn` 文章页   → HTTP 200，**正文完整**（质量最好的源）
  ❌ 百度百科条目页                   → 403（根页 200 是假象）
  ❌ `fishbase.ropensci.org`（API）  → 已停
  ❌ `fishbase.se` 子页               → 404
  ❌ `zh.wikipedia.org`              → curl 与 WebFetch 都不通

⚠️ **物种名要剥掉称号**：本项目传说档的格式是「称号·物种名」
   （`断崖之王·巨型石斑` → `巨型石斑`，`黑潮之王·蓝鳍金枪` → `蓝鳍金枪`），
   拿整串去搜会搜不到。**先剥 `·` 前缀，再搜**。

🔑 **必须分两遍跑**（2026-10-07 实测踩坑）：
  第一版 `--all` 混跑，结果**第一条 D04 泥鳅就跑了 77 秒还没完**（直查失败 → 搜索兜底
  要发 1 次搜索 + 最多 8 次页面抓取，每次超时 25s）。343 条按最坏情况要跑一整天。
  所以拆成两遍 —— **先批量直查（1 请求/条，快），再只对落空的那批跑搜索**：

用法：
  python tools/fetch-traits.py --list A01,A02,A03   # 只抓这几条（先小样验证）
  python tools/fetch-traits.py --limit 10           # 抓还没缓存的头 10 条
  python tools/fetch-traits.py --all --mode direct  # ① 全量直查（推荐先跑这个，快）
  python tools/fetch-traits.py --all --mode search  # ② 只对①落空的跑搜索兜底（慢，条数少）
  python tools/fetch-traits.py --all                # = --mode both（单条跑，慢）
  python tools/fetch-traits.py --report             # 看已有缓存与失败情况
  python tools/fetch-traits.py --show A03           # 打印某条的缓存内容（人工核对用）

⚠️ 输出**必须 flush**：第一版没 flush，重定向到日志后 `wc -l` 一直是 0，
   看起来像「卡死」，其实只是 stdout 被缓冲。

缓存：`tools/.traits-cache/<id>.json`（gitignore；含来源 URL 与正文节选）
⚠️ 解释器：managed python（只用标准库）
"""
import argparse, base64, html, json, os, re, ssl, sys, time, urllib.parse, urllib.request

# 单次请求超时。25s 太长 —— 落空的条目会成倍叠加（见文件头的两遍式说明）
TIMEOUT = 12
# 搜索兜底最多试几个候选页（8 太贪，白名单过滤后真正会抓的没几个）
SEARCH_PAGES = 4

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.dirname(os.path.abspath(__file__))
LIST = os.path.join(TOOLS, "_fishlist.json")
TRAITS = os.path.join(TOOLS, "fish-traits.json")
CACHE = os.path.join(TOOLS, ".traits-cache")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
# 形态句里最常出现的锚点词
ANCHORS = ["形态特征", "体侧扁", "身体侧扁", "体呈", "背鳍", "臀鳍", "尾鳍", "口", "侧线", "鳞"]
# 打分用的高信息词 —— 出现得越密，这一段越可能是真正的形态描述
STRONG = ["侧扁", "纺锤", "延长", "圆筒", "尾柄", "鳍棘", "鳍条", "分叉", "深叉", "叉形",
          "尾鳍", "背鳍", "臀鳍", "胸鳍", "腹鳍", "侧线", "鳞", "吻", "口", "牙", "齿",
          "眼", "斑", "带", "条纹", "体色", "体长", "体高", "形", "背缘", "腹缘"]
# 明显不是形态描述的噪音（美食/养殖/捕捞/价格）
NOISE = ["做法", "好吃", "美味", "价格", "市场", "养殖技术", "捕捞", "食用", "营养",
         "烹饪", "清蒸", "红烧", "罐头", "渔民", "产卵期", "洄游", "经济鱼类"]


def window_score(seg):
    """一段文本的「像不像形态描述」打分：高信息词密度 − 噪音惩罚。"""
    if len(seg) < 150:
        return -99
    strong = sum(seg.count(w) for w in STRONG)
    noise = sum(seg.count(w) for w in NOISE)
    # 长度归一化到「每 100 字」的信息量
    return strong / (len(seg) / 100.0) - noise / (len(seg) / 100.0) * 0.8


def best_window(text, win=900, step=150):
    """在整页正文里滑动取**信息密度最高**的一段。

    ⚠️ 这是本脚本的第二个坑：第一版取「第一个锚点附近的窗口」，
       结果 A01 沙丁鱼抓到一篇荷兰鲱鱼美食文（锚点先命中在无关段落里）。
       改成**滑窗打分取最密段**，并且多试几个候选站点、选总分的最高者。
    """
    best, best_s = "", -99
    for i in range(0, max(1, len(text) - 200), step):
        seg = text[i:i + win]
        s = window_score(seg)
        if s > best_s:
            best_s, best = s, seg
    return best if best_s > 0 else ""
# 排序用：优先抓这些站点（实测 kepuchina 正文最完整；edu/gov 的鱼类志也可靠）
GOOD_HOSTS = ("kepuchina.cn", "baike.com", "sinica.edu.tw", "fishbase", "shuichan",
              ".edu.cn", ".edu.tw", "sohu.com", "guokr.com", "163.com", "sina.com",
              "qq.com", "baike.baidu.com")
# 只信这些站点（形态描述质量可查证）；其余一律不采
TRUSTED = ("kepuchina.cn", "baike.com", "sinica.edu.tw", "fishbase.net.br", "fishbase.se",
           "shuichan", "fish", "aquarium", ".edu.cn", ".edu.tw", ".gov.cn",
           "sohu.com", "guokr.com", "163.com", "sina.com", "qq.com", "ifeng.com",
           "chinanews", "xhby.net", "agri.cn")

# 已知垃圾域名/路径（工信部备案查询、导航、登录页之类）—— 抓了也是浪费
JUNK = ("beian.", "miit.gov.cn", "mps.gov.cn", "login", "passport", "sogou.com",
        "so.com", "hao123", "wikipedia.org", "zhihu.com", "bilibili.com", "douyin")


def get(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    # ⚠️ 中研院「台灣魚類資料庫」的证书**已过期**，不开这个就用不了它 ——
    #    那是中文形态描述质量最高的源之一，只读公开资料，风险可接受。
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        raw = r.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "replace")


def strip_html(s):
    s = re.sub(r"<script[\s\S]*?</script>", " ", s)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s)


def species_of(name):
    """剥掉「称号·」前缀 —— 本项目传说档格式是 `称号·物种名`。"""
    return name.split("·")[-1].strip()


def unwrap(url):
    """解开 Bing 的跳转包装。

    ⚠️ **这是本脚本的第一个坑**：Bing 的结果链接不是直链，而是
       `https://r.bing.com/ck/a?...&u=a1<base64url>`。第一版把所有 `bing.com`
       的链接一刀切掉 → **候选列表恒为空，3 条全失败且每次只花 3 秒**
       （失败得太快本身就是信号：根本没发几次请求）。
    """
    if "bing.com" not in url:
        return url
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    u = (qs.get("u") or [""])[0]
    if u.startswith("a1"):
        b = u[2:]
        b += "=" * (-len(b) % 4)
        try:
            return base64.urlsafe_b64decode(b).decode("utf-8", "replace")
        except Exception:
            return ""
    return ""


def bing_links(query, n=8):
    """Bing 搜索，返回候选链接（按优先站点排序）。"""
    url = "https://cn.bing.com/search?q=" + urllib.parse.quote(query)
    html_doc = get(url)
    links = re.findall(r'<a[^>]+href="(https?://[^"]+)"', html_doc)
    seen, out = set(), []
    for l in links:
        real = unwrap(l)
        if not real or real in seen:
            continue
        host = urllib.parse.urlparse(real).netloc
        # 图床 / 微软自家 / 跳转余孽 一律丢掉
        if any(b in host for b in ("bing.com", "microsoft", "msn.com", "th.bing")):
            continue
        if any(j in real for j in JUNK):
            continue
        seen.add(real)
        out.append(real)
    out.sort(key=lambda u: 0 if any(g in u for g in GOOD_HOSTS) else 1)
    return out[:n]


def extract_morph(text):
    """取最像形态描述的一段。

    🔑 **优先「形态特征」小节**（2026-10-07 追加）：纯滑窗打分经常把窗口切在
    「形态」和「习性/养殖」的边界上 —— 实测 `罗非鱼` 抓到的那段开头是
    「左右摄食量最大，水温低于18℃…」，形态句混在后面。
    百科条目基本都有专门的形态小节，**先按小节标题定位**，定位不到再退回滑窗。
    """
    for head in ("形态特征", "外形特征", "形态描述", "体型特征"):
        i = text.find(head)
        if i < 0:
            continue
        seg = text[i:i + 520]
        if sum(1 for a in ANCHORS if a in seg) >= 2:
            return seg
    return best_window(text)


# ────────────────────────────────────────────────────────────────────────────
# 🔑 **按名直查百科 = 主路径**（2026-10-07，用户建议「先批量下载百科知识，再补缺失」）
#
# 为什么它比「搜索 + 抓候选页」好得多：
#   ① **1 次请求** vs 1 次搜索 + N 次抓取（网络量降一个数量级，也少打扰源站）
#   ② **天然精确**：页面标题就是词条名 —— 搜索那条路会把「麦穗鱼」匹配到
#      一家叫「麦穗」的公司官网（实测发生过），直查不会
#   ③ **查不到就是 404** → **虚构物种零误判**（星磷鱼 / 虚空鳗 / 无相鲲 全是 404）
#   实测产出率 **约 75%**，（同一批鱼）搜索路径只有约 22%。
#
# ⚠️ 它有两个副作用，靠**校验**挡掉（都已实测）：
#   · **撞名**：`石斑鱼` → 配音演员「石班瑜」→ 标题不含词条名 → 拒收
#   · **落到近义页**：`鲫鱼` → 「金鱼」→ 同样被标题校验挡掉
#   挡掉之后**回落到搜索路径**，不硬凑。
# ────────────────────────────────────────────────────────────────────────────
BAIKE_WIKI = "https://www.baike.com/wiki/"
FISHY = ("鱼", "科", "属", "纲", "目", "水", "鳃", "鳍", "鳞")


def title_matches(name, title):
    """标题是否就是这个词条。**三层判定，逐层放宽**：

    ① 互为子串 —— 正常情况（`鳊鱼` vs `鳊`）
    ② 字符重合 ≥ 0.6 —— **挡异体字误杀**。实测 `竹荚鱼` 的条目页标题写作
       「日本竹筴鱼」（**筴是荚的异体字**），互为子串都判不出，直接误杀一条本来
       有完整形态段的条目。重合度：竹荚鱼∩日本竹筴鱼 = {竹,鱼} / 3 = 0.67 → 收
    ③ 重合度阈值为什么是 0.6：`鲫鱼` vs `金鱼`（近义页）= 0.50、
       `石斑鱼` vs `石班瑜`（撞名的人）= 0.33 —— **都要挡住**，所以阈值必须在
       0.50 与 0.67 之间。取 0.6。
    """
    if name in title or title in name:
        return True
    if not title or not name:
        return False
    hit = sum(1 for c in set(name) if c in title)
    return hit / float(len(set(name))) >= 0.6


# 🔴 **限流信号**（2026-10-07 实测，这是直查路径最要命的一条）：
#    连续请求约 12 次之后，快懂百科开始返回**「验证码中间页」**
#    （`<title>验证码中间页</title>` + 字节跳动的 captcha sdk）。
#    ⚠️ 如果只按「不像百科条目页」判落空，**整轮抓取的后半段全是假失败**，
#    而且会把这些假失败写进缓存、第二遍搜索又白跑 —— 一个错误变成三重浪费。
#    所以：**识别限流 → 长退避重试 → 仍不通就整轮中止**，绝不写缓存。
BLOCK_MARKS = ("验证码中间页", "captcha", "安全验证", "访问过于频繁", "请稍候重试")


def is_blocked(doc):
    low = doc[:2000].lower()
    return any(m.lower() in low for m in BLOCK_MARKS)


# 页面**自证别名**用的标记词。别名该由页面自己声明，**不该由我猜**
# （维护一张人工 ALIAS 表 = 拿我的记忆当证据，违反「不编造」）。
ALIAS_MARKS = ("又名", "又称", "亦称", "俗称", "别名", "也叫", "又叫")


def self_declared_alias(name, summary):
    """页面是否**自己声明**了「又称 `<name>`」。

    ⚠️ 必须要求标记词**紧跟**名字（中间只许有分隔符/空格）：
       · `又称小头睡鲨`（我们要查的就是「小头睡鲨」）→ **收**
       · `又名金鲫鱼`（里面虽然含「鲫鱼」）→ **不收** —— 因为「鲫鱼」前面是「金」，
         它属于另一个名字「金鲫鱼」。**这正是 `鲫鱼` 会被误判成 `金鱼` 的那条路径**，
         一条宽松的子串判定会把它放进来。
    """
    for m in ALIAS_MARKS:
        if re.search(re.escape(m) + r"[\s、，,（(]*" + re.escape(name), summary):
            return True
    return False


def baike_direct(name):
    """按名直查快懂百科。返回 dict：ok=True 抓到 / ok=False + reject 原因。

    `blocked=True` 表示被限流（**不是**「这条鱼查不到」）—— 调用方须退避重试。
    """
    url = BAIKE_WIKI + urllib.parse.quote(name)
    try:
        doc = get(url)
    except Exception:
        return {"ok": False, "reject": "404 / 拉不到"}
    # ⚠️ 这里**只报告、不重试**：退避只允许有一个地方做（主循环），
    #    否则两处各睡一遍（实测叠加成 77s）纯属浪费，而且主循环还不知道发生了什么。
    if is_blocked(doc):
        return {"ok": False, "blocked": True, "reject": "被限流(验证码)"}
    text = strip_html(doc)
    if "-快懂百科" not in text:
        return {"ok": False, "reject": "不像百科条目页"}
    title, _, rest = text.partition("-快懂百科")
    title = title.strip()
    summary = rest[:200]
    # ① 标题校验：挡撞名与近义页（见 title_matches 的三层判定）。
    #    ⚠️ 唯一的例外是**页面自证别名** —— 很多鱼在百科上的条目标题用的是另一个
    #    常用名（`小头睡鲨` → 条目标题「格陵兰睡鲨」、`巨口鳗` → 「吞噬鳗」）。
    #    这些**该收**，但和「`鲫鱼` 跳到 `金鱼`」「`石斑鱼` 撞到演员石班瑜」在日志里
    #    长得一模一样（都是「标题不符」）→ 只能靠**页面自己写没写「又称 <名字>」**来分。
    if not title_matches(name, title) and not self_declared_alias(name, rest[:600]):
        return {"ok": False, "reject": "标题不符（%s）" % title[:16]}
    # ② 摘要校验：必须是水生生物（挡掉同名的人 / 公司 / 地名）
    if not any(w in summary for w in FISHY):
        return {"ok": False, "reject": "摘要不像水生生物"}
    seg = extract_morph(text)
    if not seg or sum(1 for a in ANCHORS if a in seg) < 2:
        # ⚠️ **短条目不能直接扔**。实测 `沙丁鱼` 的条目页全页才 536 字
        #    （只有学名 + 科属，没有展开的形态段），但标题、摘要都对，
        #    里面「硬骨鱼纲 鲱形目 鲱科 沙丁鱼属」这些**科属信息对归一化有用**。
        #    判据用「整页长度 < 900」而不是「取不到窗口」—— 避免把啰嗦但无关的
        #    长页面（美食/养殖文）也放进来。带 `thin` 标记，归一化时知道信息量少。
        if len(text) < 900 and any(w in text for w in FISHY):
            return {"ok": True, "title": title, "url": url, "thin": True,
                    "text": rest[:700]}
        return {"ok": False, "reject": "正文没有形态描述"}
    return {"ok": True, "title": title, "url": url, "text": seg}


# 查询措辞要**轮着试**：同一个物种，不同措辞翻出来的站点差别很大
# （实测「泥鳅 形态特征 侧扁 背鳍…」全是 403/无关页，换个说法就出别的站）
# 查询措辞要**轮着试**：同一个物种，不同措辞翻出来的站点差别很大。
# ⚠️ `site:` **没用** —— 实测 `... 形态特征 site:kepuchina.cn` 与去掉它返回的候选**完全一样**，
#    Bing 直接忽略了限定符。别指望定向。
QUERIES = [
    "%s 形态特征 侧扁 背鳍 尾鳍",
    "%s 外形特征 身体 鳍 鳞 描述",
    "%s 鱼 形态 鉴别特征",
]

# ────────────────────────────────────────────────────────────────────────────
# 🔑 **多源轮询**（2026-10-07 实测后的架构决定）
#
# 为什么必须轮询：**中文百科站几乎全都在快速限流**，逐站实测结果——
#   · 快懂百科 `baike.com/wiki/<名>` —— 有专门的「形态特征」段，质量最高；
#     但约 **15~20 次**后返回「验证码中间页」，冷却 **>5 分钟**（77s 退避仍不通）
#   · 搜狗百科 `baike.sogou.com/Search.e?sp=S<名>` —— **搜索结果页的头条摘要就含形态句**
#     （实例：「银鲴体长而侧扁；头小，呈锤形；口下位；下颌前缘有薄的角质…」），
#     但约 **4 次**后弹验证码页（`SourceVerifyCode`）
#   · 百度百科 —— **永久 403**（补完整浏览器头、加 Referer 都无效）
#   · 中文维基 `zh.wikipedia.org` / `wikiwand` —— 本机网络**全部超时**
#   · 中国大百科 / 物种2000 / 自然标本馆 —— 404 或超时
#   · Bing 搜索 —— 不限流，但结果摘要以食用/钓鱼/知乎为主，**形态命中率低**
# 结论：**单源必死**。「按站轮询 + 每站独立冷却 + 越封越久 + 断点续跑」才是能跑完的形态。
# ────────────────────────────────────────────────────────────────────────────
SOGOU = "https://baike.sogou.com/Search.e?sp=S"

# 别名表：**本项目的鱼名 → 百科上的条目标题**（同物异名，去查对方那个名字）。
#
# ⚠️ 只登记**确认过的同物异名**。它和「近义页」必须分清：
#   · 同物异名（该收）：`溪哥` = `长鳍马口鱲`、`花䱻` = `花骨鱼` —— 就是同一种鱼的两个名字
#   · 近义页（**不许收**）：`鲫鱼` 的条目会跳到「**金鱼**」—— 那是另一个形态
#     （野生鲫鱼 vs 观赏金鱼，体型鳍形差得远），收了就是把错的形态标成「已查证」。
#   两者在「标题不符」的日志里长得一样，**必须人工逐条判断**，不能靠字符重合自动判。
#
# 工作流：跑完一轮 → 看落空记录里的「标题不符（X）」→ 判定 X 是不是同物异名
#         → 是就登记进来 → 重跑那几条。
ALIAS = {
    "溪哥": "长鳍马口鱲",        # 同物异名
    "花䱻": "花骨鱼",            # 同物异名（Hemibarbus maculatus）
    "山女鳟": "马苏大麻哈鱼",      # 山女鳟 = 马苏大麻哈鱼的陆封型，同种
    "鲈鱼": "中国花鲈",          # Lateolabrax maculatus
    "黑鱼": "乌鳢",              # Channa argus
}
# ⛔ **明确不登记的反例**（留档，防止以后有人「顺手」加进来）：
#   `鲶鱼` 的条目会跳到「**江鳕**」—— 那是**另一个物种**（鲇科 vs 鳕科），
#   标题校验把它挡下来了，**这是对的**。同物异名 vs 异种，必须一条条看，
#   看名字像就登记 = 把错的形态标成「已查证」。


def sogou_direct(name):
    """取搜狗百科**搜索结果页**头条百科条目的摘要。

    ⚠️ 两个坑：
      ① 这不是条目页而是搜索页 —— 摘要靠前，后面接的是别的结果。实测 `马口鱼`
         的滑窗抓到了「福安 · 建制沿革」这种完全无关的段，所以加**物种名必须落在窗口里**的闸。
      ② 验证码页的特征串是 `SourceVerifyCode` / `id="ip-time-p"`，用它判限流。
    """
    url = SOGOU + urllib.parse.quote(name)
    try:
        doc = get(url)
    except Exception:
        return {"ok": False, "reject": "搜狗拉不到"}
    if "SourceVerifyCode" in doc or "ip-time-p" in doc:
        return {"ok": False, "blocked": True, "reject": "被限流(搜狗验证码)"}
    text = strip_html(doc)
    seg = extract_morph(text)
    if not seg or name not in seg:
        return {"ok": False, "reject": "搜狗头条摘要不是这条鱼"}
    if sum(1 for a in ANCHORS if a in seg) < 2:
        return {"ok": False, "reject": "搜狗摘要缺形态描述"}
    return {"ok": True, "url": url, "text": seg}


def search_path(name):
    """Bing 搜索 → 白名单站点 → 取形态段。"""
    links = []
    for tpl in QUERIES:
        try:
            links = bing_links(tpl % name)
        except Exception:
            continue
        if links:
            break
    if not links:
        return {"ok": False, "reject": "搜索无结果"}

    # 🔴 **只收白名单站点**。放开之后立刻出事：`麦穗鱼` 搜到一家叫「麦穗」的公司官网
    #    （maisuihuoke.com），锚点少也被判通过 —— 于是垃圾进了特征表。
    #    **精度优先于覆盖率**：查不到就留空，不许把无关网页当资料。
    best, best_s, best_url = "", -99, ""
    for url in links[:SEARCH_PAGES]:
        host = urllib.parse.urlparse(url).netloc
        if not any(g in host or g in url for g in TRUSTED):
            continue
        try:
            page = strip_html(get(url))
        except Exception:
            time.sleep(0.3)
            continue
        seg = best_window(page)
        if not seg or name not in seg:
            time.sleep(0.3)
            continue
        s = window_score(seg)
        if s > best_s:
            best_s, best, best_url = s, seg, url
        # 已经足够好就别再试更多站点了（省时间也少打扰源站）
        if best_s >= 22:
            break
        time.sleep(0.3)

    if not best or sum(1 for a in ANCHORS if a in best) < 2:
        return {"ok": False, "reject": "搜索没找到含形态描述的页面"}
    return {"ok": True, "url": best_url, "score": round(best_s, 1), "text": best}


# (key, 显示名, 抓取函数, 首次被限流后的冷却秒数)
SOURCES = [
    ("baike", "快懂百科", baike_direct, 420),
    ("sogou", "搜狗百科", sogou_direct, 600),
    ("bing",  "Bing搜索", search_path,  90),
]
SOURCE_COOLDOWN = {k: cd for k, _, _, cd in SOURCES}
MODE_SOURCES = {"direct": ("baike", "sogou"),
                "search": ("bing",),
                "both":   ("baike", "sogou", "bing")}


def fetch_one(f, mode, state):
    """按 `mode` 指定的源**依次轮询**一条鱼。

    `state[key]` 存每个源的冷却状态。被限流 → 该源冷却（**越封越久**：冷却 × 已连续封禁次数，
    上限 4×），然后试下一个源。全部源都没命中才写落空。
    ⚠️ 若有源**当时正在冷却**，落空记录标 `partial=True` —— 否则会把「源在冷却」误当成
       「这条鱼现实中查不到」，下一轮就白跑了。
    """
    fid, name = f["id"], f["name"]
    sp = species_of(name)
    sp = ALIAS.get(sp, sp)          # 同物异名 → 改用百科上的条目名去查
    enabled = MODE_SOURCES[mode]
    rejects, cooling, verdicts = [], False, []

    for key, label, fn, _cd in SOURCES:
        if key not in enabled:
            continue
        if time.time() < state[key]["until"]:
            cooling = True
            rejects.append("%s冷却中" % label)
            continue
        try:
            d = fn(sp)
        except Exception as e:
            d = {"ok": False, "reject": "%s异常 %s" % (label, str(e)[:24])}
        if d.get("blocked"):
            st = state[key]
            st["blocks"] += 1
            wait = SOURCE_COOLDOWN[key] * min(4, st["blocks"])
            st["until"] = time.time() + wait
            cooling = True
            rejects.append("%s被限流(冷却%.0fs)" % (label, wait))
            continue
        if d.get("ok"):
            state[key]["blocks"] = 0
            state[key]["hits"] += 1
            out = {"id": fid, "name": name, "species": sp, "ok": True,
                   "how": label, "url": d["url"], "text": d["text"]}
            if d.get("thin"):
                out["thin"] = True
            return out
        state[key]["blocks"] = 0
        verdicts.append(label)       # 该源跑通了并给了否定结论 → 算一条 verdict
        rejects.append("%s:%s" % (label, d.get("reject", "未命中")))

    out = {"id": fid, "name": name, "species": sp, "ok": False, "how": "miss",
           "err": " | ".join(rejects)}
    # 🔴 **口径修正（2026-10-07）**：`partial` 原来的条件是「有源在冷却」—— 太宽。
    #    实测就是这样把自己骗了：68 条被标成「冷却未跑全」，其实绝大多数是
    #    **主源（快懂）已经明确给了否定结论**（404 / 标题不符 / 正文没有形态描述），
    #    只是搜狗恰好在冷却。于是每一轮都重跑，白烧配额。
    #    正确口径：**只要有一个源跑通并给出否定结论，就算真落空**（"不是我"本身是结论）。
    #    只有「所有源都被限流/冷却、一条结论都没拿到」才是真正的 `partial`。
    if cooling and not verdicts:
        out["partial"] = True
    return out


def all_cooling(state, mode):
    return all(time.time() < state[k]["until"]
               for k, _, _, _ in SOURCES if k in MODE_SOURCES[mode])


# ────────────────────────────────────────────────────────────────────────────
# ⛔ **设计上虚构的鱼不走网络查证**（2026-10-07 追加，省掉一半无用请求）
#
# 实测：`SS`（星辰场）**80 条** + `SSS`（时空场）**100 条** = **180 条**，
# 名字全是「星磷鱼 / 陨铁鲷 / 真空鳐 / 时砂小鱼 / 溯流鲑 / 零度蝶鱼」这类架空组合词，
# **没有现实对应物种**，直查必然 404。
#
# 为什么必须显式跳过，而不只是「查不到也无所谓」：
#   **每条 404 同样在消耗站点的限流配额** —— 实测快懂百科约 46 次请求就封 7 分钟，
#   拿这 46 次去换虚构鱼的空请求，等于**用真实鱼的配额换空气**。
#   （这轮就白烧了一轮：跑到 SS 段才发现。）
#
# 它们**本来就该走推导路径**（`gen-art.py` 的形态推导正是按名字造的），
# 所以给它们写一条 `how: "fictional"` 的缓存，让 `--report` 的分母完整、不再重跑。
# ────────────────────────────────────────────────────────────────────────────
def is_fictional(fid):
    return re.match(r"^S{2,}", fid) is not None      # SS / SSS


def load_list():
    if not os.path.exists(LIST):
        sys.exit("缺少 tools/_fishlist.json —— 先用 gen-art.py 导出鱼表")
    return json.load(open(LIST, encoding="utf-8"))


def cached_ids(only_ok=False):
    """已缓存的 id。

    ⚠️ **失败的缓存不算数**：否则一次网络抖动就把这条鱼永久判死，重跑也跳过它。
    """
    if not os.path.isdir(CACHE):
        return set()
    out = set()
    for f in os.listdir(CACHE):
        # ⚠️ **必须跳过 `_` 开头的辅助文件**（`_draft.json` / `_run*.log`）。
        #    第一版只过滤 `.json` 后缀，于是 `_draft.json` 也被当成一条缓存 ——
        #    报告里「未抓取」变成 -1，而且它在 `--report` 的落空分支里
        #    取 `d["name"]` 直接 KeyError。**统计脚本自己也会静默算错。**
        if not f.endswith(".json") or f.startswith("_"):
            continue
        if only_ok:
            try:
                if not json.load(open(os.path.join(CACHE, f), encoding="utf-8")).get("ok"):
                    continue
            except Exception:
                continue
        out.add(f[:-5])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--show", default="")
    ap.add_argument("--mode", default="both", choices=("direct", "search", "both"),
                    help="direct=只直查百科（快，先跑）；search=只搜索兜底（慢，后跑）")
    ap.add_argument("--sleep", type=float, default=1.5, help="每条之间的间隔（秒），别打太快")
    ap.add_argument("--maxwait", type=float, default=600, help="全源冷却时单次最长等待秒数")
    ap.add_argument("--include-fictional", action="store_true",
                    help="连 SS/SSS 虚构物种也去查（默认跳过，省站点配额）")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)

    if args.report:
        have = cached_ids()
        from collections import Counter
        # 判一条 err 里有没有**任何**「某源跑通了并给了否定结论」的痕迹。
        # 有 → 这条是真落空，不是「冷却未跑全」（口径见 fetch_one 末尾的注释）。
        def has_verdict(err):
            for part in (err or "").split(" | "):
                if "冷却中" in part or "被限流" in part:
                    continue
                if ":" in part or "：" in part:
                    return True
            return False

        howc, thin_n = Counter(), 0
        miss, partial, okd, fic = [], [], [], []
        for i in sorted(have):
            d = json.load(open(os.path.join(CACHE, i + ".json"), encoding="utf-8"))
            howc[d.get("how", "(旧:纯搜索)")] += 1
            if d.get("ok"):
                okd.append(d)
                thin_n += 1 if d.get("thin") else 0
            elif d.get("how") == "fictional":
                fic.append(d)
            elif d.get("partial") and not has_verdict(d.get("err", "")):
                partial.append(d)
            else:
                miss.append(d)
        total_fish = len(load_list())
        print("缓存 %d 条（全表 %d）：" % (len(have), total_fish))
        print("  ✅ 命中 %3d   （其中短条目 %d）" % (len(okd), thin_n))
        for k, v in howc.most_common():
            if k not in ("miss", "fictional"):
                print("        · %-12s %3d" % (k, v))
        print("  ⛔ 设计上虚构 %3d  （SS/SSS 场，走推导路径，不查证）" % len(fic))
        print("  ⏳ 源冷却未跑全 %3d  ← 不是查不到，下轮重跑" % len(partial))
        print("  ✗  真落空     %3d  （退回推导路径）" % len(miss))
        n_real = total_fish - len(fic)
        print("  → 现实物种 %d 条，已命中 %d（**%.0f%%**）"
              % (n_real, len(okd), 100.0 * len(okd) / max(1, n_real)))
        print("  ─  未抓取     %3d" % (total_fish - len(have)))
        print("已归一化进特征表：%d"
              % len([k for k in json.load(open(TRAITS, encoding="utf-8")) if not k.startswith("_")]))
        if miss:
            print("\n真落空的（这些现实中确实没有中文形态资料，退回推导）：")
            for d in miss:
                print("  %s %s —— %s" % (d["id"], d["name"], d.get("err", "")[:70]))
        return

    if args.show:
        p = os.path.join(CACHE, args.show + ".json")
        if not os.path.exists(p):
            sys.exit("没有 %s 的缓存" % args.show)
        d = json.load(open(p, encoding="utf-8"))
        print("%s %s  物种名=%s\n来源: %s\n" % (d["id"], d["name"], d["species"], d.get("url", "-")))
        print(d.get("text", d.get("err", "")))
        return

    fish = load_list()
    have = cached_ids(only_ok=True)
    if args.list:
        want = [x.strip() for x in args.list.split(",") if x.strip()]
        todo = [f for f in fish if f["id"] in want]
    else:
        todo = [f for f in fish if f["id"] not in have]
        if args.limit:
            todo = todo[:args.limit]
        elif not args.all:
            sys.exit("要 --list / --limit / --all / --report / --show 之一")

    # ⛔ 虚构物种（SS/SSS）先摘出去：写一条 `fictional` 记录，**不占网络配额**
    fic = [] if args.include_fictional else [f for f in todo if is_fictional(f["id"])]
    if fic:
        todo = [f for f in todo if not is_fictional(f["id"])]
        for f in fic:
            json.dump({"id": f["id"], "name": f["name"], "species": species_of(f["name"]),
                       "ok": False, "how": "fictional",
                       "err": "设计上虚构（SS/SSS 场），无现实对应物种 —— 走推导路径"},
                      open(os.path.join(CACHE, f["id"] + ".json"), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
        print("⛔ 跳过 %d 条设计上虚构的鱼（SS/SSS 场，不消耗站点配额）" % len(fic), flush=True)

    print("待抓取 %d 条（已缓存成功 %d）  模式=%s  源=%s"
          % (len(todo), len(have), args.mode, "+".join(MODE_SOURCES[args.mode])), flush=True)
    state = {k: {"until": 0.0, "blocks": 0, "hits": 0} for k, _, _, _ in SOURCES}
    ok = bad = partial = 0
    i = 0
    while i < len(todo):
        # 所有源都在冷却 → 睡到最早解冻（别空转打请求）
        if all_cooling(state, args.mode):
            soon = min(state[k]["until"] for k, _, _, _ in SOURCES if k in MODE_SOURCES[args.mode])
            wait = max(5.0, min(soon - time.time() + 1, args.maxwait))
            print("… 所有源冷却中，等 %.0fs（剩 %d 条）" % (wait, len(todo) - i), flush=True)
            time.sleep(wait)
            continue
        f = todo[i]
        t0 = time.time()
        d = fetch_one(f, args.mode, state)
        dt = time.time() - t0
        json.dump(d, open(os.path.join(CACHE, f["id"] + ".json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        if d["ok"]:
            ok += 1
            tag = "[%s%s]" % (d.get("how", "?"), "·短条目" if d.get("thin") else "")
            print("[%d/%d] %s %-14s %s %.1fs %s"
                  % (i + 1, len(todo), f["id"], d["species"], tag, dt, d["url"][:56]), flush=True)
        elif d.get("partial"):
            partial += 1
            print("[%d/%d] %s %-14s ⏳ 源冷却未跑全 %.1fs %s"
                  % (i + 1, len(todo), f["id"], d["species"], dt, d.get("err", "")[:60]), flush=True)
        else:
            bad += 1
            print("[%d/%d] %s %-14s ✗ %.1fs %s"
                  % (i + 1, len(todo), f["id"], d["species"], dt, d.get("err", "")[:66]), flush=True)
        i += 1
        time.sleep(args.sleep)
    print("\n成功 %d / 真落空 %d / 源冷却未跑全 %d；累计 %d 条已归一化进特征表；缓存目录 %s"
          % (ok, bad, partial,
             len([k for k in json.load(open(TRAITS, encoding="utf-8")) if not k.startswith("_")]), CACHE),
          flush=True)
    if partial:
        print("⚠️ 「源冷却未跑全」的条目**不是**查不到，下轮直接重跑即可（缓存会被覆盖）。", flush=True)


if __name__ == "__main__":
    main()
