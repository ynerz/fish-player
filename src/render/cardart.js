/* ============================================================================
 * cardart.js —— AI 卡面的取用与兜底（**回退链的唯一一处真相**）
 *
 * 规格：docs/开发者文档.md §17.17「图鉴接入 AI 卡面：回退链」· docs/AI素材方案.md §7「游戏侧接入：G.Assets 素材表」
 *       · docs/改进待办.md「N3-1 图鉴卡面的回退链」
 *
 * 一句话：**有图就用图，拿不到就交给 `G.FishArt` 程序化画**，两条路都必须能出画。
 *
 * 为什么不能把这段写进 `Assets`：
 *   `Assets` 只管「键 → 地址 → 加载好的对象」，它是**异步**的；而画布是**同步**画的。
 *   图鉴一次要画 360 多张，不可能等图。所以这里补的正是中间那一层：
 *     ① `held()` —— 同步问「这张已经有了吗」（有就直接画）；
 *     ② `want()` —— 没有就去要，**要到了再重画那一张**（要不到就什么都不做）。
 *   ⇒ `Assets` 仍然是「怎么加载」的唯一真相，本模块只是它的**同步视图 + 重画回调**。
 *
 * 🔴 游戏侧只吃**透明抠图的派生物**（`assets/cards-ui/` 里的 `<id>-<档位>.png`），
 *   永远不传空档位：
 *   `<id>.png` 是**灰底母版**（`alpha ≈ 252~255`，只在人工评审台里看），
 *   贴进图鉴的浅蓝底上会糊一块灰方块。所以 `key()` 里空档位一律返回 null ——
 *   宁可回退程序化绘制，也不把母版放进来。这条不需要调用方自觉，本模块自己拦。
 *
 * 档位（tier）是**取的图有多大**，不是颜色档：
 *   `'detail'` = 1024×512（图鉴详情页 / 水族箱里的鱼）、`'list'` = 512×256 并锐化（网格 / 鱼护小图）。
 *   ⚠️ 本模块**不持有档位表** —— 认不认这个档位由 `G.Assets.resolve()` 回答（它才是
 *      「键 → 地址」的唯一真相）。档位写错时 `Assets` 返回 null ⇒ 本模块照常走回退链，
 *      失败态是**回退程序化绘制**（可见、且在 `used().miss` 里数得出来），不是贴错图。
 *   本模块的内部键**带档位**：两个档是两张不同的图，共用一个槽位会互相顶掉。
 *
 * ⚠️ 缺图 / 坏图 / 档位名写错 **都不是异常**（卡面是分批跑出来的，任何时刻都可能缺），
 *    `want()` 失败时**一个回调都不发** —— 画布上那张程序化绘制的鱼留在原地即可。
 * ========================================================================== */
