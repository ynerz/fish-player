/* =========================================================
   audio.js  —  Web Audio 程序化音效（不依赖任何音频素材文件）
   ========================================================= */
window.G = window.G || {};

G.Audio = (function () {

  var ctx = null;
  var master = null;
  var ambGain = null;
  var ambSrc = null;
  var enabled = true;
  var vol = 0.55;

  function ensure() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
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
    o.connect(g); g.connect(master);
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
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t0);
  }

  var API = {

    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled) API.stopAmbience();
      else if (ambGain) API.startAmbience();
    },
    isEnabled: function () { return enabled; },

    setVolume: function (v) {
      vol = G.U.clamp(v, 0, 1);
      if (master) master.gain.value = vol;
    },
    getVolume: function () { return vol; },

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
    /* 成功（按稀有度叠音） */
    success: function (rar) {
      var base = [523.25, 587.33, 659.25, 784];
      var n = rar + 2;
      for (var i = 0; i < n; i++) {
        tone(base[i % base.length] * (1 + Math.floor(i / base.length) * 2),
             0.30, 'sine', 0.13, i * 0.075);
      }
      if (rar >= 2) tone(1568, 0.6, 'triangle', 0.10, n * 0.075);
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
      src.connect(flt); flt.connect(ambGain); ambGain.connect(master);
      src.start();
      ambSrc = src;
      // 缓慢起伏
      var lfo = ctx.createOscillator();
      var lfoG = ctx.createGain();
      lfo.frequency.value = 0.09; lfoG.gain.value = 0.055;
      lfo.connect(lfoG); lfoG.connect(ambGain.gain);
      lfo.start();
    },
    stopAmbience: function () {
      try { if (ambSrc) ambSrc.stop(); } catch (e) {}
      ambSrc = null; ambGain = null;
    },
  };

  return API;
})();
