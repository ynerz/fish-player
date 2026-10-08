/* ============================================================================
 * assets.js —— 素材表：**外部素材的唯一取用口径**
 *
 * 规格：docs/开发者文档.md §7 · docs/AI素材方案.md §7
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

  var DIR = 'assets/cards/';
  var SFX_DIR = 'assets/audio/';
  /* 上云之后把 CDN 前缀写在这里（或调用 setBase）。空 = 与 index.html 同目录。 */
  var base = '';
  var cache = {};      // 键 → Image / AudioBuffer（成功过的不再请求第二次）
  var dead = {};       // 键 → true（**失败备忘**：404 过的键不再反复请求）
  var stat = { ok: 0, fail: 0 };

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

  /* 两类键：
       `fishcard:<id>` / `fishcard:<id>:<档位>` —— 图鉴卡面（PNG）
       `sfx:<名字>`                              —— 音效（MP3）
     认不出来的键返回 null —— **宁可返回 null 让调用方走回退，也不要拼一个可能错的路径**。 */
  function resolve(key) {
    var p = String(key == null ? '' : key).split(':');
    if (p[0] === 'fishcard') {
      if (p.length < 2 || p.length > 3) return null;
      var fid = p[1];
      if (!/^[A-Za-z0-9]+$/.test(fid)) return null;
      var morph = p[2];
      if (morph && morphKeys().indexOf(morph) < 0) return null;   // 档位名写错 = 直接拦掉
      return base + DIR + fid + (morph ? '-' + morph : '') + '.png';
    }
    if (p[0] === 'sfx') {
      if (p.length !== 2 || !/^[a-z][a-z0-9]*$/.test(p[1])) return null;
      return base + SFX_DIR + p[1] + '.mp3';
    }
    return null;
  }

  function fishKey(fid, morph) {
    return 'fishcard:' + fid + (morph ? ':' + morph : '');
  }

  /* 加载。**失败返回 null，不抛也不 reject** —— 理由见 platform.image.load 的注释。 */
  function load(key) {
    if (cache[key]) return Promise.resolve(cache[key]);
    if (dead[key]) return Promise.resolve(null);
    var url = resolve(key);
    if (!url || !G.Platform || !G.Platform.image) return Promise.resolve(null);
    return G.Platform.image.load(url).then(function (im) {
      if (im) { cache[key] = im; stat.ok++; return im; }
      dead[key] = true; stat.fail++; return null;
    });
  }

  /* 业务层的顺手封装：按鱼 id + 档位拿卡面。拿不到就是 null。 */
  function card(fid, morph) {
    return load(fishKey(fid, morph));
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
      if (buf) { cache[key] = buf; stat.ok++; return buf; }
      dead[key] = true; stat.fail++; return null;
    });
  }

  /* 家底：成功 / 失败过多少张。开发者面板与自检用。 */
  function used() {
    return { ok: stat.ok, fail: stat.fail, cached: Object.keys(cache).length };
  }

  function setBase(b) { base = b || ''; }

  /* 仅供自测：清空缓存与备忘（不然一个测试里失败过的键会影响下一个） */
  function reset() { cache = {}; dead = {}; stat = { ok: 0, fail: 0 }; }

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
