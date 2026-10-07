/* ============================================================================
 * fishmesh.js —— 体型参数 → 三角网格（全 9 种体型 + 传说细节层级）
 *
 * 规格：docs/3D渲染方案.md §3
 * 职责边界（**不要越界**）：
 *   · 纯数学：给一组体型参数，吐出顶点 + 三角面
 *   · **不碰 DOM / Canvas**，也**不引用 G.FishArt / G.Fishing / G.Fight**
 *     → 因此能在 Node 里单测（tools/test.js 是它的消费方）
 *
 * 顶点字段：
 *   x, y, z  世界坐标（右 / 上 / 侧向；吻端在 -x，尾在 +x）
 *   t        沿体长归一化位置（0 = 吻端，1 = 尾根）—— 动画与渐变要用
 *   b        「上下」分量（-1 腹侧 / +1 背侧）—— 两色身体与闪光锚点要用
 *
 * ⚠️ 单位口径：角度参数**一律存弧度**（过 G.Mesh3D.rad()）。把 60（度）当弧度会出
 *    197° 的视角错位，**不报错只出错结果**。
 *
 * ⚠️ 传说细节口径（用户 2026-10-07 要求「传说鱼要明显的细节更足」）：
 *    额外细节必须落在**剪影**上 —— 背脊棘刺 / 飘须 / 双层尾鳍 / 尾鳍飘带这类
 *    **改变轮廓**的东西；不要贴表面纹理。理由：缩到图鉴列表的 64px 时，
 *    表面花纹全糊成一团，只有轮廓外的突起还读得出来。
 * ========================================================================== */
