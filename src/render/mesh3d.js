/* ============================================================================
 * mesh3d.js —— 低多边形 3D 的投影 / 深度排序 / 逐面平涂光照
 *
 * 规格：docs/3D渲染方案.md §4
 * 职责边界（**不要越界**）：
 *   · 纯数学 + 一个把三角面画到 2D 上下文的 render()
 *   · **不碰 DOM**（ctx 由调用方传进来）、**不依赖 Fishing / Fight / Scene**
 *     → 这样整个模块能在 Node 里单测（tools/test.js 就是它的消费方）
 *   · 不画背景、不做交互、不管动画的「什么时候开」—— 那是调用方的事
 *
 * ⚠️ 单位口径：本模块**对外一律用弧度**。要传角度请先过 G.Mesh3D.rad()。
 *    踩过的坑：把 60（度）当弧度用会得到 60 rad ≈ 197°，画面完全错位但不报错。
 * ========================================================================== */
window.G = window.G || {};
G.Mesh3D = (function () {
  'use strict';

  /* 光照默认值 —— 这是**调参杠杆**，不是平衡数值（不影响经济），
     所以跟 fishart.js 的 TPL / STYLES 一样留在渲染模块里。
     将来若要做「按天气 / 时段调光」，再整体移进 config。

     2026-10-07 按 v9 参考图重标定过一次。原参数的问题是整条鱼偏暗、
     像「剪纸 + 一圈轮廓光」；v9 是实心渲染：亮面真的亮、腹部有反射补光、
     轮廓光是**有宽度的一条带**而不是发丝线。 */
  var LIGHT = {
    ambient: 0.10,                 // 环境项。口径是「无环境补光」，只给暗部的下限
    key: [-0.32, 0.72, 0.42],      // 主光方向：上方偏前左
    rim: [0.26, 0.60, -0.78],      // 边缘光方向：上方偏后
    keyGain: 1.00,                 // 主光贡献（亮面要真的亮起来，暗面才有对比）
    rimPow: 3.0,                   // 边缘光锐度（越大边越窄越亮）—— 要 crisp，不是一片晕光
    rimGain: 0.50,                 // 边缘光最低亮度
    rimKeyMix: 0.45,               // 边缘光受主光方向调制
    bellyBias: 0.55,               // 两色身体的分界偏移
    bellySpan: 0.85,               // 两色身体的过渡跨度
    bellyFloor: 0.34               // 腹部反射补光下限（只作用于朝下的面，不是环境补光）
  };
  // 方向归方向、强度归强度：光向量必须是单位向量，强度只由 keyGain / rimK 控制。
  // （不归一化的话，「光的强度」会悄悄藏在方向向量的长度里，改方向就顺手改了亮度）
  LIGHT.key = norm(LIGHT.key);
  LIGHT.rim = norm(LIGHT.rim);

  var DEG = Math.PI / 180;

  /** 角度 → 弧度。**任何拿角度写的地方都必须过这个函数。** */
  function rad(deg) { return deg * DEG; }

  function norm(v) {
    var m = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  }

  /* ------------------------------------------------------------------------
   * 相机与投影
   * 视空间约定：x 右、y 上、z 朝相机。相机在 (0,0,cameraZ) 朝 -z 看。
   * ---------------------------------------------------------------------- */
  function view(w, h, yaw, pitch, cameraZ) {
    return {
      w: w, h: h,
      cx: w / 2, cy: h / 2,
      f: Math.min(w, h) * 1.45,
      cyaw: Math.cos(yaw), syaw: Math.sin(yaw),
      cpit: Math.cos(pitch), spit: Math.sin(pitch),
      camZ: cameraZ
    };
  }

  /** 把 mesh 的全部顶点投影到屏幕，写进 out（长度 ≥ verts.length）。
   *  out[i] = { x, y, s, d }：屏幕坐标 / 缩放 / 相机距离 */
  function projectVerts(vw, verts, out) {
    var n = verts.length, cyaw = vw.cyaw, syaw = vw.syaw;
    var cpit = vw.cpit, spit = vw.spit, camZ = vw.camZ, f = vw.f;
    for (var i = 0; i < n; i++) {
      var v = verts[i];
      var xr = v.x * cyaw + v.z * syaw;
      var zr = -v.x * syaw + v.z * cyaw;
      var yr = v.y * cpit - zr * spit;
      var zr2 = v.y * spit + zr * cpit;
      var d = camZ - zr2;
      if (d < 0.35) d = 0.35;              // 近平面夹紧：防除零 / 防翻面
      var s = f / d;
      var p = out[i] || (out[i] = { x: 0, y: 0, s: 1, d: 1 });
      p.x = vw.cx + xr * s;
      p.y = vw.cy - yr * s;
      p.s = s;
      p.d = d;
    }
    return out;
  }

  /* ------------------------------------------------------------------------
   * 法线
   * ---------------------------------------------------------------------- */
  /** 世界空间面法线（未归一化的叉积方向；调用方一般紧跟 toViewNormal） */
  /** 顶点的「沿身体位置」t（0=尾 1=头，见 fishmesh 的环形生成器）。
   *  ⚠️ 鳍之类附属结构的顶点可能没带 `t` —— 缺省 0.5 而不是 undefined，
   *     否则下游插值会算出 NaN，表现是「这一块不显示但也不报错」。 */
  function vertT(mesh, idx) {
    var v = mesh.verts && mesh.verts[idx];
    return (v && typeof v.t === 'number') ? v.t : 0.5;
  }

  function faceNormal(a, b, c) {
    var e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
    var e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    return [
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x
    ];
  }

  /** 世界空间法线 → 视空间（与 projectVerts 用同一套旋转） */
  function toViewNormal(n, vw) {
    var nx = n[0] * vw.cyaw + n[2] * vw.syaw;
    var nz = -n[0] * vw.syaw + n[2] * vw.cyaw;
    var ny = n[1] * vw.cpit - nz * vw.spit;
    var nz2 = n[1] * vw.spit + nz * vw.cpit;
    return norm([nx, ny, nz2]);
  }

  /* ------------------------------------------------------------------------
   * 光照：强边缘光 + 无环境补光（口径见开发者文档 §1.4）
   *   shade(n, toCam, pal, light) → [r, g, b]，分量范围约 0~1（可超 1，由调用方 clamp）
   * ---------------------------------------------------------------------- */
  /**
   * @param n      视空间法线
   * @param toCam  面→相机方向
   * @param pal    材质参数（fishpaint.palette 的返回）
   * @param light  光照参数
   * @param posT   **沿身体长度**的位置 0~1（只有彩虹档用得上，其余可省略）
   */
  function shade(n, toCam, pal, light, posT) {
    var L = light || LIGHT;
    var key = L.key, rimDir = L.rim;

    var diff = n[0] * key[0] + n[1] * key[1] + n[2] * key[2];
    if (diff < 0) diff = 0;

    // 边缘项：面越「侧对」视线越亮；再用主光方向调制一下，让背脊更亮
    var facing = Math.abs(n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2]);
    var rimD = 1 - facing;
    if (rimD < 0) rimD = 0;
    var rim = Math.pow(rimD, L.rimPow);
    var km = n[0] * rimDir[0] + n[1] * rimDir[1] + n[2] * rimDir[2];
    rim *= L.rimGain + (1 - L.rimGain) * (km > 0 ? km : 0);

    // 「朝上的程度」0=朝下(腹) 1=朝上(背)。彩虹档也要用它算腹部补光
    var t = (L.bellyBias + L.bellySpan * n[1]);
    if (t < 0) t = 0; else if (t > 1) t = 1;

    var r, g, b;
    if (pal.bands && pal.bands.length > 1) {
      /* 彩虹档（亮色）：按**身体位置**取色，色相沿体长走一遍色带。
         ⚠️ 这里**不做背腹插值** —— 「按位置取色」这个维度已经被彩虹占用了，
            明暗层次改由下面的光照项（lit / bellyFloor）承担。
         ⚠️ posT 缺省 0.5：鳍之类附属结构的顶点可能没带 `t`，别让它变成 NaN。 */
      var u = (posT === undefined ? 0.5 : posT) * (pal.bands.length - 1);
      var i0 = Math.floor(u);
      if (i0 < 0) i0 = 0; else if (i0 > pal.bands.length - 1) i0 = pal.bands.length - 1;
      var i1 = i0 + 1; if (i1 > pal.bands.length - 1) i1 = pal.bands.length - 1;
      var f0 = u - i0;
      var A0 = pal.bands[i0], B0 = pal.bands[i1];
      r = A0[0] + (B0[0] - A0[0]) * f0;
      g = A0[1] + (B0[1] - A0[1]) * f0;
      b = A0[2] + (B0[2] - A0[2]) * f0;
    } else {
      // 两色身体：按法线朝上的程度在「背部色 ↔ 腹部色」之间插值
      var back = pal.back, belly = pal.belly;
      r = belly[0] + (back[0] - belly[0]) * t;
      g = belly[1] + (back[1] - belly[1]) * t;
      b = belly[2] + (back[2] - belly[2]) * t;
    }

    var lit = L.ambient + diff * L.keyGain;
    // 腹部反射补光：只作用于**朝下**的面，所以它不是「把整条鱼提亮」的环境光 ——
    // 没有这一项，鱼肚会黑成一块，v9 参考图里鱼肚是亮的
    var floorLit = L.bellyFloor * (1 - t);
    if (lit < floorLit) lit = floorLit;
    r *= lit; g *= lit; b *= lit;

    // 镜面（金属用低次幂 = 整块高光；闪光用高次幂 = 细高光）
    if (pal.spec > 0) {
      var h = norm([key[0] + toCam[0], key[1] + toCam[1], key[2] + toCam[2]]);
      var sd = n[0] * h[0] + n[1] * h[1] + n[2] * h[2];
      if (sd > 0) {
        var sp = Math.pow(sd, pal.metallic ? 12 : 40) * pal.spec;
        r += sp; g += sp * 0.96; b += sp * 0.72;
      }
    }

    var rimK = pal.rimK * rim;
    r += pal.rim[0] * rimK; g += pal.rim[1] * rimK; b += pal.rim[2] * rimK;
    return [r, g, b];
  }

  /* ------------------------------------------------------------------------
   * 深度排序（画家算法）
   * ---------------------------------------------------------------------- */
  /** 按三角面平均相机距离**降序**排列 order（远的先画，近的盖上去） */
  function sortOrder(tris, proj, order, depth) {
    var n = tris.length;
    for (var k = 0; k < n; k++) {
      var i = order[k], t = tris[i];
      depth[i] = (proj[t[0]].d + proj[t[1]].d + proj[t[2]].d) / 3;
    }
    // order 是索引表，用快排 + depth 查表（不新建数组）
    order.sort(function (a, b) { return depth[b] - depth[a]; });
    return order;
  }

  /* ------------------------------------------------------------------------
   * 动画：侧向行进波 + 呼吸（只有传说档 / 闪光色才该开）
   *   把结果写进 mesh 的 ax/ay/az 三个定长数组，**不新建对象**
   * ---------------------------------------------------------------------- */
  function animate(mesh, t, target) {
    var verts = mesh.verts, n = verts.length;
    var ax = target.ax, ay = target.ay, az = target.az;
    var ribbon = mesh.cfg && mesh.cfg.ribbon;
    var breath = 1 + Math.sin(t * 1.55) * 0.022;
    for (var i = 0; i < n; i++) {
      var v = verts[i];
      var tn = v.t > 0 ? v.t : 0;
      var w = Math.pow(tn, 1.7);
      var phase = t * 2.5 - tn * 3.4;
      az[i] = v.z + Math.sin(phase) * 0.085 * w;
      ay[i] = ribbon ? (v.y + Math.sin(phase + 1.1) * 0.03 * w) * breath : v.y * breath;
      ax[i] = v.x;
    }
    return target;
  }

  /** 静态：把 mesh 原顶点拷进定长数组（不开动画时也走同一条渲染路径） */
  function freeze(mesh, target) {
    var verts = mesh.verts, n = verts.length;
    var ax = target.ax, ay = target.ay, az = target.az;
    for (var i = 0; i < n; i++) {
      ax[i] = verts[i].x; ay[i] = verts[i].y; az[i] = verts[i].z;
    }
    return target;
  }

  /* ------------------------------------------------------------------------
   * 渲染缓冲：**每帧不新建数组**
   * ---------------------------------------------------------------------- */
  function makeTarget(mesh) {
    var n = mesh.verts.length, t = mesh.tris.length;
    var proj = new Array(n);
    for (var i = 0; i < n; i++) proj[i] = { x: 0, y: 0, s: 1, d: 1 };
    var order = new Array(t);
    for (i = 0; i < t; i++) order[i] = i;
    var out = {
      proj: proj, order: order, depth: new Float32Array(t),
      ax: new Float32Array(n), ay: new Float32Array(n), az: new Float32Array(n),
      // 复用的小对象，避免逐面分配
      _v: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    };
    freeze(mesh, out);
    return out;
  }

  /** 网格的包围盒（构造 / 构图 / 测试都要用） */
  function bbox(mesh) {
    var v = mesh.verts, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (var i = 0; i < v.length; i++) {
      if (v[i].x < x0) x0 = v[i].x; if (v[i].x > x1) x1 = v[i].x;
      if (v[i].y < y0) y0 = v[i].y; if (v[i].y > y1) y1 = v[i].y;
      if (v[i].z < z0) z0 = v[i].z; if (v[i].z > z1) z1 = v[i].z;
    }
    return {
      x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2
    };
  }

  /** 自动构图：算出让主体占满画面 `fill` 比例的相机距离。
   *  在 8 个朝向上取最坏情况 → **旋转时相机不会「呼吸」**（否则转起来主体一胀一缩）。
   *  之前固定 camZ = 3.0，长条鱼只占画面 24%，跟 v9 参考图的构图差很远。 */
  function fitCamera(mesh, w, h, fill) {
    var bb = bbox(mesh);
    var f = Math.min(w, h) * 1.45;
    var fx = (w / 2) * fill, fy = (h / 2) * fill;
    var corners = [];
    [bb.x0, bb.x1].forEach(function (x) {
      [bb.y0, bb.y1].forEach(function (y) {
        [bb.z0, bb.z1].forEach(function (z) {
          corners.push([x - bb.cx, y - bb.cy, z - bb.cz]);
        });
      });
    });
    var best = 0;
    for (var a = 0; a < 8; a++) {
      var yaw = a * Math.PI / 4;
      var pitch = (a % 3 === 0) ? 0 : ((a % 3 === 1) ? 0.9 : -0.9);
      var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (var i = 0; i < corners.length; i++) {
        var c = corners[i];
        var xr = c[0] * cy + c[2] * sy;
        var zr = -c[0] * sy + c[2] * cy;
        var yr = c[1] * cp - zr * sp;
        var zr2 = c[1] * sp + zr * cp;
        var need = Math.max(zr2 + Math.abs(xr) * f / fx, zr2 + Math.abs(yr) * f / fy);
        if (need > best) best = need;
      }
    }
    return Math.max(best, 1.2);
  }

  function clamp255(v) {
    v = Math.round(v * 255);
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  /** 给一个会记录调用的「假 ctx」也能跑 —— tools/test.js 就是这么测的 */
  function render(ctx, mesh, st) {
    var target = st.target;
    var vw = st.view;

    if (st.animate) animate(mesh, st.time || 0, target);
    else freeze(mesh, target);

    // 投影（把 ax/ay/az 视作顶点源，免去临时对象）
    var verts = mesh.verts, n = verts.length, i;
    var src = target._src;
    if (!src || src.length !== n) {
      src = target._src = new Array(n);
      for (i = 0; i < n; i++) src[i] = { x: 0, y: 0, z: 0 };
    }
    for (i = 0; i < n; i++) {
      var s = src[i];
      s.x = target.ax[i]; s.y = target.ay[i]; s.z = target.az[i];
    }
    projectVerts(vw, src, target.proj);

    var tris = mesh.tris, proj = target.proj, order = target.order;
    sortOrder(tris, proj, order, target.depth);

    var pal = st.palette, light = st.light || LIGHT;
    var tsec = st.time || 0;
    var lightVec = pal.spin ? norm([
      Math.cos(tsec * 1.2) * 0.55, 0.72, 0.42
    ]) : light.key;
    var L2 = pal.spin ? {
      ambient: light.ambient, key: lightVec, rim: light.rim,
      keyGain: light.keyGain, rimPow: light.rimPow, rimGain: light.rimGain,
      rimKeyMix: light.rimKeyMix, bellyBias: light.bellyBias, bellySpan: light.bellySpan
    } : light;

    var filled = 0;
    for (i = 0; i < tris.length; i++) {
      var ti = order[i], t3 = tris[ti];
      var p0 = proj[t3[0]], p1 = proj[t3[1]], p2 = proj[t3[2]];
      var nv = toViewNormal(faceNormal(
        { x: target.ax[t3[0]], y: target.ay[t3[0]], z: target.az[t3[0]] },
        { x: target.ax[t3[1]], y: target.ay[t3[1]], z: target.az[t3[1]] },
        { x: target.ax[t3[2]], y: target.ay[t3[2]], z: target.az[t3[2]] }
      ), vw);

      // 双面：法线朝观察者（屏幕 y 向下，所以这里 y 要取负）
      var toCam = norm([p0.x - vw.cx, -(p0.y - vw.cy), vw.f]);
      if (nv[0] * toCam[0] + nv[1] * toCam[1] + nv[2] * toCam[2] < 0) {
        nv = [-nv[0], -nv[1], -nv[2]];
      }

      // 沿身体的位置 —— 只有彩虹档（`pal.bands`）用得上，其余档传了也不影响
      var posT = (vertT(mesh, t3[0]) + vertT(mesh, t3[1]) + vertT(mesh, t3[2])) / 3;
      var col = shade(nv, toCam, pal, L2, posT);
      var css = 'rgb(' + clamp255(col[0]) + ',' + clamp255(col[1]) + ',' + clamp255(col[2]) + ')';

      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.fillStyle = css;
      ctx.fill();
      // 同色描一圈：否则相邻三角面之间会露出底色的发丝缝（看起来像线框）
      ctx.strokeStyle = css;
      ctx.lineWidth = 1.2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      filled++;
    }
    return filled;
  }

  return {
    LIGHT: LIGHT,
    rad: rad,
    norm: norm,
    view: view,
    projectVerts: projectVerts,
    faceNormal: faceNormal,
    toViewNormal: toViewNormal,
    shade: shade,
    sortOrder: sortOrder,
    animate: animate,
    freeze: freeze,
    makeTarget: makeTarget,
    bbox: bbox,
    fitCamera: fitCamera,
    render: render
  };
})();
