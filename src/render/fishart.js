/* =========================================================
   fishart.js  —  参数化鱼类绘制器（纯 Canvas，无图片素材）
   =========================================================
   所有鱼都由「体型模板 + 颜色 + 变异标记」程序化生成：
     fish   generic 鱼（覆盖绝大多数）
     eel    鳗形
     ray    鳐/魟（翼状）
     squid  头足类
     jelly  水母
     oarfish 皇带鱼（带状）
     shark  鲨
     whale  鲸 / 海兽
     dragon 龙鱼 / 幻兽
   ========================================================= */
window.G = window.G || {};

G.FishArt = (function () {
  var U = G.U;

  /* =========================================================
     风格层
     =========================================================
     ✅ **已选定：flat（扁平卡通，本文件的默认值）** —— 玩家侧不会暴露切换。
     其余 5 套（bold / water / real / neon / pixel）是开发期做横向对比用的备选方案，
     留着方便后期再改；真要收口时把没用的从 STYLES 里删掉即可。
     对比出图： tools/style-preview.html → docs/style-preview/
     ========================================================= */
  var STYLES = {
    /* 扁平卡通：当前的默认风格，柔渐变 + 细描边 */
    flat: { key:'flat', label:'扁平卡通', lineScale:1.0, gloss:0.22, spec:true,
            filter:'none', desc:'柔和的线性渐变 + 极细描边，清爽易读，多端适配最省事。' },

    /* 粗描边卡通：厚轮廓 + 双色平涂，像手绘贴纸 */
    bold: { key:'bold', label:'粗描边卡通', lineScale:2.4, gloss:0, spec:false, flatFill:true,
            lineColorFn: function (p) { return '#22313d'; },
            filter:'none', desc:'粗黑轮廓 + 双色平涂，辨识度最高，缩到很小也看得清种类。' },

    /* 水彩柔光：低透明叠色 + 轻微模糊，像手绘水彩本 */
    water: { key:'water', label:'水彩柔光', lineScale:0.85, gloss:0.34, spec:true, alpha:0.62, bleed:2,
            lineColorFn: function (p) { return U.rgba(p.bodyDark, 0.30); },
            filter:'saturate(1.45) brightness(1.10) blur(1.1px)', paper:true,
            desc:'半透明叠色 + 轻微晕染，柔和不刺眼，适合走治愈向。' },

    /* 写实渐变：多段渐变 + 高光 + 鳞片纹理 */
    real: { key:'real', label:'写实渐变', lineScale:0.55, gloss:0.7, spec:true, scales:true,
            filter:'saturate(1.12) contrast(1.10)',
            desc:'多段体色渐变 + 油亮高光 + 鳞片纹理，拟真感最强，单条鱼最贵。' },

    /* 霓虹剪影：深色鱼身 + 高亮描边，赛博/街机感 */
    neon: { key:'neon', label:'霓虹剪影', lineScale:2.1, gloss:0, spec:false, dark:0.68, glowBoost:2.4,
            lineColorFn: function (p) { return U.lighten(p.accent, 0.45); },
            filter:'saturate(1.35)', darkBG:true,
            desc:'压暗鱼身、点亮轮廓，深海/星陨钓场氛围最好，但白天场景会偏暗。' },

    /* 像素风：低分辨率 + 硬边放大（由外部按 pixel 参数处理） */
    pixel: { key:'pixel', label:'像素风', lineScale:1.6, gloss:0, spec:false, flatFill:true, pixel:8,
            lineColorFn: function (p) { return '#1a2430'; },
            filter:'none', desc:'低分辨率 + 硬边放大，复古可爱，素材可复用度高。' },
  };

  var ST = STYLES.flat;

  function setStyle(key) { ST = STYLES[key] || STYLES.flat; return ST; }
  function getStyle() { return ST; }
  function listStyles() { return Object.keys(STYLES).map(function (k) { return STYLES[k]; }); }

  /* 描边宽度统一出口 */
  function LWM(min, v) { return Math.max(min, v) * (ST.lineScale || 1); }

  /* 以 fish.id 生成稳定伪随机（保证斑点位置固定） */
  function seedRand(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return function () {
      h ^= h << 13; h >>>= 0;
      h ^= h >> 17;
      h ^= h << 5;  h >>>= 0;
      return h / 4294967296;
    };
  }

  /* 颜色准备 */
  function palette(fish, opt) {
    var body = fish.body, accent = fish.accent;
    if (opt && opt.tint) {
      var amt = opt.tintAmt == null ? 0.55 : opt.tintAmt;
      body = U.mix(body, opt.tint, amt);
      accent = U.mix(accent, opt.tint, amt * 0.8);
    }
    if (ST.dark) {
      body = U.darken(body, ST.dark);
      accent = U.darken(accent, ST.dark * 0.45);
    }
    var line = U.darken(body, 0.38);
    if (ST.lineColorFn) line = ST.lineColorFn({ body: body, bodyDark: U.darken(body, 0.22),
                                                bodyLight: U.lighten(body, 0.28), accent: accent,
                                                accentDark: U.darken(accent, 0.18), belly: U.lighten(body, 0.55) });
    return {
      body: body,
      bodyDark: ST.flatFill ? U.darken(body, 0.30) : U.darken(body, 0.22),
      bodyLight: U.lighten(body, 0.28),
      accent: accent,
      accentDark: U.darken(accent, 0.18),
      belly: ST.flatFill ? U.lighten(body, 0.34) : U.lighten(body, 0.55),
      line: line,
      lineScale: ST.lineScale || 1,
    };
  }

  /* ---------------- 通用鱼身 ---------------- */
  function fishBody(ctx, L, h, np) {
    var nx = np * 0.50 * L;
    var tx = -0.45 * L;
    ctx.beginPath();
    ctx.moveTo(nx, 0);
    ctx.bezierCurveTo(0.34 * L, -0.30 * h, 0.18 * L, -0.56 * h, -0.02 * L, -0.58 * h);
    ctx.bezierCurveTo(-0.20 * L, -0.60 * h, -0.34 * L, -0.34 * h, tx, -0.16 * h);
    ctx.lineTo(tx, 0.16 * h);
    ctx.bezierCurveTo(-0.34 * L, 0.34 * h, -0.20 * L, 0.60 * h, -0.02 * L, 0.58 * h);
    ctx.bezierCurveTo(0.18 * L, 0.56 * h, 0.34 * L, 0.30 * h, nx, 0);
    ctx.closePath();
  }

  /* ---------------- 尾鳍 ---------------- */
  function tail(ctx, type, L, h, p) {
    var tx = -0.44 * L;
    ctx.beginPath();
    switch (type) {
      case 'fork':
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx - 0.17 * L, -0.50 * h);
        ctx.lineTo(tx - 0.09 * L, 0);
        ctx.lineTo(tx - 0.17 * L, 0.50 * h);
        break;

      case 'lunate':
        ctx.moveTo(tx, 0);
        ctx.quadraticCurveTo(tx - 0.13 * L, -0.44 * h, tx - 0.22 * L, -0.54 * h);
        ctx.quadraticCurveTo(tx - 0.09 * L, -0.16 * h, tx - 0.05 * L, 0);
        ctx.quadraticCurveTo(tx - 0.09 * L, 0.16 * h, tx - 0.22 * L, 0.54 * h);
        ctx.quadraticCurveTo(tx - 0.13 * L, 0.44 * h, tx, 0);
        break;

      case 'round':
        ctx.moveTo(tx, 0);
        ctx.bezierCurveTo(tx - 0.12 * L, -0.40 * h, tx - 0.22 * L, -0.36 * h, tx - 0.20 * L, 0);
        ctx.bezierCurveTo(tx - 0.22 * L, 0.36 * h, tx - 0.12 * L, 0.40 * h, tx, 0);
        break;

      case 'whip':
        ctx.moveTo(tx, -0.10 * h);
        ctx.quadraticCurveTo(tx - 0.22 * L, -0.14 * h, tx - 0.34 * L, 0.02 * h);
        ctx.quadraticCurveTo(tx - 0.22 * L, 0.14 * h, tx, 0.10 * h);
        break;

      default: /* fan */
        ctx.moveTo(tx, 0);
        ctx.quadraticCurveTo(tx - 0.12 * L, -0.46 * h, tx - 0.19 * L, -0.44 * h);
        ctx.quadraticCurveTo(tx - 0.11 * L, -0.20 * h, tx - 0.09 * L, 0);
        ctx.quadraticCurveTo(tx - 0.11 * L, 0.20 * h, tx - 0.19 * L, 0.44 * h);
        ctx.quadraticCurveTo(tx - 0.12 * L, 0.46 * h, tx, 0);
    }
    ctx.closePath();
    if (p && p.accentDark) {
      var g = ctx.createLinearGradient(tx - 0.2 * L, 0, tx, 0);
      g.addColorStop(0, p.accentDark);
      g.addColorStop(1, p.accent);
      ctx.fillStyle = g;
    } else ctx.fillStyle = (p && p.accent) || '#888';
    ctx.fill();
    if (p) { ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.008); ctx.stroke(); }
  }

  /* ---------------- 背鳍 ---------------- */
  function dorsal(ctx, fish, L, h, p) {
    var top = -0.56 * h;
    if (fish.spiny) {
      var n = 7;
      ctx.beginPath();
      ctx.moveTo(0.16 * L, top * 0.86);
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = 0.16 * L - t * 0.42 * L;
        var peak = top * (0.80 + 0.55 * Math.sin(t * Math.PI));
        var base = top * 0.86;
        ctx.lineTo(x, peak);
        ctx.lineTo(x - 0.018 * L, base);
      }
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.moveTo(0.14 * L, top * 0.88);
      ctx.quadraticCurveTo(0.02 * L, top * 1.55, -0.24 * L, top * 0.60);
      ctx.closePath();
    }
    ctx.fillStyle = U.rgba(p.accent, 0.92);
    ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.008); ctx.stroke();
  }

  /* ---------------- 腹/臀鳍 ---------------- */
  function analFin(ctx, L, h, p) {
    ctx.beginPath();
    ctx.moveTo(-0.10 * L, 0.58 * h * 0.92);
    ctx.quadraticCurveTo(-0.22 * L, 1.28 * h * 0.60, -0.36 * L, 0.30 * h);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.75);
    ctx.fill();
  }

  /* ---------------- 胸鳍 ---------------- */
  function pectoral(ctx, L, h, p, phase) {
    ctx.save();
    ctx.translate(0.14 * L, 0.10 * h);
    ctx.rotate(0.5 + (phase || 0) * 0.18);
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.11 * L, 0.045 * L, 0, 0, Math.PI * 2);
    ctx.fillStyle = U.rgba(p.accent, 0.85);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 花纹 ---------------- */
  function patterns(ctx, fish, L, h, p, rand) {
    if (fish.stripes) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = p.bodyDark;
      ctx.lineWidth = LWM(1, L * 0.028);
      ctx.lineCap = 'round';
      for (var i = 0; i < 6; i++) {
        var x = (0.30 - i * 0.13) * L;
        var hh = h * (0.52 - Math.abs(i - 2.2) * 0.055);
        ctx.beginPath();
        ctx.moveTo(x, -hh);
        ctx.quadraticCurveTo(x - 0.03 * L, 0, x, hh);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (fish.spots) {
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = p.bodyDark;
      for (var k = 0; k < 16; k++) {
        var rx = (rand() * 1.0 - 0.56) * L;
        var ry = (rand() - 0.5) * h * 0.9;
        var r = L * (0.014 + rand() * 0.026);
        ctx.beginPath(); ctx.arc(rx, ry, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ---------------- 高光 / 腹部 ---------------- */
  function shading(ctx, L, h, p) {
    ctx.save();
    ctx.globalAlpha = 0.30;
    ctx.beginPath();
    ctx.ellipse(0.02 * L, 0.22 * h, 0.34 * L, 0.20 * h, 0, 0, Math.PI * 2);
    ctx.fillStyle = p.belly;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.ellipse(0.10 * L, -0.20 * h, 0.24 * L, 0.08 * h, -0.06, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 眼睛 ---------------- */
  function eye(ctx, L, h, x, y, r, p) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x + r * 0.12, y, r * 0.58, 0, Math.PI * 2);
    ctx.fillStyle = '#1b2229'; ctx.fill();
    ctx.beginPath(); ctx.arc(x + r * 0.34, y - r * 0.26, r * 0.20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
  }

  /* =========================================================
     各体型模板
     ========================================================= */
  var TPL = {};

  TPL.fish = function (ctx, fish, L, opt, p, rand) {
    var h = L * fish.body_ratio * 1.55;
    h = Math.max(h, L * 0.20);
    var np = 1;

    tail(ctx, fish.tail, L, h, p);
    dorsal(ctx, fish, L, h, p);
    pectoral(ctx, L, h, p, opt.phase);

    // 身体
    fishBody(ctx, L, h, np);
    var g = ctx.createLinearGradient(0, -0.62 * h, 0, 0.62 * h);
    g.addColorStop(0, p.bodyDark);
    g.addColorStop(0.42, p.body);
    g.addColorStop(1, p.belly);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = p.line;
    ctx.lineWidth = LWM(0.7, L * 0.009);
    ctx.stroke();

    patterns(ctx, fish, L, h, p, rand);
    shading(ctx, L, h, p);
    analFin(ctx, L, h, p);

    // 须
    if (fish.barbels) {
      ctx.strokeStyle = p.accentDark;
      ctx.lineWidth = LWM(0.8, L * 0.012);
      ctx.lineCap = 'round';
      [0.18, 0.34].forEach(function (a, i) {
        ctx.beginPath();
        ctx.moveTo(0.47 * L, 0.06 * h);
        ctx.quadraticCurveTo(0.52 * L, (0.35 + i * 0.22) * h, 0.38 * L, (0.62 + i * 0.30) * h);
        ctx.stroke();
      });
    }

    // 牙
    if (fish.teeth) {
      ctx.fillStyle = '#fffdf5';
      for (var i = 0; i < 4; i++) {
        var x = (0.44 - i * 0.055) * L;
        ctx.beginPath();
        ctx.moveTo(x, 0.03 * h);
        ctx.lineTo(x - 0.018 * L, 0.16 * h);
        ctx.lineTo(x - 0.036 * L, 0.03 * h);
        ctx.closePath(); ctx.fill();
      }
    }

    // 鮟鱇的发光诱饵
    if (fish.lure) {
      ctx.strokeStyle = p.accentDark; ctx.lineWidth = LWM(0.9, L * 0.014);
      ctx.beginPath();
      ctx.moveTo(0.30 * L, -0.55 * h);
      ctx.quadraticCurveTo(0.52 * L, -1.05 * h, 0.72 * L, -0.72 * h);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(0.74 * L, -0.70 * h, L * 0.032, 0, Math.PI * 2);
      ctx.fillStyle = '#fff9b0';
      ctx.shadowColor = '#ffe86a'; ctx.shadowBlur = L * 0.22;
      ctx.fill(); ctx.shadowBlur = 0;
    }

    // 嘴
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.010);
    ctx.beginPath();
    ctx.moveTo(0.50 * L, 0.02 * h);
    ctx.quadraticCurveTo(0.42 * L, 0.14 * h, 0.32 * L, 0.12 * h);
    ctx.stroke();

    eye(ctx, L, h, 0.33 * L, -0.13 * h, Math.max(1.4, L * 0.048), p);
  };

  TPL.eel = function (ctx, fish, L, opt, p, rand) {
    var h = Math.max(L * 0.14, L * fish.body_ratio * 0.75);
    var N = 22, pts = [];
    for (var i = 0; i <= N; i++) {
      var t = i / N;
      var x = (0.48 - t * 0.95) * L;
      var y = Math.sin(t * 5.2 + (opt.t || 0) * 1.6) * h * 0.55 * t;
      var w = h * (0.92 - t * 0.72);
      pts.push({ x: x, y: y, w: Math.max(w, h * 0.10) });
    }
    // 尾鳍
    ctx.beginPath();
    ctx.moveTo(pts[N].x + pts[N].w * 0.4, pts[N].y);
    ctx.lineTo(pts[N].x - h * 0.55, pts[N].y - h * 0.42);
    ctx.lineTo(pts[N].x - h * 0.55, pts[N].y + h * 0.42);
    ctx.closePath();
    ctx.fillStyle = p.accent; ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y - pts[0].w * 0.5);
    for (var a = 0; a <= N; a++) ctx.lineTo(pts[a].x, pts[a].y - pts[a].w * 0.5);
    for (var b = N; b >= 0; b--) ctx.lineTo(pts[b].x, pts[b].y + pts[b].w * 0.5);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.5, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    // 背鳍（连续褶边）
    ctx.beginPath();
    ctx.moveTo(0.34 * L, pts[4].y - pts[4].w * 0.5);
    for (var c = 4; c <= N - 2; c++) {
      ctx.quadraticCurveTo(pts[c].x, pts[c].y - pts[c].w * 0.5 - h * 0.66,
                           pts[c + 1].x, pts[c + 1].y - pts[c + 1].w * 0.5);
    }
    ctx.strokeStyle = U.rgba(p.accent, 0.85);
    ctx.lineWidth = LWM(1.4, h * 0.34); ctx.lineCap = 'round';
    ctx.stroke();
    if (fish.teeth) {
      ctx.fillStyle = '#fffdf5';
      for (var k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo((0.46 - k * 0.05) * L, pts[0].y + h * 0.14);
        ctx.lineTo((0.44 - k * 0.05) * L, pts[0].y + h * 0.40);
        ctx.lineTo((0.41 - k * 0.05) * L, pts[0].y + h * 0.14);
        ctx.closePath(); ctx.fill();
      }
    }
    eye(ctx, L, h, 0.40 * L, pts[0].y - h * 0.18, Math.max(1.2, L * 0.026), p);
  };

  TPL.ray = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * 0.95;                       // 翼展
    var flap = Math.sin(t * 2.2) * 0.10;    // 振翅

    /* 尾鞭 */
    ctx.beginPath();
    ctx.moveTo(-0.40 * L, -h * 0.05);
    ctx.quadraticCurveTo(-0.72 * L, flap * h * 0.5 - h * 0.02, -1.05 * L, -h * 0.06 + flap * h);
    ctx.quadraticCurveTo(-0.70 * L, h * 0.03 + flap * h, -0.40 * L, h * 0.05);
    ctx.closePath();
    ctx.fillStyle = p.bodyDark;
    ctx.fill();

    /* 翼身一体 */
    ctx.beginPath();
    ctx.moveTo(0.46 * L, 0);                                            // 吻端
    ctx.bezierCurveTo(0.34 * L, -h * (0.22 + flap), 0.06 * L, -h * (0.62 + flap),
                      -0.34 * L, -h * (0.78 + flap));                    // 前缘 → 左翼尖
    ctx.quadraticCurveTo(-0.24 * L, -h * 0.30, -0.42 * L, -h * 0.06);    // 后缘收回尾根
    ctx.lineTo(-0.42 * L, h * 0.06);
    ctx.quadraticCurveTo(-0.24 * L, h * 0.30, -0.34 * L, h * (0.78 - flap)); // 右翼尖
    ctx.bezierCurveTo(0.06 * L, h * (0.62 - flap), 0.34 * L, h * (0.22 - flap), 0.46 * L, 0);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h * 0.7, 0, h * 0.7);
    g.addColorStop(0, p.bodyDark);
    g.addColorStop(0.45, p.body);
    g.addColorStop(1, p.belly);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();

    /* 头鳍（两条小角） */
    ctx.beginPath();
    ctx.moveTo(0.34 * L, -h * 0.06);
    ctx.quadraticCurveTo(0.52 * L, -h * 0.16, 0.46 * L, -h * 0.02);
    ctx.moveTo(0.34 * L, h * 0.06);
    ctx.quadraticCurveTo(0.52 * L, h * 0.16, 0.46 * L, h * 0.02);
    ctx.strokeStyle = p.accentDark; ctx.lineWidth = LWM(0.9, L * 0.014);
    ctx.lineCap = 'round';
    ctx.stroke();

    /* 斑点 */
    if (fish.spots) {
      ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = p.bodyDark;
      for (var i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.arc(rand() * 0.8 * L - 0.42 * L, (rand() - 0.5) * h * 1.1, L * (0.012 + rand() * 0.022), 0, 6.3);
        ctx.fill();
      }
      ctx.restore();
    }

    eye(ctx, L, h, 0.36 * L, -h * 0.10, Math.max(1.4, L * 0.040), p);
  };

  TPL.squid = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * 0.60;
    // 触手
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.92);
    ctx.lineCap = 'round';
    for (var i = 0; i < 9; i++) {
      var a = (i / 8 - 0.5) * 1.5;
      ctx.lineWidth = LWM(1.2, L * (0.030 - Math.abs(a) * 0.014));
      ctx.beginPath();
      ctx.moveTo(0.10 * L, 0);
      var wob = Math.sin(t * 2.6 + i * 0.7) * h * 0.20;
      ctx.bezierCurveTo(0.34 * L, a * h * 0.55, 0.58 * L, a * h * 1.10 + wob, 0.86 * L, a * h * 1.55 + wob * 1.5);
      ctx.stroke();
    }
    // 外套膜
    ctx.beginPath();
    ctx.moveTo(0.12 * L, -h * 0.52);
    ctx.bezierCurveTo(-0.30 * L, -h * 0.62, -0.78 * L, -h * 0.30, -1.00 * L, 0);
    ctx.bezierCurveTo(-0.78 * L, h * 0.30, -0.30 * L, h * 0.62, 0.12 * L, h * 0.52);
    ctx.bezierCurveTo(0.30 * L, h * 0.30, 0.30 * L, -h * 0.30, 0.12 * L, -h * 0.52);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.6);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    // 鳍
    ctx.beginPath();
    ctx.moveTo(-0.42 * L, -h * 0.34);
    ctx.quadraticCurveTo(-0.60 * L, -h * 0.72, -0.78 * L, -h * 0.30);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.8); ctx.fill();
    eye(ctx, L, h, 0.22 * L, -h * 0.16, Math.max(1.6, L * 0.045), p);
    eye(ctx, L, h, 0.20 * L, h * 0.14, Math.max(1.4, L * 0.038), p);
  };

  TPL.jelly = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var r = L * 0.42;
    // 触须
    ctx.strokeStyle = U.rgba(p.bodyLight, 0.65);
    ctx.lineCap = 'round';
    for (var i = 0; i < 11; i++) {
      var x = -r * 0.85 + (i / 10) * r * 1.7;
      var len = L * (0.55 + Math.sin(i * 1.3) * 0.22);
      ctx.lineWidth = LWM(0.8, L * 0.016);
      ctx.beginPath();
      ctx.moveTo(x, r * 0.30);
      var wob = Math.sin(t * 2.0 + i * 0.9) * L * 0.10;
      ctx.bezierCurveTo(x + wob, r * 0.9, x - wob, r * 0.9 + len * 0.4, x + wob * 0.6, r * 0.3 + len);
      ctx.stroke();
    }
    // 伞盖
    ctx.beginPath();
    ctx.moveTo(-r, r * 0.34);
    ctx.bezierCurveTo(-r * 1.05, -r * 1.35, r * 1.05, -r * 1.35, r, r * 0.34);
    ctx.quadraticCurveTo(0, r * 0.72, -r, r * 0.34);
    ctx.closePath();
    var g = ctx.createRadialGradient(0, -r * 0.35, r * 0.12, 0, 0, r * 1.4);
    g.addColorStop(0, U.lighten(p.body, 0.45));
    g.addColorStop(0.6, p.body);
    g.addColorStop(1, U.rgba(p.bodyDark, 0.85));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = U.rgba(p.accent, 0.6); ctx.lineWidth = LWM(0.8, L * 0.010); ctx.stroke();
    // 内部环
    ctx.beginPath(); ctx.ellipse(0, -r * 0.22, r * 0.55, r * 0.46, 0, 0, 6.3);
    ctx.strokeStyle = U.rgba(p.accent, 0.55); ctx.lineWidth = LWM(0.8, L * 0.012); ctx.stroke();
  };

  TPL.oarfish = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * 0.16;
    var N = 24, pts = [];
    for (var i = 0; i <= N; i++) {
      var k = i / N;
      var x = (0.45 - k * 0.98) * L;
      var y = Math.sin(k * 4.4 + t * 1.3) * h * 0.55 * k;
      pts.push({ x: x, y: y, w: h * (1.0 - k * 0.55) });
    }
    // 背鳍冠（红/橙色膜）
    ctx.beginPath();
    ctx.moveTo(0.36 * L, pts[0].y - pts[0].w * 0.5);
    for (var a = 0; a <= N; a++) ctx.lineTo(pts[a].x, pts[a].y - pts[a].w * 0.5 - h * 0.85);
    for (var b = N; b >= 0; b--) ctx.lineTo(pts[b].x, pts[b].y - pts[b].w * 0.5);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.85); ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(pts[0].x + h * 0.5, pts[0].y);
    for (var c = 0; c <= N; c++) {
      ctx.quadraticCurveTo(pts[c].x, pts[c].y - pts[c].w * 0.5, pts[c].x - 0.02 * L, pts[c].y - pts[c].w * 0.42);
    }
    for (var d = N; d >= 0; d--) {
      ctx.quadraticCurveTo(pts[d].x, pts[d].y + pts[d].w * 0.5, pts[d].x - 0.02 * L, pts[d].y + pts[d].w * 0.42);
    }
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.5, p.bodyLight); g.addColorStop(1, p.body);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.006); ctx.stroke();
    // 腹鳍小点
    ctx.fillStyle = U.rgba(p.accent, 0.9);
    for (var e = 2; e < N; e += 3) {
      ctx.beginPath();
      ctx.ellipse(pts[e].x, pts[e].y + pts[e].w * 0.55, L * 0.018, L * 0.010, 0, 0, 6.3);
      ctx.fill();
    }
    eye(ctx, L, h, 0.38 * L, pts[0].y - h * 0.10, Math.max(1.4, L * 0.026), p);
  };

  TPL.shark = function (ctx, fish, L, opt, p, rand) {
    var h = L * Math.max(0.26, fish.body_ratio * 1.25);
    // 尾（新月）
    ctx.beginPath();
    ctx.moveTo(-0.42 * L, 0);
    ctx.quadraticCurveTo(-0.60 * L, -h * 0.9, -0.78 * L, -h * 1.35);
    ctx.quadraticCurveTo(-0.62 * L, -h * 0.20, -0.70 * L, 0);
    ctx.quadraticCurveTo(-0.60 * L, h * 0.55, -0.42 * L, 0.10 * h);
    ctx.closePath();
    ctx.fillStyle = p.accentDark; ctx.fill();
    // 背鳍
    ctx.beginPath();
    ctx.moveTo(0.10 * L, -h * 0.42);
    ctx.lineTo(-0.06 * L, -h * 1.22);
    ctx.lineTo(-0.20 * L, -h * 0.38);
    ctx.closePath();
    ctx.fillStyle = p.bodyDark; ctx.fill();
    // 小背鳍
    ctx.beginPath();
    ctx.moveTo(-0.28 * L, -h * 0.34);
    ctx.lineTo(-0.34 * L, -h * 0.62);
    ctx.lineTo(-0.40 * L, -h * 0.30);
    ctx.closePath(); ctx.fillStyle = p.bodyDark; ctx.fill();
    // 胸鳍
    ctx.beginPath();
    ctx.moveTo(0.16 * L, h * 0.18);
    ctx.quadraticCurveTo(0.02 * L, h * 0.95, -0.14 * L, h * 0.42);
    ctx.closePath(); ctx.fillStyle = U.rgba(p.bodyDark, 0.95); ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(0.52 * L, -h * 0.06);
    ctx.bezierCurveTo(0.30 * L, -h * 0.52, -0.06 * L, -h * 0.56, -0.42 * L, -h * 0.26);
    ctx.lineTo(-0.42 * L, h * 0.24);
    ctx.bezierCurveTo(-0.06 * L, h * 0.54, 0.30 * L, h * 0.46, 0.52 * L, -h * 0.06);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.6);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.5, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    // 鳃裂
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.55);
    ctx.lineWidth = LWM(0.7, L * 0.010);
    for (var i = 0; i < 5; i++) {
      var x = (0.30 - i * 0.038) * L;
      ctx.beginPath();
      ctx.moveTo(x, -h * 0.22); ctx.lineTo(x - 0.01 * L, h * 0.10);
      ctx.stroke();
    }
    if (fish.teeth) {
      ctx.fillStyle = '#fffdf5';
      for (var k = 0; k < 6; k++) {
        var tx = (0.50 - k * 0.05) * L;
        ctx.beginPath();
        ctx.moveTo(tx, -h * 0.02);
        ctx.lineTo(tx - 0.02 * L, h * 0.22);
        ctx.lineTo(tx - 0.04 * L, -h * 0.02);
        ctx.closePath(); ctx.fill();
      }
    }
    eye(ctx, L, h, 0.36 * L, -h * 0.16, Math.max(1.2, L * 0.032), p);
  };

  TPL.whale = function (ctx, fish, L, opt, p, rand) {
    var h = L * 0.42;
    // 尾叶
    ctx.beginPath();
    ctx.moveTo(-0.36 * L, 0);
    ctx.quadraticCurveTo(-0.56 * L, -h * 0.95, -0.74 * L, -h * 0.78);
    ctx.quadraticCurveTo(-0.55 * L, -h * 0.10, -0.62 * L, 0);
    ctx.quadraticCurveTo(-0.55 * L, h * 0.10, -0.74 * L, h * 0.78);
    ctx.quadraticCurveTo(-0.56 * L, h * 0.95, -0.36 * L, 0);
    ctx.closePath();
    ctx.fillStyle = p.accentDark; ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(0.50 * L, h * 0.14);
    ctx.bezierCurveTo(0.34 * L, -h * 0.52, -0.02 * L, -h * 0.62, -0.36 * L, -h * 0.30);
    ctx.lineTo(-0.36 * L, h * 0.26);
    ctx.bezierCurveTo(-0.02 * L, h * 0.62, 0.34 * L, h * 0.50, 0.50 * L, h * 0.14);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h * 0.7, 0, h * 0.7);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    // 胸鳍
    ctx.beginPath();
    ctx.moveTo(0.18 * L, h * 0.26);
    ctx.quadraticCurveTo(0.04 * L, h * 0.72, -0.10 * L, h * 0.34);
    ctx.closePath(); ctx.fillStyle = p.bodyDark; ctx.fill();
    if (fish.spots) {
      ctx.save(); ctx.globalAlpha = 0.30; ctx.fillStyle = '#ffffff';
      for (var i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.arc((rand() * 0.8 - 0.42) * L, (rand() - 0.42) * h * 0.9, L * (0.010 + rand() * 0.018), 0, 6.3);
        ctx.fill();
      }
      ctx.restore();
    }
    // 嘴线
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.8, L * 0.010);
    ctx.beginPath();
    ctx.moveTo(0.50 * L, h * 0.14);
    ctx.quadraticCurveTo(0.40 * L, h * 0.26, 0.26 * L, h * 0.24);
    ctx.stroke();
    eye(ctx, L, h, 0.40 * L, h * 0.02, Math.max(1.2, L * 0.028), p);
  };

  TPL.dragon = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = Math.max(L * 0.22, L * fish.body_ratio * 1.1);
    var N = 18, pts = [];
    for (var i = 0; i <= N; i++) {
      var k = i / N;
      var x = (0.46 - k * 0.94) * L;
      var y = Math.sin(k * 3.4 + t * 1.5) * h * 0.42 * k;
      var w = h * (0.95 - k * 0.60);
      pts.push({ x: x, y: y, w: w });
    }
    // 尾鳍
    ctx.beginPath();
    ctx.moveTo(pts[N].x, pts[N].y);
    ctx.quadraticCurveTo(pts[N].x - 0.12 * L, pts[N].y - h * 0.9, pts[N].x - 0.26 * L, pts[N].y - h * 0.5);
    ctx.quadraticCurveTo(pts[N].x - 0.16 * L, pts[N].y, pts[N].x - 0.26 * L, pts[N].y + h * 0.5);
    ctx.quadraticCurveTo(pts[N].x - 0.12 * L, pts[N].y + h * 0.9, pts[N].x, pts[N].y);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.95); ctx.fill();
    // 背鳍膜
    ctx.beginPath();
    ctx.moveTo(0.22 * L, pts[2].y - pts[2].w * 0.5);
    for (var a = 2; a <= N; a++) ctx.lineTo(pts[a].x, pts[a].y - pts[a].w * 0.5 - h * 0.72);
    for (var b = N; b >= 2; b--) ctx.lineTo(pts[b].x, pts[b].y - pts[b].w * 0.5);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.62); ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y - pts[0].w * 0.5);
    for (var c = 0; c <= N; c++) ctx.lineTo(pts[c].x, pts[c].y - pts[c].w * 0.5);
    for (var d = N; d >= 0; d--) ctx.lineTo(pts[d].x, pts[d].y + pts[d].w * 0.5);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.42, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    // 鳞片
    ctx.save();
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#ffffff';
    for (var e = 0; e <= N; e += 2) {
      ctx.beginPath();
      ctx.ellipse(pts[e].x, pts[e].y - pts[e].w * 0.12, L * 0.026, L * 0.014, 0, 0, 6.3);
      ctx.fill();
    }
    ctx.restore();
    // 龙须
    ctx.strokeStyle = p.accent; ctx.lineWidth = LWM(0.9, L * 0.011); ctx.lineCap = 'round';
    [0, 1].forEach(function (i) {
      ctx.beginPath();
      ctx.moveTo(0.44 * L, (i ? 0.10 : -0.10) * h);
      ctx.quadraticCurveTo(0.66 * L, (i ? 0.42 : -0.42) * h + Math.sin(t * 3 + i) * h * 0.10, 0.52 * L, (i ? 0.72 : -0.72) * h);
      ctx.stroke();
    });
    // 角
    ctx.strokeStyle = p.accent; ctx.lineWidth = LWM(1, L * 0.014);
    ctx.beginPath();
    ctx.moveTo(0.30 * L, -h * 0.48);
    ctx.lineTo(0.22 * L, -h * 0.98);
    ctx.stroke();
    eye(ctx, L, h, 0.36 * L, -h * 0.16, Math.max(1.4, L * 0.038), p);
  };

  /* =========================================================
     对外接口
     ========================================================= */
  function draw(ctx, fish, cx, cy, L, opt) {
    opt = opt || {};
    if (!fish) return;
    var p = palette(fish, opt);
    var rand = seedRand(fish.id);

    ctx.save();
    ctx.translate(cx, cy);
    if (opt.flip) ctx.scale(-1, 1);
    if (opt.scale && opt.scale !== 1) ctx.scale(opt.scale, opt.scale);

    if (ST.filter && ST.filter !== 'none') ctx.filter = ST.filter;
    if (ST.alpha != null) ctx.globalAlpha = ST.alpha;

    var glowing = fish.glow || opt.forceGlow || ST.glowBoost;
    if (glowing) {
      ctx.shadowColor = U.rgba(ST.glowBoost ? U.lighten(p.accent, 0.35) : p.accent, 0.9);
      ctx.shadowBlur = L * 0.55 * (ST.glowBoost || 1);
    }

    var tpl = TPL[fish.shape] || TPL.fish;
    var passes = ST.bleed || 1;
    for (var ps = 0; ps < passes; ps++) {
      if (ps > 0) {
        ctx.globalAlpha = (ST.alpha != null ? ST.alpha : 1) * 0.55;
        ctx.translate(L * 0.022 * ps, L * 0.014 * ps);
        rand = seedRand(fish.id + ps);
      }
      tpl(ctx, fish, L, opt, p, rand);
    }

    /* 鳞片纹理（写实风） */
    if (ST.scales) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.6, L * 0.004);
      for (var rr = 0; rr < 7; rr++) {
        for (var cc = 0; cc < 12; cc++) {
          var sx = (cc * 0.085 - 0.48) * L + (rr % 2) * L * 0.042;
          var sy = (rr * 0.095 - 0.30) * L;
          ctx.beginPath();
          ctx.arc(sx, sy, L * 0.026, Math.PI * 1.12, Math.PI * 1.88);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    ctx.shadowBlur = 0;
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    if (ST.paper) {
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = '#c9b78e';
      for (var i = 0; i < 26; i++) {
        ctx.fillRect((rand() * 1.6 - 1.3) * L, (rand() * 1.4 - 0.7) * L, L * 0.03, L * 0.012);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /* 未解锁剪影 */
  function drawSilhouette(ctx, fish, cx, cy, L) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = 0.20;
    var fake = Object.assign({}, fish, { glow: false });
    var p = { body: '#5b7488', bodyDark: '#3d5468', bodyLight: '#7d95a8',
              accent: '#5b7488', accentDark: '#3d5468', belly: '#8ba2b5', line: '#3d5468' };
    var rand = seedRand(fish.id);
    (TPL[fake.shape] || TPL.fish)(ctx, fake, L, {}, p, rand);
    ctx.restore();
  }

  /* 画在指定 canvas 上（自适应尺寸，用于图鉴 / 结算卡） */
  function paintTo(canvas, fish, opt) {
    opt = opt || {};
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.width;
    var h = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景光
    var gr = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, Math.max(w, h) * 0.7);
    gr.addColorStop(0, 'rgba(255,255,255,.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);

    var L = Math.min(w * 0.68, h * 1.55);
    draw(ctx, fish, w * 0.5, h * 0.5, L, opt);
    return ctx;
  }

  return { draw: draw, drawSilhouette: drawSilhouette, paintTo: paintTo, palette: palette,
           setStyle: setStyle, getStyle: getStyle, listStyles: listStyles, STYLES: STYLES };
})();
