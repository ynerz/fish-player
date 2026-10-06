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
    fightFish: null,
    fightRarity: 0,
    fishShadow: null,     // {fish, kg, x, y, vx, vy, alpha, t}
    particles: [],
    stars: [],
    clouds: [],
    decor: {},
  };

  /* ---------------- 初始化 ---------------- */
  function init(canvas) {
    cv = canvas;
    ctx = cv.getContext('2d');
    window.addEventListener('resize', resize);
    resize();
  }

  function resize() {
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
  function beginFight(fish) {
    S.floatState = 'fight';
    S.fightFish = fish;
    S.fightRarity = fish ? fish.rar : 0;
  }
  function endFight() { S.fightFish = null; S.floatState = 'none'; S.lineOut = 0; }

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

  /* 水下鱼影 */
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

  /* ---------------- 主渲染 ---------------- */
  function render(dt) {
    if (!ctx) return;
    dt = Math.min(dt, 0.05);
    time += dt;

    updateParticles(dt);
    updateClouds(dt);
    updateShadow(dt);

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
    drawDock(th);
    drawFisher(th);
    drawRod(th);
    drawLine(th);
    drawFloat(th);
    drawParticles();
    drawAmbientFront(th);
    drawVignette(th);
  }

  /* ---------------- 天空 ---------------- */
  function drawSky(th) {
    var g = ctx.createLinearGradient(0, 0, 0, horizonY() + 4);
    g.addColorStop(0, th.sky[0]);
    g.addColorStop(1, th.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizonY() + 4);
  }

  function drawCelestial(th) {
    if (th.sun) {
      var sx = th.sun.x * W, sy = th.sun.y * horizonY();
      var gg = ctx.createRadialGradient(sx, sy, 1, sx, sy, th.sun.r * 6);
      gg.addColorStop(0, th.sun.glow);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(sx, sy, th.sun.r * 6, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(sx, sy, th.sun.r, 0, 6.3);
      ctx.fillStyle = th.sun.color; ctx.fill();
    }
    if (th.moon) {
      var mx = W * 0.76, my = horizonY() * 0.22;
      var mr = th.moonSize || 34;
      var mg = ctx.createRadialGradient(mx, my, 1, mx, my, mr * 5);
      mg.addColorStop(0, 'rgba(220,235,255,.35)');
      mg.addColorStop(1, 'rgba(220,235,255,0)');
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
    var g = ctx.createLinearGradient(0, hy, 0, H);
    g.addColorStop(0, th.water[0]);
    g.addColorStop(0.42, th.water[1]);
    g.addColorStop(1, th.deep[1]);
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
      var sg = ctx.createLinearGradient(0, hy, 0, hy + (H - hy) * 0.6);
      sg.addColorStop(0, 'rgba(140,200,255,.55)');
      sg.addColorStop(1, 'rgba(140,200,255,0)');
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
      ctx.save();
      ctx.globalAlpha = 0.055;
      ctx.filter = 'blur(' + Math.round(Math.max(10, W * 0.014)) + 'px)';
      ctx.fillStyle = '#ffffff';
      for (var i = 0; i < 4; i++) {
        var bx = (th.sun.x * W) + (i - 1.5) * 62;
        ctx.beginPath();
        ctx.moveTo(bx - 18, hy);
        ctx.lineTo(bx + 18, hy);
        ctx.lineTo(bx + 118 + i * 34, H);
        ctx.lineTo(bx + 22 + i * 34, H);
        ctx.closePath();
        ctx.fill();
      }
      ctx.filter = 'none';
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
      // 亮色的鱼本体（半透明）
      ctx.globalAlpha = fs.alpha * 0.55;
      ctx.filter = 'brightness(0.75) saturate(0.9)';
      G.FishArt.draw(ctx, fs.fish, fs.x, fs.y, L, { t: fs.t });
      ctx.filter = 'none';
      ctx.restore();
    }
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
      var g = ctx.createLinearGradient(0, dy, 0, dy + pilingH);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,20,35,.55)');
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

    // 装饰：保温箱 / 猫 / 串灯 / 小船
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
        var rg = ctx.createRadialGradient(lx, ly, 0, lx, ly, 13);
        rg.addColorStop(0, 'rgba(255,215,140,' + (0.75 * gl) + ')');
        rg.addColorStop(1, 'rgba(255,215,140,0)');
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.arc(lx, ly, 13, 0, 6.3); ctx.fill();
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
  }

  function drawFisher(th) {
    var dy = dockY();
    var x = fisherX();
    var y = dy - 13;

    var Hh = Math.min(H * 0.16, 74);        // 身高
    var skin = '#eabf98';
    var shirt = '#356f9e';
    var shirtD = '#2a5a83';
    var pants = '#3d4a55';

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
    var g = ctx.createLinearGradient(x - Hh * 0.16, 0, x + Hh * 0.16, 0);
    g.addColorStop(0, shirtD); g.addColorStop(0.45, shirt); g.addColorStop(1, shirtD);
    ctx.fillStyle = g; ctx.fill();

    /* 领口 */
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(x, shoY + Hh * 0.012, Hh * 0.062, Hh * 0.045, 0, 0, Math.PI);
    ctx.fill();

    /* 手臂 → 握竿 */
    var hx = x + Hh * 0.40, hy = y - Hh * 0.63;
    ctx.strokeStyle = shirt; ctx.lineWidth = Hh * 0.085;
    ctx.beginPath();
    ctx.moveTo(x + Hh * 0.09, shoY + Hh * 0.05);
    ctx.quadraticCurveTo(x + Hh * 0.26, shoY + Hh * 0.02, hx, hy);
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(hx, hy, Hh * 0.048, 0, 6.3); ctx.fill();

    /* 头 */
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(x, y - Hh * 0.83, Hh * 0.105, 0, 6.3); ctx.fill();
    /* 侧脸阴影 */
    ctx.fillStyle = 'rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.arc(x + Hh * 0.035, y - Hh * 0.83, Hh * 0.105, -1.5, 1.5); ctx.fill();

    /* 帽子 */
    if (S.decor.hat) {
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
        var g = ctx.createLinearGradient(0, y0 - 60, 0, y0 + 70);
        var hue = ['rgba(120,255,210,', 'rgba(160,180,255,', 'rgba(220,150,255,', 'rgba(140,255,235,'][i];
        g.addColorStop(0, hue + '0)');
        g.addColorStop(0.5, hue + (0.16 - i * 0.025) + ')');
        g.addColorStop(1, hue + '0)');
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
    var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, th.vignette);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------------- 取用 ---------------- */
  function setRodBend(v) { S.rodBend = v; }
  function getRodTip() { return { x: rodTipX(), y: rodTipY() }; }
  function getFloat() { return { x: floatX(), y: surfaceY() }; }

  return {
    init: init, render: render, resize: resize,
    setField: setField, setDecor: setDecor,
    cast: cast, beginWait: beginWait, bite: bite, floatNudge: floatNudge,
    beginFight: beginFight, endFight: endFight,
    splash: splash, sparkle: sparkle, showShadow: showShadow,
    setRodBend: setRodBend, getRodTip: getRodTip, getFloat: getFloat,
    state: S,
  };
})();
