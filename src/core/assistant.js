/* =========================================================
   assistant.js  —  陪伴助手（N6）：什么时候说哪一句
   =========================================================
   它**只有判定，没有界面、也不碰浏览器 API**：
     · 台词在 `src/data/assistant.js`（内容）
     · 出声走 `G.Platform.speech`（能力）
     · 文字气泡 / 语音开关 / 音色，都通过 `init({ toast })` 交回 UI 层
   （与 `G.Fishing` 的 `cb.onCatch / cb.onMiss` 是同一套写法。）

   🔴 三条设计口径（改之前先读，理由都在这里）：
     ① **同一个场景只出一句**：不是「有语音就念、没语音就哑掉」，而是
        **文字气泡永远有，语音是加成**。所以玩家关掉语音之后，助手的表现
        是「不吭声但话还在」—— 验收里那条「关掉后完全不出声但文字照常」
        就是这么来的。**反过来做（没语音就不说）会让这个功能悄悄消失**。
     ② **台词轮换不用随机数**（`cursor` 逐条推）—— 随机会让「同一个场景
        说两次」的结果不可定点复现，而本项目的门禁全靠可复现（`Goals` /
        `Loot` 那套「种子 + 现算」同理）。轮换顺带解决了「连着两次说同一句」。
     ③ **语音不走 `G.Audio`**（系统 TTS 是浏览器另一套子系统，没有增益节点）
        ⇒ 总音量必须在**这里**乘进 `volume`。否则「音量拉到 0 语音还在念」，
        而那条滑块的文案是「所有声音的总闸门」——文案与实现分家是最难查的一类。
   ========================================================= */

window.G = window.G || {};

