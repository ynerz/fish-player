/* =========================================================
   util.js  —  通用工具：随机数、格式化、DOM、数学
   ========================================================= */
window.G = window.G || {};

G.U = (function () {

  /* ---------------- 随机 ---------------- */
  function rnd() { return Math.random(); }
  function range(a, b) { return a + Math.random() * (b - a); }
  function irange(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function chance(p) { return Math.random() < p; }

  /* 偏向小值的随机（skew 越大越偏小） */
  function skew(min, max, k) {
    k = k || 1;
    var t = Math.pow(Math.random(), k);
    return min + (max - min) * t;
  }

  /* 按权重抽取：items 需有 w 字段（weightKey 可指定） */
  function weighted(items, weightKey) {
    weightKey = weightKey || 'w';
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += (items[i][weightKey] || 0);
    if (total <= 0) return items[0] || null;
    var r = Math.random() * total;
    for (i = 0; i < items.length; i++) {
      r -= (items[i][weightKey] || 0);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /* 把权重数组归一化到合计 1 */
  function normalize(arr) {
    var s = arr.reduce(function (a, b) { return a + b; }, 0);
    return s <= 0 ? arr : arr.map(function (v) { return v / s; });
  }

  /* ---------------- 数学 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  /* 十六进制颜色 → rgb 数组 */
  function hex2rgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(r, g, b) {
    function h(v) { v = Math.round(clamp(v, 0, 255)); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + h(r) + h(g) + h(b);
  }
  /* 混合两色 */
  function mix(c1, c2, t) {
    var a = hex2rgb(c1), b = hex2rgb(c2);
    return rgb2hex(lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t));
  }
  /* 变亮/变暗 */
  function lighten(c, t) { var a = hex2rgb(c); return rgb2hex(lerp(a[0],255,t), lerp(a[1],255,t), lerp(a[2],255,t)); }
  function darken(c, t) { var a = hex2rgb(c); return rgb2hex(a[0]*(1-t), a[1]*(1-t), a[2]*(1-t)); }
  function rgba(hex, a) {
    var c = hex2rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  /* ---------------- 格式化 ---------------- */
  function num(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /* 金币：超过 1 万用 k / 万 */
  function coin(n) {
    n = Math.round(n);
    if (n < 10000) return num(n);
    if (n < 100000000) return (n / 10000).toFixed(n < 100000 ? 2 : 1) + '万';
    return (n / 100000000).toFixed(2) + '亿';
  }
  /* 秒 → 时长文本 */
  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), mm = m % 60;
    if (h < 100) return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
    var d = Math.floor(h / 24);
    return d + ' 天 ' + (h % 24) + ' 小时';
  }
  /* 秒 → 01:23:45 */
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  /* 重量文本 */
  function kg(w) {
    if (w < 1) return (w * 1000).toFixed(0) + ' g';
    if (w < 100) return w.toFixed(w < 10 ? 2 : 1) + ' kg';
    return Math.round(w) + ' kg';
  }

  /* ---------------- DOM ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function on(node, ev, fn, opt) { if (node) node.addEventListener(ev, fn, opt); }

  return {
    rnd: rnd, range: range, irange: irange, pick: pick, chance: chance,
    skew: skew, weighted: weighted, normalize: normalize,
    clamp: clamp, lerp: lerp, easeOut: easeOut,
    hex2rgb: hex2rgb, rgb2hex: rgb2hex, mix: mix, lighten: lighten,
    darken: darken, rgba: rgba,
    num: num, coin: coin, dur: dur, clock: clock, kg: kg,
    $: $, $$: $$, el: el, on: on,
  };
})();
