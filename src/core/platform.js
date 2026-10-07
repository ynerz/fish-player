/* =========================================================
   platform.js  —  平台适配层
   =========================================================
   目标：把「跟运行环境强相关」的能力全部收在这一个文件里，
   游戏逻辑只调 G.Platform.*，不直接碰 localStorage / AudioContext /
   document.createElement / devicePixelRatio。

   这样将来上微信小程序时，只需要再写一份 platform.weapp.js
   在 index.html（或 app.json 入口）里替换掉本文件，逻辑层一行不用改。

   接口（7 组）：
     storage    get / set / remove / kind
     audio      createContext()          —— 小程序要换成 wx.createInnerAudioContext
     canvas     create(w,h)              —— 小程序要换成 wx.createOffscreenCanvas
     sys        dpr() / size() / now() / isVisible() / reload()
                onResize(fn) / onVisibility(fn) / onFocus(fn) / onBlur(fn)
     input      down(el,fn) / up(fn) / cancel / leave / key
     clipboard  write(text) → Promise<boolean>   —— 小程序换成 wx.setClipboardData
     dialog     confirm(msg) / prompt(msg,def)   —— 小程序换成 wx.showModal
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
    /* 页面当前是否可见（主循环用：不可见 / 失焦都算暂停）。
       小程序端换成 onShow / onHide 维护的一个布尔值即可。 */
    isVisible: function () {
      try { return !window.document || window.document.visibilityState !== 'hidden'; }
      catch (e) { return true; }
    },
    /* 尺寸变化通知（渲染层靠它重算画布）。小程序端换成 wx.onWindowResize 即可。 */
    onResize: function (fn) {
      try { window.addEventListener('resize', fn); } catch (e) {}
    },
    /* 页面可见性变化（主循环暂停 / 恢复、离线补算都靠它）。
       小程序端换成 onShow / onHide 维护的一个布尔值即可。
       ⚠️ 回调里请用 `sys.isVisible()` 判可见性，别读 `document.hidden` ——
          那是 Web 专有字段，换平台就没了（第 ㊱ 节会拦）。 */
    onVisibility: function (fn) {
      try { (window.document || window).addEventListener('visibilitychange', fn); } catch (e) {}
    },
    /* 窗口获得 / 失去焦点。多显示器下「切到别的应用」不一定触发 visibilitychange，
       所以失焦要单独听。小程序端换成 onShow / onHide。 */
    onFocus: function (fn) {
      try { window.addEventListener('focus', fn); } catch (e) {}
    },
    onBlur: function (fn) {
      try { window.addEventListener('blur', fn); } catch (e) {}
    },
    /* 整体重载（重置存档、导入存档之后用）。
       小程序端要换成 reLaunch / navigateTo 的等价动作 —— 所以别在业务代码里写 location.reload。 */
    reload: function () {
      try { window.location.reload(); } catch (e) { /* Node / 无 location 环境：忽略 */ }
    },
    /* ⚠️ 原来的 `isWeb: true` 已删：同一个事实在顶层与这里各写了一份，
       而全项目**没有任何地方读它**（要判平台就补一个真正被消费的能力，
       别留「看着像基础设施」的字段）。 */
  };

  /* ---------------- 剪贴板 ----------------
     导出存档用。Web 端要 navigator.clipboard（且需要用户手势），
     小程序端换成 wx.setClipboardData。返回 Promise<boolean>，
     调用方拿不到就自己兜底（别一味提示「已复制」——那是假的）。 */
  var clipboard = {
    write: function (text) {
      try {
        if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
          return window.navigator.clipboard.writeText(String(text)).then(
            function () { return true; },
            function () { return false; });
        }
      } catch (e) { /* 落到下面统一返回 false */ }
      return Promise.resolve(false);
    },
  };

  /* ---------------- 对话框 ----------------
     原生 confirm / prompt 是阻塞式的，小程序端（wx.showModal）是回调式的，
     所以统一收在这里 —— 换平台时只改这一个文件。
     · confirm(msg)         → boolean
     · prompt(msg, def)     → string | null（取消返回 null）
     都带 try 兜底：拿不到就按「取消」处理，绝不让整块 UI 崩掉。 */
  var dialog = {
    confirm: function (msg) {
      try { return !!window.confirm(msg); } catch (e) { return false; }
    },
    prompt: function (msg, def) {
      try { return window.prompt(msg, def == null ? '' : String(def)); } catch (e) { return null; }
    },
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
    clipboard: clipboard,
    dialog: dialog,
  };
})();
