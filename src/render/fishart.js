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
     crustacean 甲壳类（小龙虾 / 等足虫：甲壳 + 步足 + 尾扇）
     star   棘皮·海蛇尾（中央盘 + 五辐射的腕）
     worm   软长形无脊椎（海猪 / 管虫：软体长身 + 前端触手环 + 腹面管足）
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

  /* =========================================================
     鱼形家族的 19 个细分体型（2026-10-10）
     =========================================================
     用户口径：「通用鱼这个分类也有点大，可以体型再细分画风，例如鲟鱼和普通鱼
     长得就不一样。我希望同一个体型的生物最好不要超过 20 个」。

     ⚠️ 为什么是**参数化**而不是 19 份手写剪影：
        `TPL.fish` 已经把「身体 + 尾 + 背鳍 + 胸鳍 + 臀鳍 + 花纹 + 明暗 + 眼 + 须 + 牙 + 诱饵」
        都写好了，19 个体型里有 14 个只是**比例与部件不同**（细长/高体/鲭/鲑…），
        重画一遍等于把同一段代码抄 14 次 —— 那正是本项目最忌讳的「第二份真相」。
        只有**轮廓真的换了原型**的 5 个（圆钝盘 / 扁盘 / 直立 / 翼状 / 巨口）才另写 hull。
     ⚠️ 每个变体都落在与基准鱼同一量级的外接框里 —— 否则图鉴里大小差一截。
     ⚠️ 顺序纪律同 `TPL.crab`：**主体先画、外露部件后画**
        （蟹/龟那轮的教训：附肢先画会被壳整片盖住，语法与门禁全都查不出来）。 */

  // ── 替换用轮廓 ──
  // 圆钝盘（河鲀 / 翻车鲀）：没有尾柄，体高被封顶（不然 body_ratio 0.78 会画成一根柱子）
  function hullRound(ctx, L, h) {
    var ry = Math.min(0.30 * L, 0.56 * h);
    ctx.beginPath();
    ctx.ellipse(-0.02 * L, 0, 0.34 * L, ry, 0, 0, Math.PI * 2);
    ctx.closePath();
  }
  // 扁盘（比目鱼）：横宽、竖扁，整体像一片躺着的叶子
  function hullDisc(ctx, L, h) {
    var ry = Math.max(0.16 * L, 0.34 * h);
    ctx.beginPath();
    ctx.moveTo(-0.46 * L, 0);
    ctx.bezierCurveTo(-0.40 * L, -ry, 0.14 * L, -ry * 1.16, 0.44 * L, -ry * 0.30);
    ctx.bezierCurveTo(0.52 * L, 0, 0.52 * L, 0, 0.44 * L, ry * 0.30);
    ctx.bezierCurveTo(0.14 * L, ry * 1.16, -0.40 * L, ry, -0.46 * L, 0);
    ctx.closePath();
  }
  // 直立（海马）：竖向的 S 形躯干，尾向下卷
  function hullUpright(ctx, L, h) {
    ctx.beginPath();
    ctx.moveTo(0.10 * L, -0.40 * L);
    ctx.bezierCurveTo(0.22 * L, -0.20 * L, 0.18 * L, 0.06 * L, 0.06 * L, 0.22 * L);
    ctx.bezierCurveTo(-0.02 * L, 0.34 * L, -0.10 * L, 0.30 * L, -0.12 * L, 0.20 * L);
    ctx.bezierCurveTo(-0.14 * L, 0.10 * L, -0.06 * L, 0.06 * L, -0.04 * L, -0.10 * L);
    ctx.bezierCurveTo(-0.02 * L, -0.26 * L, -0.04 * L, -0.36 * L, 0.02 * L, -0.42 * L);
    ctx.closePath();
  }
  // 翼状盘（蝠鲼）：两片大翼 + 头前一对「角」
  function hullWing(ctx, L, h) {
    ctx.beginPath();
    ctx.moveTo(0.30 * L, 0.02 * L);
    ctx.quadraticCurveTo(0.10 * L, -0.34 * L, -0.34 * L, -0.40 * L);
    ctx.quadraticCurveTo(-0.52 * L, -0.20 * L, -0.30 * L, -0.02 * L);
    ctx.quadraticCurveTo(-0.10 * L, 0.06 * L, -0.06 * L, 0.30 * L);
    ctx.quadraticCurveTo(0.10 * L, 0.22 * L, 0.30 * L, 0.02 * L);
    ctx.closePath();
  }
  // 巨口（鮟鱇 / 深海巨口）：短圆躯干 + 一张开到身长一半的嘴
  function hullJaw(ctx, L, h) {
    var ry = Math.min(0.30 * L, 0.62 * h);
    ctx.beginPath();
    ctx.moveTo(0.44 * L, -0.06 * L);
    ctx.bezierCurveTo(0.30 * L, -0.26 * L, 0.02 * L, -ry, -0.18 * L, -ry * 0.86);
    ctx.bezierCurveTo(-0.36 * L, -ry * 0.60, -0.44 * L, -ry * 0.20, -0.44 * L, 0);
    ctx.bezierCurveTo(-0.44 * L, ry * 0.22, -0.34 * L, ry * 0.60, -0.16 * L, ry * 0.88);
    ctx.bezierCurveTo(0.06 * L, ry, 0.30 * L, 0.20 * L, 0.44 * L, -0.06 * L);
    ctx.closePath();
  }

  // ── 外露部件（都在主体之后画）──
  function scutes(ctx, L, h, p) {          // 鲟：背上一列骨板
    ctx.fillStyle = U.rgba(p.accent, 0.92);
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.006);
    for (var i = 0; i < 6; i++) {
      var x = (0.34 - i * 0.13) * L, y = -0.52 * h * (1 - Math.abs(i - 1.6) * 0.06);
      ctx.beginPath();
      ctx.moveTo(x - 0.045 * L, y + 0.03 * h);
      ctx.lineTo(x, y - 0.10 * h);
      ctx.lineTo(x + 0.045 * L, y + 0.03 * h);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  function fringe(ctx, L, h, p, ry) {      // 比目鱼：周缘一圈连续鳍
    ctx.save();
    ctx.strokeStyle = U.rgba(p.accent, 0.9);
    ctx.lineWidth = Math.max(1.4, ry * 0.30);
    ctx.beginPath();
    ctx.moveTo(-0.46 * L, 0);
    ctx.bezierCurveTo(-0.40 * L, -ry, 0.14 * L, -ry * 1.16, 0.44 * L, -ry * 0.30);
    ctx.bezierCurveTo(0.52 * L, 0, 0.52 * L, 0, 0.44 * L, ry * 0.30);
    ctx.bezierCurveTo(0.14 * L, ry * 1.16, -0.40 * L, ry, -0.46 * L, 0);
    ctx.stroke();
    ctx.restore();
  }
  function sail(ctx, L, h, p) {            // 旗鱼 / 剑鱼：高而挺的背帆
    ctx.beginPath();
    ctx.moveTo(0.20 * L, -0.52 * h);
    ctx.quadraticCurveTo(-0.06 * L, -1.34 * h, -0.34 * L, -0.46 * h);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.92); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.008); ctx.stroke();
  }
  function snout(ctx, L, h, p, len) {      // 长吻（旗剑 / 鲟）
    ctx.beginPath();
    ctx.moveTo(0.44 * L, -0.10 * h);
    ctx.lineTo(len * L, -0.015 * h);
    ctx.lineTo(0.44 * L, 0.06 * h);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.95); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.007); ctx.stroke();
  }
  function finlets(ctx, L, h, p) {         // 鲭：背鳍 / 臀鳍后面那一排小鳍
    ctx.fillStyle = U.rgba(p.accent, 0.88);
    for (var i = 0; i < 4; i++) {
      var x = (-0.16 - i * 0.062) * L;
      [-0.52 * h, 0.50 * h].forEach(function (y) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 0.02 * L, y + (y < 0 ? -0.11 : 0.11) * h);
        ctx.lineTo(x - 0.045 * L, y);
        ctx.closePath(); ctx.fill();
      });
    }
  }
  function adipose(ctx, L, h, p) {         // 鲑：背鳍后那枚小脂鳍
    ctx.beginPath();
    ctx.moveTo(-0.12 * L, -0.54 * h);
    ctx.quadraticCurveTo(-0.18 * L, -0.76 * h, -0.26 * L, -0.50 * h);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.85); ctx.fill();
  }
  function curledTail(ctx, L, p) {         // 海马：向下卷的尾
    ctx.strokeStyle = p.body === undefined ? p.line : p.body;
    ctx.lineWidth = Math.max(2.4, L * 0.055);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-0.04 * L, 0.20 * L);
    ctx.quadraticCurveTo(-0.10 * L, 0.40 * L, -0.24 * L, 0.34 * L);
    ctx.quadraticCurveTo(-0.34 * L, 0.28 * L, -0.24 * L, 0.20 * L);
    ctx.stroke();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.008);
    ctx.stroke();
  }
  function tubeSnout(ctx, L, h, p) {       // 海马：管状吻
    ctx.beginPath();
    ctx.moveTo(0.10 * L, -0.30 * L);
    ctx.lineTo(0.36 * L, -0.36 * L);
    ctx.lineTo(0.10 * L, -0.20 * L);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.95); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.007); ctx.stroke();
  }
  function horns(ctx, L, h, p) {           // 蝠鲼：口前那一对「角」
    ctx.strokeStyle = U.rgba(p.bodyDark || p.line, 0.95);
    ctx.lineWidth = Math.max(1.6, L * 0.030);
    ctx.lineCap = 'round';
    [-1, 1].forEach(function (s) {
      ctx.beginPath();
      ctx.moveTo(0.28 * L, 0.02 * L + s * 0.05 * L);
      ctx.quadraticCurveTo(0.42 * L, s * 0.05 * L, 0.46 * L, (0.02 + s * 0.16) * L);
      ctx.stroke();
    });
  }
  function fangs(ctx, L, h, p, n, scale) { // 巨口形：针状牙
    ctx.fillStyle = '#fffdf5';
    for (var i = 0; i < n; i++) {
      var x = (0.36 - i * 0.052) * L;
      ctx.beginPath();
      ctx.moveTo(x, 0.02 * L);
      ctx.lineTo(x - 0.014 * L, 0.02 * L + (scale || 1) * 0.20 * L);
      ctx.lineTo(x - 0.028 * L, 0.02 * L);
      ctx.closePath(); ctx.fill();
    }
  }
  function smallTail(ctx, L, h, p) {       // 鲳：短圆身体后面一枚很小的尾
    ctx.beginPath();
    ctx.moveTo(-0.44 * L, 0);
    ctx.lineTo(-0.56 * L, -0.22 * h);
    ctx.lineTo(-0.50 * L, 0);
    ctx.lineTo(-0.56 * L, 0.22 * h);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.accent, 0.92); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.007); ctx.stroke();
  }

  // ── 变体表：一个细体型一行（提示词侧的对应句在 `tools/gen-art.py` 的 `SHAPES`）──
  var FISH_VARIANTS = {
    // 普通鱼按体深与头部构型（6）
    /* ⚠️ `slender` 的系数要**压到 0.72**、`minnow` 抬到 1.20 —— 第一版 0.80 / 0.94
       只差 17%，而这两类鱼本身的 `body_ratio` 又一样（都是 0.26~0.28），
       截图上两条几乎一模一样（`slender` 与 `minnow` 是「细分」里最需要拉开的一对）。 */
    slender:  { h: 0.72, tail: 'fork',   dorsal: 'low' },
    minnow:   { h: 1.20, tail: 'round',  dorsal: 'normal' },
    deep:     { h: 1.28, tail: 'fork',   dorsal: 'long' },
    carp:     { h: 1.10, tail: 'round',  dorsal: 'long' },
    reef:     { h: 1.14, tail: 'round',  dorsal: 'spiny' },
    perch:    { h: 1.04, tail: 'fork',   dorsal: 'two' },
    // 底栖与深海奇形（2）
    /* 底栖 / 鲶：**眼睛挪到头顶**（贴底的鱼都是这样）+ 鲶有长须（须由  标记画）。
       ⚠️ 曾经想用「吻端鼓出一块宽头」来表现，实测画出来像脑袋前贴了一块砖
          （那块必然压在主体上，接缝/色差在截图里一目了然）—— 已撤掉，改用眼位。 */
    bottom:   { h: 0.90, tail: 'round',  dorsal: 'low', eyeUp: true },
    catfish:  { h: 0.88, tail: 'round',  dorsal: 'low', eyeUp: true },
    fangfish: { hull: 'jaw',  h: 0.74, fangs: 7 },
    // 一眼可辨（9）
    flatfish: { hull: 'disc', h: 0.52 },
    sturgeon: { h: 0.84, tail: 'hetero', dorsal: 'low', snout: 0.62, scutes: true, barbels: true },
    mackerel: { h: 0.84, tail: 'lunate', dorsal: 'finlets' },
    billfish: { h: 0.76, tail: 'lunate', dorsal: 'sail', snout: 0.86 },
    anglerfish: { hull: 'jaw', h: 0.86, lure: true, fangs: 4 },
    puffer:   { hull: 'round', h: 0.66 },
    seahorse: { hull: 'upright', h: 0.66 },
    pomfret:  { h: 1.34, tail: 'small',  dorsal: 'low' },
    salmon:   { h: 0.96, tail: 'fork',   dorsal: 'normal', adipose: true },
    manta:    { hull: 'wing', h: 0.60 },
  };

  /* 变体绘制：主体先画，外露部件后画（口径见本节开头的注释）。
     ⚠️ `h` 统一由 `body_ratio` 派生再乘变体系数，cap 到 0.68L ——
        河鲀的 `body_ratio` 是 0.78，不封顶会画成一根竖柱子。 */
  function drawVariant(ctx, fish, L, opt, p, rand, v) {
    /* ⚠️ 高度上限分两档：换了轮廓原型的那几个（圆盘 / 巨口）**必须**封顶 ——
       河鲀的 `body_ratio` 是 0.78，不封顶会画成一根竖柱子；而普通鱼形不封顶，
       否则「高体鱼形」（body 0.52）反而比基准鱼矮一截，图鉴里看着反而更小。 */
    var h = Math.min(L * (v.hull ? 0.66 : 1.05),
                     Math.max(L * 0.18, L * fish.body_ratio * 1.55 * (v.h || 1)));
    var hull = v.hull || 'oval';
    var ry = Math.max(0.16 * L, 0.34 * h);

    // ① 尾（圆钝盘与直立形没有尾柄，交给各自的 hull 处理）
    if (!v.hull && v.tail !== 'small') tail(ctx, v.tail === 'hetero' ? 'fork' : (v.tail || fish.tail), L, h, p);
    // ② 背鳍
    if (v.dorsal === 'sail') sail(ctx, L, h, p);
    else if (v.dorsal === 'two') {
      dorsal(ctx, fish, L, h, p);
      ctx.beginPath();
      ctx.moveTo(-0.06 * L, -0.54 * h);
      ctx.lineTo(-0.20 * L, -0.82 * h);
      ctx.lineTo(-0.30 * L, -0.50 * h);
      ctx.closePath();
      ctx.fillStyle = U.rgba(p.accent, 0.9); ctx.fill();
    } else if (v.dorsal === 'spiny') { dorsal(ctx, { spiny: true }, L, h, p); }
    else if (v.dorsal === 'low') { dorsal(ctx, fish, L, h * 0.78, p); }
    else if (v.dorsal !== 'finlets' && v.dorsal !== 'small') dorsal(ctx, fish, L, h, p);
    // ③ 胸鳍（巨口 / 直立 / 翼状形的胸鳍位置不同，跳过通用位）
    if (!v.hull || hull === 'jaw') pectoral(ctx, L, h, p, opt.phase);

    // ④ 主体
    if (hull === 'round') hullRound(ctx, L, h);
    else if (hull === 'disc') { hullDisc(ctx, L, h); }
    else if (hull === 'upright') hullUpright(ctx, L, h);
    else if (hull === 'wing') hullWing(ctx, L, h);
    else if (hull === 'jaw') hullJaw(ctx, L, h);
    else fishBody(ctx, L, h, 1);
    var g = ctx.createLinearGradient(0, -0.62 * h, 0, 0.62 * h);
    g.addColorStop(0, p.bodyDark);
    g.addColorStop(0.42, p.body);
    g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.009); ctx.stroke();

    // ⑤ 外露部件（全部在主体之后）
    if (v.scutes) scutes(ctx, L, h, p);
    if (v.snout) snout(ctx, L, h, p, v.snout);
    if (v.dorsal === 'finlets') finlets(ctx, L, h, p);
    if (v.adipose) adipose(ctx, L, h, p);
    if (v.tail === 'small') smallTail(ctx, L, h, p);
    if (hull === 'disc') fringe(ctx, L, h, p, ry);
    if (hull === 'wing') horns(ctx, L, h, p);
    if (hull === 'upright') { curledTail(ctx, L, p); tubeSnout(ctx, L, h, p); }
    if (v.fangs) fangs(ctx, L, h, p, v.fangs, v.fangs > 5 ? 1.25 : 1);
    if (v.lure || fish.lure) {
      ctx.strokeStyle = p.accentDark; ctx.lineWidth = LWM(0.9, L * 0.014);
      ctx.beginPath();
      ctx.moveTo(0.10 * L, -0.50 * h);
      ctx.quadraticCurveTo(0.34 * L, -1.05 * h, 0.56 * L, -0.72 * h);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(0.58 * L, -0.70 * h, L * 0.030, 0, Math.PI * 2);
      ctx.fillStyle = '#fff9b0';
      ctx.shadowColor = '#ffe86a'; ctx.shadowBlur = L * 0.22;
      ctx.fill(); ctx.shadowBlur = 0;
    }
    patterns(ctx, fish, L, h, p, rand);
    shading(ctx, L, h, p);
    if (hull === 'oval' && v.dorsal !== 'finlets') analFin(ctx, L, h, p);

    // ⑥ 须 / 牙（与基准鱼同款，只是位置跟着头型走）
    if (fish.barbels || v.barbels) {
      ctx.strokeStyle = p.accentDark;
      ctx.lineWidth = LWM(0.8, L * 0.012); ctx.lineCap = 'round';
      [0.18, 0.34].forEach(function (a, i) {
        ctx.beginPath();
        ctx.moveTo(0.40 * L, 0.06 * h);
        ctx.quadraticCurveTo(0.46 * L, (0.35 + i * 0.22) * h, 0.32 * L, (0.62 + i * 0.30) * h);
        ctx.stroke();
      });
    }
    if (fish.teeth && !v.fangs) {
      ctx.fillStyle = '#fffdf5';
      for (var i2 = 0; i2 < 4; i2++) {
        var x2 = (0.36 - i2 * 0.055) * L;
        ctx.beginPath();
        ctx.moveTo(x2, 0.03 * h);
        ctx.lineTo(x2 - 0.018 * L, 0.16 * h);
        ctx.lineTo(x2 - 0.036 * L, 0.03 * h);
        ctx.closePath(); ctx.fill();
      }
    }

    // ⑦ 嘴 + 眼
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.010);
    ctx.beginPath();
    ctx.moveTo(0.44 * L, 0.02 * h);
    ctx.quadraticCurveTo(0.36 * L, 0.14 * h, 0.26 * L, 0.12 * h);
    ctx.stroke();
    if (hull === 'upright') {
      eye(ctx, L, h, 0.04 * L, -0.28 * L, Math.max(1.4, L * 0.042), p);
    } else if (hull === 'disc') {
      // 比目鱼：两只眼都挤在朝上一侧
      eye(ctx, L, h, 0.26 * L, -0.16 * ry, Math.max(1.4, L * 0.040), p);
      eye(ctx, L, h, 0.08 * L, -0.20 * ry, Math.max(1.4, L * 0.036), p);
    } else if (hull === 'wing') {
      eye(ctx, L, h, 0.16 * L, -0.14 * L, Math.max(1.4, L * 0.038), p);
    } else if (v.eyeUp) {
      eye(ctx, L, h, 0.32 * L, -0.32 * h, Math.max(1.4, L * 0.044), p);
    } else {
      eye(ctx, L, h, 0.30 * L, -0.13 * h, Math.max(1.4, L * 0.046), p);
    }
  }

  /* 19 个薄壳 —— 键集必须与 `CONFIG.shapeCn` 双向相等（verify 第 ㊸ 节）。
     ⚠️ **必须一个个写出来，不许 `Object.keys(FISH_VARIANTS).forEach`** ——
        第 ㊸ 节是按源码里的 `TPL.<键> =` 字面去抓键集的，动态赋值会让它一条都抓不到，
        于是「中文标签表 = 模板键集」这条判据**当场失去判据能力**（还不会报错）。 */
  TPL.slender = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.slender); };
  TPL.minnow = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.minnow); };
  TPL.deep = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.deep); };
  TPL.carp = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.carp); };
  TPL.reef = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.reef); };
  TPL.perch = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.perch); };
  TPL.bottom = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.bottom); };
  TPL.catfish = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.catfish); };
  TPL.fangfish = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.fangfish); };
  TPL.flatfish = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.flatfish); };
  TPL.sturgeon = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.sturgeon); };
  TPL.mackerel = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.mackerel); };
  TPL.billfish = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.billfish); };
  TPL.anglerfish = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.anglerfish); };
  TPL.puffer = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.puffer); };
  TPL.seahorse = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.seahorse); };
  TPL.pomfret = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.pomfret); };
  TPL.salmon = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.salmon); };
  TPL.manta = function (ctx, fish, L, opt, p, rand) { drawVariant(ctx, fish, L, opt, p, rand, FISH_VARIANTS.manta); };

  /* 存在性自检：防的是「变体表里删了一行、19 个薄壳少一个」——
     第 ㊸ 节只比键集，键在、画法没了它查不出来。 */
  ['slender', 'minnow', 'deep', 'carp', 'reef', 'perch', 'bottom', 'catfish', 'fangfish',
   'flatfish', 'sturgeon', 'mackerel', 'billfish', 'anglerfish', 'puffer', 'seahorse',
   'pomfret', 'salmon', 'manta'].forEach(function (k) {
    if (typeof TPL[k] !== 'function' || !FISH_VARIANTS[k]) {
      throw new Error('fishart.js：细体型 ' + k + ' 的薄壳或变体没建全');
    }
  });

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

  /* ── 甲壳类：甲壳 + 步足 + 尾扇（小龙虾 / 巨型等足虫）─────────────────────────
     为什么单开一个模板：这 2 条原来兜底成 `squid`，而 `TPL.squid` 画的是
     「长筒外套膜 + 三角鳍」= **一只乌贼**（与 AI 出图那条同源的老毛病）。
     ⚠️ 剪影上**刻意不画任何鳍** —— 甲壳类的辨识特征恰恰是「没有鳍 + 一列步足 + 尾扇」。 */
  TPL.crustacean = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.18, Math.min(0.32, (fish.body_ratio || 0.34) * 0.90));
    /* 步足（4 对，随呼吸轻微摆动） */
    ctx.strokeStyle = U.rgba(p.accentDark, 0.95);
    ctx.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      var x = (0.30 - i * 0.20) * L;
      var wob = Math.sin(t * 2.2 + i * 0.8) * h * 0.10;
      ctx.lineWidth = LWM(0.9, L * 0.012);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.26);
      ctx.quadraticCurveTo(x - L * 0.05, h * (0.86 + i * 0.05), x - L * 0.15, h * 1.06 + wob);
      ctx.stroke();
    }
    /* 尾扇（-x 端，5 片） */
    ctx.fillStyle = U.rgba(p.accent, 0.92);
    for (var s = 0; s < 5; s++) {
      var a = (s / 4 - 0.5) * 1.6;
      ctx.beginPath();
      ctx.moveTo(-0.46 * L, h * 0.04);
      ctx.lineTo(-0.50 * L - Math.cos(a) * L * 0.34, h * 0.04 + Math.sin(a) * h * 1.15);
      ctx.lineTo(-0.38 * L, h * 0.04);
      ctx.closePath(); ctx.fill();
    }
    /* 甲壳（头胸甲 + 分节腹，一体成型） */
    ctx.beginPath();
    ctx.moveTo(0.56 * L, -h * 0.16);
    ctx.bezierCurveTo(0.50 * L, -h * 0.94, 0.08 * L, -h * 1.02, -0.26 * L, -h * 0.68);
    ctx.quadraticCurveTo(-0.42 * L, -h * 0.40, -0.44 * L, 0);
    ctx.quadraticCurveTo(-0.42 * L, h * 0.36, -0.26 * L, h * 0.60);
    ctx.bezierCurveTo(0.08 * L, h * 0.98, 0.50 * L, h * 0.88, 0.56 * L, -h * 0.16);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 腹节横线 */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.55); ctx.lineWidth = LWM(0.7, L * 0.008);
    for (var k = 0; k < 4; k++) {
      var sx = (-0.02 - k * 0.11) * L;
      ctx.beginPath();
      ctx.moveTo(sx, -h * 0.80 + k * h * 0.34);
      ctx.lineTo(sx, h * 0.76 - k * h * 0.28);
      ctx.stroke();
    }
    /* 触角（两根，向前） */
    ctx.strokeStyle = U.rgba(p.accent, 0.9); ctx.lineWidth = LWM(0.8, L * 0.011);
    [0, 1].forEach(function (i) {
      ctx.beginPath();
      ctx.moveTo(0.50 * L, (i ? 0.10 : -0.10) * h);
      ctx.quadraticCurveTo(0.80 * L, (i ? 0.38 : -0.38) * h, 0.96 * L, (i ? 0.12 : -0.12) * h);
      ctx.stroke();
    });
    eye(ctx, L, h, 0.40 * L, -h * 0.32, Math.max(1.4, L * 0.036), p);
  };

  /* ── 棘皮·海蛇尾：中央盘 + 五辐射的腕 ────────────────────────────────────
     原来兜底成 `eel`（长条鱼）。⚠️ 它是**五辐射对称**的，没有「正脸 / 尾巴」之分，
     所以这里不画尾也不画眼（棘皮动物没有眼）。 */
  TPL.star = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var r = L * 0.62;
    var disc = L * 0.15;
    /* ⚠️ 五辐射对称**必须用径向渐变** —— 竖向渐变会让朝上/朝下的腕一黑一白 */
    var g = ctx.createRadialGradient(0, 0, disc * 0.4, 0, 0, r);
    g.addColorStop(0, U.lighten(p.body, 0.30));
    g.addColorStop(0.55, p.body);
    g.addColorStop(1, p.bodyDark);
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + i * (Math.PI * 2 / 5) + Math.sin(t * 0.8) * 0.05;
      var wob = Math.sin(t * 1.6 + i * 1.1) * L * 0.028;
      var ca = Math.cos(a), sa = Math.sin(a);
      var w = L * 0.075;
      ctx.beginPath();
      ctx.moveTo(ca * disc - sa * disc * 0.5, sa * disc + ca * disc * 0.5);
      ctx.quadraticCurveTo(ca * r * 0.55 - sa * w, sa * r * 0.55 + ca * w, ca * r + wob, sa * r + wob * 0.6);
      ctx.quadraticCurveTo(ca * r * 0.55 + sa * w, sa * r * 0.55 - ca * w,
                           ca * disc + sa * disc * 0.5, sa * disc - ca * disc * 0.5);
      ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    }
    /* 中央盘 */
    ctx.beginPath(); ctx.arc(0, 0, disc * 1.06, 0, 6.3);
    var g2 = ctx.createRadialGradient(0, -disc * 0.3, disc * 0.2, 0, 0, disc * 1.4);
    g2.addColorStop(0, U.lighten(p.body, 0.35)); g2.addColorStop(1, p.bodyDark);
    ctx.fillStyle = g2; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, disc * 0.55, 0, 6.3);
    ctx.strokeStyle = U.rgba(p.accent, 0.7); ctx.lineWidth = LWM(0.7, L * 0.009); ctx.stroke();
  };

  /* ── 软长形无脊椎：软体长身 + 前端触手环 + 腹面管足（海猪 / 管虫）────────────
     海参类（海猪）与环节类（管虫）的**共同剪影**就是它 —— 一条软体的长身，
     口端一圈短的触手/羽枝，腹面一排管足。
     ⚠️ 口端那圈**故意画短**：长的羽状鳃冠只对管虫成立，短的触手环对**两者都成立**
        （海参本来就有口触手），这样共用一个体型才不会偏袒其中一条。
     ⚠️ 不画眼：这 2 条在提示词里也是无眼（见 gen-art.py 的 `no_eye`）。 */
  TPL.worm = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.14, Math.min(0.26, (fish.body_ratio || 0.34) * 0.64));
    /* 腹面管足 */
    ctx.fillStyle = U.rgba(p.accentDark, 0.85);
    for (var i = 0; i < 7; i++) {
      var x = (0.34 - i * 0.13) * L;
      ctx.beginPath(); ctx.ellipse(x, h * 0.86, L * 0.026, L * 0.018, 0, 0, 6.3); ctx.fill();
    }
    /* 身体：前粗后细的软长形 */
    ctx.beginPath();
    ctx.moveTo(0.54 * L, -h * 0.42);
    ctx.bezierCurveTo(0.34 * L, -h * 1.22, -0.30 * L, -h * 1.00, -0.66 * L, -h * 0.26);
    ctx.quadraticCurveTo(-0.76 * L, 0, -0.66 * L, h * 0.28);
    ctx.bezierCurveTo(-0.30 * L, h * 1.12, 0.34 * L, h * 1.26, 0.54 * L, h * 0.44);
    ctx.quadraticCurveTo(0.62 * L, 0, 0.54 * L, -h * 0.42);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h * 1.2, 0, h * 1.2);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 体表横皱 */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.45); ctx.lineWidth = LWM(0.6, L * 0.008);
    for (var m = 0; m < 3; m++) {
      var sx = (-0.08 - m * 0.19) * L;
      ctx.beginPath(); ctx.moveTo(sx, -h * 0.82); ctx.lineTo(sx, h * 0.82); ctx.stroke();
    }
    /* 口端触手环（6 根短羽枝，随水流轻摆） */
    ctx.strokeStyle = U.rgba(p.accent, 0.92);
    ctx.lineCap = 'round';
    for (var k = 0; k < 6; k++) {
      var a = (k / 5 - 0.5) * 1.9;
      var wob = Math.sin(t * 2.0 + k * 0.9) * h * 0.14;
      ctx.lineWidth = LWM(0.9, L * (0.017 - Math.abs(a) * 0.004));
      ctx.beginPath();
      ctx.moveTo(0.52 * L, a * h * 0.30);
      ctx.quadraticCurveTo(0.72 * L, a * h * 0.62, 0.86 * L, a * h * 0.72 + wob);
      ctx.stroke();
    }
  };

  /* ── 蟹：**横宽**的甲壳 + 一对朝前的螯 + 下缘一排短步足 ──────────────────────
     与 `crustacean` 的分工：那个是**虾形**（纵长的分节腹 + 尾扇），这个是**蟹形**。
     共用一个剪影会把「虾 / 蟹」画成一个样 —— 而这一轮正好要把它俩分开用。 */
  TPL.crab = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.20, Math.min(0.34, (fish.body_ratio || 0.34) * 1.00));
    var rx = L * 0.44, ry = h * 0.92;
    /* 甲壳：**横宽椭圆**（宽 > 高，这是蟹与虾最大的区别）。
       ⚠️ 先画壳、**后画附肢** —— 反过来（第一版）腿和螯会被壳整块盖住，
          截图上看就是「一个带眼睛的蛋」。 */
    ctx.beginPath();
    ctx.ellipse(L * 0.02, 0, rx, ry, 0, 0, 6.3);
    var g = ctx.createLinearGradient(0, -ry, 0, ry);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 甲壳分区（蟹壳上那两道沟） */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.50); ctx.lineWidth = LWM(0.6, L * 0.007);
    ctx.beginPath();
    ctx.moveTo(L * 0.28, -ry * 0.82); ctx.quadraticCurveTo(L * 0.14, 0, L * 0.28, ry * 0.82);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-L * 0.40, -ry * 0.34); ctx.quadraticCurveTo(-L * 0.26, 0, -L * 0.40, ry * 0.34);
    ctx.stroke();
    /* 步足：每侧 4 条，从壳的下缘**伸出去** */
    ctx.strokeStyle = U.rgba(p.accentDark, 0.95);
    ctx.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      var x = (0.26 - i * 0.22) * L;
      var wob = Math.sin(t * 2.4 + i * 0.9) * h * 0.10;
      ctx.lineWidth = LWM(1.0, L * 0.013);
      ctx.beginPath();
      ctx.moveTo(x, ry * 0.55);
      ctx.quadraticCurveTo(x - L * 0.06, ry * 1.05, x - L * 0.22, ry * 1.30 + wob);
      ctx.stroke();
    }
    /* 一对螯：**在壳之外**（前面），一大一小 —— 蟹最好认的特征 */
    [[L * 0.78, -h * 0.44, 1.00], [L * 0.74, h * 0.40, 0.82]].forEach(function (c) {
      var cxp = c[0], cyp = c[1], sc = c[2];
      ctx.beginPath();
      ctx.moveTo(cxp - L * 0.26, cyp + h * 0.30 * sc);
      ctx.quadraticCurveTo(cxp + L * 0.20 * sc, cyp - h * 0.84 * sc,
                           cxp + L * 0.10 * sc, cyp - h * 0.16 * sc);
      ctx.quadraticCurveTo(cxp + L * 0.06 * sc, cyp + h * 0.30 * sc,
                           cxp - L * 0.26, cyp + h * 0.30 * sc);
      ctx.closePath();
      ctx.fillStyle = U.rgba(p.accent, 0.96); ctx.fill();
      ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    });
    /* 眼（蟹眼在壳的前缘，两只分开） */
    eye(ctx, L, h, L * 0.26, -ry * 0.52, Math.max(1.4, L * 0.032), p);
    eye(ctx, L, h, L * 0.28, ry * 0.38, Math.max(1.3, L * 0.028), p);
  };

  /* ── 螺 / 贝：螺旋壳 + 腹足（壳是**偏圆**的，不是长条）────────────────────
     ⚠️ 螺线**不能只画一条外螺线再填充**：`fill()` 会把首尾连成一块，
     形状会随螺旋圈数抖。这里改成「先画一个偏圆的壳 + 再补一条内螺线」——
     稳定，而且侧视读起来就是「卷起来的壳 + 一条缝」。 */
  TPL.shell = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var r = L * Math.max(0.34, Math.min(0.56, (fish.body_ratio || 0.34) * 1.5));
    var h = r * 0.52;
    var cx = -L * 0.04, cy = -r * 0.10;
    /* 腹足（壳下面的软足，前端一个小头） */
    ctx.beginPath();
    ctx.moveTo(L * 0.08, r * 0.46);
    ctx.quadraticCurveTo(L * 0.50, r * 0.92, L * 0.34, r * 1.12);
    ctx.quadraticCurveTo(L * 0.00, r * 1.26, -L * 0.34, r * 0.94);
    ctx.quadraticCurveTo(-L * 0.12, r * 0.44, L * 0.08, r * 0.46);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.belly, 0.96); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 壳（偏圆的螺旋体） */
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.96, 0, 0, 6.3);
    var g = ctx.createRadialGradient(cx - r * 0.30, cy - r * 0.34, r * 0.15, cx, cy, r * 1.10);
    g.addColorStop(0, U.lighten(p.body, 0.30));
    g.addColorStop(0.55, p.body);
    g.addColorStop(1, p.bodyDark);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.8, L * 0.009); ctx.stroke();
    /* 内螺线（由内到外，一圈半多一点） */
    var a0 = r * 0.10, turns = 2.2;
    var b0 = Math.log(r * 0.92 / a0) / (turns * Math.PI * 2);
    ctx.beginPath();
    for (var i = 0; i <= 72; i++) {
      var th = i / 72 * turns * Math.PI * 2;
      var rr = a0 * Math.exp(b0 * th);
      var x2 = cx + Math.cos(th - 1.1) * rr;
      var y2 = cy + Math.sin(th - 1.1) * rr * 0.92;
      if (i === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2);
    }
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.72);
    ctx.lineWidth = LWM(0.9, L * 0.010); ctx.lineCap = 'round'; ctx.stroke();
    /* 壳口（朝前那道加厚的唇） */
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.40, cy - r * 0.64);
    ctx.quadraticCurveTo(cx + r * 0.98, cy - r * 0.04, cx + r * 0.36, cy + r * 0.68);
    ctx.strokeStyle = U.rgba(p.accent, 0.95);
    ctx.lineWidth = LWM(1.6, L * 0.020); ctx.stroke();
    eye(ctx, L, h, L * 0.30, r * 0.72, Math.max(1.3, L * 0.028), p);
  };

  /* ── 龟：穹形背甲 + 四只桨状鳍足 + 短颈小头 ────────────────────────────────
     背甲是**穹顶 + 平底**（不是椭圆），甲片分格是它最好认的特征。 */
  TPL.turtle = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.22, Math.min(0.38, (fish.body_ratio || 0.34) * 1.10));
    /* 背甲：**穹顶 + 平底**（先画壳，鳍足与头颈随后压在外侧） */
    ctx.beginPath();
    ctx.moveTo(-L * 0.50, h * 0.30);
    ctx.quadraticCurveTo(-L * 0.48, -h * 0.98, L * 0.04, -h * 1.02);
    ctx.quadraticCurveTo(L * 0.54, -h * 0.96, L * 0.56, h * 0.26);
    ctx.quadraticCurveTo(L * 0.04, h * 0.50, -L * 0.50, h * 0.30);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.8, L * 0.009); ctx.stroke();
    /* 甲片分格 */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.55); ctx.lineWidth = LWM(0.6, L * 0.008);
    for (var k = 0; k < 4; k++) {
      var sx = (-0.28 + k * 0.22) * L;
      ctx.beginPath();
      ctx.moveTo(sx, -h * 0.92 + Math.abs(k - 1.4) * h * 0.12);
      ctx.lineTo(sx + L * 0.04, h * 0.38);
      ctx.stroke();
    }
    /* 四只鳍足：**压在壳的外侧**（前大后小、随水轻摆）——
       ⚠️ 第一版画在壳之前 ⇒ 整只被盖住，截图上看就是「一个圆顶 + 一个头」。 */
    [[0.34, -0.30, 1.00], [0.10, 0.34, 0.92], [-0.34, -0.26, 0.86], [-0.44, 0.30, 0.80]]
      .forEach(function (f, i) {
        var fx = f[0] * L, fy = f[1] * h, sc = f[2];
        var flap = Math.sin(t * 1.5 + i * 1.4) * h * 0.12;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(fx + L * 0.16, fy + (fy < 0 ? -h * 0.74 : h * 0.74) * sc,
                             fx + L * 0.26 * sc, fy + (fy < 0 ? h * 0.10 : -h * 0.10));
        ctx.quadraticCurveTo(fx - L * 0.02, fy + (fy < 0 ? h * 0.20 : -h * 0.20), fx, fy);
        ctx.closePath();
        ctx.fillStyle = U.rgba(p.accent, 0.94); ctx.fill();
        ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.006); ctx.stroke();
      });
    /* 头颈（右前，短） */
    ctx.beginPath();
    ctx.moveTo(L * 0.44, -h * 0.24);
    ctx.quadraticCurveTo(L * 0.74, -h * 0.52, L * 0.80, -h * 0.10);
    ctx.quadraticCurveTo(L * 0.78, h * 0.12, L * 0.50, h * 0.10);
    ctx.closePath();
    ctx.fillStyle = U.rgba(p.body, 0.98); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    eye(ctx, L, h, L * 0.68, -h * 0.18, Math.max(1.3, L * 0.030), p);
  };

  /* ── 海百合：分节长柄 + 顶上羽状腕冠（固着的「花」）────────────────────────
     与 `jelly` 的分工：水母是**伞盖 + 短触手**（漂着），海百合是**柄 + 羽冠**（站着）。
     与 `worm` 的分工：沙蚕是一整条软身，海百合有一根硬柄。 */
  TPL.crinoid = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.20, Math.min(0.34, (fish.body_ratio || 0.34) * 1.00));
    /* 柄：从右下往左上斜着升起来（固着端在右下） */
    var bx = L * 0.40, by = h * 1.10, tx = -L * 0.16, ty = -h * 0.34;
    ctx.beginPath();
    ctx.moveTo(bx - L * 0.07, by);
    ctx.quadraticCurveTo(L * 0.16, h * 0.36, tx - L * 0.045, ty);
    ctx.lineTo(tx + L * 0.045, ty);
    ctx.quadraticCurveTo(L * 0.30, h * 0.38, bx + L * 0.07, by);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, by, 0, ty);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.55, p.body); g.addColorStop(1, p.belly);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 柄上的环节（海百合的柄就是一圈圈骨板） */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.60); ctx.lineWidth = LWM(0.7, L * 0.009);
    for (var i = 1; i <= 6; i++) {
      var u = i / 7;
      var sx = bx + (tx - bx) * u, sy = by + (ty - by) * u;
      ctx.beginPath();
      ctx.moveTo(sx - L * 0.055, sy + h * 0.03);
      ctx.lineTo(sx + L * 0.055, sy - h * 0.02);
      ctx.stroke();
    }
    /* 固着端（根） */
    ctx.beginPath();
    ctx.ellipse(bx, by, L * 0.10, h * 0.12, 0, 0, 6.3);
    ctx.fillStyle = U.rgba(p.accentDark, 0.9); ctx.fill();
    /* 羽状腕冠：从顶端往两侧扇开的一排细腕（**画在柄之后**，露在外面） */
    ctx.lineCap = 'round';
    for (var k = 0; k < 11; k++) {
      var a = (-0.5 + k / 10) * 2.30 - Math.PI / 2;     /* 以顶端为心向上扇开 */
      var len = L * (0.34 - Math.abs(k - 5) * 0.016);
      var wob = Math.sin(t * 1.6 + k * 0.7) * h * 0.06;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.quadraticCurveTo(tx + Math.cos(a) * len * 0.55 - L * 0.03,
                           ty + Math.sin(a) * len * 0.55,
                           tx + Math.cos(a) * len, ty + Math.sin(a) * len + wob);
      ctx.strokeStyle = U.rgba(k % 2 ? p.accent : p.bodyLight, 0.92);
      ctx.lineWidth = LWM(1.0, L * (0.013 - Math.abs(k - 5) * 0.0008));
      ctx.stroke();
    }
  };

  /* ── 管水母：顶端一个浮囊 + 下面一长串泳钟与垂丝（竖着挂）──────────────────
     ⚠️ 与水母最大的区别是**形状是「一串」而不是「一个」** ——
     所以这里刻意把浮囊画小、把链条拉长（占满整个高度）。 */
  TPL.siphonophore = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.30, Math.min(0.46, (fish.body_ratio || 0.34) * 1.5));
    var fx = L * 0.10, fy = -h * 1.16;                   /* 浮囊位置 */
    /* 链条（竖轴）+ 泳钟：从上往下一串 */
    for (var i = 0; i < 9; i++) {
      var u = i / 8;
      var cy = fy + h * 1.05 + u * h * 1.95 + Math.sin(t * 1.4 + i * 0.6) * h * 0.035;
      var w = L * (0.15 - u * 0.055);
      ctx.beginPath();
      ctx.ellipse(fx + Math.sin(i * 0.9) * L * 0.03, cy, w, h * 0.075, 0, 0, 6.3);
      var gg = ctx.createLinearGradient(0, cy - h * 0.08, 0, cy + h * 0.08);
      gg.addColorStop(0, U.lighten(p.body, 0.26)); gg.addColorStop(1, p.bodyDark);
      ctx.fillStyle = gg; ctx.fill();
      ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.5, L * 0.006); ctx.stroke();
    }
    /* 浮囊（画在之后，压在最上面） */
    ctx.beginPath();
    ctx.ellipse(fx, fy, L * 0.17, h * 0.20, 0, 0, 6.3);
    var g = ctx.createLinearGradient(fx - L * 0.17, fy - h * 0.20, fx + L * 0.17, fy + h * 0.20);
    g.addColorStop(0, U.lighten(p.accent, 0.30)); g.addColorStop(1, p.accentDark);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    /* 垂丝：几条细长线随水摆 */
    ctx.lineCap = 'round';
    for (var k = 0; k < 5; k++) {
      var sx = fx + (k - 2) * L * 0.045;
      var sy = fy + h * 0.14;
      var wob = Math.sin(t * 1.9 + k * 1.1) * L * 0.05;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx - L * 0.04, sy + h * 1.4, sx + wob, sy + h * 2.5);
      ctx.strokeStyle = U.rgba(p.bodyLight, 0.75);
      ctx.lineWidth = LWM(0.6, L * 0.007);
      ctx.stroke();
    }
  };

  /* ── 海葵：矮柱身 + 顶上一圈粗触手冠（**坐在底上**，不漂）──────────────────
     与水母的分工：水母是「伞盖 + 细长触手」，海葵是「柱 + 一圈粗触手冠」，
     而且底端是**平贴底面的基盘**（一眼看出它是固着的）。 */
  TPL.anemone = function (ctx, fish, L, opt, p, rand) {
    var t = (opt.t || 0);
    var h = L * Math.max(0.26, Math.min(0.42, (fish.body_ratio || 0.34) * 1.3));
    var base = h * 1.10;
    /* 柱身（下宽上略窄） */
    ctx.beginPath();
    ctx.moveTo(-L * 0.26, base);
    ctx.quadraticCurveTo(-L * 0.22, -h * 0.30, -L * 0.15, -h * 0.62);
    ctx.lineTo(L * 0.15, -h * 0.62);
    ctx.quadraticCurveTo(L * 0.22, -h * 0.30, L * 0.26, base);
    ctx.closePath();
    var g = ctx.createLinearGradient(-L * 0.26, 0, L * 0.26, 0);
    g.addColorStop(0, p.bodyDark); g.addColorStop(0.45, p.body); g.addColorStop(1, p.bodyLight);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.7, L * 0.008); ctx.stroke();
    /* 基盘（贴底那一圈） */
    ctx.beginPath();
    ctx.ellipse(0, base, L * 0.32, h * 0.09, 0, 0, 6.3);
    ctx.fillStyle = U.rgba(p.accentDark, 0.92); ctx.fill();
    ctx.strokeStyle = p.line; ctx.lineWidth = LWM(0.6, L * 0.007); ctx.stroke();
    /* 柱身纵纹 */
    ctx.strokeStyle = U.rgba(p.bodyDark, 0.42); ctx.lineWidth = LWM(0.6, L * 0.008);
    [-0.14, 0, 0.14].forEach(function (u) {
      ctx.beginPath();
      ctx.moveTo(u * L, -h * 0.56);
      ctx.quadraticCurveTo(u * L * 1.25, h * 0.20, u * L * 1.45, base - h * 0.12);
      ctx.stroke();
    });
    /* 触手冠：一圈**粗**触手向上扇形张开（画在柱身之后） */
    ctx.lineCap = 'round';
    for (var k = 0; k < 13; k++) {
      var a = (-0.5 + k / 12) * 2.55 - Math.PI / 2;
      var len = L * (0.40 - Math.abs(k - 6) * 0.014);
      var wob = Math.sin(t * 2.0 + k * 0.8) * h * 0.07;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.58);
      ctx.quadraticCurveTo(Math.cos(a) * len * 0.5, -h * 0.58 + Math.sin(a) * len * 0.55,
                           Math.cos(a) * len * 0.95, -h * 0.58 + Math.sin(a) * len + wob);
      ctx.strokeStyle = U.rgba(k % 2 ? p.accent : p.bodyLight, 0.94);
      ctx.lineWidth = LWM(2.0, L * (0.024 - Math.abs(k - 6) * 0.0012));
      ctx.stroke();
    }
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

  /* 画在指定 canvas 上（自适应尺寸）—— 已删：图鉴 / 结算卡实际都自己建 ctx
     再调 draw()（它们各自的背景不一样），这个函数全项目零调用。 */

  /* ⚠️ `paintTo()` / `palette()` / `getStyle()` / `listStyles()` 已删（顺手清死接口那一轮）：
     · `paintTo(canvas, fish, opt)` docs/开发者文档.md §5.2「fishart.js 绘制器」说它「用于图鉴 / 结算卡」，
       但两处实际都自己建 ctx 再调 `draw()`（图鉴要画水波背景、结算卡要画渐变），
       `paintTo` 全项目零调用 —— 是「文档里有、代码里没人调」的死接口。
     · `palette()` 只在 `draw()` 内部用（`var p = palette(fish, opt)`），
       不该出现在导出面上。
     · `getStyle()` / `listStyles()` 零调用（出图工具走的是 `STYLES[key]` 与 `setStyle`）。
     verify 第 ㉜ 节会扫全部模块的导出面，防止这类接口再长出来。 */

  return { draw: draw, drawSilhouette: drawSilhouette,
           setStyle: setStyle, STYLES: STYLES };
})();
