/* =========================================================
   weather.js  —  天气与时段（v0.5.0 新增）
   =========================================================
   设计目标：给「什么时候钓」这件事加上意义，但**不做硬性门禁**
   （不能出现「这条鱼只有下雨才能钓」→ 会卡死图鉴）。

   做法：
     · 每个鱼种可以有「天气偏好」和「时段偏好」（fish.js 的 wx / tm）
     · 命中偏好时该鱼的抽取权重 ×2.2 —— 只是更容易出，不是唯一解
     · 天气与时段各自还会整体抬高「稀有档权重」与「稀有颜色概率」
     · 所以「雨天夜钓」是明显的高光时刻，但晴天白天一样能玩

   时间的推进用**游戏内时钟**（一天 = 20 分钟真实时间），
   而不是跟随系统时间 —— 否则只在晚上玩的人永远看不到白天。

   对所有数值工具（balance / verify / gen-collect-time）而言，天气是「平均态」：
   它们不传 env，倍率全部为 1，所以节奏表与掉率表仍然是基线口径。
   ========================================================= */
window.G = window.G || {};

G.Weather = (function () {
  var U = G.U, CFG = G.CONFIG;
  var W = CFG.weather;

  var cur = null;        // 当前天气定义
  var left = 0;          // 当前天气还剩多少秒
  var tClock = 0;        // 游戏内一天已过的秒数
  var tIdx = 0;          // 当前时段下标

  var listeners = [];

  /* 天气权重表里挑一个（避开与当前相同的，除非只有一种） */
  function rollWeather(prevKey) {
    var list = W.types.filter(function (t) { return t.key !== prevKey; });
    if (!list.length) list = W.types;
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].weight;
    var r = Math.random() * total;
    for (i = 0; i < list.length; i++) { r -= list[i].weight; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }

  function timeDef() { return W.times[tIdx]; }

  function init(seed) {
    cur = rollWeather(null);
    left = U.range(W.minDur, W.maxDur);
    /* 让每次开局的起点不完全一样，但又不会太离谱 */
    tClock = (seed || Math.random()) * W.dayLen;
    tIdx = Math.floor(tClock / (W.dayLen / W.times.length)) % W.times.length;
  }

  function emit() {
    listeners.forEach(function (fn) { fn(snapshot()); });
  }
  function on(fn) { listeners.push(fn); }

  function update(dt) {
    if (!cur) return;
    left -= dt;
    if (left <= 0) {
      cur = rollWeather(cur.key);
      left = U.range(W.minDur, W.maxDur);
      emit();
    }
    tClock = (tClock + dt) % W.dayLen;
    var idx = Math.floor(tClock / (W.dayLen / W.times.length)) % W.times.length;
    if (idx !== tIdx) { tIdx = idx; emit(); }
  }

  /* 给抽卡用的环境描述；工具不传就是全 1 的中性环境 */
  function env() {
    if (!cur) return null;
    var t = timeDef();
    return {
      wx: cur.key,
      tm: t.key,
      rareMul: (cur.rareMul || 1) * (t.rareMul || 1),
      colorBoost: (cur.colorBoost || 1) * (t.colorBoost || 1),
    };
  }

  /* 中性环境：数值工具与离线补算用（保证与节奏表口径一致） */
  function neutral() {
    return { wx: null, tm: null, rareMul: 1, colorBoost: 1 };
  }

  function snapshot() {
    var t = timeDef();
    var dayPct = tClock / W.dayLen;
    return {
      wx: cur, tm: t,
      left: left,
      dayPct: dayPct,
      clock: fmtClock(),
      rareMul: (cur.rareMul || 1) * (t.rareMul || 1),
      colorBoost: (cur.colorBoost || 1) * (t.colorBoost || 1),
    };
  }

  /* 游戏内时钟 HH:MM
     四个时段各占 6 小时，整体 +4 小时偏移，让「晨」落在 4:00 而不是 0:00：
       晨 4~10 ｜ 昼 10~16 ｜ 暮 16~22 ｜ 夜 22~4 */
  var CLOCK_OFFSET_H = 4;
  function fmtClock() {
    var total = Math.floor(((tClock / W.dayLen) * 24 + CLOCK_OFFSET_H) % 24 * 60);
    var h = Math.floor(total / 60), m = total % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function set(weatherKey, timeKey) {
    if (weatherKey) {
      var w = W.types.filter(function (x) { return x.key === weatherKey; })[0];
      if (w) cur = w;
    }
    if (timeKey) {
      var i = W.times.map(function (x) { return x.key; }).indexOf(timeKey);
      if (i >= 0) { tIdx = i; tClock = i * (W.dayLen / W.times.length); }
    }
    emit();
  }

  return {
    init: init, update: update, on: on,
    env: env, neutral: neutral, snapshot: snapshot,
    set: set,
    isReady: function () { return !!cur; },
  };
})();
