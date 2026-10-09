/* =========================================================
   platform.js  —  平台适配层
   =========================================================
   目标：把「跟运行环境强相关」的能力全部收在这一个文件里，
   游戏逻辑只调 G.Platform.*，不直接碰 localStorage / AudioContext /
   document.createElement / devicePixelRatio。

   这样将来上微信小程序时，只需要再写一份 platform.weapp.js
   在 index.html（或 app.json 入口）里替换掉本文件，逻辑层一行不用改。

   接口（9 组）：
     storage    get / set / kind
     audio      createContext() / load(url) → Promise<AudioBuffer|null> / playFile（小程序占位）
                —— 小程序要换成 wx.createInnerAudioContext
     canvas     create(w,h)              —— 小程序要换成 wx.createOffscreenCanvas
     image      create() / load(url) → Promise<Image|null>   —— 小程序换成 wx.createImage
     sys        dpr() / now() / raf(fn) / cancelRaf(h) / isVisible() / reload()
                onReady(fn) / onResize(fn) / onVisibility(fn) / onFocus(fn) / onBlur(fn)
                onError(fn) / onRejection(fn) / isFile()
     input      down(el,fn) / up(fn) / cancel / leave / key
     clipboard  write(text) → Promise<boolean>   —— 小程序换成 wx.setClipboardData
     dialog     confirm(msg) / prompt(msg,def)   —— 小程序换成 wx.showModal
     speech     available() / list() / onVoices(fn) / speak(text,opts) / stop()
                —— 陪伴助手（N6）的出声能力；小程序要换成云端 TTS 或直接 no-op

   ⚠️ 上面只列**现行**接口。这里曾多列过 `storage.remove` 与 `sys.size()` 两个 ——
      2026-10-08 全项目 API 扫描实测它们**零消费**，已删（进了 `verify` 32-b 的 REMOVED 名单；
      32-c 的子能力网也要求每个子键都有调用点）。**别照着旧版本把它们加回来**：
      「看着像基础设施」的 API 正是本项目反复清掉的那类债。
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
    /* 加载并解码一段音频 → `Promise<AudioBuffer | null>`。
       **失败一律 resolve(null)，不抛也不 reject** —— 与 `image.load` 同一口径：
       音频文件可能不存在 / `file://` 下读不了 / 解码失败，这些都是**常态**，
       调用方要的是「有就用、没有就走回退（合成音）」，不是异常处理。
       ⚠️ 小程序端**不能用这一套**（它不做解码，`wx.createInnerAudioContext` 直接吃 URL）——
          那时这个能力要整体替换，所以业务侧**不要假设拿到的是 AudioBuffer**，
          只使用「非 null 就说明能播」这一条语义。 */
    load: function (url) {
      var c = audio.createContext();
      if (!c || !c.decodeAudioData || typeof fetch !== 'function') return Promise.resolve(null);
      return fetch(url).then(function (r) {
        return (r && r.ok) ? r.arrayBuffer() : null;
      }).then(function (b) {
        if (!b) return null;
        return new Promise(function (res) {
          /* 新旧两种签名都试：老 Safari 只认回调形态（返回值不是 Promise） */
          try {
            var p = c.decodeAudioData(b, function (buf) { res(buf); }, function () { res(null); });
            if (p && p.then) p.then(function (buf) { res(buf); }, function () { res(null); });
          } catch (e) { res(null); }
        });
      }).catch(function () { return null; });
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
    /* 单调时钟 —— **全项目唯一的取时口径**（业务代码不许写 `performance.now()`，
       第 ㊱ 节按字面量拦）。主循环的帧间隔、水族箱动画的相位都靠它。
       ⚠️ 它必须与「帧时间戳」同源：`requestAnimationFrame` 回调收到的第一个参数
          就是本函数在同一时刻会返回的值（Web 端都是 `performance.now()`）。
          换平台时两个一起换，否则 `now - last` 会算出一个天文数字。 */
    now: function () {
      return (window.performance && window.performance.now)
        ? window.performance.now()
        : Date.now();
    },
    /* 帧调度：**它是平台能力，不是「标准计时器」** ——
       Web 与微信小游戏有全局 `requestAnimationFrame`，而**小程序（非小游戏）页面里没有**，
       要换成 `canvas.requestAnimationFrame`。所以业务代码一律走这两个入口。
     ⚠️ **边界**（2026-10-08 明确，见 `docs/每小时优化轮次规范.md` §9「自主决策：质量优先」）：
        `requestAnimationFrame` / `cancelAnimationFrame` **算**平台能力（渲染宿主的调度器）；
        而 `setTimeout` / `setInterval` **不算**（任何宿主都有，Node 里也有）——
        给它们包一层只是多一层无意义的间接，反而掩盖了「真正要换的只有帧调度」这件事。
     ⚠️ 拿不到 raf 时**退回 `setTimeout` 而不是抛**，并且**照样把时间戳传给回调**：
        主循环的 dt 就是 `(now - last)` 算的，而它的基准来自 `sys.now()` ——
        两条路必须同源，否则退回路径会算出天文数字的 dt（上一处注释已经说过这个坑）。
        有了这个兜底，调用方**不需要再写 `if (cancelAnimationFrame)` 这类空值守卫**。 */
    raf: function (fn) {
      try {
        if (window.requestAnimationFrame) return window.requestAnimationFrame(fn);
      } catch (e) { /* 落到下面的 setTimeout */ }
      return setTimeout(function () { fn(sys.now()); }, 16);
    },
    cancelRaf: function (h) {
      if (h == null) return;
      try {
        if (window.requestAnimationFrame && window.cancelAnimationFrame) {
          window.cancelAnimationFrame(h);
          return;
        }
      } catch (e) { /* 落到下面的 clearTimeout */ }
      try { clearTimeout(h); } catch (e2) { /* Node / 小程序：忽略 */ }
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
    /* 首次启动：DOM 就绪后跑一次 `fn`（main.js 的 boot / devtools 的挂载都走它）。
       ⚠️ 业务代码里不许再写 `document.readyState` / `DOMContentLoaded` —— 第 ㊱ 节会拦。
       没有 DOM（Node / 小程序）或已经就绪时**立即执行**，不把启动卡住。 */
    onReady: function (fn) {
      /* 非函数直接忽略，但**不静默** —— 写成 `onReady(boot())`（多打一对括号）
         会让启动永不发生，那是本项目最难查的一类白屏，所以要在控制台喊一声。 */
      if (typeof fn !== 'function') {
        try { console.error('[Platform] sys.onReady 需要一个函数，收到 ' + typeof fn); } catch (e) {}
        return;
      }
      var d = null;
      try { d = window.document; } catch (e) { d = null; }
      if (!d || d.readyState !== 'loading') { fn(); return; }
      try { d.addEventListener('DOMContentLoaded', fn); }
      catch (e) { fn(); }          /* 挂不上就别卡住启动 */
    },
    /* 全局错误钩子（G.Track 用）。
       ⚠️ 用 addEventListener 而不是 `window.onerror =`，避免覆盖别人的处理器。 */
    onError: function (fn) {
      try { window.addEventListener('error', fn); } catch (e) {}
    },
    /* 未处理的 Promise 拒绝（同一个错误采集点，小程序端要另找等价事件） */
    onRejection: function (fn) {
      try { window.addEventListener('unhandledrejection', fn); } catch (e) {}
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
    /* 是否跑在 `file://` 下（双击打开的开发期形态）。
       消费方：`G.Assets.mode()` —— 决定素材走 `inline`（内联）还是 `external`（同目录文件）。
       ⚠️ 加这个能力是**因为有真实消费方**；项目里删过没有消费方的 `isWeb`，
          不许再留「看着像基础设施」的字段（第 ㉜-c 节会要求每个子键都有调用点）。 */
    isFile: function () {
      return !!(window.location && window.location.protocol === 'file:');
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

  /* ---------------- 图像 ---------------- */
  /* 图片加载的**唯一**口径。业务代码不许写 `new Image()`（第 ㊱ 节按字面量拦）。
     小程序端换成 `wx.createImage()` —— 同名 API，src / onload / onerror 都在。 */
  var image = {
    create: function () { return new Image(); },
    /* 加载一张图。成功给 Image 对象、失败给 **null**（不抛、不 reject）。
       为什么给 null 而不是 reject：**素材缺失是常态** —— 卡图是分批跑出来的，
       任何时刻都可能有一半的鱼还没出图。调用方要的是「有就用、没有就走回退」，
       不是异常处理；用 reject 只会换来一堆没人接的 unhandled rejection。 */
    load: function (url) {
      return new Promise(function (res) {
        var im = image.create();
        im.onload = function () { res(im); };
        im.onerror = function () { res(null); };
        im.src = url;
      });
    },
  };

  /* ---------------- 语音合成（TTS） ----------------
     陪伴助手（N6）的**出声**能力。Web 端就是浏览器内置的合成人声
     （系统 TTS 音色）—— **离线可用、不用 Key、零依赖**；
     小程序端要么换成云端 TTS、要么整组 no-op，所以业务代码一律走这里
     （`verify` 第 ㊱ 节按字面量拦 `speechSynthesis` / `SpeechSynthesisUtterance`）。

     ⚠️ 四条硬边界（照平台层的老规矩，改之前先读）：
       ① **拿不到能力就兜底不抛** —— `available()` 返回 false，
          `speak()` / `stop()` 都是 no-op。调用方**不写**「能力在不在」的守卫，
          只保留「我自己要不要说」这种判断（与 `sys.raf` 同款约定）。
       ② **音色可列但不可承诺** —— `list()` 给的是**本机装了哪些声音**：
          可能是空数组、也可能是十几个语种混在一起。上层必须接受「只有系统默认」。
       ③ **语音不经过 AudioContext**（它不走 `G.Audio` 那套增益节点）⇒
          「总音量」这个闸门必须在**调用侧**乘进 `volume`。否则玩家把音量拉到 0，
          语音照样念 —— 那是「同一个事实两处真相」的**听感版**。
       ④ `getVoices()` 常常**第一次返回空**（Chrome 异步加载声音列表）⇒ 只调一次
          `list()` 的界面会永远看不到音色下拉。这就是 `onVoices(fn)` 存在的理由：
          列表就绪后重画。 */
  var synth = null;
  try { synth = window.speechSynthesis || null; } catch (e) { synth = null; }

  /* 「这个可选项是个能用的数字吗」——`null` / `''` / 字符串一律不算。
     写成独立小函数是为了它在三处调用点只有一份实现（`isFinite(null) === true` 那个坑）。 */
  function numOpt(v) { return typeof v === 'number' && isFinite(v); }

  var speech = {
    available: function () {
      if (!synth || typeof synth.speak !== 'function') return false;
      /* `SpeechSynthesisUtterance` 少了也没用：能力是**两者一起**才算数。
         用 `window.` 取而不是裸全局 —— 与文件里其它能力的写法一致。 */
      return typeof window.SpeechSynthesisUtterance === 'function';
    },
    /* 本机可选的声音：`[{ id, name, lang }]`。拿不到就空数组（**不是 null**）——
       调用方只需要「循环一遍」，不该再写一次空值守卫。 */
    list: function () {
      if (!speech.available() || typeof synth.getVoices !== 'function') return [];
      try {
        return (synth.getVoices() || []).map(function (v) {
          return { id: v.voiceURI || v.name || '', name: v.name || '', lang: v.lang || '' };
        });
      } catch (e) { return []; }
    },
    /* 声音列表就绪的通知（异步加载）。拿不到通知就算了：界面会退回「系统默认」。
       ⚠️ 注册方要自己防重复注册（本函数不做去重）—— 设置面板每次重绘都注册一遍
          就会攒下一串回调，是典型的「听着没事、跑久了变慢」的坑。 */
    onVoices: function (fn) {
      if (!synth || typeof fn !== 'function') return;
      try {
        if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', fn);
        else synth.onvoiceschanged = fn;
      } catch (e) { /* 老实现挂不上：界面继续用「系统默认」，不影响其它功能 */ }
    },
    /* 说一句。opts：`{ voice, rate, pitch, volume, onend }`（都是可选的）。
       返回 true = 这一句**真的送出去了**；false = 本平台没这个能力 / 文本为空。
       注意 true 只代表「送出去了」，不代表一定听得见（系统可能一个音色都没有）。 */
    speak: function (text, opts) {
      if (!speech.available()) return false;
      var t = String(text == null ? '' : text).trim();
      if (!t) return false;
      var o = opts || {};
      try {
        /* 同一时刻只允许一句：`speechSynthesis` 是**队列式**的，不 cancel 就会
           一句接一句排队念下去（玩家连钓两条传说鱼 → 助手念到天黑）。 */
        synth.cancel();
        var u = new window.SpeechSynthesisUtterance(t);
        /* 音色按 `voiceURI`（退回 `name`）匹配 —— **在原始列表里找**，不拿 `list()`
           的下标去对：那是两处索引对齐的隐含假设，改一处就静默配错声音。 */
        if (o.voice && typeof synth.getVoices === 'function') {
          var raw = synth.getVoices() || [];
          for (var i = 0; i < raw.length; i++) {
            if ((raw[i].voiceURI || raw[i].name) === o.voice) { u.voice = raw[i]; break; }
          }
        }
        /* ⚠️ 判「是不是数字」要连类型一起看：`isFinite(null)` 是 **true**，
           等于把 null 写进 utterance 参数（各家浏览器解释不一致）。 */
        if (numOpt(o.rate)) u.rate = o.rate;
        if (numOpt(o.pitch)) u.pitch = o.pitch;
        if (numOpt(o.volume)) u.volume = o.volume;
        if (typeof o.onend === 'function') u.onend = o.onend;
        synth.speak(u);
        return true;
      } catch (e) { return false; }
    },
    stop: function () {
      if (!speech.available()) return;
      try { synth.cancel(); } catch (e) { /* 已经停了 / 没在说：忽略 */ }
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
    image: image,
    speech: speech,
  };
})();
