/* =========================================================
   audio.js  —  Web Audio 程序化音效（不依赖任何音频素材文件）
   ========================================================= */
window.G = window.G || {};

G.Audio = (function () {

  var ctx = null;
  var master = null;
  var busSfx = null;   // 音效子总线（挂在 master 下）
  var busAmb = null;   // 环境音子总线
  var busBgm = null;   // 背景音乐子总线
  var ambGain = null;
  var ambSrc = null;
  var ambLfo = null;   // 环境音的缓慢起伏 LFO（停止时要一起收，见 stopAmbience）
  var enabled = true;
  var vol = 0.55;

  function ensure() {
    if (ctx) return true;
    try {
      ctx = G.Platform.audio.createContext();
      if (!ctx) return false;
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
      /* 三条子总线（2026-10-08 加）：**音效**、**环境音**、**背景音乐**分开挂在 master 下。
         这不是为了「好看」：环境音要压得很低（0.10）、音效要顶出来，共用一个 gain
         就只能各调各的绝对值、互相牵制；更要紧的是**将来要加「音乐音量」滑块**时，
         调的是 `busBgm` 一个节点，**不用碰任何调用点**。
         ⚠️ 环境音原本也挂在 busBgm 上，这一批**拆成 busAmb** —— 环境音与 BGM 分开开关
            （设置面板已有「环境音」，这次又加了「背景音乐」），
           共一条总线的话「调小音乐」会顺手把水声一起调小，那不是玩家按下那个滑块的意思。
         ⚠️ 三条默认都是 1.00，是为了**不改动既有的音量平衡**（改了等于顺手调了一次音量）。 */
      busSfx = ctx.createGain(); busSfx.gain.value = 1.00; busSfx.connect(master);
      busAmb = ctx.createGain(); busAmb.gain.value = 1.00; busAmb.connect(master);
      busBgm = ctx.createGain(); busBgm.gain.value = 1.00; busBgm.connect(master);
    } catch (e) { return false; }
    return true;
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /* 一个短音 */
  function tone(freq, dur, type, gain, delay, freqTo) {
    if (!enabled || !ensure()) return;
    resume();
    var t0 = ctx.currentTime + (delay || 0);
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (freqTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(busSfx || master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* 噪声（水花、雨声） */
  function noise(dur, gain, filterFreq, delay, q) {
    if (!enabled || !ensure()) return;
    resume();
    var t0 = ctx.currentTime + (delay || 0);
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var flt = ctx.createBiquadFilter();
    flt.type = filterFreq > 1200 ? 'highpass' : 'lowpass';
    flt.frequency.value = filterFreq || 800;
    flt.Q.value = q || 1;
    var g = ctx.createGain();
    g.gain.value = gain || 0.2;
    src.connect(flt); flt.connect(g); g.connect(busSfx || master);
    src.start(t0);
  }

  /* ==========================================================================
   * 背景音乐（2026-10-08 加，用户口径「bgm 音效也是需要的」）
   *
   * 做法：**和弦进行 + 稀疏铃音**，全程序化合成，没有素材文件。
   * 每小节摆三件东西：
   *   · 低音   —— 和弦根音下沉两个八度（正弦，稍长）→ 让音乐「有地板」
   *   · 和弦铺底 —— 三和弦（三角波，慢起慢落）→ 这一段氛围就是它撑起来的
   *   · 铃音   —— 音阶内的高八度随机点缀，每小节 2~3 个
   *
   * ⚠️ **「每小节一个和弦、铃音稀疏」是刻意的，不是偷懒**：再密就变成旋律，
   *    会跟玩家的操作音效（咬钩 / 收线 / 结算）抢注意力。钓鱼游戏的音乐要
   *    **能听一整天而不烦**，靠的是「没有信息量」而不是「好听」。
   *
   * ⚠️ 调度必须是 **lookahead**：`setInterval` 只负责「醒来，把未来 1.2 秒该响的
   *    音一次性排进 AudioContext」，**绝不用定时器打点发声** —— 主线程一卡
   *    （渲染峰值 / 开面板），定时器就迟到，节奏立刻抖。排进 AudioContext 的音
   *    走的是音频硬件时钟，**采样级准时**。
   *
   * ⚠️ 四个要收干净的东西：定时器、总线节点、`bgmWant`（用户意图位）、
   *    以及已经排进去、还没响的音。见 bgmTeardown 的注释。
   *
   * ⚠️ 音乐参数**不写在这里**，由调用方从钓场主题（`fields.js` 的 `theme.bgm`）
   *    传进来 —— 数值不许散落在逻辑里（同 rarity / goals 的规矩），
   *    而且调音乐只要动那张表，不用碰本文件。
   * ======================================================================== */
  var SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
  };
  var bgmSpec = null;    // 当前钓场的音乐参数 { root, mode, chords, bar }
  /* 「用户想不想听音乐」与「总开关开着没」是两件事，必须分开存：
     `setEnabled(false)` 只能临时收声，**不许把意图位一起清掉** ——
     否则从设置里关一次音效再打开，音乐就再也回不来了（环境音用 `ambGain`
     非空当这个意图位，音乐这边同理，只是它没有常驻节点可借，单独存一个布尔）。 */
  var bgmWant = false;
  var bgmTimer = null;
  var bgmBus = null;     // 本次播放的收声节点（teardown 靠它做淡出）
  var bgmNext = 0;       // 下一小节的 AudioContext 时刻
  var bgmIdx = 0;        // 已经排到第几小节（决定轮到哪个和弦）

  /* 级数 → 频率。deg 1~7 对应音阶七级（0 基），可上下八度：
     `deg2freq(spec, 1, -2)` = 主音低两个八度 = 低音声部。 */
  function deg2freq(spec, deg, oct) {
    var sc = SCALES[spec.mode] || SCALES.major;
    var i = ((deg - 1) % 7 + 7) % 7;
    var wrap = Math.floor((deg - 1) / 7);          // 超过 7 级往上翻八度
    return spec.root * Math.pow(2, (sc[i] + 12 * (wrap + (oct || 0))) / 12);
  }

  /* 排一个音到**指定的时刻**（不是「现在响」）—— 这是 lookahead 的关键 */
  function bgmTone(freq, dur, type, gain, t0, atk) {
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + (atk || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(bgmBus || busBgm || master);
    o.start(t0); o.stop(t0 + dur + 0.05);          // 自己会停，所以不用记着回收
  }

  function bgmBar(spec, t0, deg) {
    var bar = spec.bar;
    bgmTone(deg2freq(spec, deg, -2), bar * 1.02, 'sine', 0.060, t0, bar * 0.22);
    /* 三和弦 = 级数 +0 / +2 / +4；高一点的音稍轻一点（避免糊成一片） */
    [0, 2, 4].forEach(function (iv, k) {
      bgmTone(deg2freq(spec, deg + iv, -1), bar * 0.94, 'triangle',
              0.030 - k * 0.004, t0 + 0.02 * k, bar * 0.34);
    });
    var n = 2 + (Math.random() < 0.45 ? 1 : 0);
    for (var i = 0; i < n; i++) {
      bgmTone(deg2freq(spec, deg + [0, 2, 4, 6][Math.floor(Math.random() * 4)], 0),
              0.9 + Math.random() * 0.6, 'sine', 0.024,
              t0 + Math.random() * (bar * 0.8), 0.012);
    }
  }

  /* 定时器唯一的工作：把未来 1.2 秒排满 */
  function bgmPump() {
    if (!bgmSpec || !enabled || !ctx) return;
    var now = ctx.currentTime;
    /* 标签页被系统挂起几秒再回来，`currentTime` 会跳很远。
       落后超过一小节就**重新对齐**，不要试图把欠的都补上 ——
       补出来的是一堵「同时响」的音墙，而且排几百个节点要好久。 */
    if (bgmNext < now - bgmSpec.bar) bgmNext = now + 0.05;
    var chs = bgmSpec.chords;
    for (var guard = 0; bgmNext < now + 1.2 && guard < 8; guard++) {
      bgmBar(bgmSpec, bgmNext, chs[bgmIdx % chs.length]);
      bgmNext += bgmSpec.bar;
      bgmIdx++;
    }
  }

  /* 收声。⚠️ 已经排进 AudioContext 的音**没法撤销**（最多再响 1.2 秒），
     所以不是去跟踪每一个源节点，而是让它们**全都经过 `bgmBus` 这个 gain**，
     收声时只把这一个 gain 淡到 0 再摘掉 —— 一次操作、无爆音，代价也小。 */
  function bgmTeardown() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    if (bgmBus) {
      var b = bgmBus;
      bgmBus = null;
      try {
        var t = ctx ? ctx.currentTime : 0;
        b.gain.cancelScheduledValues(t);
        b.gain.setValueAtTime(b.gain.value, t);
        b.gain.linearRampToValueAtTime(0.0001, t + 0.12);   // 淡出，别硬切（会「啪」一声）
        setTimeout(function () { try { b.disconnect(); } catch (e) {} }, 200);
      } catch (e) { try { b.disconnect(); } catch (e2) {} }
    }
    bgmNext = 0; bgmIdx = 0;
  }

  var API = {

    setEnabled: function (v) {
      enabled = !!v;
      /* 总开关一关：音乐与环境音一起收声。但**意图位不许动**（见 bgmWant 的注释）——
         音乐能不能回来取决于 `bgmWant`，不是 `enabled`。 */
      if (!enabled) { bgmTeardown(); API.stopAmbience(); }
      else {
        if (ambGain) API.startAmbience();
        if (bgmWant) API.startBgm();
      }
    },
    /* ⚠️ `isEnabled()` / `getVolume()` 已删：全项目零调用（开关状态只有 UI 在读，
       而 UI 读的是存档里的 settings）。返回值为「看着像基础设施」的 getter 最容易
       长成死代码，verify 第 ㉜ 节会盯着。 */

    setVolume: function (v) {
      vol = G.U.clamp(v, 0, 1);
      if (master) master.gain.value = vol;
    },

    /* 抛竿：挥竿风切 + 落水 */
    cast: function () {
      noise(0.22, 0.16, 2200, 0, 0.8);
      tone(680, 0.16, 'sine', 0.06, 0, 240);
    },
    splash: function () {
      noise(0.42, 0.30, 900, 0, 0.7);
      tone(180, 0.20, 'sine', 0.10, 0, 70);
    },
    /* 咬钩提示 */
    bite: function () {
      tone(880, 0.10, 'square', 0.14, 0);
      tone(1320, 0.12, 'square', 0.12, 0.11);
    },
    /* 咬钩前的浮漂异动：刻意做得很轻，只是「有东西在试探」的感觉 */
    hint: function () {
      tone(1180, 0.09, 'sine', 0.035, 0);
      noise(0.10, 0.030, 1600, 0, 0.9);
    },
    /* 收线咔哒 */
    tick: function () {
      tone(1500 + Math.random() * 500, 0.035, 'square', 0.045, 0);
    },
    /* 断线 */
    snap: function () {
      noise(0.14, 0.35, 3000, 0, 1.6);
      tone(420, 0.30, 'sawtooth', 0.14, 0, 90);
    },
    /* 脱钩 */
    escape: function () {
      tone(300, 0.35, 'triangle', 0.12, 0, 130);
      noise(0.24, 0.14, 700, 0.03);
    },
    /* 成功（按稀有度叠音）。**传说档走专属 fanfare**（见下）。 */
    success: function (rar) {
      var r = rar || 0;
      if (r >= 3) { API.legendary(); return; }
      var base = [523.25, 587.33, 659.25, 784];
      var n = r + 2;
      for (var i = 0; i < n; i++) {
        tone(base[i % base.length] * (1 + Math.floor(i / base.length) * 2),
             0.30, 'sine', 0.13, i * 0.075);
      }
      /* 史诗档：加高频挑音 + **低频铺底**（低频才是「有份量」的来源，纯高频只会显得单薄） */
      if (r >= 2) {
        tone(1568, 0.6, 'triangle', 0.10, n * 0.075);
        tone(196, 0.5, 'sine', 0.12, 0);
      }
    },

    /* 传说鱼专属（2026-10-08，用户口径「传说鱼要有专门的音效」）。
       ⚠️ 关键不是「比 success 多几声」，而是**换一套编制** —— 否则只是音量大一点，
          玩家听不出「我钓到了不一样的东西」。四层叠加：
          ① 低频冲击（落地的重量）② 宽琶音（成就感）③ 高频闪烁（稀有度）④ 长尾低音（托住）
       ⚠️ 它**只被 `success()` 在第 4 档（传说）时委派**，别处不直接调；
          所以它是唯一一个「消费方在本模块内」的导出方法，
          第 ㉜ 节为此专门补了「同模块成员调用也算消费方」的判据（起因见那边）。
       ⚠️ 采样层那条路：`success` 被采样接管时（`assets/audio/success.mp3` 存在）
          **不会再走到这里** —— 传说鱼会听成通用上鱼音。真出现这种情况，
          给传说单独放一份 `legendary.mp3` 即可（采样层是按方法名认的）。 */
    legendary: function () {
      tone(140, 0.55, 'sine', 0.30, 0, 55);          // ① 冲击：正弦下滑
      noise(0.30, 0.16, 500, 0, 0.6);                //    再补一层低频噪声当「钝响」
      [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0].forEach(function (f, i) {
        tone(f, 0.42, 'triangle', 0.15, 0.12 + i * 0.085);   // ② 六声上行，比 success 更宽
      });
      for (var i = 0; i < 7; i++) {                  // ③ 星尘：随机相位的高频亮点
        tone(2100 + Math.random() * 1600, 0.16, 'sine', 0.05, 0.55 + Math.random() * 0.5);
      }
      tone(261.63, 1.5, 'sine', 0.10, 0.12);         // ④ 长尾：把整段托住，不然会飘
    },

    /* 稀有颜色的「一闪」（用户口径「特效也得有」）。
       消费方：`fishing.js` 上鱼时**只在抽到非原色**（彩虹 / 白化 / 黄金 / 闪光）那一下播，
       与画面上的 `G.Scene.sparkle()` 同一时刻 —— 音画一起闪，才有「光」的感觉。
       ⚠️ 名字刻意**不叫 `sparkle`**：视觉层已经有一个 `G.Scene.sparkle()`，
          同名会让「按名扫描零调用」的门禁把它当成已消费（撞名即通过），
          实测踩过 —— `Audio.sparkle` 就是这么蒙过第 ㉜ 节的。见那里的注释。 */
    glint: function () {
      for (var i = 0; i < 5; i++) {
        tone(2400 + Math.random() * 2200, 0.12, 'sine', 0.045,
             i * 0.055 + Math.random() * 0.03);
      }
    },

    /* 领奖 / 目标达成（用户口径「各种奖励音效」）。
       消费方：`panels.js` 目标面板的「领取 / 全部领取」。
       定位：比 `coin` 更有份量（那是零钱），比 `unlock` 更轻（那是一次性的大解锁）——
       **它一天会响很多次，所以不能做太长、太亮**。
       （原本那两处用的是 `unlock`：每天领任务都放一段四声大琶音，太"隆重"了。） */
    reward: function () {
      tone(784, 0.14, 'triangle', 0.13, 0);
      tone(1046.5, 0.14, 'triangle', 0.13, 0.09);
      tone(1318.5, 0.30, 'sine', 0.12, 0.18);
    },
    /* 图鉴新记录 */
    newRecord: function () {
      tone(1046.5, 0.16, 'sine', 0.15, 0);
      tone(1318.5, 0.16, 'sine', 0.15, 0.10);
      tone(1568.0, 0.34, 'sine', 0.15, 0.20);
    },
    coin: function () {
      tone(1200, 0.07, 'square', 0.09, 0);
      tone(1600, 0.12, 'square', 0.08, 0.06);
    },
    click: function () { tone(700, 0.035, 'sine', 0.07, 0); },
    deny:  function () { tone(200, 0.14, 'square', 0.10, 0, 150); },
    unlock: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        tone(f, 0.42, 'sine', 0.14, i * 0.13);
      });
    },

    /* 环境：低频水声涌动 */
    startAmbience: function () {
      if (!enabled || !ensure()) return;
      resume();
      if (ambSrc) return;
      var len = Math.floor(ctx.sampleRate * 3);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var last = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;         // 布朗噪声
        d[i] = last * 3.2;
      }
      var src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      var flt = ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = 520;
      ambGain = ctx.createGain();
      ambGain.gain.value = 0.10;
      src.connect(flt); flt.connect(ambGain); ambGain.connect(busAmb || master);
      src.start();
      ambSrc = src;
      // 缓慢起伏
      var lfo = ctx.createOscillator();
      var lfoG = ctx.createGain();
      lfo.frequency.value = 0.09; lfoG.gain.value = 0.055;
      lfo.connect(lfoG); lfoG.connect(ambGain.gain);
      lfo.start();
      ambLfo = lfo;
    },
    /* ⚠️ 三样都要收：buffer 源、LFO、以及挂在 busAmb 上的那个 gain 节点。
       原来只 `ambSrc.stop()` —— LFO 是另一个独立振荡器，不 stop 就会**一直跑下去**
       （它连在 ambGain.gain 上，而 ambGain 自己也还挂在总线上），
       表现是：在设置里反复开关环境音，后台悄悄多出几套一直在跑的振荡器。 */
    stopAmbience: function () {
      try { if (ambSrc) ambSrc.stop(); } catch (e) {}
      try { if (ambLfo) ambLfo.stop(); } catch (e) {}
      try { if (ambGain) ambGain.disconnect(); } catch (e) {}
      ambSrc = null; ambGain = null; ambLfo = null;
    },

    /* ---------------------------------------------------------
       背景音乐（2026-10-08 加）
       ---------------------------------------------------------
       `spec` 就是钓场主题的 `theme.bgm`：`{ root, mode, chords, bar }`。
       · 传 spec → 换曲子；**已经在放的时候只换参数、不重启调度器** ——
         切钓场时音乐不该从头来一遍（那一下很突兀），接着往下走、和弦自然换过去。
       · 不传 spec → 沿用上次那份（`setEnabled(true)` 恢复播放走这条路）。
       拿不到 AudioContext / 没参数 / 总开关关着都**静默返回**，绝不抛。 */
    startBgm: function (spec) {
      if (spec && spec.chords && spec.chords.length) bgmSpec = spec;
      bgmWant = true;
      if (!enabled || !bgmSpec || !ensure()) return;
      resume();
      if (bgmTimer) return;                  // 已经在放：只换曲，不重启
      bgmBus = ctx.createGain();
      bgmBus.gain.value = 1;
      bgmBus.connect(busBgm || master);
      bgmIdx = 0;
      bgmNext = ctx.currentTime + 0.15;
      bgmPump();                             // 先排一小节，别等第一次定时器
      bgmTimer = setInterval(bgmPump, 250);
    },
    /* 收声（含淡出、定时器、总线节点）。**同时清掉意图位** ——
       这是「用户不想听音乐了」，与 setEnabled(false) 的临时收声不同。 */
    stopBgm: function () {
      bgmWant = false;
      bgmTeardown();
    },
  };

  /* ==========================================================================
   * 采样音效层（2026-10-08 加）
   *
   * 做法：**公开 API 一个都不变**（仍是 cast / splash / …），只在下面把 `API` 上
   * 除开关 / 环境音 / 音乐之外的每个方法包一层「先试采样、拿不到就照旧走原合成」。
   * ⇒ 全项目 **56 个播放点零改动**，`tools/test.js` 的 audioStub 也不用动。
   *
   * 素材放 `assets/audio/<id>.mp3`（键是 `sfx:<id>`，路径由 `G.Assets` 统一拼）。
   * ⚠️ **音效清单就是 `API` 自己的方法名** —— 不在这里再列一遍。
   *    清单写两份必然分家（本项目反复踩过的坑型）；将来加一个音效方法，
   *    采样回退会自动跟上，不需要记得回来改这里。
   *
   * ⚠️ 三条必须守住的：
   *   1. **未就绪 ≠ 静音**：采样是异步的，首次触发时必然还没回来 —— 本次必须**照旧播合成音**、
   *      同时后台预取，**不能 return**（否则开局几秒是哑的，而且很难被发现）。
   *   2. **失败一律不抛**：`G.Assets.sfx` 失败返回 null 并记备忘，这里收到 null 就永久走合成。
   *      `file://` 下读不到音频文件属预期，也走这条路。
   *   3. **音量走子总线** —— 音效挂 `busSfx`、环境音挂 `busAmb`，两者最终都汇到 `master`，
   *      所以 `setVolume` / `setEnabled` 仍然只有一处生效，而环境音与音乐将来能各自调。
   *
   * ⚠️ **循环播放的三件事不做采样**：环境音（startAmbience / stopAmbience）
   *    与背景音乐（startBgm / stopBgm）都要循环、都有节点生命周期，
   *    与一次性音效不是一回事 —— 它们进 `NO_SAMPLE`，见下面那张表。
   *    真要做音乐采样，走的是「整段循环 buffer」的另一套（见 docs/改进待办.md）。
   * ======================================================================== */
  var sampleBuf = {};    // id → AudioBuffer（拿到之后就一直用它）
  var sampleAsked = {};  // id → true（只请求一次）
  var NO_SAMPLE = {
    setEnabled: 1, setVolume: 1,
    startAmbience: 1, stopAmbience: 1,
    startBgm: 1, stopBgm: 1,
  };

  function playSample(id) {
    var b = sampleBuf[id];
    if (!b || !ensure()) return false;
    try {
      resume();
      var s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(busSfx || master);            // 音效走音效总线（与环境音 / 音乐分开）
      s.start();
      return true;
    } catch (e) { return false; }   // 播不出来就当没有采样，让调用方回退合成
  }

  Object.keys(API).forEach(function (id) {
    if (NO_SAMPLE[id]) return;
    var synth = API[id];
    if (typeof synth !== 'function') return;
    API[id] = function () {
      /* 总开关优先。原来这层判断在 tone/noise 内部，而采样路径绕过了它，所以必须在这里补。 */
      if (!enabled) return;
      if (playSample(id)) return;               // 有采样 → 播采样
      if (!sampleAsked[id] && G.Assets && G.Assets.sfx) {
        sampleAsked[id] = true;                 // 只问一次；失败的键由 G.Assets 记备忘
        G.Assets.sfx(id).then(function (b) { if (b) sampleBuf[id] = b; });
      }
      return synth.apply(null, arguments);      // 没采样：**照旧出声**，绝不是静音
    };
  });

  return API;
})();