window.G = window.G || {};
G.CardArt = (function () {
  'use strict';

  /* 键（=`<档位>:<id>:<颜色档>`）→ Image。**同步视图**：画布是同步画的，必须能同步回答
     「这张有图了吗」。
     ⚠️ 这不是第二份缓存 —— 图对象本身仍由 `Assets` 加载并持有，这里只记
        「哪些键已经有结果」，是给同步绘制路径用的索引。 */
  var READY = {};
  /* 键 → 回调数组。同一张图只发一次请求，多个消费方挂同一串（图鉴滚动时
     同一张卡可能被两次要，第二次不该再发一次网络请求）。 */
  var WAIT = {};
  /* 可替换的加载器：默认走 `G.Assets.card`（Promise）。
     留这个口子是因为**宿主语义不同**（小程序端的加载可能同步返回 URL / 对象），
     测试里也要一个同步桩才能覆盖「图到了要重画」这条分支。 */
  var loader = null;
  var stat = { hit: 0, miss: 0, ask: 0 };

  /* 颜色档键必须在 `config.colorMorphs` 里 —— 档位名是平衡数值的一部分，
     这里**不许另写一份表**（写两份必然分家，本项目反复踩过的坑型）。 */
  function knownMorph(morph) {
    if (!morph) return null;
    var cm = (G.CONFIG && G.CONFIG.colorMorphs) || [];
    for (var i = 0; i < cm.length; i++) if (cm[i].key === morph) return morph;
    return null;
  }

  /* 内部键：`<档位>:<id>:<颜色档>`。**任一段不合规就返回 null**（调用方据此走程序化绘制）。
     ⚠️ 档位不在这里校验（表在 `Assets`）—— 但要**照原样带进键**：漏掉它会让两个档
        共用同一个槽位，先到的那张图会把后到的顶掉（而且不报错）。 */
  function key(tier, fid, morph) {
    var m = knownMorph(morph);
    if (!m) return null;                        // 空 / 未知颜色档 ⇒ 拒绝（母版不进游戏）
    if (!fid || !/^[A-Za-z0-9]+$/.test(String(fid))) return null;
    return String(tier) + ':' + fid + ':' + m;
  }

  /* 同步：已经拿到的图，或 null。 */
  function held(tier, fid, morph) {
    var k = key(tier, fid, morph);
    return k ? (READY[k] || null) : null;
  }

  /* 异步：确保这张图会被加载，好了就调 `cb(img)`。
     返回「现在就有图吗」—— 调用方用它决定要不要先画程序化的那张：
       true  ⇒ 立刻画图（cb 也已经被同步调用过）
       false ⇒ 先画程序化绘制的，等 cb 来了再重画一次
     ⚠️ 拿不到图（缺图 / 坏图 / 键不合规）时**不调 cb**，也不返回 true。 */
  function want(tier, fid, morph, cb) {
    var k = key(tier, fid, morph);
    if (!k) { stat.miss++; return false; }
    if (READY[k]) { if (cb) cb(READY[k]); return true; }
    if (WAIT[k]) { if (cb) WAIT[k].push(cb); return false; }
    WAIT[k] = cb ? [cb] : [];
    stat.ask++;
    var call = loader || function (t, f, m) { return G.Assets.card(t, f, m); };
    var r;
    try { r = call(tier, fid, morph); } catch (e) { r = null; }
    /* 两种宿主形态都要吃：Web 端给 Promise；同步宿主（测试桩 / 将来某个小程序的
       实现）直接给一张图或 null。**别假设一定是 thenable** —— 假设错了会静默不画。 */
    if (r && typeof r.then === 'function') {
      r.then(function (im) { settle(k, im); }, function () { settle(k, null); });
      return false;                       // 异步宿主：现在还没图，调用方先画程序化的
    }
    settle(k, r);                         // 同步宿主：这一刻就定了
    return !!READY[k];
  }

  function settle(k, im) {
    var wait = WAIT[k] || [];
    delete WAIT[k];
    if (!im) { stat.miss++; return; }   // 缺图 / 坏图：一个回调都不发 ⇒ 程序化那张留在画布上
    READY[k] = im;
    for (var i = 0; i < wait.length; i++) {
      try { wait[i](im); } catch (e) { /* 重画失败不能把别的消费方带下水 */ }
    }
  }

  /* 把一张卡面**等比放进框**，以 (cx, cy) 为中心画出来。
     取 contain 口径（整张图都看得见，永不裁切）：派生物是固定的 **2:1**（Q8 补边），
     而调用方的框都比它**更扁或正好相等**（图鉴网格 260×112 = 2.32:1、详情 380×190 = 2.00:1、
     鱼护小图 96×52 = 1.85:1）⇒ 要么上下留一点、要么刚好铺满，**不会左右留白**。
     🔎 实测（A01 贴进网格格 464×200）：旧的 3:2 母版贴出 300×200、现在 2:1 贴出 400×200；
        **主体宽 268 → 270px（几乎没变）** ⇒ 这一步的收益是「贴满框 + 体积骤降」，
        **不是**「鱼看着更大」（高度受限时两者主体像素本来就一样，别拿它当理由）。
     ⚠️ 精确的「按体重缩放鱼的大小」是队列 N3-3 的事，**不给它在这里埋第二套缩放规则**；
        本函数只负责「把图放进去」，与程序化绘制的 `len` 参数各管各的。
     返回实际画出的 { w, h, s }（自测据它断言，不用去猜 canvas 的像素）。 */
  function blit(ctx, img, cx, cy, bw, bh) {
    /* 「命中」= **真的贴上去一次**，这里才是唯一该数它的地方。
       ⚠️ 原来这个计数在 `want()` 的「已经有图了」那一支里 —— 而那条路**实际走不到**：
          调用方（`paintFish`）先问 `held()`，拿到了就直接 `blit`、**不会再调 `want`**；
          图是异步来的话，回调和重画也都被 `held()` 拦在前面。
          结果是开发者面板那行「卡面 命中」**恒为 0** —— 而屏幕上明明全是 AI 卡面。
          这种「指标口径写错」比没有指标更糟：它会让人以为接线没生效（Q9 当场所见）。 */
    stat.hit++;
    var s = Math.min(bw / img.width, bh / img.height);
    var w = img.width * s, h = img.height * s;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    return { w: w, h: h, s: s };
  }

  /* 家底：真的贴上去多少张（hit）/ 有多少次要不到（miss）/ 真发出去多少请求（ask）。
     开发者面板与自测用。⚠️ `hit` 数在 `blit()` 里，见那里的注释（写在 `want()` 里会恒为 0）。 */
  function used() { return { hit: stat.hit, miss: stat.miss, ask: stat.ask }; }

  /* 换加载器（传 null 回到 `Assets.card`）。 */
  function setLoader(fn) { loader = fn || null; }

  /* 仅供自测：清空同步视图（不然一个用例里加载过的键会影响下一个）。 */
  function reset() { READY = {}; WAIT = {}; stat = { hit: 0, miss: 0, ask: 0 }; }

  return {
    held: held,
    want: want,
    blit: blit,
    used: used,
    setLoader: setLoader,
    reset: reset,
  };
})();
