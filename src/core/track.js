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
     · 不碰 localStorage / console 之外的任何平台能力（将来上小程序也不用改采集点）
     · **绝不因为记日志本身而抛异常**（所有入口 try/catch 兜底）
     · 连续重复的消息只累加次数（n）不新占一条 ——
       渲染循环里出错是每帧一次，不合并的话缓冲一眨眼就被刷光了

   将来接外部服务：实现 flush(records) 并在这里调用即可，采集点不用动。
   ========================================================= */
window.G = window.G || {};

G.Track = (function () {
  var CFG = G.CONFIG;
  var T = CFG.track || {};

  var buf = [];        // 环形缓冲（数组尾部最新）
  var seq = 0;         // 自增序号（给用户反馈时对得上号）
  var installed = false;
  var listeners = [];  // flush 钩子（外部上报的接入点）

  function enabled() { return T.enabled !== false; }
  function limit() { return Math.max(1, T.buffer || 40); }

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
    if (installed || T.captureGlobal === false) { installed = true; return; }
    installed = true;
    try {
      var w = window;
      /* 用 addEventListener 而不是 onerror=，避免覆盖别人的处理器 */
      w.addEventListener('error', function (e) {
        var err = e && e.error;
        record('error', 'window.onerror',
          (e && e.message) || (err && err.message) || 'unknown error',
          { src: e && e.source, line: e && e.lineno, col: e && e.colno }, err);
      });
      w.addEventListener('unhandledrejection', function (e) {
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
  function clear() { buf = []; return true; }
  /* 去重后的条数（合并过的连击只算一条） */
  function kinds() { return buf.length; }
  /* 可粘贴给开发者的纯文本（不含任何平台对象，纯字符串拼接） */
  function dump() {
    try {
      var lines = ['# 钓鱼人生 v' + CFG.version + ' 运行日志（最近 ' + buf.length + ' 条）'];
      buf.forEach(function (r) {
        var c = r.ctx || {};
        lines.push('[' + r.i + '] ' + r.level.toUpperCase() + ' ' + r.name +
          (r.n > 1 ? ' ×' + r.n : '') +
          ' @ ' + new Date(r.t).toISOString() +
          '（' + (c.phase || '?') + ' / ' + (c.field || '?') + '）');
        lines.push('    ' + r.msg);
        if (r.extra) lines.push('    extra: ' + JSON.stringify(r.extra));
        if (r.stack) lines.push('    stack: ' + r.stack.split('\n').slice(0, 4).join(' / '));
      });
      return lines.join('\n');
    } catch (e) { return '# 日志导出失败：' + e.message; }
  }
  function dumpJson() {
    try { return JSON.stringify({ v: CFG.version, at: Date.now(), records: buf }); }
    catch (e) { return '{"error":"serialize failed"}'; }
  }

  return {
    init: init, error: error, warn: warn, event: event,
    list: list, count: count, kinds: kinds, clear: clear,
    dump: dump, dumpJson: dumpJson,
    flush: flush, onFlush: onFlush,
    enabled: enabled,
  };
})();
