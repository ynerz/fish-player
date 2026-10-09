/* =========================================================
   scene.js  —  Canvas 2D 横版水边场景
   =========================================================
   层次：天空 → 天体 → 云 → 远山 → 水面 → 水下 → 码头 → 钓手
        → 鱼竿 → 鱼线 → 浮漂 → 粒子 → 环境特效 → 暗角
   ========================================================= */
window.G = window.G || {};

G.Scene = (function () {
  var U = G.U;

  var cv = null, ctx = null;
  var W = 0, H = 0, dpr = 1;
  var time = 0;
  var field = G.FIELDS[0];

  /* 状态 */
  var S = {
    floatState: 'none',   // none | flying | wait | bite | fight
    floatT: 0,
    biteDip: 0,
    nudge: 0,             // 0~1，咬钩前的「浮漂异动」强度，指数衰减
    rodBend: 0,
    lineOut: 0,           // 0~1 线放出的程度（抛竿动画）
    fishShadow: null,     // {fish, kg, x, y, vx, vy, alpha, t}
    particles: [],
    stars: [],
    clouds: [],
    decor: {},
    neighbor: null,   // 隔壁钓鱼佬（N7）：{ x, skin, shirt, shirtD, pants, hat } 或 null
    rocks: [],         // 浅滩石头 [{x, y, rx, ry, sub, wy, body, top}]
    rain: [],          // 雨丝 [{x, y, len, v, a}]
    wxKey: null,       // 上一帧的天气 key，用来在变天时重建雨丝
    fogPhase: 0,
  };

  /* ---------------- 初始化 ---------------- */
  function init(canvas) {
    clearGradCache();
    cv = canvas;
    ctx = cv.getContext('2d');
    /* 尺寸变化走适配层（小程序端是 wx.onWindowResize），别直接监听 window */
    G.Platform.sys.onResize(resize);
    resize();
  }

  function resize() {
    clearGradCache();
    if (!cv) return;
    var r = cv.parentElement.getBoundingClientRect();
    dpr = G.Platform.sys.dpr();
    W = Math.max(320, r.width);
    H = Math.max(240, r.height);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildStatic();
  }

  function buildStatic() {
    S.wxKey = null;
    S.stars = [];
    var n = field.theme.stars ? 110 : 0;
    for (var i = 0; i < n; i++) {
      S.stars.push({
        x: Math.random() * W,
        y: Math.random() * horizonY() * 0.95,
        r: 0.5 + Math.random() * 1.5,
        ph: Math.random() * 6.28,
        sp: 0.6 + Math.random() * 1.8,
      });
    }
    S.clouds = [];
    var cn = field.theme.clouds ? field.theme.clouds.n : 0;
    for (var c = 0; c < cn; c++) {
      S.clouds.push({
        x: Math.random() * W,
        y: horizonY() * (0.10 + Math.random() * 0.52),
        s: 0.55 + Math.random() * 0.95,
        sp: field.theme.clouds.speed * (0.6 + Math.random() * 0.8),
      });
    }
    /* 浅滩石头（theme.rocks）：轮廓与位置在这里一次算好，绘制时不再掷随机数 */
    S.rocks = [];
    if (field.theme.rocks) {
      var sy = surfaceY();
      for (var r = 0; r < ROCK_SPECS.length; r++) S.rocks.push(makeRock(ROCK_SPECS[r], sy));
    }
  }

  /* ---------------- 渐变缓存 ----------------
     场景里的渐变只跟「画布尺寸 / 钓场主题」有关，跟时间无关，
     但原来是每帧重建 —— 60fps 下每秒新建几百个 CanvasGradient 对象，
     低端机 GC 压力明显。这里缓存起来，在 resize / setField 时失效。
     ⚠️ 新增渐变一律走 grad()，不要直接调 ctx.createXxxGradient：
        少数「颜色随时间呼吸」的（如灯笼光晕）改成预渲染离线图 +
        globalAlpha，也不要每帧重建渐变。
        tools/verify.js 第 ⑰ 节会扫源码断言这件事。 */
  var gradCache = {};
  function grad(key, make) {
    var g = gradCache[key];
    if (!g) g = gradCache[key] = make();
    return g;
  }
  function clearGradCache() { gradCache = {}; glowSprite = null; beamSprite = null; beamKey = ''; }

  /* 极光带：4 条渐变只跟画布高度有关（i 决定位置与色相），同样缓存。
     ⚠️ 单独抽成具名函数，让 i 走参数而不是循环变量 —— 闭包捕获 var 循环变量
        在「缓存未命中时才求值」的写法下很危险。 */
  function auroraGrad(i) {
    return grad('aurora' + i, function () {
      var yy = horizonY() * (0.20 + i * 0.14);
      var gg = ctx.createLinearGradient(0, yy - 60, 0, yy + 70);
      var hue = ['rgba(120,255,210,', 'rgba(160,180,255,', 'rgba(220,150,255,', 'rgba(140,255,235,'][i];
      gg.addColorStop(0, hue + '0)');
      gg.addColorStop(0.5, hue + (0.16 - i * 0.025) + ')');
      gg.addColorStop(1, hue + '0)');
      return gg;
    });
  }

  /* 灯笼光晕：预渲染一张离屏小图，再用 globalAlpha 做呼吸。
     原来是每帧 9 个 createRadialGradient + 9 个 arc（纯白烧 GC）。 */
  var glowSprite = null;
  function lanternGlow(r) {
    if (glowSprite) return glowSprite;
    var d = Math.max(4, Math.round(r * 2 * dpr));
    var c = G.Platform.canvas.create(d, d);
    var c2 = c.getContext('2d');
    var cx = d / 2;
    var g = c2.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0, 'rgba(255,215,140,1)');
    g.addColorStop(1, 'rgba(255,215,140,0)');
    c2.fillStyle = g;
    c2.beginPath(); c2.arc(cx, cx, cx, 0, 6.3); c2.fill();
    glowSprite = c;
    return c;
  }

  /* 水下光束：**预渲染**成一张离屏图，每帧只 drawImage。
     原来是每帧 4 次带 `ctx.filter = 'blur(Npx)'` 的斜条填充 —— Canvas2D 的 filter
     会强制开一层离屏再跑高斯卷积，是整帧里最贵的一笔；而这道光束只跟
     「画布尺寸 + 太阳位置」有关，跟时间无关（太阳位置随时段走 ⇒ 缓存键带上它）。
     做法与 `lanternGlow()` 完全一致，resize / setField 由 `clearGradCache()` 一起清掉。
     ⚠️ 只截地平线往下的那一段（上方没有光束内容），省一半显存；但往上留
        `BEAM_PAD` 的余量 —— 不留的话模糊的光晕会在截断面被切出一道硬边。 */
  var BEAM_PAD = 40;
  var beamSprite = null, beamKey = '';
  function sunBeamTop() { return Math.max(0, horizonY() - BEAM_PAD); }
  function sunBeam(th) {
    var hy = horizonY(), y0 = sunBeamTop();
    var key = y0 + '_' + W + 'x' + H + '_' + Math.round(th.sun.x * W) + '_' + dpr;
    if (beamSprite && beamKey === key) return beamSprite;
    var c = G.Platform.canvas.create(Math.round(W * dpr), Math.round((H - y0) * dpr));
    var c2 = c.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.filter = 'blur(' + Math.round(Math.max(10, W * 0.014)) + 'px)';
    c2.fillStyle = '#ffffff';
    for (var i = 0; i < 4; i++) {
      var bx = (th.sun.x * W) + (i - 1.5) * 62;
      c2.beginPath();
      c2.moveTo(bx - 18, hy - y0);
      c2.lineTo(bx + 18, hy - y0);
      c2.lineTo(bx + 118 + i * 34, H - y0);
      c2.lineTo(bx + 22 + i * 34, H - y0);
      c2.closePath();
      c2.fill();
    }
    c2.filter = 'none';
    beamSprite = c; beamKey = key;
    return c;
  }

  function horizonY() { return H * 0.46; }
  function surfaceY() { return horizonY() + Math.min(70, H * 0.10); }
  function dockY() { return horizonY() + Math.min(78, H * 0.115); }
  function fisherX() { return W * 0.17; }
  function rodTipX() { return W * 0.255; }
  function rodTipY() { return horizonY() - H * 0.06; }
  function floatHomeX() { return W * 0.56; }

  /* ---------------- 对外动作 ---------------- */
  function setField(f) {
    clearGradCache();
    field = f;
    buildStatic();
    S.particles.length = 0;
    S.fishShadow = null;
    S.floatState = 'none';
    S.lineOut = 0;
  }
  function setDecor(list) {
    S.decor = {};
    (list || []).forEach(function (id) { S.decor[id] = true; });
  }
  /* 隔壁钓鱼佬（N7）。传 null 就不画人 —— 内容表为空 / 以后换「钓场里有没有人」
     都走这一条口，不要在别处偷偷往 S.decor 里塞标记。 */
  function setNeighbor(n) { S.neighbor = n || null; }

  function cast() {
    S.floatState = 'flying';
    S.floatT = 0;
    S.nudge = 0;
    S.lineOut = 0;
    S.fishShadow = null;
    G.Audio.cast();
  }

  /* 咬钩前的浮漂异动 —— 让「提前收杆」这件事有可观察的信号。
     只是很轻微的连续抖动 + 一圈细小涟漪，不暴露鱼的稀有度。 */
  function floatNudge() { S.nudge = 1; }
  function beginWait() {
    S.floatState = 'wait';
    S.floatT = 0;
    splash(1);
    G.Audio.splash();
  }
  function bite() { S.floatState = 'bite'; S.biteDip = 1; }
  /* 进入拉扯：只切状态。原先这里还把 `fish` / `fish.rar` 存进 `S.fightFish` /
     `S.fightRarity`，但**全项目没有一处读它们**（2026-10-08 全项目扫描发现）——
     水下鱼影走的是 `showShadow(fish, kg)`，稀有度由 `sparkle(n, rar)` 现传，
     两个字段纯属只写不读，已删。beginFight 因此不再需要参数。 */
  function beginFight() { S.floatState = 'fight'; }
  /* 收杆 / 上岸 / 失败 / 换场：把这一竿的水下鱼影一起收掉。
     鱼影是「等待期」的表现，回合结束了就不该还在水里游。 */
  function endFight() {
    S.fishShadow = null;
    S.floatState = 'none';
    S.lineOut = 0;
  }

  function splash(power) {
    power = power || 1;
    var fx = floatX(), fy = surfaceY();
    for (var i = 0; i < 16 * power; i++) {
      S.particles.push({
        kind: 'drop',
        x: fx + U.range(-6, 6), y: fy,
        vx: U.range(-70, 70) * power, vy: U.range(-190, -60) * power,
        r: U.range(1.2, 3.4), life: 0, max: U.range(0.45, 0.95),
        c: 'rgba(255,255,255,.92)',
      });
    }
    for (var k = 0; k < 35 * power; k++) {
      S.particles.push({
        kind: 'ripple',
        x: fx + U.range(-10, 10), y: fy + U.range(-2, 4),
        r: U.range(2, 8), grow: U.range(26, 60),
        life: 0, max: U.range(0.7, 1.5),
        c: 'rgba(255,255,255,.55)',
      });
    }
  }

  function sparkle(n, rar) {
    var fx = floatX(), fy = surfaceY();
    var cols = ['#ffe9a8', '#ffffff', '#bfe9ff', G.CONFIG.rarity[rar || 0].color2];
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = U.range(40, 180);
      S.particles.push({
        kind: 'spark',
        x: fx, y: fy - 6,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 60,
        r: U.range(1.5, 3.6), life: 0, max: U.range(0.6, 1.5),
        c: cols[Math.floor(Math.random() * cols.length)],
      });
    }
  }

  /* 水下鱼影 —— 「有东西在水下游过来」。
     ⚠️ 本函数原来全项目零调用：`S.fishShadow` 永远是 null，
        于是 updateShadow() 与 drawUnderwater() 里那两段鱼影代码**从来没跑过**，
        而 docs/开发者文档.md §5.1「scene.js 分层」却把它列成「供 fishing.js 调用」的接口。
        现在由 fishing.js 在「抛竿动画结束 → 进入等待」时调一次
        （见 fishing.js 的 case 'flying'），收杆 / 上岸 / 失败时
        统一由 endFight() 清掉 —— 所以这里只说「显示」，不管生命周期。
     只按体重给大小，不暴露稀有度；鱼种是真实的，但玩家在等待期
     本来就只能看个影子，与「等得久 = 大鱼」这条既有信息口径一致。 */
  function showShadow(fish, kg) {
    if (!fish) { S.fishShadow = null; return; }
    S.fishShadow = {
      fish: fish, kg: kg || 1,
      x: -W * 0.15,
      y: surfaceY() + Math.min(150, H * 0.20) + Math.random() * 40,
      vx: U.range(60, 130),
      vy: U.range(-18, 18),
      t: 0,
      alpha: 0,
    };
  }

  function floatX() {
    if (S.floatState === 'flying') {
      return U.lerp(W * 0.30, floatHomeX(), U.easeOut(S.floatT / G.CONFIG.misc.flyTime));
    }
    /* 异动时浮漂轻微横向游移，看起来像有东西在水下试探 */
    if (S.nudge > 0) return floatHomeX() + Math.sin(time * 7.5) * S.nudge * 3.4;
    return floatHomeX();
  }

  /* =========================================================
     天气与时段
     =========================================================
     只做「叠一层表现」，不改各个钓场自己的主题配色 ——
     否则 D 场的晴天草原和 SSS 场的极光夜会被冲掉。
     ========================================================= */
  function ensureRain() {
    var n = Math.round(W / 9);
    S.rain.length = 0;
    for (var i = 0; i < n; i++) {
      S.rain.push({
        x: Math.random() * (W + 80) - 40,
        y: Math.random() * H,
        len: 9 + Math.random() * 16,
        v: 620 + Math.random() * 420,
        a: 0.18 + Math.random() * 0.32,
      });
    }
  }

  function updateWeatherFx(dt) {
    if (!G.Weather || !G.Weather.isReady()) return;
    var sn = G.Weather.snapshot();
    if (sn.wx.key !== S.wxKey) { S.wxKey = sn.wx.key; ensureRain(); }
    S.fogPhase = (S.fogPhase || 0) + dt * 0.35;
    if (sn.wx.key === 'rain') {
      for (var i = 0; i < S.rain.length; i++) {
        var r = S.rain[i];
        r.y += r.v * dt;
        r.x += r.v * dt * 0.16;      // 斜着下
        if (r.y > H) { r.y = -20; r.x = Math.random() * (W + 80) - 40; }
        if (r.x > W + 40) r.x = -40;
      }
    }
  }

  function drawWeatherFx() {
    if (!G.Weather || !G.Weather.isReady()) return;
    var sn = G.Weather.snapshot();

    /* --- 时段色调 --- */
    if (sn.tm.tint) {
      ctx.save();
      ctx.fillStyle = sn.tm.tint;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    /* --- 天气色调 --- */
    if (sn.wx.skyTint) {
      ctx.save();
      ctx.fillStyle = sn.wx.skyTint;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* --- 雨丝 --- */
    if (sn.wx.key === 'rain') {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(200,226,255,1)';
      for (var i = 0; i < S.rain.length; i++) {
        var r = S.rain[i];
        ctx.globalAlpha = r.a;
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x - r.len * 0.16, r.y + r.len);
        ctx.stroke();
      }
      ctx.restore();
      /* 水面被雨点打出的细碎涟漪 */
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.32)';
      ctx.lineWidth = 1;
      var hy = surfaceY();
      for (var k = 0; k < 14; k++) {
        var px = ((time * 90 + k * 137) % (W + 60)) - 30;
        var pr = 2 + ((time * 40 + k * 53) % 12);
        ctx.globalAlpha = Math.max(0, 1 - pr / 14) * 0.7;
        ctx.beginPath();
        ctx.ellipse(px, hy + (k % 5) * 26, pr, pr * 0.3, 0, 0, 6.3);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* --- 雾：贴着水面的柔白带 --- */
    if (sn.wx.key === 'fog') {
      var hy2 = horizonY();
      var g2 = grad('fogband', function () {
        var q = ctx.createLinearGradient(0, hy2 - H * 0.16, 0, hy2 + H * 0.34);
        q.addColorStop(0, 'rgba(226,236,244,0)');
        q.addColorStop(0.45, 'rgba(226,236,244,.62)');
        q.addColorStop(1, 'rgba(226,236,244,0)');
        return q;
      });
      ctx.save();
      ctx.globalAlpha = 0.75 + Math.sin(S.fogPhase) * 0.12;
      ctx.fillStyle = g2;
      ctx.fillRect(0, hy2 - H * 0.16, W, H * 0.5);
      ctx.restore();
    }
  }

  /* ---------------- 主渲染 ---------------- */
  function render(dt) {
    if (!ctx) return;
    dt = Math.min(dt, 0.05);
    time += dt;

    updateParticles(dt);
    updateClouds(dt);
    updateShadow(dt);
    updateWeatherFx(dt);

    /* 抛竿动画推进 */
    if (S.floatState === 'flying') {
      S.floatT += dt;
      if (S.floatT > G.CONFIG.misc.flyTime) { S.floatT = G.CONFIG.misc.flyTime; }
    }
    if (S.biteDip > 0) S.biteDip = Math.max(0, S.biteDip - dt * 1.6);
    if (S.nudge > 0) S.nudge = Math.max(0, S.nudge - dt * 0.42);

    var th = field.theme;

    drawSky(th);
    drawAmbientBack(th);
    drawCelestial(th);
    drawStars();
    drawClouds(th);
    drawHills(th);
    drawWater(th);
    drawUnderwater(th);
    drawRocks(th);
    drawDock(th);
    drawNeighbor(th);      // 隔壁钓鱼佬（N7）：先画他，玩家照旧画在最上层
    drawFisher(th);
    drawRod(th);
    drawLine(th);
    drawFloat(th);
    drawParticles();
    drawAmbientFront(th);
    drawWeatherFx();
    drawVignette(th);
  }

  /* ---------------- 天空 ---------------- */
  function drawSky(th) {
    var g = grad('sky', function () {
      var gg = ctx.createLinearGradient(0, 0, 0, horizonY() + 4);
      gg.addColorStop(0, th.sky[0]);
      gg.addColorStop(1, th.sky[1]);
      return gg;
    });
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizonY() + 4);
  }

  function drawCelestial(th) {
    if (th.sun) {
      var sx = th.sun.x * W, sy = th.sun.y * horizonY();
      var gg = grad('sunglow', function () {
        var q = ctx.createRadialGradient(sx, sy, 1, sx, sy, th.sun.r * 6);
        q.addColorStop(0, th.sun.glow);
        q.addColorStop(1, 'rgba(255,255,255,0)');
        return q;
      });
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(sx, sy, th.sun.r * 6, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(sx, sy, th.sun.r, 0, 6.3);
      ctx.fillStyle = th.sun.color; ctx.fill();
    }
    if (th.moon) {
      var mx = W * 0.76, my = horizonY() * 0.22;
      var mr = th.moonSize || 34;
      var mg = grad('moonglow', function () {
        var q = ctx.createRadialGradient(mx, my, 1, mx, my, mr * 5);
        q.addColorStop(0, 'rgba(220,235,255,.35)');
        q.addColorStop(1, 'rgba(220,235,255,0)');
        return q;
      });
      ctx.fillStyle = mg;
      ctx.beginPath(); ctx.arc(mx, my, mr * 5, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(mx, my, mr, 0, 6.3);
      ctx.fillStyle = '#eef4ff'; ctx.fill();
      // 环形山
      ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#8fa2c4';
      [[-0.3, -0.2, 0.22], [0.25, 0.1, 0.16], [-0.05, 0.35, 0.13]].forEach(function (c) {
        ctx.beginPath(); ctx.arc(mx + c[0] * mr, my + c[1] * mr, c[2] * mr, 0, 6.3); ctx.fill();
      });
      ctx.restore();
    }
  }

  function drawStars() {
    if (!S.stars.length) return;
    S.stars.forEach(function (s) {
      var tw = 0.45 + 0.55 * Math.abs(Math.sin(time * s.sp + s.ph));
      ctx.globalAlpha = tw * 0.9;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.3); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function updateClouds(dt) {
    S.clouds.forEach(function (c) {
      c.x += c.sp * dt;
      if (c.x > W + 160) c.x = -160;
    });
  }

  function drawClouds(th) {
    if (!th.clouds) return;
    ctx.save();
    ctx.globalAlpha = th.clouds.alpha;
    ctx.fillStyle = th.clouds.color;
    S.clouds.forEach(function (c) {
      var s = c.s, y = c.y;
      ctx.beginPath();
      ctx.ellipse(c.x, y, 52 * s, 17 * s, 0, 0, 6.3);
      ctx.ellipse(c.x + 34 * s, y + 5 * s, 38 * s, 13 * s, 0, 0, 6.3);
      ctx.ellipse(c.x - 38 * s, y + 6 * s, 34 * s, 11 * s, 0, 0, 6.3);
      ctx.ellipse(c.x + 8 * s, y - 12 * s, 30 * s, 14 * s, 0, 0, 6.3);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawHills(th) {
    var hy = horizonY();
    th.hills.forEach(function (h, i) {
      ctx.save();
      ctx.globalAlpha = h.alpha;
      ctx.fillStyle = h.color;
      ctx.beginPath();
      ctx.moveTo(-20, hy + 2);
      var segs = 9, amp = hy * h.height * (1 - i * 0.12);
      for (var s = 0; s <= segs; s++) {
        var x = -20 + (W + 40) * (s / segs);
        var y = hy - amp * (0.55 + 0.45 * Math.sin(s * 1.7 + i * 2.1))
                     - amp * 0.28 * Math.sin(s * 0.8 + i);
        if (s === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 20, hy + 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  /* ---------------- 水面 ---------------- */
  function drawWater(th) {
    var hy = horizonY();
    var g = grad('water', function () {
      var q = ctx.createLinearGradient(0, hy, 0, H);
      q.addColorStop(0, th.water[0]);
      q.addColorStop(0.42, th.water[1]);
      q.addColorStop(1, th.deep[1]);
      return q;
    });
    ctx.fillStyle = g;
    ctx.fillRect(0, hy, W, H - hy);

    // 波光条带
    var wv = th.waves || 1;
    ctx.save();
    for (var b = 0; b < 14; b++) {
      var t = b / 13;
      var y0 = hy + Math.pow(t, 1.9) * (H - hy);
      var amp = 1.2 + t * 9 * wv;
      var alpha = (0.05 + t * 0.13) * (th.gloom ? 0.6 : 1);
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.lineWidth = 0.8 + t * 1.8;
      ctx.beginPath();
      for (var x = -10; x <= W + 10; x += 12) {
        var yy = y0 + Math.sin((x * 0.012) + time * (0.8 + t * 1.4) + b) * amp;
        if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 深夜海面的幽光
    if (th.shimmer) {
      ctx.save();
      ctx.globalAlpha = 0.16 + 0.08 * Math.sin(time * 0.7);
      var sg = grad('shimmer', function () {
        var q = ctx.createLinearGradient(0, hy, 0, hy + (H - hy) * 0.6);
        q.addColorStop(0, 'rgba(140,200,255,.55)');
        q.addColorStop(1, 'rgba(140,200,255,0)');
        return q;
      });
      ctx.fillStyle = sg;
      ctx.fillRect(0, hy, W, (H - hy) * 0.6);
      ctx.restore();
    }

    // 水面高光点
    ctx.save();
    for (var i = 0; i < 34; i++) {
      var px = (i * 137.5) % W;
      var py = hy + ((i * 53.7) % (H - hy)) * 0.92;
      var tw = 0.5 + 0.5 * Math.sin(time * 2.2 + i);
      if (tw < 0.42) continue;
      ctx.globalAlpha = (th.gloom ? 0.11 : 0.26) * tw;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px, py, 3 + (i % 4), 1.2);
    }
    ctx.restore();
  }

  function drawUnderwater(th) {
    var hy = horizonY();
    // 水下光束（模糊处理，避免出现硬边斜条）
    if (th.sun) {
      var y0 = sunBeamTop();
      ctx.save();
      ctx.globalAlpha = 0.055;
      ctx.drawImage(sunBeam(th), 0, y0, W, H - y0);
      ctx.restore();
    }
    // 鱼影
    if (S.fishShadow) {
      var fs = S.fishShadow;
      ctx.save();
      ctx.globalAlpha = fs.alpha * 0.85;
      var L = Math.min(W * 0.30, 60 + Math.log(1 + fs.kg) * 26);
      // 水中的暗影
      ctx.save();
      ctx.globalAlpha = fs.alpha * 0.32;
      ctx.filter = 'none';
      ctx.translate(fs.x, fs.y);
      ctx.scale(1, 0.86);
      G.FishArt.draw(ctx, Object.assign({}, fs.fish, { glow: false }), 0, 0, L, { t: fs.t });
      ctx.globalAlpha = 1;
      ctx.restore();
      // 彩虹色档的鱼本体（半透明）
      ctx.globalAlpha = fs.alpha * 0.55;
      ctx.filter = 'brightness(0.75) saturate(0.9)';
      G.FishArt.draw(ctx, fs.fish, fs.x, fs.y, L, { t: fs.t });
      ctx.filter = 'none';
      ctx.restore();
    }
  }

  /* ---------------- 浅滩石头（theme.rocks） ----------------
     C 场「溪流浅滩」的主题里一直写着 `rocks: true`，但**自 v0.1.0 起没有任何绘制路径读它**
     （2026-10-08 被 verify 32-g 的「数据文件死字段」网抓出来，用户拍板走「补绘制」而不是删字段）。
     画法与其他场景道具同一套：纯色 + 简单多边形，**不建渐变**（verify ⑰ 会盯）。
     位置**手工摆放**，刻意避开两处玩法信息：码头（左侧 40%）与浮漂落点（floatHomeX ≈ 56%）。
     顶点抖动写死在 specs 里而不是用随机数 → 换分辨率 / resize 时石头不会跳动。 */
  var ROCK_SPECS = [
    /* 露出水面的卵石：x = 画布宽度占比，rx/ry = 半宽 / 半高，
       rise = 顶端露出水面多少（px），wob = 6 个顶点的半径抖动。
       ry 给到 rx 的六成左右才像鹅卵石 —— 太扁会看成一排小筏子。 */
    { x: 0.655, rx: 30, ry: 19, rise: 14, wob: [ 0.08, -0.14,  0.14, -0.06,  0.18, -0.10] },
    { x: 0.742, rx: 18, ry: 12, rise:  8, wob: [-0.12,  0.10, -0.08,  0.14, -0.06,  0.08] },
    { x: 0.850, rx: 42, ry: 27, rise: 18, wob: [ 0.12, -0.08,  0.06, -0.16,  0.04, -0.12] },
    { x: 0.945, rx: 24, ry: 15, rise: 10, wob: [-0.06,  0.14, -0.10,  0.08, -0.12,  0.10] },
    /* 近处水下的碎石：depth = 从水线往画面下方的进度（越大离镜头越近、越大）
       —— 隔着水看，颜色偏水色、整体淡一档 */
    { x: 0.315, rx: 26, ry: 13, sub: true, depth: 0.46, wob: [ 0.10, -0.08,  0.14, -0.12,  0.06, -0.10] },
    { x: 0.500, rx: 34, ry: 16, sub: true, depth: 0.58, wob: [-0.12,  0.06, -0.08,  0.14, -0.10,  0.10] },
    { x: 0.705, rx: 42, ry: 19, sub: true, depth: 0.74, wob: [ 0.08, -0.12,  0.06, -0.08,  0.12, -0.06] },
  ];

  function makeRock(spec, sy) {
    var k = Math.min(1, Math.max(0.6, W / 1180));   // 窄窗口里按比例缩一档（与鱼长度同一套思路）
    var rx = spec.rx * k, ry = spec.ry * k;
    var x = W * spec.x;
    var y = spec.sub ? (sy + (H - sy) * spec.depth) : (sy + ry - spec.rise * k);
    /* 6 个顶点（从正上方顺时针）+ 只属于上半身的受光面 */
    var pts = [];
    [-90, -30, 30, 90, 150, -150].forEach(function (deg) {
      var a = deg * Math.PI / 180, i = pts.length, w = 1 + spec.wob[i % 6];
      pts.push([x + Math.cos(a) * rx * w, y + Math.sin(a) * ry * w]);
    });
    function mid(i, j) { return [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2]; }
    return {
      x: x, y: y, rx: rx, ry: ry, sub: !!spec.sub, wy: sy,
      body: pts,
      /* 三段面：受光的顶面（左上）· 中间调石身 · 背光的底面（右下）
         —— 只有两段的话石头看着像一块平板（第一版就是，实测截图后补的） */
      top: [mid(5, 3), pts[5], pts[0], pts[1], mid(1, 2)],
      bot: [mid(1, 2), pts[2], pts[3], pts[4], mid(4, 5)],
    };
  }

  function poly(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  function drawRocks(th) {
    if (!S.rocks.length) return;
    var lit = th.gloom ? 0.62 : 1;      // 暗场里压暗一档（与码头台面同一套处理）
    ctx.save();
    for (var i = 0; i < S.rocks.length; i++) {
      var r = S.rocks[i];

      /* 水下的暗影：把石头「压」进水里 */
      ctx.globalAlpha = (r.sub ? 0.12 : 0.20) * lit;
      ctx.fillStyle = '#0b3a40';
      ctx.beginPath();
      ctx.ellipse(r.x, r.y + r.ry * 0.62, r.rx * 1.10, r.ry * 0.30, 0, 0, 6.3);
      ctx.fill();

      /* 石身 + 受光顶面 + 背光底面（沉在水里的那几块整体淡一档，像隔着一层水）
         ⚠️ 水下那几块的配色要比水**浅**，不能比水暗 —— 第一版用了暗灰，
            实机截图里读成了几个黑洞（不是石头）。 */
      ctx.globalAlpha = r.sub ? 0.58 : 1;
      ctx.fillStyle = r.sub ? '#5e8b88' : '#7e776a';
      poly(r.body); ctx.fill();
      ctx.fillStyle = r.sub ? '#497875' : '#665f54';
      poly(r.bot); ctx.fill();
      ctx.fillStyle = r.sub ? '#7fab9f' : '#9b9384';
      poly(r.top); ctx.fill();

      /* 露在水面的那几块：水线处压一条亮边（浅滩的白沫）。
         沿石身裁切后再画，否则短线会伸到轮廓外（截图里看得出来）。 */
      if (!r.sub) {
        ctx.save();
        poly(r.body); ctx.clip();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#eafaf8';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(r.x - r.rx, r.wy);
        ctx.lineTo(r.x + r.rx, r.wy);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function updateShadow(dt) {
    var fs = S.fishShadow;
    if (!fs) return;
    fs.t += dt;
    fs.alpha = Math.min(0.92, fs.alpha + dt * 1.2);
    fs.x += fs.vx * dt;
    fs.y += Math.sin(fs.t * 1.6) * 14 * dt + fs.vy * dt;
    var top = surfaceY() + 14;
    var bot = H - 24;
    if (fs.y < top) { fs.y = top; fs.vy = Math.abs(fs.vy) * 0.6; }
    if (fs.y > bot) { fs.y = bot; fs.vy = -Math.abs(fs.vy) * 0.6; }
    if (fs.x > W * 0.92) { fs.vx *= -1; }
    if (fs.x < W * 0.10) { fs.vx = Math.abs(fs.vx); }
  }

  /* ---------------- 码头 / 钓手 ---------------- */
  function drawDock(th) {
    var dy = dockY();
    var pierW = W * 0.40;
    var pilingH = Math.min(H - dy - 26, 132);

    ctx.save();

    /* 水面阴影 */
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#03202f';
    ctx.beginPath();
    ctx.ellipse(pierW * 0.5, dy + 16, pierW * 0.62, 16, 0, 0, 6.3);
    ctx.fill();
    ctx.globalAlpha = 1;

    /* 支柱（只到水下有限深度，不再顶到底部） */
    var n = 5;
    for (var i = 0; i < n; i++) {
      var x = W * 0.025 + i * (pierW * 0.235);
      ctx.fillStyle = th.dockDark;
      ctx.fillRect(x, dy, 9, pilingH);
      // 水下渐隐
      var g = grad('piling' + (x | 0) + '_' + (pilingH | 0), function () {
        var q = ctx.createLinearGradient(0, dy, 0, dy + pilingH);
        q.addColorStop(0, 'rgba(0,0,0,0)');
        q.addColorStop(1, 'rgba(0,20,35,.55)');
        return q;
      });
      ctx.fillStyle = g;
      ctx.fillRect(x, dy, 9, pilingH);
      // 受光边
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(x, dy, 2, pilingH);
    }

    /* 横撑 */
    ctx.fillStyle = th.dockDark;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, dy + pilingH * 0.42, pierW, 7);
    ctx.fillRect(0, dy + pilingH * 0.78, pierW, 6);
    ctx.globalAlpha = 1;

    /* 台面板 */
    var hl = th.gloom ? 0.06 : 0.22;
    ctx.fillStyle = th.dock;
    ctx.fillRect(-12, dy - 13, pierW + 12, 15);
    ctx.fillStyle = 'rgba(255,255,255,' + hl + ')';
    ctx.fillRect(-12, dy - 13, pierW + 12, 3);
    ctx.fillStyle = 'rgba(0,0,0,.20)';
    ctx.fillRect(-12, dy + 0, pierW + 12, 4);

    /* 木板缝 */
    ctx.strokeStyle = 'rgba(0,0,0,.16)';
    ctx.lineWidth = 1;
    for (var b = 1; b < 9; b++) {
      var bx = -12 + (pierW + 12) * (b / 9);
      ctx.beginPath(); ctx.moveTo(bx, dy - 13); ctx.lineTo(bx, dy + 2); ctx.stroke();
    }

    /* 木桶小道具 */
    var bx2 = W * 0.055;
    ctx.fillStyle = '#8a6a45';
    ctx.beginPath();
    ctx.moveTo(bx2 - 8, dy - 12);
    ctx.lineTo(bx2 + 8, dy - 12);
    ctx.lineTo(bx2 + 6, dy - 1);
    ctx.lineTo(bx2 - 6, dy - 1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#6d5236';
    ctx.fillRect(bx2 - 8, dy - 9, 16, 2);
    ctx.fillStyle = '#3f6f9e';
    ctx.beginPath(); ctx.ellipse(bx2, dy - 12, 8, 3, 0, 0, 6.3); ctx.fill();

    ctx.restore();

    drawDecors(th);
  }

  /* ---------------- 装饰（14 件，全部程序化绘制） ----------------
     位置一律锚在 dockY() / surfaceY() / horizonY() 上，换分辨率不跑位。
     加新装饰的两步：① items.js 的 G.DECORS 加一条；② 这里补一段绘制。
     ⚠️ 用 flat 画风：只用纯色 + 简单几何，不新建渐变
        （D1 就是「每帧新建渐变」的性能问题，别再堆回去）。 */
  function drawDecors(th) {
    var dy = dockY();

    /* ---- 保温箱 ---- */
    if (S.decor.cooler) {
      ctx.save();
      ctx.fillStyle = '#3f8fd6';
      ctx.fillRect(W * 0.035, dy - 30, 30, 19);
      ctx.fillStyle = '#eef4f8';
      ctx.fillRect(W * 0.035, dy - 34, 30, 5);
      ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.strokeRect(W * 0.035, dy - 30, 30, 19);
      ctx.restore();
    }
    if (S.decor.cat) {
      ctx.save();
      var cx = W * 0.115, cy = dy - 8;
      // 影子
      ctx.fillStyle = 'rgba(0,0,0,.14)';
      ctx.beginPath(); ctx.ellipse(cx, cy + 2, 15, 4, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#e0a45c';
      ctx.beginPath(); ctx.ellipse(cx, cy - 6, 13, 8, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 11, cy - 15, 7.5, 0, 6.3); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy - 21); ctx.lineTo(cx + 8, cy - 28); ctx.lineTo(cx + 12, cy - 22); ctx.closePath();
      ctx.moveTo(cx + 13, cy - 22); ctx.lineTo(cx + 17, cy - 28); ctx.lineTo(cx + 18, cy - 21); ctx.closePath();
      ctx.fill();
      // 尾巴
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy - 6);
      ctx.quadraticCurveTo(cx - 24, cy - 14 - Math.sin(time * 1.2) * 3, cx - 18, cy - 24);
      ctx.lineWidth = 4; ctx.strokeStyle = '#e0a45c'; ctx.lineCap = 'round'; ctx.stroke();
      // 眼
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath(); ctx.arc(cx + 13, cy - 16, 1.4, 0, 6.3); ctx.fill();
      ctx.restore();
    }
    if (S.decor.light) {
      ctx.save();
      ctx.strokeStyle = 'rgba(60,50,40,.5)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-10, dy - 40);
      ctx.quadraticCurveTo(W * 0.2, dy - 26, W * 0.40, dy - 40);
      ctx.stroke();
      for (var l = 0; l <= 8; l++) {
        var lx = -10 + (W * 0.40 + 10) * (l / 8);
        var ly = dy - 40 + Math.sin(Math.PI * (l / 8)) * 14;
        var gl = 0.6 + 0.4 * Math.sin(time * 2.4 + l);
        /* 光晕用预渲染离线图 + globalAlpha，不再每帧建渐变 */
        ctx.globalAlpha = 0.75 * gl;
        ctx.drawImage(lanternGlow(13), lx - 13, ly - 13, 26, 26);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffdf9a';
        ctx.beginPath(); ctx.arc(lx, ly, 1.8, 0, 6.3); ctx.fill();
      }
      ctx.restore();
    }
    if (S.decor.boatdeco) {
      ctx.save();
      var bx = W * 0.74;
      var by = surfaceY() + 26 + Math.sin(time * 1.1) * 3;
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.beginPath(); ctx.ellipse(bx, by + 4, 46, 6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#a97a4a';
      ctx.beginPath();
      ctx.moveTo(bx - 48, by - 8);
      ctx.quadraticCurveTo(bx, by + 16, bx + 48, by - 8);
      ctx.quadraticCurveTo(bx, by + 2, bx - 48, by - 8);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c19260';
      ctx.fillRect(bx - 30, by - 12, 60, 5);
      ctx.strokeStyle = '#8a6238'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx - 6, by - 10); ctx.lineTo(bx - 6, by - 44); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx - 4, by - 42); ctx.lineTo(bx + 16, by - 12); ctx.lineTo(bx - 4, by - 12); ctx.closePath();
      ctx.fillStyle = '#e8e2d4'; ctx.fill();
      ctx.restore();
    }

    /* ================= v0.5.2 新增 ================= */

    /* ---- 露营帐篷（金币 18 万） ---- */
    if (S.decor.tent) {
      ctx.save();
      var tx = W * 0.300, ty = dy - 13;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath(); ctx.ellipse(tx, ty + 1, 24, 4, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#c9591f';
      ctx.beginPath();
      ctx.moveTo(tx, ty - 40); ctx.lineTo(tx + 23, ty); ctx.lineTo(tx - 23, ty);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e2703a';
      ctx.beginPath();
      ctx.moveTo(tx, ty - 40); ctx.lineTo(tx + 23, ty); ctx.lineTo(tx - 2, ty);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#4a2a18';
      ctx.beginPath();
      ctx.moveTo(tx, ty - 23); ctx.lineTo(tx + 9, ty); ctx.lineTo(tx - 9, ty);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#8a6a45'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tx, ty - 40); ctx.lineTo(tx, ty - 48); ctx.stroke();
      ctx.fillStyle = '#ffd977';
      ctx.beginPath();
      ctx.moveTo(tx, ty - 48); ctx.lineTo(tx + 10, ty - 44.5); ctx.lineTo(tx, ty - 41);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    /* ---- 荣誉奖牌（纪念币 25 枚） ---- */
    if (S.decor.plaque) {
      ctx.save();
      var px = W * 0.243, py = dy - 13;
      ctx.fillStyle = '#8a6a45';
      ctx.fillRect(px - 1.6, py - 20, 3.2, 20);
      ctx.fillStyle = '#f2f4f6';
      ctx.beginPath();
      ctx.moveTo(px - 9, py - 34); ctx.lineTo(px + 9, py - 34);
      ctx.lineTo(px + 9, py - 22); ctx.lineTo(px - 9, py - 22);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#b9c4cc'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#e8b23c';
      ctx.beginPath(); ctx.arc(px, py - 29, 4.6, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath(); ctx.arc(px, py - 29, 2.1, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#3f8fd6';
      ctx.beginPath();
      ctx.moveTo(px - 4, py - 25); ctx.lineTo(px + 4, py - 25);
      ctx.lineTo(px + 2.4, py - 19.5); ctx.lineTo(px - 2.4, py - 19.5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    /* ---- 篝火（金币 90 万） ---- */
    if (S.decor.fire) {
      ctx.save();
      var fx = W * 0.366, fy = dy - 13;
      ctx.fillStyle = '#9aa4ab';
      for (var fi = 0; fi < 6; fi++) {
        var fa = fi / 6 * 6.28;
        ctx.beginPath();
        ctx.ellipse(fx + Math.cos(fa) * 11, fy - 1 + Math.sin(fa) * 3.2, 4, 3, 0, 0, 6.3);
        ctx.fill();
      }
      ctx.strokeStyle = '#6d5236'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(fx - 7, fy - 1); ctx.lineTo(fx + 7, fy - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fx + 7, fy - 1); ctx.lineTo(fx - 7, fy - 6); ctx.stroke();

      var fw = 0.72 + 0.28 * Math.sin(time * 7.3);
      var fh = 17 + Math.sin(time * 9.1) * 3;
      /* 光晕：用两层半透明实心圆代替径向渐变（每帧新建渐变会踩 D1 的坑） */
      ctx.globalAlpha = 0.16 * fw; ctx.fillStyle = '#ff9b2f';
      ctx.beginPath(); ctx.arc(fx, fy - 11, 23, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 0.22 * fw;
      ctx.beginPath(); ctx.arc(fx, fy - 11, 13, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#ff9b2f';
      ctx.beginPath();
      ctx.moveTo(fx, fy - 4 - fh);
      ctx.quadraticCurveTo(fx + 7.5, fy - 8, fx + 4, fy - 2);
      ctx.quadraticCurveTo(fx, fy + 1, fx - 4, fy - 2);
      ctx.quadraticCurveTo(fx - 7.5, fy - 8, fx, fy - 4 - fh);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe07a';
      ctx.beginPath();
      ctx.moveTo(fx, fy - 4 - fh * 0.6);
      ctx.quadraticCurveTo(fx + 4, fy - 6, fx + 2, fy - 2.5);
      ctx.quadraticCurveTo(fx, fy - 0.5, fx - 2, fy - 2.5);
      ctx.quadraticCurveTo(fx - 4, fy - 6, fx, fy - 4 - fh * 0.6);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    /* ---- 热气球（金币 260 万） ---- */
    if (S.decor.balloon) {
      ctx.save();
      var bx0 = W * 0.800 + Math.sin(time * 0.13) * 20;
      var by0 = horizonY() * 0.34 + Math.sin(time * 0.21) * 6;
      var br = Math.min(W, H) * 0.030 + 12;
      var bcols = ['#e8595c', '#f2f4f6', '#ffd977', '#f2f4f6', '#3f8fd6'];
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(bx0, by0, br, br * 0.94, 0, 0, 6.3);
      ctx.clip();
      for (var bi = 0; bi < bcols.length; bi++) {
        ctx.fillStyle = bcols[bi];
        ctx.fillRect(bx0 - br + (2 * br / bcols.length) * bi, by0 - br,
                     2 * br / bcols.length + 1, 2 * br);
      }
      ctx.fillStyle = '#c9d2d8';
      ctx.beginPath();
      ctx.ellipse(bx0, by0 + br * 0.88, br * 0.36, br * 0.20, 0, 0, 6.3);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(70,60,50,.7)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx0 - br * 0.34, by0 + br * 0.9); ctx.lineTo(bx0 - br * 0.16, by0 + br * 1.45);
      ctx.moveTo(bx0 + br * 0.34, by0 + br * 0.9); ctx.lineTo(bx0 + br * 0.16, by0 + br * 1.45);
      ctx.stroke();
      ctx.fillStyle = '#a97a4a';
      ctx.fillRect(bx0 - br * 0.18, by0 + br * 1.45, br * 0.36, br * 0.26);
      ctx.restore();
    }

    /* ---- 芦苇丛（生态值 30） ---- */
    if (S.decor.reed) {
      ctx.save();
      var rx = W * 0.470, rbase = surfaceY() + 9;
      ctx.lineCap = 'round';
      for (var ri = 0; ri < 7; ri++) {
        var rxx = rx + (ri - 3) * 5.6;
        var rh = 28 + ((ri * 37) % 24);
        var rsw = Math.sin(time * 1.5 + ri) * 4;
        ctx.strokeStyle = ri % 2 ? '#7f9a4e' : '#8fae5a';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(rxx, rbase);
        ctx.quadraticCurveTo(rxx + rsw * 0.4, rbase - rh * 0.6, rxx + rsw, rbase - rh);
        ctx.stroke();
        ctx.fillStyle = ri % 2 ? '#c9a86a' : '#a8bd72';
        ctx.beginPath();
        ctx.ellipse(rxx + rsw, rbase - rh - 3, 2.3, 5.5, rsw * 0.03, 0, 6.3);
        ctx.fill();
      }
      ctx.restore();
    }

    /* ---- 睡莲（生态值 120） ---- */
    if (S.decor.lily) {
      ctx.save();
      var lx = W * 0.640, ly = surfaceY() + 6;
      for (var li = 0; li < 5; li++) {
        var lxx = lx + Math.cos(li * 1.9) * (10 + li * 7);
        var lyy = ly + Math.sin(li * 2.6) * 5;
        var lr = 8 + (li % 3) * 3;
        ctx.fillStyle = li % 2 ? '#4f9e5e' : '#5fb46c';
        ctx.beginPath();
        ctx.ellipse(lxx, lyy, lr, lr * 0.55, 0, 0.5, 6.0);
        ctx.fill();
      }
      for (var pi = 0; pi < 5; pi++) {
        var pa = pi / 5 * 6.283 + time * 0.12;
        ctx.fillStyle = '#f7d3e0';
        ctx.beginPath();
        ctx.ellipse(lx + Math.cos(pa) * 3.2, ly - 5 + Math.sin(pa) * 2, 3.2, 5.6, pa, 0, 6.3);
        ctx.fill();
      }
      ctx.fillStyle = '#ffe07a';
      ctx.beginPath(); ctx.arc(lx, ly - 5, 2.2, 0, 6.3); ctx.fill();
      ctx.restore();
    }

    /* ---- 白鹭（生态值 400） ---- */
    if (S.decor.heron) {
      ctx.save();
      var hx = W * 0.700, hy = surfaceY() + 11;
      var bob = Math.sin(time * 0.9) * 1.6;
      ctx.globalAlpha = 0.16; ctx.fillStyle = '#f4f7f9';
      ctx.beginPath(); ctx.ellipse(hx, hy + 3, 11, 3.4, 0, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#5a6772'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx - 3, hy - 22); ctx.lineTo(hx - 4.5, hy);
      ctx.moveTo(hx + 3, hy - 22); ctx.lineTo(hx + 4.5, hy);
      ctx.stroke();
      ctx.fillStyle = '#f4f7f9';
      ctx.beginPath(); ctx.ellipse(hx, hy - 27 + bob, 11, 8, -0.12, 0, 6.3); ctx.fill();
      ctx.strokeStyle = '#f4f7f9'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(hx + 6, hy - 30 + bob);
      ctx.quadraticCurveTo(hx + 14, hy - 40 + bob, hx + 12, hy - 50 + bob);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(hx + 12, hy - 51 + bob, 3.6, 0, 6.3); ctx.fill();
      ctx.strokeStyle = '#e8b23c'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hx + 14, hy - 51 + bob); ctx.lineTo(hx + 22, hy - 49 + bob);
      ctx.stroke();
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath(); ctx.arc(hx + 13.4, hy - 52 + bob, 1, 0, 6.3); ctx.fill();
      ctx.restore();
    }

    /* ---- 珊瑚礁（生态值 1000） ---- */
    if (S.decor.reef) {
      ctx.save();
      var rx2 = W * 0.880, ry2 = surfaceY() + 13;
      ctx.fillStyle = '#6f7b84';
      ctx.beginPath();
      ctx.moveTo(rx2 - 26, ry2 + 8);
      ctx.quadraticCurveTo(rx2 - 16, ry2 - 12, rx2 - 2, ry2 - 8);
      ctx.quadraticCurveTo(rx2 + 12, ry2 - 18, rx2 + 22, ry2 + 4);
      ctx.quadraticCurveTo(rx2, ry2 + 14, rx2 - 26, ry2 + 8);
      ctx.closePath(); ctx.fill();
      var ccol = ['#e8737f', '#f0a24a', '#c98fe0'];
      ctx.lineCap = 'round'; ctx.lineWidth = 3.2;
      for (var ci = 0; ci < 3; ci++) {
        var cx2 = rx2 - 12 + ci * 12;
        var chh = 10 + ci * 5;
        ctx.strokeStyle = ccol[ci];
        ctx.beginPath();
        ctx.moveTo(cx2, ry2 - 6); ctx.lineTo(cx2 - 3, ry2 - 6 - chh);
        ctx.moveTo(cx2, ry2 - 6 - chh * 0.5); ctx.lineTo(cx2 + 5, ry2 - 6 - chh * 0.88);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(rx2, ry2 + 9, 30, 5, 0, 0, 6.3); ctx.stroke();
      ctx.restore();
    }

    /* ---- 荣誉拱门（纪念币 80 枚） ---- */
    if (S.decor.arch) {
      ctx.save();
      var ax = W * 0.200, ay = dy - 13;
      var aw = W * 0.115, ahh = Math.min(H * 0.20, 104);
      ctx.strokeStyle = '#c9a86a'; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax - aw, ay);
      ctx.lineTo(ax - aw, ay - ahh * 0.62);
      ctx.quadraticCurveTo(ax, ay - ahh * 1.16, ax + aw, ay - ahh * 0.62);
      ctx.lineTo(ax + aw, ay);
      ctx.stroke();
      ctx.fillStyle = '#ffd977';
      ctx.beginPath(); ctx.arc(ax, ay - ahh * 0.88, 3.6, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 0.30 * (0.7 + 0.3 * Math.sin(time * 2.2));
      ctx.beginPath(); ctx.arc(ax, ay - ahh * 0.88, 9, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#e8595c';
      ctx.beginPath();
      ctx.moveTo(ax - aw, ay - ahh * 0.70);
      ctx.lineTo(ax - aw - 12, ay - ahh * 0.70 + 4);
      ctx.lineTo(ax - aw, ay - ahh * 0.70 + 8);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ax + aw, ay - ahh * 0.70);
      ctx.lineTo(ax + aw + 12, ay - ahh * 0.70 + 4);
      ctx.lineTo(ax + aw, ay - ahh * 0.70 + 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  /* ---------------- 钓手（玩家与隔壁共用同一段画法） ----------------
     抽出来只为一件事：**同一个人形只有一处真相** —— 隔壁不是另画一个人，
     是同一段身体换一组颜色、换一个站位（配色与站位来自 `src/data/story.js`）。
     `o` = { x, y, Hh, skin, shirt, shirtD, pants, hat }；返回肩高 shoY（玩家要拿它接手臂）。
     ⚠️ 手臂 / 鱼竿**只有玩家画**：隔壁这一轮不抛线，免得他的竿与玩家的竿线
        在画面上打架（这不是省略，是有意的 —— 见 N7 待办里「先 1 个 NPC + 2 个事件」）。 */
  function drawAnglerBody(th, o) {
    var x = o.x, y = o.y, Hh = o.Hh;
    var skin = o.skin, shirt = o.shirt, shirtD = o.shirtD, pants = o.pants;

    ctx.save();

    /* 影子 */
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.ellipse(x + 2, y + 1, Hh * 0.26, Hh * 0.06, 0, 0, 6.3); ctx.fill();

    /* 腿 */
    ctx.strokeStyle = pants;
    ctx.lineWidth = Hh * 0.115;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - Hh * 0.04, y - Hh * 0.02); ctx.lineTo(x - Hh * 0.075, y - Hh * 0.40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + Hh * 0.05, y - Hh * 0.02); ctx.lineTo(x + Hh * 0.10, y - Hh * 0.40); ctx.stroke();

    /* 躯干 */
    var hipY = y - Hh * 0.40, shoY = y - Hh * 0.72;
    ctx.beginPath();
    ctx.moveTo(x - Hh * 0.125, hipY);
    ctx.quadraticCurveTo(x - Hh * 0.165, shoY + Hh * 0.06, x - Hh * 0.135, shoY);
    ctx.lineTo(x + Hh * 0.135, shoY);
    ctx.quadraticCurveTo(x + Hh * 0.165, shoY + Hh * 0.06, x + Hh * 0.125, hipY);
    ctx.closePath();
    /* 🔴 缓存键必须覆盖 `make()` 读到的**全部入参**（N7 五期）：这段画法现在有两个消费方
       （玩家 + 隔壁那位，以后可能更多），只按 `x` 缓存的话，两个人站到同一个整数像素上时
       **后画的那个会穿前一个的衣服**（拿到的还是缓存里那份旧渐变，颜色与宽度都跟着旧值）——
       不报错、只是悄悄画错。`clearGradCache()` 只在 resize / 切钓场时清，挡不住同帧撞位。 */
    var g = grad('shirt' + (x | 0) + '|' + (Hh | 0) + '|' + shirt + shirtD, function () {
      var q = ctx.createLinearGradient(x - Hh * 0.16, 0, x + Hh * 0.16, 0);
      q.addColorStop(0, shirtD); q.addColorStop(0.45, shirt); q.addColorStop(1, shirtD);
      return q;
    });
    ctx.fillStyle = g; ctx.fill();

    /* 领口 */
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(x, shoY + Hh * 0.012, Hh * 0.062, Hh * 0.045, 0, 0, Math.PI);
    ctx.fill();

    /* 头 */
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(x, y - Hh * 0.83, Hh * 0.105, 0, 6.3); ctx.fill();
    /* 侧脸阴影 */
    ctx.fillStyle = 'rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.arc(x + Hh * 0.035, y - Hh * 0.83, Hh * 0.105, -1.5, 1.5); ctx.fill();

    /* 帽子（戴不戴由调用方决定：玩家看装饰、邻居看内容表） */
    if (o.hat) {
      ctx.fillStyle = '#c85f4a';
      ctx.beginPath();
      ctx.ellipse(x, y - Hh * 0.885, Hh * 0.185, Hh * 0.042, 0, 0, 6.3);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x, y - Hh * 0.925, Hh * 0.115, Hh * 0.085, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#a8483a';
      ctx.fillRect(x - Hh * 0.115, y - Hh * 0.912, Hh * 0.23, Hh * 0.02);
    } else {
      ctx.fillStyle = '#39506a';
      ctx.beginPath();
      ctx.arc(x, y - Hh * 0.855, Hh * 0.108, Math.PI * 1.02, Math.PI * 1.98);
      ctx.fill();
      ctx.fillStyle = '#2c3f55';
      ctx.beginPath();
      ctx.ellipse(x + Hh * 0.075, y - Hh * 0.862, Hh * 0.075, Hh * 0.018, -0.12, 0, 6.3);
      ctx.fill();
    }

    ctx.restore();
    return shoY;
  }

  function drawFisher(th) {
    var dy = dockY();
    var x = fisherX();
    var y = dy - 13;
    var Hh = Math.min(H * 0.16, 74);        // 身高
    var skin = '#eabf98';
    var shirt = '#356f9e';

    var shoY = drawAnglerBody(th, {
      x: x, y: y, Hh: Hh,
      skin: skin, shirt: shirt, shirtD: '#2a5a83', pants: '#3d4a55',
      hat: !!S.decor.hat,
    });

    /* 手臂 → 握竿（只有玩家有：邻居这一轮不抛线，见 drawAnglerBody 的头注） */
    var hx = x + Hh * 0.40, hy = y - Hh * 0.63;
    ctx.strokeStyle = shirt; ctx.lineWidth = Hh * 0.085;
    ctx.beginPath();
    ctx.moveTo(x + Hh * 0.09, shoY + Hh * 0.05);
    ctx.quadraticCurveTo(x + Hh * 0.26, shoY + Hh * 0.02, hx, hy);
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(hx, hy, Hh * 0.048, 0, 6.3); ctx.fill();
  }

  /* 隔壁钓鱼佬：站位与配色全部来自内容表（`src/data/story.js`），画法复用上面那段。
     竿是**靠在身边的一根斜杆**而不是抛出去的手竿 —— 画的目的是「这里还站着一个人」，
     不是「他也在钓」；他真在钓这件事发生在对话里。 */
  function drawNeighbor(th) {
    var nb = S.neighbor;
    if (!nb) return;
    var Hh = neighborH();
    var x = W * nb.x, y = dockY() - 13;

    ctx.save();
    /* 靠着的竿先画（在人身后） */
    ctx.strokeStyle = '#7a5a33';
    ctx.lineWidth = Math.max(2, H * 0.0045);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + Hh * 0.30, y - Hh * 0.02);
    ctx.lineTo(x - Hh * 0.10, y - Hh * 1.05);
    ctx.stroke();
    /* 脚边的鱼桶 */
    ctx.fillStyle = '#4b6b7a';
    ctx.fillRect(x + Hh * 0.26, y - Hh * 0.24, Hh * 0.20, Hh * 0.24);
    ctx.fillStyle = '#3b5866';
    ctx.fillRect(x + Hh * 0.26, y - Hh * 0.265, Hh * 0.20, Hh * 0.05);
    ctx.restore();

    drawAnglerBody(th, {
      x: x, y: y, Hh: Hh,
      skin: nb.skin, shirt: nb.shirt, shirtD: nb.shirtD, pants: nb.pants,
      hat: !!nb.hat,
    });

    /* 「可以搭话」的小提示（一个气泡 + 三个点）—— 现在他能被点了（N7 二期），
       而**看不出能点的按钮等于没有**：不画这个，玩家永远不会去点那撮像素。
       位置贴着头顶、随呼吸轻微起伏（幅度按身高缩放，窗口大小变了不会飘开）。
       ⚠️ 只有他真有闲聊池时才画 —— 没话可说的邻居不该挂个气泡骗玩家点。 */
    if (nb.talk && nb.talk.length) {
      var bw = Hh * 0.40, bh = Hh * 0.24;
      var bx = x, by = y - Hh * 1.22 + Math.sin(time * 2.1) * Hh * 0.03;
      var dot = Math.max(1, bh * 0.115);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      ctx.beginPath();
      ctx.moveTo(bx - bw / 2 + bh / 2, by - bh / 2);
      ctx.arcTo(bx + bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2, bh / 2);
      ctx.arcTo(bx + bw / 2, by + bh / 2, bx - bw / 2, by + bh / 2, bh / 2);
      ctx.arcTo(bx - bw / 2, by + bh / 2, bx - bw / 2, by - bh / 2, bh / 2);
      ctx.arcTo(bx - bw / 2, by - bh / 2, bx + bw / 2, by - bh / 2, bh / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#5a6a78';
      for (var i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(bx + i * bh * 0.30, by, dot, 0, 6.3);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* 邻居的身高 —— 画他与**判断他站在哪一块**共用这一处（见 hitNeighbor()）。 */
  function neighborH() { return Math.min(H * 0.155, 72); }

  /* 玩家点在画布上的一点，落没落在那位邻居身上（N7 二期：点他主动搭话）。
     🔴 口径：命中框与 `drawNeighbor()` **同源** —— 两处都从 `neighborH()` + `nb.x` +
        `dockY()` 现算，绝不在这里再抄一份「他大概在画面左边」。抄一份的后果是
        「画在这儿、点在那儿」，而且**不报任何错**（玩家只会觉得这游戏点了没反应）。
     框比身体略宽一点（手 / 触屏都点得到）：横向覆盖影子与鱼桶、纵向**从头顶的气泡一路到脚边**
     （点那个气泡也该算数 —— 它就是给玩家看的「点我」）。
     `px / py` = 相对画布左上角的**逻辑像素**（由调用方从 clientX 减去画布矩形换算）。 */
  function hitNeighbor(px, py) {
    var nb = S.neighbor;
    if (!nb || typeof px !== 'number' || typeof py !== 'number') return false;
    if (!isFinite(px) || !isFinite(py)) return false;
    var Hh = neighborH();
    var x = W * nb.x, y = dockY() - 13;
    return px >= x - Hh * 0.30 && px <= x + Hh * 0.46
      && py >= y - Hh * 1.40 && py <= y + Hh * 0.10;
  }

  function handPos() {
    var dy = dockY();
    var x = fisherX(), y = dy - 13;
    var Hh = Math.min(H * 0.16, 74);
    return { x: x + Hh * 0.40, y: y - Hh * 0.63, Hh: Hh };
  }

  function drawRod(th) {
    var hp = handPos();
    var hx = hp.x, hy = hp.y;
    var tx = rodTipX(), ty = rodTipY();

    var bend = S.rodBend;
    var mx = U.lerp(hx, tx, 0.55) + bend * 22;
    var my = U.lerp(hy, ty, 0.55) + Math.abs(bend) * 16;

    ctx.save();
    /* 竿影 */
    ctx.strokeStyle = 'rgba(0,0,0,.14)';
    ctx.lineWidth = Math.max(2.4, H * 0.007);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hx + 3, hy + 4);
    ctx.quadraticCurveTo(mx + 3, my + 4, tx + 3, ty + 4);
    ctx.stroke();

    /* 竿身（分两段做出粗细变化） */
    ctx.strokeStyle = '#7a5a33';
    ctx.lineWidth = Math.max(2.2, H * 0.0058);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo(mx, my, tx, ty);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy - 1.5);
    ctx.quadraticCurveTo(mx, my - 1.5, tx, ty - 1.5);
    ctx.stroke();

    /* 握把 */
    ctx.strokeStyle = '#8a3f2f';
    ctx.lineWidth = Math.max(4, H * 0.011);
    ctx.beginPath();
    ctx.moveTo(hx - 10, hy + 9);
    ctx.lineTo(hx + 7, hy - 5);
    ctx.stroke();

    /* 导环 */
    ctx.strokeStyle = 'rgba(60,60,60,.75)';
    ctx.lineWidth = 1.2;
    for (var i = 1; i <= 3; i++) {
      var t = i / 4;
      var px = U.lerp(hx, tx, t), py = U.lerp(hy, ty, t);
      ctx.beginPath(); ctx.arc(px, py - 2, 2.4, 0, 6.3); ctx.stroke();
    }
    ctx.restore();
  }

  function drawLine(th) {
    if (S.floatState === 'none' && S.lineOut <= 0) return;
    var hp = handPos();
    var tx = rodTipX(), ty = rodTipY();
    var fx = floatX(), fy = surfaceY();

    if (S.floatState === 'flying') {
      var t = S.floatT / G.CONFIG.misc.flyTime;
      fx = U.lerp(W * 0.30, floatHomeX(), U.easeOut(t));
      fy = fy - (1 - t) * (1 - t) * H * 0.22;
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.78)';
    ctx.lineWidth = S.floatState === 'fight' ? 1.6 : 1.1;
    var sag = S.floatState === 'fight' ? 5 : 15;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo((tx + fx) / 2, Math.min(ty, fy) + sag, fx, fy);
    ctx.stroke();
    ctx.restore();
  }

  function drawFloat(th) {
    if (S.floatState === 'none') return;
    var fx = floatX();
    var base = surfaceY();
    var bob = Math.sin(time * 2.1) * 1.6;
    var dip = 0;

    if (S.floatState === 'wait') {
      bob += Math.sin(time * 0.7) * 1.2;
    } else if (S.floatState === 'bite') {
      dip = 7 * (0.6 + 0.4 * Math.sin(time * 22));
    } else if (S.floatState === 'fight') {
      dip = 5 + Math.sin(time * 9) * 3;
    }
    if (S.nudge > 0) dip += (Math.sin(time * 11) * 0.5 + 0.5) * S.nudge * 2.6;
    var fy = base + bob + dip;

    // 水波圈
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 2; i++) {
      var rr = ((time * 22 + i * 16) % 34);
      if (S.nudge > 0) { rr = (rr + S.nudge * 8) % 34; }
      ctx.globalAlpha = 1 - rr / 34;
      ctx.beginPath(); ctx.ellipse(fx, base + 2, rr, rr * 0.32, 0, 0, 6.3); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 浮漂：下白上红
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.ellipse(fx, base + 3, 8, 3, 0, 0, 6.3); ctx.fill();

    ctx.beginPath();
    ctx.ellipse(fx, fy, 5.2, 6.6, 0, 0, 6.3);
    ctx.fillStyle = '#f7f7f2'; ctx.fill();
    ctx.beginPath();
    ctx.ellipse(fx, fy - 6.2, 5.2, 6.0, 0, Math.PI, 0);
    ctx.fillStyle = '#e8503f'; ctx.fill();
    ctx.strokeStyle = 'rgba(120,60,40,.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(fx, fy, 5.2, 6.6, 0, 0, 6.3); ctx.stroke();
    // 标杆
    ctx.strokeStyle = '#e8503f'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(fx, fy - 10); ctx.lineTo(fx, fy - 17); ctx.stroke();
    ctx.restore();
  }

  /* ---------------- 粒子 ---------------- */
  function updateParticles(dt) {
    var out = [];
    for (var i = 0; i < S.particles.length; i++) {
      var p = S.particles[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      if (p.kind === 'drop') {
        p.vy += 460 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else if (p.kind === 'spark') {
        p.vy += 180 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else if (p.kind === 'ripple') {
        p.r += p.grow * dt;
      } else {
        p.x += (p.vx || 0) * dt;
        p.y += (p.vy || 0) * dt;
      }
      out.push(p);
    }
    S.particles = out;
  }

  function drawParticles() {
    ctx.save();
    S.particles.forEach(function (p) {
      var a = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, a);
      if (p.kind === 'ripple') {
        ctx.strokeStyle = p.c; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r, p.r * 0.33, 0, 0, 6.3); ctx.stroke();
      } else {
        ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + 0.6 * a), 0, 6.3); ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ---------------- 环境氛围 ---------------- */
  var ambParts = [];
  function drawAmbientBack(th) {
    if (th.aurora) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 4; i++) {
        var y0 = horizonY() * (0.20 + i * 0.14);
        var g = auroraGrad(i);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        for (var x = 0; x <= W; x += 20) {
          ctx.lineTo(x, y0 + Math.sin(x * 0.008 + time * 0.55 + i * 1.7) * 26);
        }
        ctx.lineTo(W, y0 + 80);
        for (var x2 = W; x2 >= 0; x2 -= 20) {
          ctx.lineTo(x2, y0 + 80 + Math.sin(x2 * 0.006 - time * 0.4 + i) * 20);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawAmbientFront(th) {
    var mode = th.ambient;
    if (!mode || mode === 'none') return;

    if (!ambParts.length) {
      for (var i = 0; i < 60; i++) {
        ambParts.push({
          x: Math.random() * W, y: Math.random() * H,
          s: Math.random(), v: Math.random(), ph: Math.random() * 6.28,
        });
      }
    }

    ctx.save();
    if (mode === 'rain') {
      ctx.strokeStyle = th.ambientColor;
      ctx.lineWidth = 1.2;
      ambParts.forEach(function (p) {
        var yy = (p.y + time * (420 + p.v * 320)) % (H + 60) - 30;
        var xx = (p.x + time * 60) % (W + 60) - 30;
        ctx.globalAlpha = 0.24 + p.s * 0.3;
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx - 4, yy + 16 + p.s * 12);
        ctx.stroke();
      });
    } else if (mode === 'leaf') {
      ambParts.forEach(function (p) {
        var yy = (p.y + time * (28 + p.v * 34)) % (H + 40) - 20;
        var xx = (p.x + Math.sin(time * 0.8 + p.ph) * 40 + time * 12) % (W + 80) - 40;
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = th.ambientColor;
        ctx.save();
        ctx.translate(xx, yy);
        ctx.rotate(time * 1.4 + p.ph);
        ctx.beginPath(); ctx.ellipse(0, 0, 4.5 + p.s * 2.5, 2 + p.s, 0, 0, 6.3); ctx.fill();
        ctx.restore();
      });
    } else if (mode === 'spray') {
      ambParts.forEach(function (p) {
        var yy = surfaceY() + ((p.y + time * 90 * (0.4 + p.v)) % (H - surfaceY()));
        var xx = (p.x + Math.sin(time * 1.1 + p.ph) * 26) % W;
        ctx.globalAlpha = 0.30 * (1 - (yy - surfaceY()) / (H - surfaceY()));
        ctx.fillStyle = th.ambientColor;
        ctx.beginPath(); ctx.arc(xx, yy, 1 + p.s * 1.6, 0, 6.3); ctx.fill();
      });
    } else if (mode === 'mist') {
      ambParts.slice(0, 22).forEach(function (p) {
        var xx = (p.x + time * (6 + p.v * 10)) % (W + 200) - 100;
        var yy = horizonY() + p.s * 60;
        ctx.globalAlpha = 0.13;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.ellipse(xx, yy, 60 + p.s * 50, 12 + p.s * 8, 0, 0, 6.3); ctx.fill();
      });
    } else if (mode === 'star') {
      ambParts.slice(0, 26).forEach(function (p) {
        var yy = (p.y + time * (10 + p.v * 20)) % H;
        ctx.globalAlpha = 0.35 + 0.4 * Math.sin(time * 2 + p.ph);
        ctx.fillStyle = th.ambientColor;
        ctx.beginPath(); ctx.arc(p.x, yy, 0.8 + p.s * 1.4, 0, 6.3); ctx.fill();
      });
    } else if (mode === 'aurora') {
      ambParts.slice(0, 30).forEach(function (p) {
        var yy = (p.y + time * (16 + p.v * 26)) % H;
        ctx.globalAlpha = 0.30 + 0.35 * Math.sin(time * 1.6 + p.ph);
        ctx.fillStyle = th.ambientColor;
        ctx.beginPath(); ctx.arc(p.x, yy, 0.8 + p.s * 1.8, 0, 6.3); ctx.fill();
      });
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawVignette(th) {
    var g = grad('vignette', function () {
      var q = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
      q.addColorStop(0, 'rgba(0,0,0,0)');
      q.addColorStop(1, th.vignette);
      return q;
    });
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------------- 取用 ----------------
     ⚠️ 只保留真的有外部消费方的接口（verify 第 ㉕ / ㉜ 节的判据）。
     已删：`getRodTip` / `getFloat`（场景内部直接用 `rodTipX()` / `floatX()`）、
           `state`（内部靠裸名 `S`，外部没人读 `G.Scene.state`）、
           `resize`（尺寸变化由本文件内部监听窗口事件处理，外部没人调 `G.Scene.resize`）。 */
  function setRodBend(v) { S.rodBend = v; }

  return {
    init: init, render: render,
    setField: setField, setDecor: setDecor, setNeighbor: setNeighbor,
    hitNeighbor: hitNeighbor,
    cast: cast, beginWait: beginWait, bite: bite, floatNudge: floatNudge,
    beginFight: beginFight, endFight: endFight,
    splash: splash, sparkle: sparkle, showShadow: showShadow,
    setRodBend: setRodBend,
  };
})();
