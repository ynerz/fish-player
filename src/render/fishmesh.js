/* ============================================================================
 * fishmesh.js —— 体型参数 → 三角网格
 *
 * 规格：docs/3D渲染方案.md §3
 * 职责边界（**不要越界**）：
 *   · 纯数学：给一组体型参数，吐出顶点 + 三角面
 *   · **不碰 DOM / Canvas**，也**不引用 G.FishArt / G.Fishing / G.Fight**
 *     → 因此能在 Node 里单测（tools/test.js 是它的消费方）
 *
 * 顶点字段：
 *   x, y, z  世界坐标（模型的右 / 上 / 侧向）
 *   t        沿体长归一化位置（0 = 吻端，1 = 尾根）—— 动画与渐变要用
 *   b        该点在环上的竖直分量（-1 腹侧、+1 背侧）—— 「两色身体」与闪光锚点要用
 *
 * ⚠️ 单位口径：`defPitch` 等角度参数**一律存弧度**（过 G.Mesh3D.rad() 转）。
 *    踩过的坑：把 60（度）当弧度用会得到 197° 的视角，画面错位但不报错。
 *
 * ⚠️ 本版只做 fish / shark / eel 三种（队列 T2）。ray 需要「平面型驱动」的生成器，
 *    车削式做不出它的后掠翼尖与头部凹口 —— 见规格 §3.5，排到 T3。
 * ========================================================================== */