G.Assistant = (function () {

  /* 语气表：场景键 → 语调。**「哪些场景出声」在 config**（`CFG.assistant.speakKeys`），
     这里只管「这件事该用什么语气说」—— 那是判定，不是数值。 */
  var UP = 'up', DOWN = 'down';
  var TONE = { legendary: UP, record: UP, snap: DOWN };

  var cb = { toast: null };
  var lastAt = {};   /* 场景键 → 上次播报的时刻（`sys.now()`），动态键 */
  var cursor = {};   /* 场景键 → 下一句台词的下标（轮换，不用随机） */

  function cfg() { return (G.CONFIG && G.CONFIG.assistant) || {}; }
  function now() {
    return (G.Platform && G.Platform.sys && G.Platform.sys.now)
      ? G.Platform.sys.now() : Date.now();
  }
  /* 台词表：`src/data/assistant.js`。缺表 / 空数组都按「没这句」处理 ——
     单测与「素材缺失」都能落到这条路上，而不是抛异常。 */
  function lines(key) {
    var all = G.ASSISTANT_LINES;
    var t = (all && typeof all === 'object') ? all[key] : null;
    return (t && t.length) ? t : null;
  }
  /* 传说档的下标**从 `CFG.rarity` 现算**（认 `key === 'legend'`）——
     不写死 3，也不假设「传说永远是最后一档」（数值链改档位顺序时这里不该跟着改）。 */
  function legendIdx() {
    var r = (G.CONFIG && G.CONFIG.rarity) || [];
    for (var i = 0; i < r.length; i++) if (r[i].key === 'legend') return i;
    return r.length - 1;
  }
  /* 挂机（自动钓鱼）时不开口：那是「人不在屏幕前」的场景，
     念稿只会与挂机批量提示抢注意力。判定走 `G.Fishing` 的公开口径，不另读存档。 */
  function muted() {
    return !!(G.Fishing && typeof G.Fishing.isIdleMode === 'function' && G.Fishing.isIdleMode());
  }
  /* 语音开不开 + 这一句该不该出声。**只看 `settings.speech`**：
     「音效」那条开关的文案是「开关全部**程序化音效**」，而语音是系统 TTS、
     不是程序化音效 —— 所以它有自己的一行开关（面板里就在它上面）。 */
  function voiceOn() {
    var s = (G.State && G.State.get) ? G.State.get() : null;
    if (!s || !s.settings) return false;
    if (!s.settings.speech) return false;
    /* 总音量 0 = 玩家把所有的声音都关了：这时**不调用** TTS，
       而不是「调用一个音量 0 的 TTS」（后者会照常把 `spoken` 记成 true，
       界面上看着像在念、耳朵里什么都没有）。 */
    return s.settings.volume > 0.001;
  }
  function speaks(key) {
    var list = cfg().speakKeys;
    return !!(list && list.indexOf(key) >= 0);
  }
  function speakLine(text, key) {
    var sp = G.Platform && G.Platform.speech;
    if (!sp || !sp.speak) return false;
    var s = (G.State && G.State.get) ? G.State.get() : null;
    var se = (s && s.settings) || {};
    var tune = TONE[key] === UP ? cfg().tuneUp : (TONE[key] === DOWN ? cfg().tuneDown : null);
    var rate = (se.speechRate == null ? 1 : se.speechRate) * (tune ? tune.rateMul : 1);
    var pitch = (se.speechPitch == null ? 1 : se.speechPitch) * (tune ? tune.pitchMul : 1);
    return !!sp.speak(text, {
      voice: se.voice || '',
      rate: rate,
      pitch: pitch,
      volume: se.volume,
    });
  }

  /* 播报一句：节流 → 取下一句 → （按分档）出声 → 出文字气泡。
     返回这一句的 `{ key, text, spoken }`，节流命中或没有台词就返回 null。 */
  function say(key, force) {
    var t = lines(key);
    if (!t) return null;
    if (!force) {
      var gap = cfg().minGapMs || 0;
      var at = now();
      if (lastAt[key] != null && (at - lastAt[key]) < gap) return null;
      lastAt[key] = at;
    }
    var i = cursor[key] || 0;
    cursor[key] = (i + 1) % t.length;
    var text = t[i];
    var line = { key: key, text: text, spoken: false };
    if (force || (speaks(key) && voiceOn())) line.spoken = speakLine(text, key);
    if (cb.toast) cb.toast(line);
    return line;
  }

  /* ---------------- 对外 ---------------- */
  return {
    /* `init({ toast })`：`toast(line)` 由 UI 层实现（现在是 `Hud.toast`）。
       没有 toast 回调时助手**静默说话**（出声照旧）—— 测试里就是这么用的。 */
    init: function (opts) {
      cb.toast = (opts && typeof opts.toast === 'function') ? opts.toast : null;
    },
    /* 一条鱼上岸。优先级：传说档 > 个人纪录 > 不出声（普通鱼不接话 ——
       每竿一句 = 挂机时每分钟好几条，那是刷屏不是陪伴）。 */
    onCatch: function (info) {
      if (muted()) return null;
      var rar = info ? info.rar : null;
      if (typeof rar === 'number' && rar >= legendIdx()) return say('legendary');
      if (info && info.isRecord) return say('record');
      return null;
    },
    /* 这一竿丢了。只有**断线**值得搭一句话；脱钩 / 错过咬口游戏自己已经说清楚了，
       助手再补一句就是「同一件事两处说」（而两处迟早会分家）。 */
    onMiss: function (result) {
      if (muted()) return null;
      return result === 'snap' ? say('snap') : null;
    },
    /* 设置面板的「试听」：**不受节流 / 不受语音开关约束**（玩家刚按下按钮就是要听），
       但受总音量约束（音量 0 时点了没声音 —— 那正是他要的）。
       返回 true = 这一句真的送出去了（机器上有没有音色则不作承诺，见 platform.speech）。 */
    preview: function () {
      var line = say('preview', true);
      return !!(line && line.spoken);
    },
    /* 清空节流与轮换游标（测试用；也留给将来的「重置存档」入口）——
       ⚠️ 它**不碰存档、不碰平台能力**，只是把模块内部的两张表清空。 */
    reset: function () { lastAt = {}; cursor = {}; },
  };
})();
