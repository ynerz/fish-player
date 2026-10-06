/* =========================================================
   platform.js  —  平台适配层
   =========================================================
   目标：把「跟运行环境强相关」的能力全部收在这一个文件里，
   游戏逻辑只调 G.Platform.*，不直接碰 localStorage / AudioContext /
   document.createElement / devicePixelRatio。

   这样将来上微信小程序时，只需要再写一份 platform.weapp.js
   在 index.html（或 app.json 入口）里替换掉本文件，逻辑层一行不用改。

   接口（5 组）：
     storage  get / set / remove
     audio    createContext()            —— 小程序要换成 wx.createInnerAudioContext
     canvas   create(w,h)                —— 小程序要换成 wx.createOffscreenCanvas
     sys      dpr() / size() / now()
     input    down(el,fn) / up(fn)       —— 小程序只有 touch 事件
   ========================================================= */
window.G = window.G || {};

G.Platform = (function () {

  /* ---------------- storage ----------------
     优先用 localStorage；被禁用（隐私模式 / file:// 限制）时
     自动退回内存实现，保证游戏还能玩，只是关掉页面就丢档。 */
  var ls = null;
  try { ls = window.localStorage; } catch (e) { ls = null; }
  var mem = {};
  var usingMemory = false;

  var storage = {
    get: function (k) {
      try { if (ls) return ls.getItem(k); } catch (e) {}
      return (k in mem) ? mem[k] : null;
    },
    set: function (k, v) {
      try { if (ls) { ls.setItem(k, String(v)); return; } } catch (e) {}
      if (!usingMemory) { usingMemory = true; }
      mem[k] = String(v);
    },
    remove: function (k) {
      try { if (ls) { ls.removeItem(k); return; } } catch (e) {}
      delete mem[k];
    },
    /* 留给设置面板做提示：存档到底落在哪儿 */
    kind: function () { return (ls && !usingMemory) ? 'localStorage' : 'memory'; },
  };

  /* ---------------- audio ---------------- */
  var audio = {
    /* 返回一个 AudioContext，拿不到就返回 null（音效会被静默跳过） */
    createContext: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        return new AC();
      } catch (e) { return null; }
    },
    /* 兼容位：小程序只能用音频文件，不支持 figure out 波表。
       将来在 platform.weapp.js 里实现 playFile(id) 即可，
       本文件的实现是 no-op，不影响 Web 端的程序化音效。 */
    playFile: null,
  };

  /* ---------------- canvas ---------------- */
  var canvas = {
    create: function (w, h) {
      var c = document.createElement('canvas');
      if (w) c.width = w;
      if (h) c.height = h;
      return c;
    },
  };

  /* ---------------- 系统信息 ---------------- */
  var sys = {
    /* 设备像素比，上限 2 —— 3x 屏上按 3 倍渲染只会白白吃性能 */
    dpr: function () { return Math.min(window.devicePixelRatio || 1, 2); },
    size: function () {
      return { w: window.innerWidth || 800, h: window.innerHeight || 600 };
    },
    now: function () {
      return (window.performance && window.performance.now)
        ? window.performance.now()
        : Date.now();
    },
    isWeb: true,
  };

  /* ---------------- 输入 ----------------
     统一成「按下 / 抬起」两个语义。小程序端换成 touchstart / touchend。 */
  var input = {
    down: function (el, fn) { el.addEventListener('pointerdown', fn); },
    /* ⚠️ 签名是 up(fn)，**只有回调**（松手可能落在页面任意位置，所以绑 window）。
       踩过的坑：这里曾写成 up(el, fn)，而调用方按 up(回调) 传参，
       结果真正注册的是 addEventListener('pointerup', undefined) ——
       「松手」这个动作**永远不会生效**：按住能收线、松开不收线，
       张力必然拉满断线，且不报任何错。任何平台实现都必须保持 up(fn)。 */
    up: function (fn) { window.addEventListener('pointerup', fn); },
    upOn: function (el, fn) { el.addEventListener('pointerup', fn); },
    cancel: function (el, fn) { el.addEventListener('pointercancel', fn); },
    /* 指针划出元素也要放开 —— 否则按住按钮拖出去会一直「收线」 */
    leave: function (el, fn) { el.addEventListener('pointerleave', fn); },
    key: function (fn, down) {
      window.addEventListener(down ? 'keydown' : 'keyup', fn);
    },
  };

  return {
    storage: storage,
    audio: audio,
    canvas: canvas,
    sys: sys,
    input: input,
    isWeb: true,
  };
})();