window.G = window.G || {};
G.FishMesh = (function () {
  'use strict';

  var rad = (window.G && G.Mesh3D) ? G.Mesh3D.rad : function (d) { return d * Math.PI / 180; };

  /* 体型参数表。
     与 fishart.js 的 TPL 是**同一批体型**，但参数含义不同：
     TPL 描述「怎么用矢量画」，这里描述「怎么长成网格」。
     T3 会把两边的「胖瘦 / 体高」对齐成单一来源（规格 §3.2 的 [待定] 项）。 */
  var TYPES = {
    fish: {
      label: '通用鱼形', stations: 12, segments: 9,
      x0: -0.78, len: 1.42,
      prof: function (t) { return Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.75); },
      h: 0.34, w: 0.20,
      defYaw: 0, defPitch: 0,
      caudal: 0.28, dorsal: 0.17, pectoral: true, belly: 0.34
    },
    shark: {
      label: '鲨鱼', stations: 12, segments: 9,
      x0: -0.86, len: 1.64,
      arch: 0.03,                                  // 脊柱微微拱起
      prof: function (t) { return Math.pow(Math.sin(Math.PI * Math.pow(t, 0.45)), 0.58); },
      h: 0.30, w: 0.24,
      defYaw: 0, defPitch: 0,
      caudal: 0.34, dorsal: 0.26, pectoral: true, belly: 0.30
    },
    eel: {
      label: '鳗鱼', stations: 16, segments: 8,
      x0: -0.72, len: 1.52,
      prof: function (t) { return 0.66 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.34); },
      h: 0.135, w: 0.115,
      defYaw: 0, defPitch: 0,
      caudal: 0.13, dorsal: 0, pectoral: false, ribbon: true, belly: 0
    }
  };

  /** 该体型在 t 处的半高 / 半宽（供测试与将来的形变参数使用） */
  function profileAt(typeKey, t) {
    var cfg = TYPES[typeKey];
    if (!cfg) return null;
    var r = Math.max(cfg.prof(t), 0.0001);
    return { hy: r * cfg.h, hz: r * cfg.w, r: r };
  }

  function spineX(cfg, t) { return cfg.x0 + cfg.len * t; }
  function spineY(cfg, t) { return cfg.arch ? cfg.arch * Math.sin(Math.PI * t) : 0; }

  /* ------------------------------------------------------------------------
   * 主生成器：车削式（沿脊柱放环，环与环之间连成三角面）
   * ---------------------------------------------------------------------- */
  function build(typeKey) {
    var cfg = TYPES[typeKey];
    if (!cfg) throw new Error('FishMesh.build: 未知体型 ' + typeKey);

    var verts = [], tris = [];
    var N = cfg.stations, S = cfg.segments, i, j;

    function push(x, y, z, t, b) {
      verts.push({ x: x, y: y, z: z, t: t, b: b === undefined ? 0 : b });
      return verts.length - 1;
    }
    function vid(i2, j2) { return i2 * S + ((j2 % S) + S) % S; }

    // —— 主体
    for (i = 0; i <= N; i++) {
      var t = i / N;
      var r = Math.max(cfg.prof(t), 0.0001);
      var hy = r * cfg.h, hz = r * cfg.w;
      var sx = spineX(cfg, t), sy = spineY(cfg, t);
      for (j = 0; j < S; j++) {
        var a = 2 * Math.PI * j / S;
        var ca = Math.cos(a), sa = Math.sin(a);
        var yy = ca * hy, zz = sa * hz;
        if (cfg.belly && ca < 0) yy *= (1 - cfg.belly * 1.1);   // 鱼肚收一点
        push(sx, sy + yy, zz, t, ca);
      }
    }
    for (i = 0; i < N; i++) {
      for (j = 0; j < S; j++) {
        var A = vid(i, j), B = vid(i, j + 1), C = vid(i + 1, j + 1), D = vid(i + 1, j);
        tris.push([A, B, C], [A, C, D]);
      }
    }

    // —— 两端封口（三角扇）
    var nose = push(cfg.x0 - 0.045, 0, 0, 0, 0);
    var tail = push(cfg.x0 + cfg.len + 0.03, spineY(cfg, 1), 0, 1, 0);
    for (j = 0; j < S; j++) {
      tris.push([vid(0, j), nose, vid(0, j + 1)]);
      tris.push([vid(N, j), vid(N, j + 1), tail]);
    }

    // —— 尾鳍（竖直扇形，动画里会左右摆）
    var finGrp = [];
    if (cfg.caudal > 0) {
      var xT = spineX(cfg, 1), yT = spineY(cfg, 1), c = cfg.caudal;
      var base = verts.length;
      push(xT + 0.01, yT, 0, 1, 0);
      push(xT + c, yT + c * 0.95, 0, 1, 0);
      push(xT + c * 0.62, yT + c * 0.18, 0, 1, 0);
      push(xT + c, yT - c * 0.95, 0, 1, 0);
      push(xT + c * 0.62, yT - c * 0.18, 0, 1, 0);
      tris.push([base, base + 1, base + 2], [base, base + 2, base + 4], [base, base + 4, base + 3]);
      for (var k = base; k < base + 5; k++) finGrp.push(k);
    }

    // —— 背鳍
    if (cfg.dorsal > 0) {
      var d = verts.length, t0 = 0.34, tm = 0.5, t1 = 0.70;
      push(spineX(cfg, t0), spineY(cfg, t0) + cfg.prof(t0) * cfg.h, 0, t0, 1);
      push(spineX(cfg, tm), spineY(cfg, tm) + cfg.prof(tm) * cfg.h + cfg.dorsal, 0, tm, 1);
      push(spineX(cfg, t1), spineY(cfg, t1) + cfg.prof(t1) * cfg.h, 0, t1, 1);
      tris.push([d, d + 1, d + 2]);
      for (k = d; k < d + 3; k++) finGrp.push(k);
    }

    // —— 胸鳍（左右各一）
    if (cfg.pectoral) {
      [1, -1].forEach(function (sgn) {
        var p = verts.length, tp = 0.36;
        var rx = spineX(cfg, tp), ry = spineY(cfg, tp);
        var hy = cfg.prof(tp) * cfg.h, hz = cfg.prof(tp) * cfg.w;
        push(rx, ry - hy * 0.25, sgn * hz * 0.85, tp, -1);
        push(rx - 0.14, ry - hy * 1.15, sgn * (hz + 0.16), tp, -1);
        push(rx + 0.16, ry - hy * 0.85, sgn * (hz + 0.07), tp, -1);
        tris.push([p, p + 1, p + 2]);
        for (k = p; k < p + 3; k++) finGrp.push(k);
      });
    }

    return { verts: verts, tris: tris, finGrp: finGrp, cfg: cfg, type: typeKey };
  }

  return {
    TYPES: TYPES,
    build: build,
    profileAt: profileAt
  };
})();
