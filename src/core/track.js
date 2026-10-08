/* =========================================================
   track.js  —  错误上报 / 埋点（**空壳**）
   =========================================================
   定位：单机阶段不接任何外部服务，但要把「崩在哪一步」留下来。
   所以这里只做两件事：
     ① 挂 window.onerror / unhandledrejection，把异常记进**内存环形缓冲**
     ② 提供 G.Track.error / warn / event 三个采集点 + 一份可导出的文本

   为什么需要它：现在的异常处理是「什么都不做」——
   boot 里抛一个异常就是白屏，玩家只能说「打不开」，
   我们连崩在哪一步、在哪个钓场都问不出来。

   设计约束：
     · 全部参数在 CFG.track（enabled / buffer / maxMessage / dedupe），本文件不写死数值
     · 除了 `G.Platform.storage` 与 `console` 之外不碰任何平台能力 ——
       不出现 `localStorage` 字面量、不联网（将来上小程序也不用改采集点）
     · **绝不因为记日志本身而抛异常**（所有入口 try/catch 兜底）
     · 连续重复的消息只累加次数（n）不新占一条 ——
       渲染循环里出错是每帧一次，不合并的话缓冲一眨眼就被刷光了
     · 环形缓冲**落盘**（走 G.Platform.storage）——
       最该拿到的那条日志恰恰是「白屏」：刷新之后内存缓冲就没了，
       玩家又没法一边看着白屏一边开控制台，所以必须自己活过一次 reload

   将来接外部服务：实现 flush(records) 并在这里调用即可，采集点不用动。
   ========================================================= */
window.G = window.G || {};