window.G = window.G || {};
G.FishMesh = (function () {
  'use strict';

  var rad = (window.G && G.Mesh3D) ? G.Mesh3D.rad : function (d) { return d * Math.PI / 180; };
  var PI = Math.PI;
  function pow(a, b) { return Math.pow(a, b); }

  /* ========================================================================
   * 稀有度 → 细节层级（单一来源；口径见开发者文档 §1.4 与规格 §3.6）
   *   0 = 基础剪影　1 = +腹鳍 +背棘带　2 = +飘须 +双层尾鳍 +棘刺阵 +尾鳍飘带
   * ====================================================================== */
  var DETAIL_TIERS = [
    { rar: 0, name: '普通', detail: 0 },
    { rar: 1, name: '稀有', detail: 0 },
    { rar: 2, name: '史诗', detail: 1 },
    { rar: 3, name: '传说', detail: 2 }
  ];
  function detailForRar(rar) {
    for (var i = DETAIL_TIERS.length - 1; i >= 0; i--) {
      if (rar >= DETAIL_TIERS[i].rar) return DETAIL_TIERS[i].detail;
    }
    return 0;
  }

  /* ========================================================================
   * 几何小工具（都往同一个 api 里塞顶点 / 三角面）
   * ====================================================================== */
  function makeApi() {
    var verts = [], tris = [];
    return {
      verts: verts, tris: tris,
      push: function (x, y, z, t, b) {
        verts.push({ x: x, y: y, z: z, t: t === undefined ? 0 : t, b: b === undefined ? 0 : b });
        return verts.length - 1;
      },
      tri: function (a, b, c) {
        if (a === b || b === c || a === c) return;   // 退化面不建
        tris.push([a, b, c]);
      }
    };
  }

  /** 扇形鳍（尾鳍）：根 → 上叶尖 → 上内凹 → 下叶尖 → 下内凹，3 个三角面 */
  function fanFin(api, t, root, tipA, notchA, tipB, notchB, bTop, bBot) {
    var r = api.push(root[0], root[1], root[2], t, 0);
    var a1 = api.push(tipA[0], tipA[1], tipA[2], t, bTop);
    var a2 = api.push(notchA[0], notchA[1], notchA[2], t, bTop * 0.4);
    var b1 = api.push(tipB[0], tipB[1], tipB[2], t, bBot);
    var b2 = api.push(notchB[0], notchB[1], notchB[2], t, bBot * 0.4);
    api.tri(r, a1, a2); api.tri(r, a2, b2); api.tri(r, b2, b1);
  }

  /** 单根细带（飘须 / 飘带 / 触手 / 长尾鞭都用它）：pts 是一串点，hw 是各点半宽 */
  function strip(api, pts, hws, dirFn, t) {
    var i, a, b;
    var lo = [], hi = [];
    for (i = 0; i < pts.length; i++) {
      var d = dirFn(i, pts);
      lo.push(api.push(pts[i][0] - d[0] * hws[i], pts[i][1] - d[1] * hws[i],
                       pts[i][2] - d[2] * hws[i], t, 0));
      hi.push(api.push(pts[i][0] + d[0] * hws[i], pts[i][1] + d[1] * hws[i],
                       pts[i][2] + d[2] * hws[i], t, 0));
    }
    for (i = 0; i < pts.length - 1; i++) {
      a = lo[i]; b = lo[i + 1];
      api.tri(a, hi[i], hi[i + 1]); api.tri(a, hi[i + 1], b);
    }
  }

  /* ------------------------------------------------------------------------
   * 传说专属：飘带（streamer）
   *   每根飘带从「剪影的最外沿」甩出去 —— 鳐从翼尖、鲸从尾叶、常规鱼从尾鳍叶。
   *   为什么一定要挂在外沿：传说细节要能在 64px 缩略图上被看见，
   *   只有改变**轮廓**的东西才读得出来。锚点按体型算，不写死。
   * ---------------------------------------------------------------------- */
  function streamAnchors(c) {
    var out = [];
    if (c.whip) {                                  // 鳐：翼尖拖两条
      out.push({ p: [c.xAt(0.03), 0, c.span * 0.88], dir: [1, 0, 0.30], cur: [0.1, 0, 0.10] });
      out.push({ p: [c.xAt(0.03), 0, -c.span * 0.88], dir: [1, 0, -0.30], cur: [0.1, 0, -0.10] });
    } else if (c.fluke) {                          // 鲸：尾叶两尖各拖一条
      out.push({ p: [c.xAt(1) + c.fluke * 0.9, 0, c.fluke * 0.66], dir: [1, 0, 0.42] });
      out.push({ p: [c.xAt(1) + c.fluke * 0.9, 0, -c.fluke * 0.66], dir: [1, 0, -0.42] });
    } else if (c.caudal > 0) {                     // 常规鱼：尾鳍上下叶各拖一条
      var k = c.caudal, xT = c.xAt(1), yT = c.yAt(1);
      out.push({ p: [xT + k * 0.95, yT + k * 0.92, 0], dir: [1, 0.30, 0], cur: [0, 0.18, 0] });
      out.push({ p: [xT + k * 0.95, yT - k * 0.92, 0], dir: [1, -0.30, 0], cur: [0, -0.18, 0] });
    }
    return out;
  }

  function addStreamers(api, c, len) {
    streamAnchors(c).forEach(function (a) {
      var pts = [], hw = [], s, u;
      for (s = 0; s <= 5; s++) {
        u = s / 5;
        var cur = a.cur || [0, 0, 0];
        pts.push([
          a.p[0] + a.dir[0] * len * u + cur[0] * u * u,
          a.p[1] + a.dir[1] * len * u + cur[1] * u * u,
          a.p[2] + a.dir[2] * len * u + cur[2] * u * u
        ]);
        hw.push(0.021 * (1 - u * 0.75));
      }
      // 带面方向：默认朝上（竖直飘带）；鳐那两条要朝侧面才看得见
      var up = a.dir[2] !== 0 ? function () { return [0, 1, 0]; } : function () { return [0, 0, 1]; };
      strip(api, pts, hw, up, 1);
    });
  }

  /* ========================================================================
   * 体型 1/2/3/5/6/9：沿 x 轴的常规管状体
   * ====================================================================== */
  function tubeX(p) {
    return {
      label: p.label, stations: p.stations, segments: p.segments,
      axis: 'x',
      xAt: function (t) { return p.x0 + p.len * t; },
      yAt: function (t) { return p.arch ? p.arch * Math.sin(PI * t) : 0; },
      hAt: function (t) { return Math.max(p.prof(t), 0.0001) * p.h; },
      wAt: function (t) { return Math.max(p.prof(t), 0.0001) * p.w; },
      ring: function (t, j, S) {
        var a = 2 * PI * j / S, ca = Math.cos(a);
        var hy = Math.max(p.prof(t), 0.0001) * p.h;
        var hz = Math.max(p.prof(t), 0.0001) * p.w;
        var yy = ca * hy, zz = Math.sin(a) * hz;
        if (p.belly && ca < 0) yy *= (1 - p.belly * 1.1);
        return { x: p.x0 + p.len * t, y: (p.arch ? p.arch * Math.sin(PI * t) : 0) + yy, z: zz, b: ca };
      },
      cap0: function () { return [p.x0 - 0.045, 0, 0]; },
      cap1: function () { return [p.x0 + p.len + 0.03, this.yAt(1), 0]; },
      prof: p.prof, caudal: p.caudal, fluke: p.fluke, dorsal: p.dorsal,
      pectoral: p.pectoral, ribbon: p.ribbon, ridge: p.ridge, crest: p.crest,
      barbels: p.barbels, tentacles: p.tentacles, mantleFin: p.mantleFin,
      defYaw: p.defYaw || 0, defPitch: p.defPitch || 0
    };
  }

  /* ========================================================================
   * 体型 4：鳐鱼 —— **平面型驱动**（车削式做不出后掠翼尖与头部凹口）
   *   环沿 z 轴铺开（展向），每个展向位置的截面 = 前后很长的「透镜」
   * ====================================================================== */
  function rayBody(p) {
    function chordAt(u) { return p.chord * (1 - 0.80 * pow(Math.abs(u), 1.45)); }
    function thickAt(u) { return p.thick * (1 - 0.55 * pow(Math.abs(u), 0.85)); }
    function sweepAt(u) { return p.sweep * pow(Math.abs(u), 1.35); }   // 翼尖后掠
    function headAt(u) { return p.head * (1 - pow(Math.min(1, Math.abs(u) / 0.3), 2)); } // 中央头部前凸
    return {
      label: p.label, stations: p.stations, segments: p.segments, axis: 'z',
      xAt: function (t) { var u = -1 + 2 * t; return sweepAt(u) - headAt(u); },
      yAt: function () { return 0; },
      hAt: function (t) { return thickAt(-1 + 2 * t) * 0.5; },
      wAt: function (t) { return chordAt(-1 + 2 * t) * 0.5; },
      ring: function (t, j, S) {
        var u = -1 + 2 * t;
        var a = 2 * PI * j / S;
        var ca = Math.cos(a), sa = Math.sin(a);
        var ch = chordAt(u), th = thickAt(u);
        return {
          x: sweepAt(u) - headAt(u) + ca * ch * 0.5,
          y: sa * th * 0.5,
          z: u * p.span,
          b: sa
        };
      },
      cap0: null, cap1: null,                       // 翼尖自身收成一点，不需要封口
      whip: p.whip, span: p.span, chord: p.chord, thick: p.thick,
      chordAt: chordAt, sweepAt: sweepAt,
      // ★ 鳐的默认视角必须是俯视：侧视下它只是一条细缝，正面认不出是鳐
      defYaw: 0, defPitch: rad(60)
    };
  }

  /* ========================================================================
   * 体型 7：水母 —— 脊柱沿 y 轴（伞盖是绕 y 轴的回转体）
   * ====================================================================== */
  function jellyBody(p) {
    function rAt(t) { return p.rad * Math.sqrt(Math.max(0, 1 - t * t)) + 0.015; }
    return {
      label: p.label, stations: p.stations, segments: p.segments, axis: 'y',
      xAt: function () { return 0; },
      yAt: function (t) { return p.y0 + p.len * t; },
      hAt: function (t) { return rAt(t); },
      wAt: function (t) { return rAt(t); },
      ring: function (t, j, S) {
        var a = 2 * PI * j / S;
        return { x: Math.cos(a) * rAt(t), y: p.y0 + p.len * t, z: Math.sin(a) * rAt(t), b: 0 };
      },
      cap0: function () { return [0, p.y0 - 0.05, 0]; },
      cap1: function () { return [0, p.y0 + p.len + 0.03, 0]; },
      tentacles: p.tentacles, rAt: rAt, y0: p.y0,
      // 水母没有鱼鳍：通用鳍逻辑要跳过它，否则会在伞盖侧面长出两片腹鳍
      noFins: true,
      // 伞盖正着看最好认（略微俯一点，能看到伞的内侧）
      defYaw: 0, defPitch: rad(-12)
    };
  }

  /* ========================================================================
   * 体型表
   * ====================================================================== */
  var TYPES = {
    fish: tubeX({
      label: '通用鱼形', stations: 12, segments: 9, x0: -0.78, len: 1.42,
      prof: function (t) { return pow(Math.sin(PI * pow(t, 0.62)), 0.75); },
      h: 0.34, w: 0.20, caudal: 0.28, dorsal: 0.17, pectoral: true, belly: 0.34
    }),
    eel: tubeX({
      label: '鳗鱼', stations: 16, segments: 8, x0: -0.72, len: 1.52,
      prof: function (t) { return 0.66 * pow(Math.sin(PI * (0.08 + 0.84 * t)), 0.34); },
      h: 0.135, w: 0.115, caudal: 0.13, dorsal: 0, pectoral: false, ribbon: true, belly: 0
    }),
    shark: tubeX({
      label: '鲨鱼', stations: 12, segments: 9, x0: -0.86, len: 1.64, arch: 0.03,
      prof: function (t) { return pow(Math.sin(PI * pow(t, 0.45)), 0.58); },
      h: 0.30, w: 0.24, caudal: 0.34, dorsal: 0.26, pectoral: true, belly: 0.30
    }),
    ray: rayBody({
      label: '鳐鱼', stations: 14, segments: 12,
      span: 0.74, chord: 0.62, thick: 0.10, sweep: 0.34, head: 0.10, whip: 0.62
    }),
    squid: tubeX({
      label: '鱿鱼', stations: 12, segments: 9, x0: -0.62, len: 1.30,
      prof: function (t) { return pow(Math.sin(PI * (0.06 + 0.88 * t)), 0.42) * 0.95; },
      h: 0.19, w: 0.19, caudal: 0, dorsal: 0, pectoral: false,
      mantleFin: 0.24, tentacles: 8, belly: 0
    }),
    jelly: jellyBody({
      label: '水母', stations: 9, segments: 14, y0: -0.26, len: 0.56, rad: 0.40,
      tentacles: 11
    }),
    oarfish: tubeX({
      label: '皇带鱼', stations: 18, segments: 8, x0: -0.86, len: 1.76,
      prof: function (t) { return 0.5 * pow(Math.sin(PI * (0.05 + 0.9 * t)), 0.30) + 0.06; },
      h: 0.115, w: 0.075, caudal: 0.11, dorsal: 0, pectoral: true,
      crest: { from: 0.06, to: 0.94, h: 0.13 }, belly: 0
    }),
    whale: tubeX({
      label: '鲸鱼', stations: 13, segments: 10, x0: -0.76, len: 1.52, arch: 0.02,
      prof: function (t) { return pow(Math.sin(PI * pow(t, 0.42)), 0.52); },
      h: 0.42, w: 0.34, caudal: 0, fluke: 0.36, dorsal: 0.10, pectoral: true, belly: 0.42
    }),
    dragon: tubeX({
      label: '龙鱼', stations: 15, segments: 9, x0: -0.76, len: 1.46,
      prof: function (t) { return pow(Math.sin(PI * (0.05 + 0.9 * t)), 0.60); },
      h: 0.20, w: 0.145, caudal: 0.30, dorsal: 0, pectoral: false,
      ribbon: true, ridge: 0.13, barbels: 2, belly: 0.12
    })
  };

  /** 该体型在 t 处的半高 / 半宽（供测试与将来的形变参数使用） */
  function profileAt(typeKey, t) {
    var cfg = TYPES[typeKey];
    if (!cfg) return null;
    return { hy: cfg.hAt(t), hz: cfg.wAt(t) };
  }

  /** 该体型的默认视角（**弧度**）。按体型给：鳐俯视、水母略俯，其余侧视。
   *  口径见 docs/3D渲染方案.md §6 —— 正面 / 侧面对某些体型根本没有辨识度。 */
  function defaultView(typeKey) {
    var cfg = TYPES[typeKey];
    if (!cfg) return null;
    return { yaw: cfg.defYaw || 0, pitch: cfg.defPitch || 0 };
  }

  /* ========================================================================
   * 附属结构（鳍 / 棘 / 须 / 触手 / 尾鞭）
   * ====================================================================== */
  function addFins(api, c, detail) {
    // —— 竖直尾鳍
    if (c.caudal > 0) {
      var xT = c.xAt(1), yT = c.yAt(1), k = c.caudal;
      fanFin(api, 1,
        [xT + 0.01, yT, 0],
        [xT + k, yT + k * 0.95, 0], [xT + k * 0.62, yT + k * 0.18, 0],
        [xT + k, yT - k * 0.95, 0], [xT + k * 0.62, yT - k * 0.18, 0], 1, -1);
      // 传说：后面再叠一层更大的尾鳍（双层轮廓一眼就能看出更华丽）
      if (detail >= 2) {
        var k2 = k * 1.62;
        fanFin(api, 1,
          [xT - 0.02, yT, 0],
          [xT + k2 * 0.92, yT + k2 * 0.86, 0], [xT + k2 * 0.5, yT + k2 * 0.12, 0],
          [xT + k2 * 0.92, yT - k2 * 0.86, 0], [xT + k2 * 0.5, yT - k2 * 0.12, 0], 1, -1);
      }
    }

    // —— 水平尾鳍（鲸的尾叶是横的，不是竖的）
    if (c.fluke > 0) {
      var xF = c.xAt(1), yF = c.yAt(1), f = c.fluke;
      fanFin(api, 1,
        [xF + 0.01, yF, 0],
        [xF + f * 0.95, yF, f * 0.72], [xF + f * 0.5, yF, f * 0.16],
        [xF + f * 0.95, yF, -f * 0.72], [xF + f * 0.5, yF, -f * 0.16], 0, 0);
    }

    // —— 背鳍
    if (c.dorsal > 0) {
      var t0 = 0.34, tm = 0.5, t1 = 0.70;
      var a = api.push(c.xAt(t0), c.yAt(t0) + c.hAt(t0), 0, t0, 1);
      var b = api.push(c.xAt(tm), c.yAt(tm) + c.hAt(tm) + c.dorsal, 0, tm, 1);
      var d = api.push(c.xAt(t1), c.yAt(t1) + c.hAt(t1), 0, t1, 1);
      api.tri(a, b, d);
    }

    // —— 胸鳍
    if (c.pectoral) {
      [1, -1].forEach(function (sgn) {
        var tp = 0.36, rx = c.xAt(tp), ry = c.yAt(tp);
        var hy = c.hAt(tp), hz = c.wAt(tp);
        var p0 = api.push(rx, ry - hy * 0.25, sgn * hz * 0.85, tp, -1);
        var p1 = api.push(rx - 0.14, ry - hy * 1.15, sgn * (hz + 0.16), tp, -1);
        var p2 = api.push(rx + 0.16, ry - hy * 0.85, sgn * (hz + 0.07), tp, -1);
        api.tri(p0, p1, p2);
      });
    }

    // —— 鱿鱼的三角侧鳍（要立起来一点，否则侧视下完全看不见）
    if (c.mantleFin > 0) {
      [1, -1].forEach(function (sgn) {
        var tf = 0.66, rx = c.xAt(tf), ry = c.yAt(tf), hz = c.wAt(tf);
        var q0 = api.push(rx - 0.26, ry - 0.01, sgn * hz * 0.90, tf, 0);
        var q1 = api.push(rx + 0.02, ry + c.mantleFin * 0.58, sgn * (hz + c.mantleFin), tf, 1);
        var q2 = api.push(rx + 0.34, ry + c.mantleFin * 0.10, sgn * hz * 0.55, tf, 0);
        api.tri(q0, q1, q2);
      });
    }

    // —— 龙鱼背脊棘 + 皇带鱼背冠（都是一条纵向带）
    if (c.ridge > 0) {
      var M = 8;
      for (var m = 0; m < M; m++) {
        var tt = 0.20 + 0.58 * m / (M - 1);
        var xb = c.xAt(tt), hb = c.hAt(tt);
        var v0 = api.push(xb, c.yAt(tt) + hb, 0, tt, 1);
        var v1 = api.push(xb - c.ridge * 0.45, c.yAt(tt) + hb + c.ridge, 0, tt, 1);
        var v2 = api.push(xb + c.ridge * 0.55, c.yAt(tt) + hb + c.ridge * 0.12, 0, tt, 1);
        api.tri(v0, v1, v2);
      }
      if (detail >= 2) {                       // 传说：棘刺加密加高，剪影更凶
        for (m = 0; m < M; m++) {
          tt = 0.24 + 0.52 * m / (M - 1);
          xb = c.xAt(tt); hb = c.hAt(tt);
          v0 = api.push(xb + 0.02, c.yAt(tt) + hb, 0, tt, 1);
          v1 = api.push(xb - c.ridge * 0.7, c.yAt(tt) + hb + c.ridge * 1.7, 0, tt, 1);
          v2 = api.push(xb + c.ridge * 0.7, c.yAt(tt) + hb + c.ridge * 0.3, 0, tt, 1);
          api.tri(v0, v1, v2);
        }
      }
    }
    // 皇带鱼背冠：做成**一整条实心鳍**，不是一根细带
    // （细带只有 0.024 宽，侧视下等于看不见 —— 而背冠正是皇带鱼最标志性的特征）
    if (c.crest) {
      var M2 = 10, prev = null;
      for (var s2 = 0; s2 <= M2; s2++) {
        var u2 = s2 / M2;
        var tu = c.crest.from + (c.crest.to - c.crest.from) * u2;
        var bx = c.xAt(tu), by = c.yAt(tu) + c.hAt(tu);
        var txp = bx - c.crest.h * 0.20;
        var typ = by + c.crest.h * (0.38 + 0.62 * Math.sin(PI * u2));
        var vb = api.push(bx, by, 0, tu, 1);
        var vt = api.push(txp, typ, 0, tu, 1);
        if (prev) {
          api.tri(prev.vb, vb, vt);
          api.tri(prev.vb, vt, prev.vt);
        }
        prev = { vb: vb, vt: vt };
      }
    }

    // —— 龙鱼飘须（传说再加一对，更长）
    if (c.barbels) {
      var pairs = detail >= 2 ? 4 : c.barbels;
      for (var q = 0; q < pairs; q++) {
        var sgnq = q % 2 === 0 ? 1 : -1;
        var scale = (q < 2 ? 1 : 1.7) * (detail >= 2 ? 1.25 : 1);
        var ptsB = [], hwB = [];
        for (var s3 = 0; s3 <= 5; s3++) {
          var u3 = s3 / 5;
          ptsB.push([
            c.xAt(0.04) - u3 * 0.34 * scale,
            c.yAt(0) - u3 * u3 * 0.16 * scale,
            sgnq * (0.02 + u3 * 0.16)
          ]);
          hwB.push(0.016 * (1 - u3 * 0.7));
        }
        strip(api, ptsB, hwB, function () { return [0, 0, 1]; }, 0);
      }
    }

    /* —— 传说专属（detail 2）：腹鳍 + 侧鳍飘带 —— */
    if (c.noFins) return;                       // 水母这类没有鱼鳍的体型直接跳过
    if (detail >= 2) {
      [1, -1].forEach(function (sgn) {
        var tpv = 0.58, rxp = c.xAt(tpv), ryp = c.yAt(tpv);
        var hyp = c.hAt(tpv), hzp = c.wAt(tpv);
        var e0 = api.push(rxp - 0.02, ryp - hyp * 0.75, sgn * hzp * 0.7, tpv, -1);
        var e1 = api.push(rxp - 0.22, ryp - hyp * 1.5, sgn * (hzp + 0.10), tpv, -1);
        var e2 = api.push(rxp + 0.16, ryp - hyp * 1.05, sgn * (hzp + 0.06), tpv, -1);
        api.tri(e0, e1, e2);
      });
    } else if (detail >= 1) {
      // 史诗：只加一对素净的腹鳍
      var tpv1 = 0.58, rxp1 = c.xAt(tpv1), ryp1 = c.yAt(tpv1);
      var hyp1 = c.hAt(tpv1), hzp1 = c.wAt(tpv1);
      [1, -1].forEach(function (sgn) {
        var g0 = api.push(rxp1 - 0.02, ryp1 - hyp1 * 0.75, sgn * hzp1 * 0.7, tpv1, -1);
        var g1 = api.push(rxp1 - 0.16, ryp1 - hyp1 * 1.4, sgn * (hzp1 + 0.07), tpv1, -1);
        var g2 = api.push(rxp1 + 0.12, ryp1 - hyp1 * 1.0, sgn * (hzp1 + 0.04), tpv1, -1);
        api.tri(g0, g1, g2);
      });
    }
  }

  function addWhip(api, c) {
    var pts = [], hw = [];
    var x0 = c.xAt(1), y0 = c.yAt(1);
    for (var s = 0; s <= 6; s++) {
      var u = s / 6;
      pts.push([x0 + c.whip * u, y0 - 0.10 * u * u, 0]);
      hw.push(0.020 * (1 - u * 0.86));
    }
    strip(api, pts, hw, function () { return [0, 0, 1]; }, 1);
  }

  function addTentacles(api, c, detail) {
    // 稀有度在触手类体型（水母 / 鱿鱼）上只能靠触手表达：
    // 史诗 +2 根，传说再 +4 根并且拉长 —— 否则这两档在它们身上完全看不出来
    var n = c.tentacles + (detail >= 2 ? 4 : (detail >= 1 ? 2 : 0));
    var lenK = detail >= 2 ? 1.38 : 1;
    // ⚠️ 触手的方向按体型分：水母（脊柱沿 y）朝下挂；鱿鱼朝**前**伸。
    //    一开始两种都写成朝下，结果鱿鱼看着像两块薄片 —— 方向错了，形态就全错。
    var forward = c.axis !== 'y';
    var radAt0 = c.rAt ? c.rAt(0) : c.wAt(0);
    var y0 = c.y0 !== undefined ? c.y0 : c.yAt(0);
    var x0 = c.xAt(0);
    for (var q = 0; q < n; q++) {
      var a = 2 * PI * q / n;
      var dx = Math.cos(a), dz = Math.sin(a);
      var pts = [], hw = [];
      for (var s = 0; s <= 7; s++) {
        var u = s / 7;
        var spread = radAt0 * 0.86 * (1 - u * 0.32);
        pts.push([
          forward ? x0 + dx * spread * 0.5 - 0.66 * lenK * u : x0 + dx * spread,
          forward ? y0 + dz * spread * 0.5 - 0.10 * u * u * lenK
                  : y0 - 0.78 * lenK * u,
          forward ? dz * spread * 0.5 : dz * spread
        ]);
        hw.push(0.020 * (1 - u * 0.55));
      }
      strip(api, pts, hw, (function (ddx, ddz) {
        return function () { return [-ddz, 0, ddx]; };     // 带面沿切向
      })(dx, dz), 0);
    }
  }

  /* ========================================================================
   * 统一构建：环形管状体 + 附属结构
   * ====================================================================== */
  function build(typeKey, opts) {
    var c = TYPES[typeKey];
    if (!c) throw new Error('FishMesh.build: 未知体型 ' + typeKey);
    var detail = (opts && opts.detail) || 0;
    if (detail < 0) detail = 0;
    if (detail > 2) detail = 2;

    var api = makeApi();
    var N = c.stations, S = c.segments, i, j;

    for (i = 0; i <= N; i++) {
      var t = i / N;
      for (j = 0; j < S; j++) {
        var p = c.ring(t, j, S);
        api.push(p.x, p.y, p.z, t, p.b);
      }
    }
    function vid(a, b) { return a * S + ((b % S) + S) % S; }
    for (i = 0; i < N; i++) {
      for (j = 0; j < S; j++) {
        var A = vid(i, j), B = vid(i, j + 1), C = vid(i + 1, j + 1), D = vid(i + 1, j);
        api.tri(A, B, C); api.tri(A, C, D);
      }
    }
    // 两端封口
    if (c.cap0) {
      var q0 = c.cap0();
      var i0 = api.push(q0[0], q0[1], q0[2], 0, 0);
      for (j = 0; j < S; j++) api.tri(vid(0, j), i0, vid(0, j + 1));
    }
    if (c.cap1) {
      var q1 = c.cap1();
      var i1 = api.push(q1[0], q1[1], q1[2], 1, 0);
      for (j = 0; j < S; j++) api.tri(vid(N, j), vid(N, j + 1), i1);
    }

    addFins(api, c, detail);
    if (c.whip) addWhip(api, c);
    if (c.tentacles) addTentacles(api, c, detail);
    // 传说专属：外沿飘带（挂在外沿才改得动剪影，缩到 64px 还看得见）
    if (detail >= 2) addStreamers(api, c, c.whip || c.fluke ? 0.52 : 0.46);

    return {
      verts: api.verts, tris: api.tris,
      cfg: c, type: typeKey, detail: detail,
      stats: {
        tris: api.tris.length,
        verts: api.verts.length,
        detail: detail
      }
    };
  }

  return {
    TYPES: TYPES,
    DETAIL_TIERS: DETAIL_TIERS,
    detailForRar: detailForRar,
    build: build,
    profileAt: profileAt,
    defaultView: defaultView,
    rad: rad
  };
})();
