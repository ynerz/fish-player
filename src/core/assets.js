/* ============================================================================
 * assets.js —— 素材表：**外部素材的唯一取用口径**
 *
 * 规格：docs/开发者文档.md §17.13「素材接入：G.Assets 素材表」· docs/AI素材方案.md §7「游戏侧接入：G.Assets 素材表」
 *       （原来这里指的是开发者文档的第 7 节 —— 那是「存档与兼容」，照它翻文档一定先翻错一节。
 *         门禁第 ㊽ 节现在要求这类引用**连标题一起写**：节号写错、标题对不上就当场报红。）
 *
 * 职责边界（**不要越界**）：
 *   · 只管「键 → 地址 → 加载好的对象」这一条链，**不认识任何业务概念**
 *   · 不碰 DOM（加载走 `G.Platform.image`）、不依赖 Fishing / Fight / Scene
 *     → 路径这一段可以在 Node 里单测
 *
 * 为什么必须有这一层（用户 2026-10-07 放开「零素材」之后的第一件基础设施）：
 *   图鉴卡面是**分批跑出来的**（362 条 × 6 张，要跑几十小时），所以任何时刻
 *   都可能有鱼「还没出图」。如果路径硬拼在业务代码里，换一批图就要全局搜替换；
 *   而且「文件不存在」会变成一堆 404 + 未捕获异常。
 *   ⇒ 统一在这里判「这个键认不认得」与「能不能加载」，**加载失败返回 null**，
 *     调用方拿 null 去走回退链（AI 卡 → 程序化绘制）。
 *
 * ⚠️ 平台能力一律走 `G.Platform`：图片是 `G.Platform.image`，判断是否 file://
 *    是 `G.Platform.sys.isFile()`。业务代码不许写 `new Image()`（第 ㊱ 节拦）。
 * ========================================================================== */