G.Track = (function () {
  var CFG = G.CONFIG;
  var T = CFG.track || {};

  /* 落盘结构的版本号。**与存档的 SAVE_V 无关**（那是玩家数据的版本，
     这里是「日志文件长什么样」的版本），所以不要跟着 SAVE_V 一起改。 */
  var TRACK_SAVE_V = 1;

  var buf = [];        // 环形缓冲（数组尾部最新）
  var seq = 0;         // 自增序号（给用户反馈时对得上号）
  var installed = false;
  var listeners = [];  // flush 钩子（外部上报的接入点）
  var restored = 0;    // 本次启动从磁盘接回来的条数（0 = 没有上次的日志）
  var lastSave = 0;    // 上次落盘时间（节流用）

  function enabled() { return T.enabled !== false; }
  function limit() { return Math.max(1, T.buffer || 40); }
  function saveKey() { return T.storageKey || 'fishplayer.track.v1'; }

  /* 把任意值转成「可以安全写进日志」的东西：不抛异常、不无限长 */
  function safe(v, depth) {
    depth = depth || 0;
    try {
      if (v == null) return null;
      var t = typeof v;
      if (t === 'number') return isFinite(v) ? v : String(v);
      if (t === 'boolean' || t === 'string') return String(v).slice(0, 200);
      if (t === 'function') return '[function]';
      if (depth >= 2) return '[deep]';
      if (t === 'object') {
        if (v instanceof Error) return { name: v.name, message: String(v.message).slice(0, 200) };
        var out = {}, n = 0;
        for (var k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          if (n++ >= 12) { out['…'] = 'truncated'; break; }
          out[k] = safe(v[k], depth + 1);
        }
        return out;
      }
      return String(v).slice(0, 200);
    } catch (e) { return '[unserializable]'; }
  }

  /* 「卡在哪一步」：出问题时游戏处在什么状态。这才是最有诊断价值的一栏。 */
  function ctx() {
    try {
      var s = (G.State && G.State.get) ? G.State.get() : null;
      return {
        ver: CFG.version,
        phase: (G.Fishing && G.Fishing.getState) ? G.Fishing.getState() : '?',
        field: s ? s.field : null,
        book: s && s.book ? Object.keys(s.book).length : null,
        coin: s ? Math.round(s.coin) : null,
        idle: s && s.settings ? !!s.settings.idle : null,
      };
    } catch (e) { return null; }
  }

  function stackOf(err) {
    try {
      if (err && err.stack) return String(err.stack).slice(0, (T.maxMessage || 300) * 3);
      if (typeof err === 'string') return null;
      return null;
    } catch (e) { return null; }
  }

  /* ---------------- 落盘（活过刷新） ----------------
     最该拿到的日志是白屏那一条：刷新之后内存里什么都没了，
     玩家又不可能一边看着白屏一边开控制台，所以缓冲要自己落盘。
     存储一律走 G.Platform.storage（被禁用时会退回内存实现，不影响游戏）。 */

  /* 把缓冲打包成一个字符串。超长时从头部丢记录（保最新）。
     返回 null = 连一条都塞不下，调用方就别写盘了。 */
  function pack(recs) {
    recs = recs || buf;
    var cap = T.persistMaxBytes || 32000;
    var out = recs.slice(-limit());
    while (true) {
      var s;
      try {
        s = JSON.stringify({
          sv: TRACK_SAVE_V, ver: CFG.version, at: Date.now(),
          restored: restored, records: out,
        });
      } catch (e) { return null; }
      if (s.length <= cap) return s;
      if (out.length <= 1) return null;
      out = out.slice(1);
    }
  }

  /* 落盘。force=true 时不等节流窗口（新建的 error 记录优先写下去）。
     被节流挡下的写入不是丢掉，而是排一次延迟写 —— 否则「报错后立刻崩」时，
     恰恰最后那几条会留在内存里跟着页面一起消失。 */
  var pendingSave = false;
  function scheduleSave() {
    if (pendingSave) return;
    pendingSave = true;
    try {
      setTimeout(function () { pendingSave = false; save(true); }, (T.persistMinMs || 500));
    } catch (e) { pendingSave = false; }   // 环境没有定时器就放弃（不能影响游戏）
  }
  function save(force) {
    if (!enabled() || T.persist === false) return false;
    var now = Date.now();
    if (!force && now - lastSave < (T.persistMinMs || 500)) { scheduleSave(); return false; }
    var payload = pack();
    if (payload == null) return false;
    try {
      G.Platform.storage.set(saveKey(), payload);
      lastSave = now;
      return true;
    } catch (e) { return false; }        // 存不下也不许影响游戏
  }

  /* 从磁盘接回上次会话的日志。脏数据一律丢掉，不许把游戏带崩。 */
  function sanitize(r) {
    if (!r || typeof r !== 'object') return null;
    return {
      i: isFinite(r.i) ? Math.max(1, Math.floor(r.i)) : 1,
      t: isFinite(r.t) ? r.t : Date.now(),
      level: (r.level === 'error' || r.level === 'warn') ? r.level : 'event',
      name: String(r.name == null ? '' : r.name).slice(0, 60),
      msg: String(r.msg == null ? '' : r.msg).slice(0, T.maxMessage || 300),
      n: isFinite(r.n) ? Math.max(1, Math.floor(r.n)) : 1,
      stack: typeof r.stack === 'string' ? r.stack.slice(0, (T.maxMessage || 300) * 3) : null,
      extra: (r.extra && typeof r.extra === 'object') ? r.extra : null,
      ctx: (r.ctx && typeof r.ctx === 'object') ? r.ctx : null,
      prev: true,                        // 上次会话留下的（dump 里标出来）
    };
  }
  function load() {
    if (!enabled() || T.persist === false) return 0;
    try {
      var raw = G.Platform && G.Platform.storage ? G.Platform.storage.get(saveKey()) : null;
      if (!raw) return 0;
      var d = JSON.parse(raw);
      if (!d || !(d.records instanceof Array)) return 0;
      var recs = d.records.slice(-limit()).map(sanitize).filter(function (r) { return r !== null; });
      if (!recs.length) return 0;
      buf = recs;
      seq = 0;
      for (var i = 0; i < recs.length; i++) if (recs[i].i > seq) seq = recs[i].i;
      restored = recs.length;
      return restored;
    } catch (e) { return 0; }
  }

  /* ---------------- 采集 ---------------- */
  function record(level, name, msg, extra, err) {
    if (!enabled()) return null;
    try {
      var text = String(msg == null ? '' : msg).slice(0, T.maxMessage || 300);
      var last = buf.length ? buf[buf.length - 1] : null;
      /* 合并连击：渲染循环里出错是每帧一次，不合并会把缓冲瞬间刷光 */
      if (T.dedupe !== false && last && last.level === level && last.name === name && last.msg === text) {
        last.n = (last.n || 1) + 1;
        last.t = Date.now();
        save(false);                             // 连击只更新次数，按节流写
        return last;
      }
      var rec = {
        i: ++seq,
        t: Date.now(),
        level: level,
        name: String(name == null ? '' : name).slice(0, 60),
        msg: text,
        n: 1,
        stack: stackOf(err),
        extra: extra === undefined ? null : safe(extra),
        ctx: ctx(),
      };
      buf.push(rec);
      var over = buf.length - limit();
      while (over-- > 0) buf.shift();          // 环形：超了从头丢
      listeners.forEach(function (fn) { try { fn(rec); } catch (e) {} });
      save(level === 'error');                 // 报错优先落盘（白屏那条最值钱）
      return rec;
    } catch (e) { return null; }               // 记日志自己绝不抛
  }

  function error(name, err, extra) {
    var msg = (err && err.message) ? err.message : (err == null ? name : err);
    var nm = (err && err.message) ? name : 'error';
    var rec = record('error', nm, msg, extra, err);
    /* 白屏是最糟的情况，至少让控制台留一份（console 是 Web/小程序都有的最小能力） */
    try {
      if (typeof console !== 'undefined' && console.error) console.error('[Track]', name, msg, extra || '');
    } catch (e) {}
    return rec;
  }
  function warn(name, msg, extra) { return record('warn', name, msg, extra); }
  function event(name, extra) { return record('event', name, name, extra); }

  /* ---------------- 全局兜底 ---------------- */
  function init() {
    if (installed) return restored;
    installed = true;
    load();                       // 先把上次会话的日志接回来，再挂全局兜底
    if (T.captureGlobal === false) return restored;
    try {
      /* 全局钩子一律走平台层 —— Web 端是 window 的 error / unhandledrejection，
         换平台时只改 platform.js（第 ㊱ 节盯「字面量只许出现在 platform.js」）。 */
      var sys = window.G.Platform.sys;
      sys.onError(function (e) {
        var err = e && e.error;
        record('error', 'window.onerror',
          (e && e.message) || (err && err.message) || 'unknown error',
          { src: e && e.source, line: e && e.lineno, col: e && e.colno }, err);
      });
      sys.onRejection(function (e) {
        var r = e && e.reason;
        record('error', 'unhandledrejection',
          (r && r.message) || String(r), null, r);
      });
    } catch (e) { /* 环境不支持就算了，采集点仍然可用 */ }
  }

  /* ---------------- 外部上报的接入点（当前是空壳） ----------------
     上线接服务时：实现这里（把 records POST 出去），其余代码不用动。 */
  function flush(records) {
    void records;
    return false;    // false = 还没接外部服务
  }
  function onFlush(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /* ---------------- 读取 ---------------- */
  function list() { return buf.slice(); }
  function count() { return buf.length; }
  /* 清空内存缓冲，并把「空」写回磁盘 —— 否则刷新一次旧的日志又会冒出来 */
  function clear() { buf = []; restored = 0; save(true); return true; }
  /* 本次启动从磁盘接回上次会话的条数（0 = 干净启动） */
  function restoredCount() { return restored; }
  /* 手动把缓冲写下去（设置面板/开发者面板用得到），返回是否写成功 */
  function persist() { return save(true); }
  /* 可粘贴给开发者的纯文本（不含任何平台对象，纯字符串拼接） */
  function dump() {
    try {
      var lines = ['# 钓鱼人生 v' + CFG.version + ' 运行日志（最近 ' + buf.length + ' 条' +
        (restored ? '，其中 ' + restored + ' 条来自上次会话' : '') + '）'];
      buf.forEach(function (r) {
        var c = r.ctx || {};
        lines.push('[' + r.i + '] ' + r.level.toUpperCase() + ' ' + r.name +
          (r.n > 1 ? ' ×' + r.n : '') +
          ' @ ' + new Date(r.t).toISOString() +
          '（' + (c.phase || '?') + ' / ' + (c.field || '?') + '）' +
          (r.prev ? ' [上次会话]' : ''));
        lines.push('    ' + r.msg);
        if (r.extra) lines.push('    extra: ' + JSON.stringify(r.extra));
        if (r.stack) lines.push('    stack: ' + r.stack.split('\n').slice(0, 4).join(' / '));
      });
      return lines.join('\n');
    } catch (e) { return '# 日志导出失败：' + e.message; }
  }
  function dumpJson() {
    var s = pack(buf);
    return s == null ? '{"error":"serialize failed"}' : s;
  }

  return {
    init: init, error: error, warn: warn, event: event,
    list: list, count: count, clear: clear,
    dump: dump, dumpJson: dumpJson,
    restored: restoredCount, persist: persist,
    flush: flush, onFlush: onFlush,
    enabled: enabled,
  };
})();