window.G = window.G || {};
G.Assets = (function () {
  'use strict';

  /* 卡面取的是 **Q8 的派生物**（`tools/prep-cards.py` 出：补边到 2:1 的两档），
     不是生图原始输出 `assets/cards/`。理由有三条，任一条都足以决定：
       ① 原始抠图是 **3:2**，而展示位是 2.32:1 / 2.00:1 ⇒ `contain` 贴进去左右各空掉一截；
          派生物已补透明边到 **2:1**，贴进展示位像素级铺满（Q8 实测：A01 网格 300×200 → 400×200）。
       ② 原始一张 495 KB，列表档只要 110 KB —— 图鉴一屏 362 项，差的是两个数量级。
       ③ 「多大尺寸」这件事只能有一处真相：它住在 `prep-cards.py` 的 `SPEC` 里，
          这里只放**两张表**（目录 + 档位子目录），`verify §53` 会拿 `SPEC` 现算对拍。
     ⚠️ 目录名与 `tools/prep-cards.py:OUT_DIR` **同源**；改了脚本不改这里 = 全体静默 404
        ⇒ 回退程序化绘制（画面「看起来还行」，所以没人会发现）。门禁盯着这条。 */
  var CARD_DIR = 'assets/cards-ui/';
  /* 档位（tier）→ 子目录。**唯一一处**。
     档位不是「颜色档」（那是 `fishcard` 键里最后一节的 morph），而是**图的分辨率档**：
       detail = `<CARD_DIR><槽位>.png`（1024×512，图鉴详情 / 水族箱）
       list   = `<CARD_DIR>list/<槽位>.png`（512×256 且锐化，网格缩略 / 鱼护小图）
     ⚠️ 子目录名与 `prep-cards.py:LIST_SUB` 同源（§53 现算对拍）。 */
  var TIER_SUB = { detail: '', list: 'list/' };
  var SFX_DIR = 'assets/audio/';
  /* 上云之后把 CDN 前缀写在这里（或调用 setBase）。空 = 与 index.html 同目录。 */
  var base = '';
  var cache = {};      // 键 → Image / AudioBuffer（成功过的不再请求第二次）
  var dead = {};       // 键 → true（**失败备忘**：404 过的键不再反复请求）

  /* 家底计数器**按素材类别分开**（image / sfx）—— 原来两类共用一个 ok/fail，
     于是开发者面板上的「失败 1」分不清是卡面还是音效：而 `file://` 形态下音效
     **必然**失败（fetch 被拦），这一行就永远在报警，真正的卡面加载失败反而被淹掉
     （做 N3-1 时当场把 `fail:1` 误读成「卡面没加载上」）。
     总量不另存一份，`used()` 里现算 —— 同一个事实写两遍必然分家。 */
  var KINDS = ['image', 'sfx'];
  var stat = blankStat();
  function blankStat() {
    var s = {};
    KINDS.forEach(function (k) { s[k] = { ok: 0, fail: 0 }; });
    return s;
  }
  function bump(kind, good) { stat[kind][good ? 'ok' : 'fail']++; }

  /* 档位名**从 config 取**，不许在这里另写一份 —— 档位是平衡数值的一部分，
     写两份必然分家（本项目反复踩过的坑型）。 */
  function morphKeys() {
    var cm = (G.CONFIG && G.CONFIG.colorMorphs) || [];
    return cm.map(function (m) { return m.key; });
  }

  /* 当前形态：`inline` = 跑在 file://（开发期双击打开）；`external` = http / 发布 / 上云。
     ⚠️ 两种形态下**路径写法是一样的**（浏览器在 file:// 下同样能加载相对路径的图片），
        差别只在发布时是否改走 `base` 的 CDN 前缀 —— 所以这个函数是给
        「开发者面板显示家底」与「排查客户机上素材为什么没出来」用的，
        不要拿它去分支业务逻辑。 */
  function mode() {
    return (G.Platform && G.Platform.sys && G.Platform.sys.isFile()) ? 'inline' : 'external';
  }

  /* 档位名是不是这张表**自己**的键。
     ⚠️ 不许写 `p[1] in TIER_SUB`：`in` 会沿原型链找，`'constructor' in TIER_SUB` 为真，
        于是 `fishcard:constructor:A01:golden` 拿到的是 `Object.prototype.constructor` 这个**函数**，
        字符串一拼就变成一个垃圾路径（不是 null）—— 本模块存在的意义就是「认不出就返回 null，
        绝不拼一个可能错的路径」，这条正好反过来。原型链上的 `toString` / `valueOf` /
        `hasOwnProperty` / `__proto__` 全是同一个坑。 */
  function hasTier(t) { return Object.prototype.hasOwnProperty.call(TIER_SUB, t); }

  /* 两类键：
       `fishcard:<档位>:<id>:<颜色档>` —— 图鉴卡面（PNG，Q8 的两档派生物）
       `sfx:<名字>`                  —— 音效（MP3）
     认不出来的键返回 null —— **宁可返回 null 让调用方走回退，也不要拼一个可能错的路径**。

     ⚠️ 卡面的四个键段**一个都不许省**：
       · 档位（tier）省了 ⇒ 「要多大」就没说，只能猜；
       · 颜色档（morph）省了 ⇒ 拼出来的是**灰底母版** `<id>.png`（它不在派生目录里，
         本来就取不到；在这里拦掉是**第二道防线**，第一道在 `cardart.js` 的 `key()`）——
         母版贴到浅蓝底上会糊一块灰方块，宁可回退程序化绘制。 */
  function resolve(key) {
    var p = String(key == null ? '' : key).split(':');
    if (p[0] === 'fishcard') {
      if (p.length !== 4) return null;
      /* ⚠️ `hasTier()` 判「键在不在」而不是 `p[1] in TIER_SUB ? ... : null` 的三元 ——
         `TIER_SUB.detail` 的值是**空串**，用真值判断会把 detail 档自己也拦掉；
         而 `in` 又会沿原型链（见 `hasTier()` 的注释）。 */
      if (!hasTier(p[1])) return null;                             // 档位写错 = 直接拦
      var fid = p[2];
      if (!/^[A-Za-z0-9]+$/.test(fid)) return null;
      var morph = p[3];
      if (morphKeys().indexOf(morph) < 0) return null;             // 档位名写错 = 直接拦掉
      return base + CARD_DIR + TIER_SUB[p[1]] + fid + '-' + morph + '.png';
    }
    if (p[0] === 'sfx') {
      if (p.length !== 2 || !/^[a-z][a-z0-9]*$/.test(p[1])) return null;
      return base + SFX_DIR + p[1] + '.mp3';
    }
    return null;
  }

  /* 拼键。**档位在最前** —— 念出来就是「列表档 / A01 / 闪光」，四个键段与 `resolve()`
     的解析顺序一一对应（两处各拼一套必然分家，所以它俩必须同源）。
     ⚠️ 参数顺序与 `resolve()` 一致；少传 / 传错会让 `resolve()` 返回 null ⇒
        表现为「一直回退程序化绘制」，不会贴错图 —— 失败态是可见的（`miss` 计数会涨）。 */
  function fishKey(tier, fid, morph) {
    return 'fishcard:' + tier + ':' + fid + ':' + morph;
  }

  /* 加载。**失败返回 null，不抛也不 reject** —— 理由见 platform.image.load 的注释。 */
  function load(key) {
    if (cache[key]) return Promise.resolve(cache[key]);
    if (dead[key]) return Promise.resolve(null);
    var url = resolve(key);
    if (!url || !G.Platform || !G.Platform.image) return Promise.resolve(null);
    return G.Platform.image.load(url).then(function (im) {
      if (im) { cache[key] = im; bump('image', true); return im; }
      dead[key] = true; bump('image', false); return null;
    });
  }

  /* 业务层的顺手封装：按档位 + 鱼 id + 颜色档拿卡面。拿不到就是 null。 */
  function card(tier, fid, morph) {
    return load(fishKey(tier, fid, morph));
  }

  /* 音效：按名字拿一段**已解码的音频**。拿不到就是 null（调用方回退到合成音）。
     与图片共用同一套缓存与失败备忘 —— 键带前缀，不会撞。
     ⚠️ 小程序端这个返回值的语义会变（那边不做解码，直接吃 URL）——
        见 `G.Platform.audio.load` 的注释；业务侧只用「非 null = 能播」这一条。 */
  function sfx(name) {
    var key = 'sfx:' + name;
    if (cache[key]) return Promise.resolve(cache[key]);
    if (dead[key]) return Promise.resolve(null);
    var url = resolve(key);
    if (!url || !G.Platform || !G.Platform.audio || !G.Platform.audio.load) return Promise.resolve(null);
    return G.Platform.audio.load(url).then(function (buf) {
      if (buf) { cache[key] = buf; bump('sfx', true); return buf; }
      dead[key] = true; bump('sfx', false); return null;
    });
  }

  /* 家底：成功 / 失败过多少 —— **分图片与音效两组**，总量由两组现算。
     开发者面板与自检读它；分组的用途很具体：客户机上「卡面不出来」时，
     先看 `image.fail`，别把 `file://` 下必然失败的音效当罪证。 */
  function used() {
    var img = stat.image, sfxStat = stat.sfx;
    return {
      ok: img.ok + sfxStat.ok,
      fail: img.fail + sfxStat.fail,
      cached: Object.keys(cache).length,
      image: { ok: img.ok, fail: img.fail },
      sfx: { ok: sfxStat.ok, fail: sfxStat.fail },
    };
  }

  function setBase(b) { base = b || ''; }

  /* 仅供自测：清空缓存与备忘（不然一个测试里失败过的键会影响下一个） */
  function reset() { cache = {}; dead = {}; stat = blankStat(); }

  return {
    mode: mode,
    resolve: resolve,
    fishKey: fishKey,
    load: load,
    card: card,
    sfx: sfx,
    used: used,
    setBase: setBase,
    reset: reset,
  };
})();
