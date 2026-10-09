/* =========================================================
   panels.js  —  各类弹层：钓场 / 图鉴 / 商店 / 统计 / 设置 / 结算卡
   ========================================================= */
window.G = window.G || {};

G.Panels = (function () {
  var U = G.U, St = G.State, CFG = G.CONFIG;
  var modal, titleEl, bodyEl, closeBtn;
  var appEl;      // #app —— 「面板开着」这个全局态挂在它身上（底栏禁用态的样式靠它选）
  var catchCard, catchCanvas;
  var current = null;
  var onCloseCb = null;

  /* 钓场等级配色 —— **只此一份**。
     原先在「钓场选择」「图鉴·各钓场进度」「统计·各钓场进度」三处各写了一遍，
     而且兜底色还不一样（一处 #1f8fd6、一处 #8b98a5、一处干脆没有兜底）。
     加一个新等级时只要漏改一处，同一张卡片就会在不同面板里变色。 */
  var FIELD_RANK_COLOR = { D:'#8b98a5', C:'#5aa9d6', B:'#3f8f5f', A:'#2b6fc4', S:'#3b4a8f', SS:'#5b3fa8', SSS:'#a87a1f' };
  function rankColor(rank) { return FIELD_RANK_COLOR[rank] || '#8b98a5'; }

  /* 钓场解锁门槛 —— **从钓场数据现算**，绝不在文案里写死。
     规则：普通钓场「本场图鉴 ≥ collectionPct 就解锁下一个」，
           隐藏钓场（requireFull）需要前置钓场全部收满。
     ⚠️ 「钓场选择」页原来把「80%」「SS / SSS」「七个钓场」三样全写死在说明里，
        而同一页的钓场卡片读的是 `f.collectionPct` / `G.FIELDS` ——
        改一次数据，说明和卡片就会分家（与 verify 第 ㉙ 节盯的
        「挂机 ×0.95 / 离线 8 小时」是同一类问题）。 */
  function fieldGateText() {
    var normal = null, full = null, hiddenRanks = [];
    G.FIELDS.forEach(function (f) {
      if (f.requireFull) {                       // 隐藏钓场：前置全部收满
        hiddenRanks.push(f.rank);
        if (full == null || f.collectionPct > full) full = f.collectionPct;
      } else if (f.requires != null) {           // 普通钓场：前置那一场达到 N%
        if (normal == null || f.collectionPct > normal) normal = f.collectionPct;
      }
    });
    return {
      normal: normal == null ? '—' : Math.round(normal * 100) + '%',
      full: full == null ? '—' : Math.round(full * 100) + '%',
      hiddenRanks: hiddenRanks.length ? hiddenRanks.join(' / ') : '隐藏钓场',
      count: G.FIELDS.length,
    };
  }

  /* 小时 → 中文时长 */
  function fmtH(h) {
    if (!h) return '—';
    if (h < 1) return Math.round(h * 60) + ' 分钟';
    if (h < 24) return (Math.round(h * 10) / 10) + ' 小时';
    return (Math.round(h / 24 * 10) / 10) + ' 天';
  }

  /* 水族箱产出可能是个位数，「四舍五入」会把 0.7 显示成 1、把 0 也显示成整数，
     玩家看不出这个系统到底在不在工作。小于 100 时保留一位小数。 */
  function fmtYield(v) {
    if (!(v > 0)) return '0';
    if (v >= 100) return U.coin(v);
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  function init() {
    modal = U.$('#modal');
    appEl = U.$('#app');
    titleEl = U.$('#modalTitle');
    bodyEl = U.$('#modalBody');
    closeBtn = U.$('#modalClose');
    catchCard = U.$('#catchCard');
    catchCanvas = U.$('#catchCanvas');

    U.on(closeBtn, 'click', function () { G.Audio.click(); close(); });
    U.on(modal, 'click', function (e) { if (e.target === modal) close(); });
    U.on(document, 'keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function isOpen() { return !modal.classList.contains('hidden'); }
  function currentView() { return current; }

  /* 只重绘当前弹层，不重置任何筛选状态（refresh 用） */
  function renderCurrent(arg) {
    if (!current || !VIEWS[current]) return;
    var def = VIEWS[current];
    titleEl.textContent = typeof def.title === 'function' ? def.title(arg) : def.title;
    bodyEl.innerHTML = '';
    def.render(bodyEl, arg);
  }

  function open(name, arg) {
    current = name;
    var def = VIEWS[name];
    if (!def) return;
    /* 图鉴：每次打开都回到「当前钓场」的列表页（不保留上次的筛选/详情） */
    if (name === 'book') {
      bookFilter.field = St.get().field || 'ALL';
      bookFilter.sel = null;
      bookFilter.q = '';
      bookFilter.onlyNew = false;
    }
    /* 反正要整块重画了，排队等的那次 refresh 就没必要了 */
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = 0; }
    renderCurrent(arg);
    modal.classList.remove('hidden');
    /* 底栏进入禁用态（样式见 style.css 的 `#app.modal-open #deck`）——
       口径是「面板打开时底栏不可点」，但**必须画出来**：底栏被遮罩盖住后
       看起来仍然完全正常，玩家会连点几次并以为卡了。见 style.css 里那段注释。 */
    if (appEl) appEl.classList.add('modal-open');
    G.Audio.click();
  }

  function close() {
    /* ⚠️ 守卫只看 `tankRAF`（自己有没有在跑），**不再判 `cancelAnimationFrame` 在不在** ——
       那是「平台有没有这个能力」的问题，已经由 `G.Platform.sys.cancelRaf` 兜底（含空值）。 */
    if (tankRAF) { G.Platform.sys.cancelRaf(tankRAF); tankRAF = 0; }
    /* 面板关了就把列表的懒绘制观察器也断了（它一直握着已经脱离文档的节点） */
    if (netIO) { netIO.disconnect(); netIO = null; }
    /* 水族箱精灵跟着面板一起释放：它们只在这一次打开期间有用，
       而 dpr 换了（窗口拖到另一块屏）之后旧精度的图不能再用 —— close 时清掉最省事。 */
    tankSprites = {};
    modal.classList.add('hidden');
    if (appEl) appEl.classList.remove('modal-open');
    bodyEl.innerHTML = '';
    current = null;
    /* ⚠️ 这里**不要**把 onCloseCb 置空。它是 hud.js 在 init 时注册一次的
       「关面板时清掉顶栏标签页高亮」—— 原来写成一次性回调（调完就置 null），
       于是从第二次关面板开始，那个标签页会一直保持高亮。
       常驻回调就应该常驻；确实需要一次性的话，由回调自己负责注销。 */
    if (onCloseCb) onCloseCb();
  }

  /* ⚠️ 一次交互里 refresh() 常被喊好几遍 —— 点击回调自己喊一次，
     St 的 'net' 事件又让 main.js 喊一次（放生更狠：releaseNetAt 连发 'net' 和 'eco'，
     main.js 两个都订阅了）→ 同一个动作把整面板 DOM 重建 2~3 遍，纯浪费。
     这里合并成「一个 tick 最多重绘一次」：先排队，等当前调用栈跑完再画。 */
  var refreshTimer = 0;
  function refresh() {
    if (!isOpen() || refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = 0;
      if (isOpen()) renderCurrent();
    }, 0);
  }

  function setOnClose(fn) { onCloseCb = fn; }

  /* =========================================================
     钓场
     ========================================================= */
  var VIEWS = {};

  VIEWS.fields = {
    title: '选择钓场',
    render: function (root) {
      var s = St.get();
      var grid = U.el('div', 'field-grid');
      G.FIELDS.forEach(function (f) {
        var st = St.fieldState(f.id);
        var prog = st.prog;
        var card = U.el('div', 'field-card' + (st.unlocked ? '' : ' locked') + (s.field === f.id ? ' current' : ''));
        var pct = Math.round(prog.pct * 100);
        var need = f.collectionPct >= 1 ? prog.total : St.needCount(prog.total, f.collectionPct || 0.8);

        card.innerHTML =
          (s.field === f.id ? '<div class="fc-ribbon">当前</div>' : '') +
          '<div class="fc-top">' +
            '<div class="fc-rank" style="background:' + rankColor(f.rank) + '">' + f.rank + '</div>' +
            '<div><div class="fc-name">' + (f.hidden && !st.unlocked ? '？？？' : f.name) + '</div>' +
            '<div style="font-size:10px;color:#93a9b8">' + f.sub + '</div></div>' +
          '</div>' +
          '<div class="fc-desc">' + (f.hidden && !st.unlocked ? '未发现的隐藏钓场。' : f.desc) + '</div>' +
          '<div class="fc-bar"><i style="width:' + pct + '%;background:' + (prog.got >= need ? '#3fbf7f' : '#5aa9d6') + '"></i></div>' +
          '<div class="fc-foot"><span>图鉴 ' + prog.got + '/' + prog.total + '</span>' +
            (st.unlocked
              ? (s.field === f.id ? '<span class="ok">正在这里</span>' : '<span class="ok">可进入</span>')
              : '<span class="no">未解锁</span>') +
          '</div>' +
          '<div class="fc-legend">' +
            (f.estUnlockHours > 0
              ? '预计累计 <b>' + fmtH(f.estUnlockHours) + '</b> 解锁 ｜ 本场收满约 ' + fmtH(f.estOwnHours)
              : '起始钓场 ｜ 本场收满约 ' + fmtH(f.estOwnHours)) +
          '</div>' +
          (st.unlocked ? '' : '<div class="fc-legend" style="color:#e8595c">' + st.reason + '</div>');

        U.on(card, 'click', function () {
          if (!st.unlocked) { G.Audio.deny(); return; }
          if (s.field === f.id) { close(); return; }
          St.setField(f.id);
          G.Fishing.setField(f);
          G.Scene.setField(f);
          G.Audio.splash();
          close();
        });
        grid.appendChild(card);
      });
      root.appendChild(grid);

      var gate = fieldGateText();
      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '14px';
      tip.innerHTML =
        '<b>解锁规则</b>：本钓场图鉴收集达 <b>' + gate.normal + '</b> 即可解锁下一个钓场；' +
        '隐藏钓场 <b>' + gate.hiddenRanks + '</b> 需要前面所有钓场 <b>' + gate.full + '</b> 收满。<br>' +
        '<b>关于时长</b>：时长不是解锁门槛，只是按当前掉率算出来的<b>期望耗时</b>（' +
        '由 <code>tools/solve-drop.js</code> 反推、<code>tools/balance.js</code> 复核）。' +
        gate.count + ' 个钓场全部收满约 <b>' + fmtH(G.FIELDS[G.FIELDS.length - 1].estUnlockHours +
                                          G.FIELDS[G.FIELDS.length - 1].estOwnHours) + '</b>。<br>' +
        '累计解锁节奏：' +
        G.FIELDS.filter(function (f) { return f.estUnlockHours > 0; })
          .map(function (f) {
            return '<span class="lg" style="margin-left:4px">' + f.rank + ' <b>' + fmtH(f.estUnlockHours) + '</b></span>';
          }).join('');
      root.appendChild(tip);
    },
  };

  /* =========================================================
     图鉴
     ========================================================= */
  /* 图鉴筛选状态
     field:  null = 打开时自动定位到「当前钓场」（见 open()）
     sel:    当前展开的鱼种 id（鱼种详情页），null = 列表页 */
  var bookFilter = { field: null, rarity: -1, sel: null, q: '', onlyNew: false };

  /* 某鱼种「单竿钓到」的基础概率（不含鱼饵/鱼竿加成）
     = 该档位在场内的权重占比 × 该鱼在本档鱼种池里的权重占比 */
  function baseFishProb(f) {
    var fld = G.FIELD_MAP[f.field];
    if (!fld || !fld.rarity) return 0;
    var tot = 0, i;
    for (i = 0; i < fld.rarity.length; i++) tot += fld.rarity[i];
    if (tot <= 0) return 0;
    var bucket = (G.FISH_BY_FIELD_RARITY[f.field] || [])[f.rar] || [];
    var bw = 0;
    for (i = 0; i < bucket.length; i++) bw += (bucket[i].w || 0);
    if (bw <= 0) return 0;
    return (fld.rarity[f.rar] / tot) * ((f.w || 0) / bw);
  }

  /* 某条鱼的颜色概率总和（按它自己的稀有度取，避免归一化算出负数概率） */
  function colorTotalOf(rar) {
    var t = G.Loot.colorProbTotal(rar);
    return t > 0 ? t : 1;
  }

  /* 期望竿数文本 */
  function expCasts(p) {
    if (!p || p <= 0) return '—';
    var n = 1 / p;
    if (n < 10) return (Math.round(n * 10) / 10) + ' 竿';
    if (n < 10000) return Math.round(n) + ' 竿';
    if (n < 1e6) return (n / 10000).toFixed(2) + ' 万竿';
    return (n / 1e8).toFixed(2) + ' 亿竿';
  }

  /* 概率文本：自动选有效位数，避免「11.5368%」这种噪音，也不会把稀有鱼显示成 0.00% */
  function fmtPct(p) {
    if (!p || p <= 0) return '0%';
    var v = p * 100;
    if (v >= 10) return v.toFixed(1) + '%';
    if (v >= 1) return v.toFixed(2) + '%';
    if (v >= 0.01) return v.toFixed(3) + '%';
    if (v >= 0.0001) return v.toFixed(5) + '%';
    return v.toExponential(2) + '%';
  }

  /* 面板入参的数字兜底：面板既可能被带 payload 打开（main.js 传 offlineCatchUp
     的结果），也可能被 refresh() 这种「不带参数重绘」的路径调到 ——
     任何 undefined / NaN 都会把文案渲染成字面「NaN」或「undefined」。 */
  function numOr0(v) { return isFinite(v) ? v : 0; }

  /* 概率文案的「短版」：嵌在中文句子里用（0.01 → 1%、0.065 → 6.5%）。
     fmtPct() 是给列表单元格用的（会把 1% 补成 1.00%），嵌进句子太吵。 */
  function pctPlain(p) {
    if (!(p > 0)) return '0%';
    return (Math.round(p * 10000) / 100) + '%';
  }

  /* 图鉴里每个钓场一行的双进度（品种 / 品种×颜色）。配色走模块顶部的 rankColor()。 */
  function fkRow(f) {
    var p = St.fieldProgress(f.id);
    var c = St.fieldColorProgress(f.id);
    var locked = !St.get().unlocked[f.id];
    var name = (f.hidden && locked) ? '？？？' : f.name;
    return '<div class="fk-row' + (locked ? ' locked' : '') + '">' +
      '<span class="fk-rank" style="background:' + rankColor(f.rank) + '">' + f.rank + '</span>' +
      '<div class="fk-main">' +
        '<div class="fk-top">' +
          '<span class="fk-name">' + name + '</span>' +
          '<span class="fk-num">品种 <b>' + p.got + '</b>/' + p.total +
            '　颜色 <b>' + c.got + '</b>/' + c.total + '</span>' +
        '</div>' +
        '<div class="fk-bar"><i style="width:' + (p.pct * 100).toFixed(1) + '%;background:#1f8fd6"></i></div>' +
        '<div class="fk-bar"><i style="width:' + (c.pct * 100).toFixed(1) + '%;background:#8b5cf6"></i></div>' +
      '</div>' +
    '</div>';
  }

  /* 图鉴顶部的一条进度条（品种 / 品种×颜色 各一条） */
  function bkBar(label, note, got, total, color) {
    var pct = total ? got / total : 0;
    return '<div class="bk-bar-row">' +
      '<div class="bk-bar-top">' +
        '<span class="bk-bar-label">' + label + '</span>' +
        '<span class="bk-bar-num"><b>' + got + '</b> / ' + total +
          '<em>' + (pct * 100).toFixed(1) + '%</em></span>' +
      '</div>' +
      '<div class="bk-bar"><i style="width:' + (pct * 100).toFixed(2) + '%;background:' + color + '"></i></div>' +
      '<div class="bk-bar-note">' + note + '</div>' +
    '</div>';
  }

  /* 画图鉴网格里的一条鱼（拆出来是为了能按需懒绘制） */
  function paintBookItem(cv, f, e) {
    cv.setAttribute('data-drawn', '1');   // 供自测脚本确认懒绘制是否触发
    var ctx = cv.getContext('2d');
    var dpr = G.Platform.sys.dpr();
    cv.width = 260 * dpr; cv.height = 112 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (e) {
      /* 显示「最稀有已收集颜色」：colorMorphs 按常见→稀有排列，取下标最大的 */
      var best = null;
      CFG.colorMorphs.forEach(function (cm) {
        if (!(e.colors && e.colors[cm.key])) return;
        if (!best || CFG.colorMorphs.indexOf(cm) > CFG.colorMorphs.indexOf(best)) best = cm;
      });
      var amt = best && best.tint ? 0.75 : 0;
      G.FishArt.draw(ctx, f, 130, 56, 168, {
        tint: best && best.tint, tintAmt: amt, t: 0.6,
      });
    } else {
      G.FishArt.drawSilhouette(ctx, f, 130, 56, 168);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(91,116,136,.75)';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', 130, 64);
    }
  }

  /* ---------------- 鱼种详情页：看这一条鱼各种颜色的收集情况 ---------------- */
  function renderFishDetail(root, fid) {
    var f = G.FISH_ID[fid];
    if (!f) { bookFilter.sel = null; VIEWS.book.render(root); return; }

    var e = St.bookEntry(fid);
    var fld = G.FIELD_MAP[f.field] || {};
    var pFish = baseFishProb(f);
    var cTotal = colorTotalOf(f.rar);
    var gotColors = 0;
    if (e && e.colors) {
      CFG.colorMorphs.forEach(function (cm) { if (e.colors[cm.key]) gotColors++; });
    }

    /* ---- 返回条 ---- */
    var bar = U.el('div', 'fd-bar');
    var back = U.el('button', 'chip', '‹ 返回图鉴');
    U.on(back, 'click', function () { bookFilter.sel = null; G.Audio.click(); refresh(); });
    bar.appendChild(back);
    bar.appendChild(U.el('span', 'fd-bar-stat',
      '颜色收集 <b>' + gotColors + '</b> / ' + CFG.colorMorphs.length));
    root.appendChild(bar);

    /* ---- 鱼卡 ---- */
    var card = U.el('div', 'fd-card');

    var cv = G.Platform.canvas.create();
    cv.className = 'fd-canvas';
    cv.width = 380; cv.height = 190;
    card.appendChild(cv);

    /* 展示「已收集到的最稀有颜色」，没收集过就画剪影 */
    var best = null;
    CFG.colorMorphs.forEach(function (cm) {
      if (!(e && e.colors && e.colors[cm.key])) return;
      /* colorMorphs 按「常见 → 稀有」排列，下标越大越稀有，所以取下标最大的那个 */
      if (!best || CFG.colorMorphs.indexOf(cm) > CFG.colorMorphs.indexOf(best)) best = cm;
    });

    (function () {
      var dpr = G.Platform.sys.dpr();
      cv.width = 380 * dpr; cv.height = 190 * dpr;
      cv.style.width = '380px'; cv.style.height = '190px';
      var ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var g2 = ctx.createLinearGradient(0, 0, 0, 190);
      g2.addColorStop(0, '#eaf7ff'); g2.addColorStop(1, '#c6e9fb');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, 380, 190);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
      for (var i = 0; i < 4; i++) {
        ctx.beginPath();
        for (var x = 0; x <= 380; x += 10) {
          var y = 142 + i * 14 + Math.sin(x * 0.05 + i) * 3;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (e) {
        var amt = best && best.tint ? 0.75 : 0;
        G.FishArt.draw(ctx, f, 190, 90, 240, { tint: best && best.tint, tintAmt: amt, t: 0.8 });
      } else {
        G.FishArt.drawSilhouette(ctx, f, 190, 90, 240);
        ctx.fillStyle = 'rgba(91,116,136,.75)';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('?', 190, 100);
      }
    })();

    var info = U.el('div', 'fd-info');
    info.innerHTML =
      '<div class="fd-name">' + (e ? f.name : '？？？') + '</div>' +
      '<div class="fd-tags">' +
        '<span class="cc-tag rar' + f.rar + '">' + CFG.rarity[f.rar].name + '</span>' +
        '<span class="cc-tag plain">' + (fld.rank || '?') + ' ' + (fld.name || '未知钓场') + '</span>' +
        (best ? '<span class="cc-tag plain">最稀有已得：' + best.name + '</span>' : '') +
      '</div>' +
      '<div class="fd-rows">' +
        '<div class="fd-row"><span>体重区间</span><span>' + U.kg(f.minKg) + ' ~ ' + U.kg(f.maxKg) + '</span></div>' +
        '<div class="fd-row"><span>基础售价</span><span>' + U.coin(f.price) + ' 金</span></div>' +
        (e
          ? '<div class="fd-row"><span>你的纪录</span><span>' + U.kg(e.maxKg) + '</span></div>' +
            '<div class="fd-row"><span>累计钓获</span><span>' + e.n + ' 条</span></div>'
          : '<div class="fd-row"><span>状态</span><span style="color:#e8595c">尚未钓到</span></div>') +
        '<div class="fd-row"><span>单竿概率</span><span>' + fmtPct(pFish) + '　（约 ' +
          expCasts(pFish) + ' 一次）</span></div>' +
      '</div>';
    card.appendChild(info);
    root.appendChild(card);

    /* ---- 颜色收集清单 ---- */
    root.appendChild(U.el('div', 'section-title', '颜色收集'));

    var list = U.el('div', 'fd-colors');
    CFG.colorMorphs.forEach(function (cm) {
      var cnt = (e && e.colors && e.colors[cm.key]) || 0;
      var has = cnt > 0;
      var p = G.Loot.colorProb(cm, f.rar) / cTotal;
      var row = U.el('div', 'fd-color-row' + (has ? ' on' : ''));

      var sw = U.el('i', 'fd-swatch');
      sw.style.background = cm.tint || '#a9c7da';
      row.appendChild(sw);

      var main = U.el('div', 'fd-c-main');
      main.innerHTML =
        '<div class="fd-c-name">' + cm.name +
          (has ? '<em class="fd-yes">已收集 ' + cnt + ' 条</em>'
               : '<em class="fd-no">未收集</em>') + '</div>' +
        '<div class="fd-c-sub">出现概率 ' + fmtPct(p) + '　｜　售价 ×' +
          cm.valueMul.toFixed(2) + '　｜　约 ' + expCasts(pFish * p) + ' 钓到一条</div>';
      row.appendChild(main);

      list.appendChild(row);
    });
    root.appendChild(list);

    var tip = U.el('div', 'hint-text');
    tip.style.marginTop = '10px';
    /* ⚠️ 「闪光 1%、黄金 3%」是 colorMorphs 里普通档的真实概率，不能写死 ——
       同一页的每一行已经在用 fmtPct() 显示从 config 现算的概率了，
       只有这句说明里留了第二份真相（改概率时它一定会漂）。 */
    var cmShiny = G.Loot.colorByKey('shiny'), cmGolden = G.Loot.colorByKey('golden');
    tip.innerHTML = '概率是这条鱼<b>所属稀有度档位（' + CFG.rarity[f.rar].name + '）</b>的数值 —— ' +
                    '<b>鱼越稀有，出稀有颜色的概率越高</b>（普通鱼基准：' +
                    cmShiny.name + ' ' + pctPlain(G.Loot.colorProb(cmShiny, 0)) + '、' +
                    cmGolden.name + ' ' + pctPlain(G.Loot.colorProb(cmGolden, 0)) + '）。<br>' +
                    '期望竿数按<b>基础掉率</b>计算，未计入鱼饵 / 鱼竿的稀有权重加成，实际会更快。' +
                    '颜色只影响外观与售价，<b>不参与钓场解锁</b>。';
    root.appendChild(tip);
  }

  VIEWS.book = {
    title: function () {
      return bookFilter.sel && G.FISH_ID[bookFilter.sel] ? G.FISH_ID[bookFilter.sel].name : '鱼类图鉴';
    },
    render: function (root) {
      /* 详情页 */
      if (bookFilter.sel) { renderFishDetail(root, bookFilter.sel); return; }

      var g = St.globalProgress();
      var colStat = St.colorProgress();

      var head = U.el('div', 'book-head');
      head.innerHTML =
        '<div style="flex:1 1 340px;min-width:280px">' +
          '<b style="font-size:15px">全图鉴收集进度</b>' +
          bkBar('品种', '钓场解锁只看这一条', g.got, g.total, '#1f8fd6') +
          bkBar('品种 × 颜色', '含颜色的完整收集（纯粹彩蛋）', colStat.got, colStat.total, '#8b5cf6') +
        '</div>';

      var filters = U.el('div', 'book-filters');

      /* 钓场筛选：各钓场在前，「全部钓场」放最后 */
      if (bookFilter.field == null) bookFilter.field = St.get().field || 'ALL';
      var fieldOpts = G.FIELDS.map(function (f) {
        return { k: f.id, n: f.rank + ' ' + f.name + (St.get().field === f.id ? ' ·当前' : '') };
      }).concat([{ k: 'ALL', n: '全部钓场' }]);
      fieldOpts.forEach(function (o) {
        var c = U.el('button', 'chip' + (bookFilter.field === o.k ? ' active' : ''), o.n);
        U.on(c, 'click', function () { bookFilter.field = o.k; refresh(); });
        filters.appendChild(c);
      });

      var rarRow = U.el('div', 'book-filters');
      rarRow.style.marginTop = '6px';
      [{ k: -1, n: '全部稀有度' }].concat(CFG.rarity.map(function (r, i) { return { k: i, n: r.name }; }))
        .forEach(function (o) {
          var c = U.el('button', 'chip' + (bookFilter.rarity === o.k ? ' active' : ''), o.n);
          U.on(c, 'click', function () { bookFilter.rarity = o.k; refresh(); });
          rarRow.appendChild(c);
        });

      head.appendChild(filters);
      root.appendChild(head);

      /* 各钓场各自的图鉴比例（上面两条是全局总比例） */
      var fk = U.el('div', 'field-progress');
      fk.innerHTML = '<div class="fk-title">各钓场进度</div>' +
        '<div class="fk-grid">' + G.FIELDS.map(fkRow).join('') + '</div>' +
        '<div class="fk-legend">' +
          '<span><i style="background:#1f8fd6"></i>品种（解锁条件看这个）</span>' +
          '<span><i style="background:#8b5cf6"></i>品种 × 颜色</span>' +
        '</div>';
      root.appendChild(fk);

      root.appendChild(rarRow);

      /* ---- 搜索 + 只看未收集 ---- */
      var tools = U.el('div', 'book-tools');
      var inp = U.el('input', 'bk-search');
      inp.type = 'search';
      inp.placeholder = '搜索鱼名…';
      inp.value = bookFilter.q || '';
      /* 只重绘列表，不重绘整个面板 —— 否则输入框会失焦 */
      U.on(inp, 'input', function () { bookFilter.q = inp.value.trim(); paint(); });

      var onlyBtn = U.el('button', 'chip' + (bookFilter.onlyNew ? ' active' : ''), '只看未收集');
      U.on(onlyBtn, 'click', function () {
        bookFilter.onlyNew = !bookFilter.onlyNew;
        G.Audio.click();
        refresh();
      });

      var cnt = U.el('span', 'bk-count');
      tools.appendChild(inp);
      tools.appendChild(onlyBtn);
      tools.appendChild(cnt);
      root.appendChild(tools);

      var wrap = U.el('div', 'bk-list-wrap');
      root.appendChild(wrap);

      /* ---- 列表：懒绘制（362 个 canvas 一次性画会明显卡顿） ---- */
      var io = null;

      function paint() {
        var list = G.FISH.filter(function (f) {
          if (bookFilter.field !== 'ALL' && f.field !== bookFilter.field) return false;
          if (bookFilter.rarity >= 0 && f.rar !== bookFilter.rarity) return false;
          if (bookFilter.q && f.name.indexOf(bookFilter.q) < 0) return false;
          if (bookFilter.onlyNew && St.isCaught(f.id)) return false;
          return true;
        });

        if (io) { io.disconnect(); io = null; }
        wrap.innerHTML = '';
        cnt.textContent = '共 ' + list.length + ' 条';

        if (!list.length) {
          wrap.appendChild(U.el('div', 'empty-tip', '没有符合条件的鱼'));
          return;
        }

        if ('IntersectionObserver' in window) {
          io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              if (!en.isIntersecting) return;
              io.unobserve(en.target);
              if (en.target._paint) en.target._paint();
            });
          }, { root: bodyEl, rootMargin: '260px' });
        }

        var grid = U.el('div', 'book-grid');
        grid.style.marginTop = '14px';

        list.forEach(function (f) {
          var e = St.bookEntry(f.id);
          var item = U.el('div', 'book-item' + (e ? '' : ' unknown'));
          /* 点进详情：看这一条鱼各种颜色的收集情况 */
          U.on(item, 'click', function () {
            bookFilter.sel = f.id;
            G.Audio.click();
            refresh();
          });

          var cv = G.Platform.canvas.create();
          cv.width = 260; cv.height = 112;
          cv.className = 'bi-canvas';
          item.appendChild(cv);

          var sub = U.el('div', 'bi-name', e ? f.name : '？？？');
          item.appendChild(sub);
          var tag = U.el('div', 'bi-tag rar' + f.rar, e ? CFG.rarity[f.rar].name : '未发现');
          item.appendChild(tag);

          var colorsRow = U.el('div', 'bi-colors');
          CFG.colorMorphs.forEach(function (cm) {
            var has = !!(e && e.colors && e.colors[cm.key]);
            var dot = U.el('i', has ? 'on' : '');
            dot.style.background = cm.tint || '#a9c7da';
            dot.title = cm.name + (has ? ' ✓ 已收集' : ' ✗ 未收集');
            colorsRow.appendChild(dot);
          });
          item.appendChild(colorsRow);

          var gotColors = e ? CFG.colorMorphs.filter(function (c) {
            return e.colors && e.colors[c.key];
          }).length : 0;
          item.title = f.name + '　颜色 ' + gotColors + '/' + CFG.colorMorphs.length;

          if (e) {
            var rec = U.el('div', 'bi-record', '最大 ' + U.kg(e.maxKg) + ' · ' + e.n + ' 条');
            item.appendChild(rec);
          } else {
            var c0 = U.el('div', 'bi-sub', '体重 ' + U.kg(f.minKg) + '~' + U.kg(f.maxKg));
            item.appendChild(c0);
          }

          item._paint = function () { paintBookItem(cv, f, e); };
          if (io) io.observe(item); else item._paint();

          grid.appendChild(item);
        });

        wrap.appendChild(grid);
      }

      paint();

      var lg = U.el('div', 'legend-list');
      lg.style.marginTop = '14px';
      CFG.rarity.forEach(function (r, i) {
        lg.innerHTML += '<span class="lg"><i style="background:' + r.color + '"></i>' + r.name + '</span>';
      });
      CFG.colorMorphs.forEach(function (c) {
        lg.innerHTML += '<span class="lg"><i style="background:' + (c.tint || '#8b98a5') + '"></i>' + c.name +
                        ' ' + fmtPct(G.Loot.colorProb(c, 0)) + '　售价 ×' + c.valueMul.toFixed(2) + '</span>';
      });
      root.appendChild(lg);
      var ctip = U.el('div', 'hint-text');
      ctip.style.marginTop = '8px';
      ctip.innerHTML = '每种鱼最多可能有 ' + CFG.colorMorphs.length +
                       ' 种颜色。图鉴里显示的图案是<b>你收集到的最稀有颜色</b>，下面 ' + CFG.colorMorphs.length +
                       ' 个小圆点代表该颜色的收集状态。<b>点任意一条鱼可以查看它的颜色收集详情</b>。<br>' +
                       '<b>颜色概率随鱼的稀有度提高</b> —— 下面的概率是<b>普通鱼</b>的基准值，' +
                       '稀有 / 史诗 / 传说的鱼出闪光、黄金的概率更高。颜色只影响外观和售价，<b>不影响解锁</b>。';
      root.appendChild(ctip);
    },
  };

  /* =========================================================
     鱼护 / 水族箱
     ========================================================= */
  var tankRAF = 0;

  /* 水族箱里每条鱼的**离屏精灵**。
     ⚠️ 为什么能缓存：drawTank 传给 `FishArt.draw` 的 `t` 是常量 0.8 —— 每条鱼的
        形状完全静态，每帧重画只是在白烧（实测满仓 24 条：单次 0.030ms、
        每帧 0.71ms、**每秒 42.5ms ≈ 4.3% CPU**，全是同一张图重画 60 遍）。
        改成首帧画一次、之后每帧 `drawImage`。做法与 `Scene` 的 `lanternGlow()` 同套。
     ⚠️ 包围盒必须留够：鱼体在 `(0,0)` 两侧并不对称（约 −0.5L ~ +0.86L，尾巴更长），
        所以半宽取 0.86L；发光鱼（`fish.glow`）还有 `shadowBlur = L*0.55` 的外晕，
        不留 pad 会在精灵边界切出一道硬边。
     生命周期跟着面板走：`renderNet` 开头清空（卖出 / 取出会整块重绘）。 */
  var tankSprites = {};
  function tankSprite(fish, cm, L) {
    var key = fish.id + '|' + (cm ? cm.key : 'n') + '|' + Math.round(L);
    var sp = tankSprites[key];
    if (sp) return sp;
    var pad = (fish.glow ? 0.62 : 0.20) * L;
    var w = Math.max(8, Math.round(2 * (0.86 * L + pad)));
    var h = Math.max(8, Math.round(2 * (0.45 * L + pad)));
    var dpr = G.Platform.sys.dpr();
    var c = G.Platform.canvas.create(Math.round(w * dpr), Math.round(h * dpr));
    var c2 = c.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    G.FishArt.draw(c2, fish, w / 2, h / 2, L, {
      tint: cm && cm.tint, tintAmt: cm && cm.tint ? 0.75 : 0, t: 0.8,
    });
    sp = { cv: c, w: w, h: h };
    tankSprites[key] = sp;
    return sp;
  }

  /* 鱼护 / 水族箱每一行的小图：与图鉴一样走 IntersectionObserver 懒绘制。
     原先是每行一个 `setTimeout(miniFish, 0)` —— 满格时一次建 N 个定时器，
     而且面板已经关掉之后，那些脱离文档的 canvas 还会被画一遍（白跑）。
     ⚠️ 懒绘制的 canvas 必须**先定好尺寸**：不设 width/height 的话浏览器会给
     300×150 的默认值，行高会先被撑开、画完再回落。 */
  var netIO = null;

  var MINI_W = 96, MINI_H = 52;

  /* 定尺寸并返回 dpr（建列表时与真正绘制时都要先走这一遍） */
  function miniSize(cv) {
    var dpr = G.Platform.sys.dpr();
    cv.width = MINI_W * dpr; cv.height = MINI_H * dpr;
    cv.style.width = MINI_W + 'px'; cv.style.height = MINI_H + 'px';
    return dpr;
  }

  /* 画一条鱼的小图标（列表用） */
  function miniFish(cv, entry) {
    var fish = G.FISH_ID[entry.f];
    if (!fish) return;
    var cm = G.Loot.colorByKey(entry.c);
    var ctx = cv.getContext('2d');
    var dpr = miniSize(cv);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MINI_W, MINI_H);
    G.FishArt.draw(ctx, fish, MINI_W / 2, MINI_H / 2, MINI_W * 0.9, {
      tint: cm && cm.tint, tintAmt: cm && cm.tint ? 0.75 : 0, t: 0.6,
    });
  }

  function renderNet(root) {
    var s = St.get();

    /* 每次整块重绘都要换一个观察器：旧的连着已废的 DOM 节点。
       （回调里 unobserve 用局部 io，别用 netIO —— 重绘后它已经指向新的了） */
    if (netIO) { netIO.disconnect(); netIO = null; }
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          if (en.target._paint) en.target._paint();
        });
      }, { root: bodyEl, rootMargin: '260px' });
      netIO = io;
    }
    var netN = St.netCount(), tankN = St.tankCount();
    var yieldPerHour = St.tankYieldPerHour();

    /* ---- 顶部：两种收集货币 + 水族箱产出 ---- */
    var top = U.el('div', 'stat-grid');
    top.innerHTML =
      '<div class="stat-box"><div class="sb-label">生态值</div><div class="sb-value">' +
        U.num(s.eco || 0) + '</div></div>' +
      '<div class="stat-box"><div class="sb-label">纪念币</div><div class="sb-value">' +
        U.num(s.medals || 0) + '<small>枚</small></div></div>' +
      '<div class="stat-box"><div class="sb-label">水族箱产出</div><div class="sb-value">' +
        fmtYield(yieldPerHour) + '<small>金/时</small></div></div>' +
      '<div class="stat-box"><div class="sb-label">累计放生</div><div class="sb-value">' +
        U.num(s.stats.released || 0) + '<small>条</small></div></div>';
    root.appendChild(top);

    var ecoTip = U.el('div', 'hint-text');
    ecoTip.style.margin = '8px 0 4px';
    ecoTip.innerHTML = '放生鱼护里的鱼能得到 <b>生态值</b>，它只能换<b>限定装饰</b>（纯外观），' +
      '换不到金币 / 鱼饵 / 装备。鱼越稀有、越鲜艳、越重，给得越多。';
    root.appendChild(ecoTip);

    /* ---- 鱼护 ---- */
    var head = U.el('div', 'net-head');
    var cost = St.netExpandCost();
    head.innerHTML =
      '<div><b style="font-size:15px">鱼护</b>' +
        '<div class="net-sub">钓到的鱼可以留在这里，随时卖出、放生，或移进水族箱</div></div>' +
      '<div class="net-cap"><b>' + netN + '</b> / ' + s.netCap + '</div>';
    root.appendChild(head);

    var bar = U.el('div', 'bk-bar');
    bar.style.marginTop = '6px';
    bar.innerHTML = '<i style="width:' + (s.netCap ? netN / s.netCap * 100 : 0) +
                    '%;background:#1f8fd6"></i>';
    root.appendChild(bar);

    var acts = U.el('div', 'net-actions');
    var allVal = St.netValue();
    var btnAll = U.el('button', 'btn-ghost', '全部卖出　+' + U.coin(allVal) + ' 金');
    btnAll.disabled = netN === 0;
    U.on(btnAll, 'click', function () {
      var got = St.sellAllNet();
      G.Audio.coin();
      if (got) G.State.emit('toast', { text: '鱼护清空，入账 ' + U.coin(got) + ' 金', kind: 'good' });
      refresh();
    });
    var btnEx = U.el('button', 'btn-ghost',
      cost == null ? '鱼护已扩到最大' : '扩容 +' + CFG.storage.netStep + ' 格　' + U.coin(cost) + ' 金');
    btnEx.disabled = cost == null;
    U.on(btnEx, 'click', function () {
      var r = St.expandNet();
      if (!r.ok) { G.Audio.deny(); G.State.emit('toast', { text: r.msg, kind: 'bad' }); return; }
      G.Audio.coin();
      G.State.emit('toast', { text: '鱼护扩容到 ' + r.cap + ' 格', kind: 'good' });
      refresh();
    });
    acts.appendChild(btnAll);
    acts.appendChild(btnEx);
    root.appendChild(acts);

    if (!netN) {
      root.appendChild(U.el('div', 'empty-tip', '鱼护是空的。钓到鱼时选「收进鱼护」就会放进来'));
    } else {
      var list = U.el('div', 'net-list');
      /* 新的排前面 */
      var idxs = s.net.map(function (_, i) { return i; }).reverse();
      idxs.forEach(function (i) {
        var entry = s.net[i];
        var fish = G.FISH_ID[entry.f];
        if (!fish) return;
        var cm = G.Loot.colorByKey(entry.c);
        var row = U.el('div', 'net-row');

        /* ⚠️ 下标**点击时现查**（`curIdx`），不许用渲染时闭包里的 `i`：
           `refresh()` 是 setTimeout(0) 排队的 —— 状态变了、DOM 还没重建，
           这个窗口里再点同一行，旧下标会落在**另一条鱼**身上
           （例：卖掉排在第 0 位的那条后，它下面那行的旧下标 0 现在指向另一条鱼，
             「卖出」toast 还印着旧名字）。条目对象是稳定的，`indexOf` 才是真相；
           已被本窗口里上一次点击卖掉 / 放生的（indexOf = -1）只响拒绝音。 */
        function curIdx() { return s.net.indexOf(entry); }
        var cv = G.Platform.canvas.create();
        miniSize(cv);                    // 先定尺寸，别让默认的 300×150 撑开行高
        row.appendChild(cv);

        var info = U.el('div', 'net-info');
        info.innerHTML =
          '<div class="net-name">' + fish.name +
            '<span class="cc-tag rar' + fish.rar + '">' + CFG.rarity[fish.rar].name + '</span></div>' +
          '<div class="net-meta">' + (cm ? cm.name : '原色') + '　·　' + U.kg(entry.kg) +
            '　·　<span class="net-price">' + U.coin(St.netPrice(entry)) + ' 金</span></div>';
        row.appendChild(info);

        var ops = U.el('div', 'net-ops');
        function mkBtn(label, cls, fn) {
          var b = U.el('button', 'mini-btn' + (cls ? ' ' + cls : ''), label);
          U.on(b, 'click', fn);
          ops.appendChild(b);
        }
        mkBtn('卖出', '', function () {
          var k = curIdx();
          if (k < 0) { G.Audio.deny(); return; }
          var p = St.sellNetAt(k);
          G.Audio.coin();
          G.State.emit('toast', { text: '卖出 ' + fish.name + '，+' + U.coin(p) + ' 金', kind: 'good' });
          refresh();
        });
        mkBtn('放生 +' + St.ecoValue(entry), 'ghost', function () {
          var k = curIdx();
          if (k < 0) { G.Audio.deny(); return; }
          var r = St.releaseNetAt(k);
          if (!r.ok) return;
          G.Audio.splash();
          G.State.emit('toast', { text: '放生了 ' + fish.name + '　生态值 +' + U.num(r.eco), kind: 'good' });
          refresh();
        });
        mkBtn('进水族箱', 'ghost', function () {
          var k = curIdx();
          if (k < 0) { G.Audio.deny(); return; }
          if (!St.moveToTank(k)) {
            G.Audio.deny();
            G.State.emit('toast', { text: '水族箱满了，先扩容或取出几条', kind: 'warn' });
            return;
          }
          G.Audio.click();
          refresh();
        });
        if (St.tankFull()) ops.lastChild.disabled = true;

        row.appendChild(ops);
        list.appendChild(row);
        cv._paint = function () { miniFish(cv, entry); };
        if (io) io.observe(cv); else cv._paint();
      });
      root.appendChild(list);
    }

    /* ---- 水族箱 ---- */
    var th = U.el('div', 'net-head');
    th.style.marginTop = '22px';
    var tcost = St.tankExpandCost();
    th.innerHTML =
      '<div><b style="font-size:15px">水族箱</b>' +
        '<div class="net-sub">挑几条最喜欢的鱼养在这里 —— 它们会一直在水里游，' +
          '而且按身价每小时产出金币（离线最多补算 ' +
          Math.round(CFG.idle.maxCatchUp / 3600) + ' 小时）</div></div>' +
      '<div class="net-cap"><b>' + tankN + '</b> / ' + s.tankCap + '</div>';
    root.appendChild(th);

    var tbar = U.el('div', 'bk-bar');
    tbar.style.marginTop = '6px';
    tbar.innerHTML = '<i style="width:' + (s.tankCap ? tankN / s.tankCap * 100 : 0) +
                     '%;background:#8b5cf6"></i>';
    root.appendChild(tbar);

    var tacts = U.el('div', 'net-actions');
    var btnTex = U.el('button', 'btn-ghost',
      tcost == null ? '水族箱已扩到最大' : '扩容 +' + CFG.storage.tankStep + ' 格　' + U.coin(tcost) + ' 金');
    btnTex.disabled = tcost == null;
    U.on(btnTex, 'click', function () {
      var r = St.expandTank();
      if (!r.ok) { G.Audio.deny(); G.State.emit('toast', { text: r.msg, kind: 'bad' }); return; }
      G.Audio.coin();
      G.State.emit('toast', { text: '水族箱扩容到 ' + r.cap + ' 格', kind: 'good' });
      refresh();
    });
    tacts.appendChild(btnTex);
    root.appendChild(tacts);

    var wrap = U.el('div', 'tank-wrap');
    var box = G.Platform.canvas.create();
    box.className = 'tank-canvas';
    wrap.appendChild(box);
    if (!tankN) {
      var empty = U.el('div', 'tank-empty', '空的。把鱼护里的鱼「进水族箱」就会出现在这里');
      wrap.appendChild(empty);
    }
    root.appendChild(wrap);

    /* 水族箱动画：面板打开时跑，关闭自动停 */
    if (tankRAF) G.Platform.sys.cancelRaf(tankRAF);
    var items = s.tank.map(function (e) {
      return { e: e, ph: Math.random() * 6.28, sp: 0.35 + Math.random() * 0.5, y: 0.25 + Math.random() * 0.5 };
    });
    /* t0 与下面 `drawTank(now)` 收到的帧时间戳同源（都走平台时钟），
       差值才是真的相位秒数 —— 别在一边换成 Date.now()。 */
    var t0 = G.Platform.sys.now();
    /* 水体的渐变只跟画布高度有关 —— 按尺寸缓存，别每帧新建。
       口径与 scene.js 的 `grad()` 缓存工厂一致：渲染路径里不许造渐变对象。
       （verify 第 ⑰ 节会扫这段的源码断言。） */
    var waterGrad = null, waterGradH = -1;
    /* 空的鱼缸里没有会动的东西 —— 尺寸没变就别重画。
       原来无条件每帧把水 + 亮带 + 沙全画一遍，面板开着时每秒 60 次纯浪费；
       但也不能「只画一帧」：窗口缩放时画布该跟着重新铺水，不能一直糊着旧尺寸。
       所以走「按需重绘」：每帧只做一次尺寸比较，真的变了才画。 */
    var tankPainted = false, tankW = -1, tankH = -1;
    function drawTank(now) {
      if (!isOpen() || current !== 'net') { tankRAF = 0; return; }
      tankRAF = G.Platform.sys.raf(drawTank);
      var dpr = G.Platform.sys.dpr();
      var Wp = box.clientWidth || 320, Hp = box.clientHeight || 170;
      if (!tankN && tankPainted && Wp === tankW && Hp === tankH) return;
      tankPainted = true; tankW = Wp; tankH = Hp;
      if (box.width !== Wp * dpr || box.height !== Hp * dpr) {
        box.width = Wp * dpr; box.height = Hp * dpr;
      }
      var ctx = box.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var tt = (now - t0) / 1000;

      /* 水与沙 */
      if (waterGradH !== Hp) {
        waterGrad = ctx.createLinearGradient(0, 0, 0, Hp);
        waterGrad.addColorStop(0, '#dff1fb'); waterGrad.addColorStop(1, '#8fc7e6');
        waterGradH = Hp;
      }
      ctx.fillStyle = waterGrad; ctx.fillRect(0, 0, Wp, Hp);
      ctx.fillStyle = 'rgba(255,244,200,.45)';
      ctx.beginPath();
      for (var x = 0; x <= Wp; x += 8) {
        var y = 16 + Math.sin(x * 0.035 + tt * 1.2) * 5;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(Wp, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#eadcc0';
      ctx.beginPath(); ctx.ellipse(Wp * 0.5, Hp + 4, Wp * 0.62, 26, 0, 0, 6.3); ctx.fill();

      items.forEach(function (it, i) {
        var fish = G.FISH_ID[it.e.f];
        if (!fish) return;
        var cm = G.Loot.colorByKey(it.e.c);
        var span = Wp - 90;
        var px = 45 + ((tt * it.sp * 46 + i * 137) % span);
        var py = Hp * it.y + Math.sin(tt * 1.7 + it.ph) * 7;
        var L = Math.min(74, 26 + Math.log(1 + it.e.kg) * 11);
        var dir = Math.cos(tt * it.sp * 1.1 + it.ph) >= 0 ? 1 : -1;
        var sp = tankSprite(fish, cm, L);
        ctx.save();
        ctx.translate(px, py);
        if (dir < 0) ctx.scale(-1, 1);
        ctx.drawImage(sp.cv, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
        ctx.restore();
      });
    }
    tankRAF = G.Platform.sys.raf(drawTank);

    /* 水族箱里的鱼：取出 / 直接卖 */
    if (tankN) {
      var tlist = U.el('div', 'net-list');
      s.tank.forEach(function (entry, i) {
        var fish = G.FISH_ID[entry.f];
        if (!fish) return;
        var cm = G.Loot.colorByKey(entry.c);
        var row = U.el('div', 'net-row');
        var cv2 = G.Platform.canvas.create();
        miniSize(cv2);                   // 同上：先定尺寸
        row.appendChild(cv2);
        var info2 = U.el('div', 'net-info');
        info2.innerHTML =
          '<div class="net-name">' + fish.name +
            '<span class="cc-tag rar' + fish.rar + '">' + CFG.rarity[fish.rar].name + '</span></div>' +
          '<div class="net-meta">' + (cm ? cm.name : '原色') + '　·　' + U.kg(entry.kg) +
            '　·　<span class="net-price">' + U.coin(St.netPrice(entry)) + ' 金</span></div>';
        row.appendChild(info2);
        var ops2 = U.el('div', 'net-ops');
        /* ⚠️ 与鱼护列表同一坑：下标点击时现查（refresh 是 setTimeout(0) 排队的） */
        function curTankIdx() { return s.tank.indexOf(entry); }
        var bOut = U.el('button', 'mini-btn ghost', '取出');
        U.on(bOut, 'click', function () {
          var k = curTankIdx();
          if (k < 0) { G.Audio.deny(); return; }
          if (!St.takeFromTank(k)) {
            G.Audio.deny();
            G.State.emit('toast', { text: '鱼护满了，先卖几条', kind: 'warn' });
            return;
          }
          G.Audio.click(); refresh();
        });
        bOut.disabled = St.netFull();
        var bSell = U.el('button', 'mini-btn', '卖出');
        U.on(bSell, 'click', function () {
          var k = curTankIdx();
          if (k < 0) { G.Audio.deny(); return; }
          var p = St.sellTankAt(k);
          G.Audio.coin();
          G.State.emit('toast', { text: '卖出 ' + fish.name + '，+' + U.coin(p) + ' 金', kind: 'good' });
          refresh();
        });
        ops2.appendChild(bOut); ops2.appendChild(bSell);
        row.appendChild(ops2);
        tlist.appendChild(row);
        cv2._paint = function () { miniFish(cv2, entry); };
        if (io) io.observe(cv2); else cv2._paint();
      });
      root.appendChild(tlist);
    }
  }

  VIEWS.net = { title: '鱼护 · 水族箱', render: renderNet };

  /* =========================================================
     商店
     ========================================================= */
  var shopTab = 'bait';

  VIEWS.shop = {
    title: '钓具商店',
    render: function (root) {
      var s = St.get();
      var tabs = U.el('div', 'shop-tabs');
      [['bait', '鱼饵'], ['rod', '鱼竿'], ['line', '鱼线'], ['decor', '装饰'], ['paid', '付费内容']]
        .forEach(function (t) {
          var c = U.el('button', 'chip' + (shopTab === t[0] ? ' active' : ''), t[1]);
          U.on(c, 'click', function () { shopTab = t[0]; refresh(); });
          tabs.appendChild(c);
        });
      root.appendChild(tabs);

      var list = U.el('div', 'shop-list');

      function shopRow(icon, name, desc, rightHtml, onBuy, cls) {
        var row = U.el('div', 'shop-item' + (cls || ''));
        row.innerHTML = '<div class="sh-ico">' + icon + '</div>' +
          '<div class="sh-main"><div class="sh-name">' + name + '</div><div class="sh-desc">' + desc + '</div></div>';
        var btnWrap = U.el('div', '', rightHtml);
        row.appendChild(btnWrap);
        var b = btnWrap.querySelector('button');
        if (b && onBuy) U.on(b, 'click', onBuy);
        list.appendChild(row);
        return row;
      }

      if (shopTab === 'bait') {
        G.BAITS.forEach(function (b) {
          var have = St.baitCount(b.id);
          var mine = b.free || s.baitSel === b.id;
          var right;
          if (b.free) right = '<button class="sh-buy' + (s.baitSel === b.id ? ' equipped' : ' equip') + '">' +
                              (s.baitSel === b.id ? '使用中' : '选用') + '</button>' +
                              '<div class="sh-price" style="text-align:center;margin-top:4px">无限</div>';
          /* ⚠️ 付费饵要能看出「现在用的就是它」：装备态给按钮上绿色（.equipped），
             价格行补「使用中」小字；持有但没在用的补一颗「选用」——
             它在购买按钮之后，shopRow 绑的是第一个按钮（购买），所以这里要自己接。 */
          else if (s.baitSel === b.id) {
            right = '<button class="sh-buy equipped">买 ' + b.pack + ' 个</button>' +
                    '<div class="sh-price" style="text-align:center;margin-top:4px">' +
                    U.coin(b.price * b.pack) + ' 金 · 使用中</div>';
          } else {
            right = '<button class="sh-buy">买 ' + b.pack + ' 个</button>' +
                    (have > 0 ? '<button class="sh-buy equip sh-equip">选用</button>' : '') +
                    '<div class="sh-price" style="text-align:center;margin-top:4px">' +
                    U.coin(b.price * b.pack) + ' 金</div>';
          }
          /* ⚠️ 叫「咬口时间」不叫「上鱼速度」：speed 乘的是**等待时间**（越小越快），
             写成「速度 ×0.56」方向正好说反（看着像砍了 44% 速度，实际是快了 79%）。 */
          var desc = b.desc + ' ｜ 咬口时间 ×' + b.speed.toFixed(2) +
                     ' ｜ 稀有权重 ×' + b.rareMul.toFixed(2) +
                     (b.legendMul > 1 ? ' ｜ 传说 ×' + b.legendMul.toFixed(2) : '') +
                     ' ｜ 持有 ' + (b.free ? '∞' : have);
          var row = shopRow('🪱', b.name, desc, right, function () {
            if (b.free) { St.selectBait(b.id); G.Audio.click(); refresh(); G.State.emit('bait'); return; }
            var r = St.buyBait(b.id, 1);
            if (!r.ok) { G.Audio.deny(); G.State.emit('toast', { text: r.msg, kind: 'bad' }); return; }
            G.Audio.coin();
            G.State.emit('toast', { text: '购入 ' + b.name + ' ×' + r.amount, kind: 'good' });
            if (!St.baitCount(s.baitSel) && s.baitSel !== 'worm') St.selectBait(b.id);
            refresh();
          }, s.baitSel === b.id ? 'owned' : '');
          /* 「选用」是第二个按钮（第一个必须是购买 —— shopRow 只绑第一个），自己接 */
          var eq = row.querySelector('.sh-equip');
          if (eq) U.on(eq, 'click', function () {
            St.selectBait(b.id); G.Audio.click(); refresh(); G.State.emit('bait');
          });
        });
      }

      if (shopTab === 'rod') {
        G.RODS.forEach(function (r) {
          var owned = s.rods.indexOf(r.id) >= 0;
          var right = owned
            ? '<button class="sh-buy' + (s.rodSel === r.id ? ' equipped' : ' equip') + '">' + (s.rodSel === r.id ? '使用中' : '装备') + '</button>'
            : '<button class="sh-buy"' + (s.coin < r.price ? ' disabled' : '') + '>购买</button>' +
              '<div class="sh-price" style="text-align:center;margin-top:4px">' + U.coin(r.price) + ' 金</div>';
          shopRow(r.icon, r.name, r.desc + ' ｜ 稀有权重 ×' + r.rareMul.toFixed(2) + ' ｜ 收线效率 ×' + r.reel.toFixed(2),
            right, function () {
              if (owned) { St.selectRod(r.id); G.Audio.click(); refresh(); return; }
              var res = St.buyRod(r.id);
              if (!res.ok) { G.Audio.deny(); G.State.emit('toast', { text: res.msg, kind: 'bad' }); return; }
              St.selectRod(r.id); G.Audio.coin();
              G.State.emit('toast', { text: '获得 ' + r.name, kind: 'good' });
              refresh();
            }, owned ? 'owned' : '');
        });
      }

      if (shopTab === 'line') {
        G.LINES.forEach(function (r) {
          var owned = s.lines.indexOf(r.id) >= 0;
          var right = owned
            ? '<button class="sh-buy' + (s.lineSel === r.id ? ' equipped' : ' equip') + '">' + (s.lineSel === r.id ? '使用中' : '装备') + '</button>'
            : '<button class="sh-buy"' + (s.coin < r.price ? ' disabled' : '') + '>购买</button>' +
              '<div class="sh-price" style="text-align:center;margin-top:4px">' + U.coin(r.price) + ' 金</div>';
          shopRow(r.icon, r.name, r.desc + ' ｜ 张力上限 ' + r.tensionMax, right, function () {
            if (owned) { St.selectLine(r.id); G.Audio.click(); refresh(); return; }
            var res = St.buyLine(r.id);
            if (!res.ok) { G.Audio.deny(); G.State.emit('toast', { text: res.msg, kind: 'bad' }); return; }
            St.selectLine(r.id); G.Audio.coin();
            G.State.emit('toast', { text: '获得 ' + r.name, kind: 'good' });
            refresh();
          }, owned ? 'owned' : '');
        });
      }

      if (shopTab === 'decor') {
        /* 当前两种收集货币的余额先亮出来，玩家才知道差多少（商店里要能直接看到） */
        var bal = U.el('div', 'hint-text');
        bal.style.margin = '0 0 6px';
        bal.innerHTML = St.curLabel('coin') + ' <b>' + U.coin(s.coin) + '</b>　·　' +
          St.curLabel('eco') + ' <b>' + U.num(s.eco || 0) + '</b>　·　' +
          St.curLabel('medal') + ' <b>' + U.num(s.medals || 0) + '</b>';
        root.appendChild(bal);

        var groups = [['coin', '金币装饰'], ['eco', '限定装饰 · 生态值'], ['medal', '限定装饰 · 纪念币']];
        groups.forEach(function (grp) {
          var items = G.DECORS.filter(function (x) { return St.decorCur(x) === grp[0]; });
          if (!items.length) return;
          var gh = U.el('div', 'section-title', grp[1] + '（' + items.length + '）');
          gh.style.marginTop = '16px';
          root.appendChild(gh);
          var gl = U.el('div', 'shop-list');
          items.forEach(function (r) {
            var owned = s.decors.indexOf(r.id) >= 0;
            var cur = St.decorCur(r);
            var have = St.curHave(cur);
            var priceTxt = cur === 'coin' ? (U.coin(r.price) + ' 金') : (r.price + ' ' + St.curLabel(cur));
            var right = owned ? '<button class="sh-buy equipped">已拥有</button>'
              : '<button class="sh-buy"' + (have < r.price ? ' disabled' : '') + '>购买</button>' +
                '<div class="sh-price" style="text-align:center;margin-top:4px">' + priceTxt + '</div>';
            var row = U.el('div', 'shop-item' + (owned ? ' owned' : ''));
            row.innerHTML = '<div class="sh-ico">' + r.icon + '</div>' +
              '<div class="sh-main"><div class="sh-name">' + r.name +
                (cur === 'coin' ? '' : '<em class="goal-tag">限定</em>') + '</div>' +
              '<div class="sh-desc">' + r.desc + '</div></div>';
            var bw = U.el('div', '', right);
            row.appendChild(bw);
            gl.appendChild(row);
            var btn = bw.querySelector('button');
            if (btn && !owned) U.on(btn, 'click', function () {
              var res = St.buyDecor(r.id);
              if (!res.ok) { G.Audio.deny(); G.State.emit('toast', { text: res.msg, kind: 'bad' }); return; }
              G.Audio.coin();
              G.State.emit('toast', { text: '获得装饰：' + r.name, kind: 'good' });
              G.Scene.setDecor(s.decors);
              refresh();
            });
          });
          root.appendChild(gl);
        });
        var tip = U.el('div', 'hint-text');
        tip.style.marginTop = '12px';
        tip.innerHTML = '装饰纯外观，购买后会<b>真实出现在钓场里</b>。<br>' +
          '「限定」装饰用金币买不到 —— 生态值靠<b>放生</b>攒，纪念币靠<b>每日任务</b>攒。';
        root.appendChild(tip);
      }

      if (shopTab === 'paid') {
        var m = CFG.monetization;
        var info = U.el('div', 'hint-text');
        info.innerHTML =
          '<b>本版本为单机版，全部付费点暂未开启</b>（' + (m.enabled ? '已开启' : '开关关闭') + '）。<br>' +
          '以下是策划案里的付费设计，代码里已预留接口，接小程序 / Steam 时再打开：<br><br>';
        /* ⚠️ 这里的数值必须来自 config / 道具表，不许写死在文案里。
           原来硬编码了 20% / 5% / 10%，还写着「已实现为鱼竿稀有权重 ×1.08~×1.45」——
           而 items.js 里鱼竿的实际区间是 ×1.06~×1.5，改数值时这两处一定会漂。
           视频兑换码 / 广告券同理，由 monetization 的开关决定文案。 */
        var pctOf = function (v) { return Math.round(v * 100) + '%'; };
        var rodBoosts = G.RODS.map(function (r) { return r.rareMul; })
          .filter(function (v) { return v > 1; });
        var rodRange = rodBoosts.length
          ? '×' + Math.min.apply(null, rodBoosts) + '~×' + Math.max.apply(null, rodBoosts)
          : '—';
        var rows = [
          ['🎣', '稀有鱼竿', '钓到稀有鱼的概率提高 ' + pctOf(m.rodRareBoost) +
            '（已实现为鱼竿稀有权重 ' + rodRange + '）'],
          ['📅', '月卡 · 自动挂机', '挂机自动帮上鱼，稀有鱼概率下降 ' + pctOf(m.idleRareCut) +
            '（' + (m.idleIsSubscribed ? '月卡功能' : '当前免费开放') + '）'],
          ['📤', '分享得鱼竿', '分享给好友可获得鱼竿，稀有鱼概率 +' + pctOf(m.shareRodBoost)],
          ['🎬', '视频兑换码', '做视频发布到平台可领取兑换码，解锁挂机自动上鱼' +
            (m.videoCode ? '' : '（策划案里已取消）')],
          /* ⚠️ 券的时长也读 config —— 「1 小时」原来写死在这句文案里，
             改了 monetization.adTicketHours 界面不会跟着变。 */
          ['📺', '看广告', '观看广告获得 ' + m.adTicketHours + ' 小时挂机券' +
            (m.adIdleTicket ? '' : '（策划案里已取消）')],
        ];
        rows.forEach(function (r) {
          var row = U.el('div', 'shop-item');
          row.innerHTML = '<div class="sh-ico">' + r[0] + '</div>' +
            '<div class="sh-main"><div class="sh-name">' + r[1] + '</div><div class="sh-desc">' + r[2] + '</div></div>' +
            '<div><button class="sh-buy" disabled>未开放</button></div>';
          list.appendChild(row);
        });
        root.appendChild(list);
        root.appendChild(info);
        return;
      }

      root.appendChild(list);
    },
  };

  /* =========================================================
     统计
     ========================================================= */
  VIEWS.stats = {
    title: '钓鱼记录',
    render: function (root) {
      var s = St.get(), st = s.stats;
      var gp = St.globalProgress();

      root.appendChild(U.el('div', 'section-title', '总览'));
      var g1 = U.el('div', 'stat-grid');
      function box(label, value, unit) {
        return '<div class="stat-box"><div class="sb-label">' + label + '</div>' +
               '<div class="sb-value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</div></div>';
      }
      var curF = G.FIELD_MAP[s.field] || {};
      var curP = St.fieldProgress(s.field);
      var wholeH = G.FIELDS[G.FIELDS.length - 1].estUnlockHours +
                   G.FIELDS[G.FIELDS.length - 1].estOwnHours;
      g1.innerHTML =
        box('累计游玩时长', U.clock(s.playTime)) +
        box('游玩的第几天', (s.stats.days || 0) + 1, '天') +
        box('金币', U.num(Math.round(s.coin))) +
        box('总抛竿数', U.num(st.casts)) +
        box('总钓获', U.num(st.catches)) +
        box('图鉴收集', gp.got + ' / ' + gp.total) +
        box('图鉴完成度', (gp.pct * 100).toFixed(1), '%') +
        /* ⚠️ 这两格是**理论时长**（estOwnHours / estUnlockHours 的含义是「从零收满要多久」），
           不随进度变化。所以已经 100% 时必须显式写「已收满」——
           否则满图鉴的玩家会看到「当前钓场预计收满 2 小时」这种自相矛盾的数
           （和 ㉓ 节那处「体重占比 155% 上限」是同一类：文案与数据对不上）。 */
        box('当前钓场收满约需', curP.pct >= 1 ? '已收满' : fmtH(curF.estOwnHours || 0)) +
        box('全图鉴收满约需', gp.pct >= 1 ? '已收满' : fmtH(wholeH));
      root.appendChild(g1);

      root.appendChild(U.el('div', 'section-title', '记录'));
      var g2 = U.el('div', 'stat-grid');
      g2.innerHTML =
        box('最大重量', U.kg(st.maxKg)) +
        box('该记录鱼种', (st.maxKgFish || '—')) +
        box('累计卖鱼收入', U.coin(st.totalValue)) +
        box('断线次数', U.num(st.snaps)) +
        box('脱钩次数', U.num(st.escapes)) +
        box('挂机钓获', U.num(st.idleCatches)) +
        box('鱼护 / 容量', St.netCount() + ' / ' + s.netCap) +
        box('水族箱 / 容量', St.tankCount() + ' / ' + s.tankCap);
      root.appendChild(g2);

      root.appendChild(U.el('div', 'section-title', '各钓场进度'));
      var g3 = U.el('div', 'shop-list');
      G.FIELDS.forEach(function (f) {
        var p = St.fieldProgress(f.id);
        var unlocked = !!s.unlocked[f.id];
        /* ⚠️ 这两行原来各留了一份「真相」：
           · `var need = …` 算完之后从来没人用（与 v0.5.5 删掉的 maxFish 同类）；
           · 门槛百分比写成字面量「需前置 100%」，而卡片上另一处（panels.js 的
             `need` / fc-foot 那一带）读的是 f.collectionPct ——
             隐藏钓场的 collectionPct 本来就是 1.0，现算一次即可。 */
        var gatePct = Math.round((f.collectionPct || 0.8) * 100) + '%';
        var row = U.el('div', 'shop-item' + (unlocked ? '' : ''));
        row.innerHTML = '<div class="sh-ico" style="font-weight:800;color:#fff;background:' +
            rankColor(f.rank) + '">' + f.rank + '</div>' +
          '<div class="sh-main"><div class="sh-name">' + (f.hidden && !unlocked ? '？？？' : f.name) + '</div>' +
          '<div class="sh-desc">图鉴 ' + p.got + '/' + p.total + '（' + (p.pct * 100).toFixed(0) + '%）' +
          (unlocked ? ' ｜ 已解锁'
                    : (f.requireFull ? ' ｜ 需前置 ' + gatePct : ' ｜ 需 ' + gatePct)) + '</div></div>';
        g3.appendChild(row);
      });
      root.appendChild(g3);
    },
  };

  /* =========================================================
     目标（每日任务 / 称号 / 成就）
     =========================================================
     ⚠️ 奖励口径：这里只发「称号」与纪念币（纪念币无消费出口），
        不发金币 / 鱼饵 / 装备，避免长线系统把经济曲线带跑。
     ========================================================= */
  VIEWS.goals = {
    title: '目标',
    render: function (root) {
      var Gl = G.Goals, s = St.get();
      var list = Gl.quests();

      /* --- 顶部：纪念币 / 称号 / 成就进度 --- */
      var ap = Gl.achProgress();
      var head = U.el('div', 'stat-grid');
      head.innerHTML =
        '<div class="stat-box"><div class="sb-label">纪念币</div><div class="sb-value">' +
          Gl.medals() + '<small>枚</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">成就</div><div class="sb-value">' +
          ap.got + '<small>/ ' + ap.total + '</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">已解锁称号</div><div class="sb-value">' +
          Gl.titles().filter(function (t) { return t.id; }).length + '<small>个</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">当前佩戴</div><div class="sb-value" style="font-size:16px">' +
          esc(Gl.equipped().name) + '</div></div>';
      root.appendChild(head);

      /* --- 任务行渲染（每日 / 周常共用，避免两套 markup 漂移） --- */
      function questRows(list, claimFn, gain) {
        var box = U.el('div', 'goal-list');
        list.forEach(function (q) {
          var row = U.el('div', 'goal-row' + (q.claimed ? ' claimed' : (q.done ? ' done' : '')));
          row.innerHTML =
            '<div class="goal-main">' +
              '<div class="goal-top"><span class="goal-name">' + esc(q.text) + '</span>' +
              '<span class="goal-num">' + esc(Gl.fmtVal(q.t, q.cur)) + ' / ' + esc(Gl.fmtVal(q.t, q.need)) + '</span></div>' +
              '<div class="goal-bar"><i style="width:' + (q.pct * 100).toFixed(1) + '%"></i></div>' +
            '</div>';
          var btn = U.el('button', 'sh-buy' + (q.claimed ? '' : (q.done ? '' : ' plain')),
            q.claimed ? '已领取' : (q.done ? '领 取' : '进行中'));
          btn.disabled = q.claimed || !q.done;
          if (q.done && !q.claimed) btn.classList.add('ready');
          U.on(btn, 'click', function () {
            var r = claimFn(q.i);
            if (!r.ok) { G.Audio.deny(); St.emit('toast', { text: r.msg, kind: 'warn' }); return; }
            /* 领奖用 `reward` 而不是 `unlock`：`unlock` 是四声大琶音（钓场 / 鱼竿那种
               一次性的大解锁），一天要领好几条任务，每次都放那个太"隆重"了。 */
            G.Audio.reward();
            St.emit('toast', { text: '任务完成　+' + (r.gain || gain) + ' 纪念币（共 ' + r.medals + ' 枚）', kind: 'good' });
            if (G.Hud) G.Hud.syncGoalBadge();
            refresh();
          });
          row.appendChild(U.el('div', 'goal-act')).appendChild(btn);
          box.appendChild(row);
        });
        return box;
      }
      function claimAllBtn(n, fn) {
        var all = U.el('button', 'btn-ghost');
        all.style.marginTop = '10px';
        all.textContent = '全部领取（' + n + ' 条）';
        U.on(all, 'click', function () {
          var got = fn();
          G.Audio.reward();
          St.emit('toast', { text: '领取了 ' + got + ' 条奖励', kind: 'good' });
          if (G.Hud) G.Hud.syncGoalBadge();
          refresh();
        });
        return all;
      }
      var GOAL_CFG = (G.CONFIG.goals || {});
      var dGain = GOAL_CFG.dailyMedals || 1;
      var wGain = GOAL_CFG.weeklyMedals || 1;

      /* --- 每日任务 --- */
      var claimable = 0;
      list.forEach(function (q) { if (q.done && !q.claimed) claimable++; });
      var qTitle = U.el('div', 'section-title', '每日任务 · ' + s.daily.day +
        (claimable ? '　<span style="color:#e8a020">' + claimable + ' 条可领取</span>' : ''));
      root.appendChild(qTitle);

      var tip = U.el('div', 'hint-text');
      tip.style.marginBottom = '10px';
      tip.innerHTML = '每天 <b>' + list.length + '</b> 条，按日期自动生成（不联网）。' +
        '完成一条得 <b>' + dGain + ' 枚纪念币</b>，每天 0 点刷新，<b>未领取的任务会作废</b>。';
      root.appendChild(tip);

      root.appendChild(questRows(list, Gl.claim, dGain));
      if (claimable > 1) root.appendChild(claimAllBtn(claimable, Gl.claimAll));

      /* --- 周常挑战（v0.5.6）---
         先取 wlist：它内部会 ensureWeek()，s.weekly 才会就位 */
      var wlist = Gl.weekly();
      var wClaimable = 0;
      wlist.forEach(function (q) { if (q.done && !q.claimed) wClaimable++; });
      root.appendChild(U.el('div', 'section-title', '周常挑战 · 本周 ' + s.weekly.week +
        (wClaimable ? '　<span style="color:#e8a020">' + wClaimable + ' 条可领取</span>' : '')));

      var wTip = U.el('div', 'hint-text');
      wTip.style.marginBottom = '10px';
      wTip.innerHTML = '每周 <b>' + wlist.length + '</b> 条，按 ISO 周自动生成（不联网）。' +
        '目标比每日任务重，完成一条得 <b>' + wGain + ' 枚纪念币</b>；' +
        '<b>每周一 0 点刷新，未领取的会作废</b>。';
      root.appendChild(wTip);

      root.appendChild(questRows(wlist, Gl.claimWeekly, wGain));
      if (wClaimable > 1) root.appendChild(claimAllBtn(wClaimable, Gl.claimAllWeekly));

      /* --- 称号 --- */
      var titles = Gl.titles();
      var pool = [];
      G.ACHIEVEMENTS.forEach(function (a) {
        if (a.title) pool.push({ name: a.title, from: '成就「' + a.name + '」', on: Gl.achDone(a), id: 'ach:' + a.id });
      });
      G.MEDAL_TITLES.forEach(function (t) {
        pool.push({ name: t.name, from: t.desc, on: Gl.medals() >= t.need, id: 'medal:' + t.id });
      });
      var onN = pool.filter(function (t) { return t.on; }).length;
      root.appendChild(U.el('div', 'section-title', '称号（' + onN + ' / ' + pool.length + '）'));
      var tWrap = U.el('div', 'title-wrap');
      pool.forEach(function (t) {
        var chip = U.el('div', 'title-chip' + (t.on ? '' : ' locked') + (s.titleSel === t.id ? ' on' : ''));
        chip.innerHTML = '<b>' + esc(t.name) + '</b><i>' + esc(t.from) + '</i>';
        chip.title = t.on ? (s.titleSel === t.id ? '点击卸下' : '点击佩戴') : ('未解锁：' + t.from);
        U.on(chip, 'click', function () {
          if (!t.on) { G.Audio.deny(); return; }
          Gl.equip(s.titleSel === t.id ? '' : t.id);
          G.Audio.click();
          if (G.Hud) G.Hud.syncTitle();
          refresh();
        });
        tWrap.appendChild(chip);
      });
      root.appendChild(tWrap);
      var tTip = U.el('div', 'hint-text');
      tTip.style.marginTop = '8px';
      tTip.innerHTML = '称号只做展示，不带任何属性加成。';
      root.appendChild(tTip);

      /* --- 成就 --- */
      var ach = Gl.achievements();
      function achFmt(a, v) {
        if (a.fmt === 'coin') return U.coin(v) + ' 金';
        if (a.metric === 'maxKgAll') return U.kg(v);
        if (a.metric === 'playHours') return (v < 10 ? (Math.round(v * 10) / 10) : Math.round(v)) + ' 小时';
        return U.num(Math.floor(v));
      }
      G.ACH_CATS.forEach(function (cat) {
        var items = ach.filter(function (a) { return a.cat === cat.key; });
        var done = items.filter(function (a) { return a.done; }).length;
        root.appendChild(U.el('div', 'section-title', '成就 · ' + cat.name + '（' + done + ' / ' + items.length + '）'));
        var l = U.el('div', 'goal-list');
        items.forEach(function (a) {
          var row = U.el('div', 'goal-row ach' + (a.done ? ' done' : ''));
          row.innerHTML =
            '<div class="ach-mark">' + (a.done ? '✓' : '·') + '</div>' +
            '<div class="goal-main">' +
              '<div class="goal-top"><span class="goal-name">' + esc(a.name) +
                (a.title ? '<em class="goal-tag">称号</em>' : '') + '</span>' +
              '<span class="goal-num">' + esc(achFmt(a, a.got)) + ' / ' + esc(achFmt(a, a.need)) + '</span></div>' +
              '<div class="goal-desc">' + esc(a.desc) + '</div>' +
              '<div class="goal-bar"><i style="width:' + (a.pct * 100).toFixed(1) + '%"></i></div>' +
            '</div>';
          l.appendChild(row);
        });
        root.appendChild(l);
      });

      var foot = U.el('div', 'hint-text');
      foot.style.marginTop = '16px';
      foot.innerHTML = '成就是<b>按存档实时算出来的</b>（不额外占用存档字段），所以以后调整条件不需要迁移存档。';
      root.appendChild(foot);
    },
  };

  /* 面板里所有来自数据的文本都要过一遍，避免鱼名/称号名把 HTML 结构撕开 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* =========================================================
     设置
     ========================================================= */
  VIEWS.settings = {
    title: '设置',
    render: function (root) {
      var s = St.get();

      function row(name, desc, ctlHtml, onReady) {
        var r = U.el('div', 'set-row');
        r.innerHTML = '<div><div class="set-name">' + name + '</div><div class="set-desc">' + desc + '</div></div>';
        var c = U.el('div', 'set-ctl', ctlHtml);
        r.appendChild(c);
        root.appendChild(r);
        if (onReady) onReady(c);
        return r;
      }

      row('音效', '开关全部程序化音效（环境水声与背景音乐另有开关）', '<button class="btn-ghost" id="setSound">' +
        (s.settings.sound ? '已开启' : '已关闭') + '</button>', function (c) {
        U.on(c.querySelector('#setSound'), 'click', function () {
          s.settings.sound = !s.settings.sound;
          /* ⚠️ 只管总开关。环境音 / 背景音乐**不在这里补启动** ——
             `setEnabled(true)` 自己会按「意图位」把它们恢复（见 audio.js 的 bgmWant），
             在这里再补一句就会变成「关过音效之后，音乐被强行拉回来」。 */
          G.Audio.setEnabled(s.settings.sound);
          St.scheduleSave(); refresh();
        });
      });

      row('环境音', '水面涌动低频环境声', '<button class="btn-ghost" id="setAmb">' +
        (s.settings.ambient ? '已开启' : '已关闭') + '</button>', function (c) {
        U.on(c.querySelector('#setAmb'), 'click', function () {
          s.settings.ambient = !s.settings.ambient;
          if (s.settings.ambient && s.settings.sound) G.Audio.startAmbience();
          else G.Audio.stopAmbience();
          St.scheduleSave(); refresh();
        });
      });

      row('背景音乐', '随钓场 / 时段 / 天气变化的和弦垫乐（程序化合成，不占素材）',
        '<button class="btn-ghost" id="setBgm">' +
        (s.settings.music ? '已开启' : '已关闭') + '</button>', function (c) {
        U.on(c.querySelector('#setBgm'), 'click', function () {
          s.settings.music = !s.settings.music;
          if (s.settings.music && s.settings.sound) {
            /* 从**当前钓场 + 当前时段 / 天气**重新起 —— 恢复播放时不能放成上一个钓场那一首，
               也不能放成上一个时段的调式（关着音乐时变过天，`bgmOf()` 那条路是走不到的）。
               ⚠️ 实参必须过 `G.Weather.bgmSpec()` 合一次：直接传 `theme.bgm` 就是绕开
                  时段 / 天气修饰，而且**表现只在这一个入口**（其它入口正常）——
                  本项目踩过的「同一件事的第二份真相」正是这个形状。verify 第 ㊶ 节盯着所有调用点。 */
            G.Audio.startBgm(G.Weather.bgmSpec((G.FIELD_MAP[s.field] || G.FIELDS[0]).theme.bgm));
          } else {
            /* ⚠️ 必须是 `stopBgm` 而不是 `setEnabled(false)`：后者会把音效一起关掉 */
            G.Audio.stopBgm();
          }
          St.scheduleSave(); refresh();
        });
      });

      row('音乐音量', '背景音乐相对总音量的比例（0 ~ 100）',
        '<input type="range" id="setMusicVol" min="0" max="100" value="' +
        Math.round(s.settings.musicVol * 100) + '">', function (c) {
        U.on(c.querySelector('#setMusicVol'), 'input', function (e) {
          var v = e.target.value / 100;
          s.settings.musicVol = v;
          G.Audio.setMusicVolume(v);
          St.scheduleSave();
        });
      });

      row('音量', '整体音量 0 ~ 100（所有声音的总闸门）', '<input type="range" id="setVol" min="0" max="100" value="' +
        Math.round(s.settings.volume * 100) + '">', function (c) {
        U.on(c.querySelector('#setVol'), 'input', function (e) {
          var v = e.target.value / 100;
          s.settings.volume = v;
          G.Audio.setVolume(v);
          St.scheduleSave();
        });
      });

      row('挂机', '自动抛竿、自动提竿、自动收线（稀有鱼概率 ×' +
        CFG.idle.rareWeightMul.toFixed(2) + '）',
        '<button class="btn-ghost" id="setIdle">' + (s.settings.idle ? '已开启' : '已关闭') + '</button>',
        function (c) {
          U.on(c.querySelector('#setIdle'), 'click', function () {
            var v = !s.settings.idle;
            St.setIdle(v);
            U.$('#chkIdle').checked = v;
            refresh();
          });
        });

      /* 新手引导：非阻塞气泡教「按住收线 / 松手放线 / 躲逃窜」三个动作。
         走完（或跳过）就永久关闭，但随时可以从这里重看。 */
      var tutDone = !!(s.tut && s.tut.done);
      var tutStep = (s.tut && s.tut.step) || 0;
      var tutTotal = G.Tutorial.stepCount();
      row('新手引导', '在拉扯中依次教「按住收线 / 松手放线 / 躲逃窜」三个动作。' +
        (tutDone ? '已完成。' : '进度 ' + tutStep + '/' + tutTotal + '。'),
        '<button class="btn-ghost" id="setTut">' + (tutDone ? '重 看' : '从头') + '</button>',
        function (c) {
          U.on(c.querySelector('#setTut'), 'click', function () {
            G.Tutorial.restart();
            close();          // 先把设置面板关掉，否则气泡被弹层压在下面
          });
        });

      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '16px';
      tip.innerHTML =
        '当前版本 <b>v' + CFG.version + '</b> ｜ 存档保存在 ' +
        (G.Platform.storage.kind() === 'localStorage' ? '浏览器 localStorage' : '<b>内存</b>（浏览器禁用了本地存储，关掉页面就会丢档，请尽快导出备份）') +
        '。<br>' +
        '快捷键：<kbd>空格</kbd> 抛竿 / 提竿 / 收线。';
      root.appendChild(tip);

      row('重置存档', '清空所有进度，重新开始。此操作不可撤销。',
        '<button class="btn-ghost danger" id="setReset">重置</button>', function (c) {
        U.on(c.querySelector('#setReset'), 'click', function () {
          if (!G.Platform.dialog.confirm('确定要清空所有进度吗？此操作不可撤销。')) return;
          /* ⚠️ 这里**不要**再补一次 reload：`St.reset()` 内部会 `emit('reset')`，
             main.js 订阅了这个事件并负责重载页面。以前两处都调 → 同一次点击
             触发两次重载（playwright 里表现为 ERR_ABORTED，看着像「重置没生效」）。 */
          St.reset();
        });
      });

      row('导出存档', '把存档 JSON 复制到剪贴板，方便备份',
        '<button class="btn-ghost" id="setExport">导出</button>', function (c) {
        U.on(c.querySelector('#setExport'), 'click', function () {
          var txt = JSON.stringify(St.get());
          /* 剪贴板走适配层；拿不到（无权限 / 非安全上下文）就退化成让玩家手动复制，
             别一味提示「已复制到剪贴板」—— 那句在失败时是假的。 */
          G.Platform.clipboard.write(txt).then(function (copied) {
            if (copied) {
              G.State.emit('toast', { text: '存档已复制到剪贴板', kind: 'good' });
            } else {
              G.Platform.dialog.prompt('浏览器不允许自动复制，请手动复制下面这段存档 JSON：', txt);
              G.State.emit('toast', { text: '复制失败，已改为手动复制', kind: 'warn' });
            }
          });
        });
      });

      row('导入存档', '粘贴之前导出的 JSON。会覆盖当前进度，导入前请先导出备份。',
        '<button class="btn-ghost" id="setImport">导入</button>', function (c) {
        U.on(c.querySelector('#setImport'), 'click', function () {
          var txt = G.Platform.dialog.prompt('把导出的存档 JSON 粘贴到这里：');
          if (!txt) return;
          var r = St.importSave(txt);
          if (!r.ok) { G.Audio.deny(); G.State.emit('toast', { text: r.msg, kind: 'bad' }); return; }
          G.Audio.unlock();
          G.State.emit('toast', { text: '导入成功，正在重载…', kind: 'good' });
          setTimeout(function () { G.Platform.sys.reload(); }, 700);
        });
      });
    },
  };

  /* =========================================================
     选饵 / 选竿 / 选线（底栏点击触发）
     ========================================================= */
  VIEWS.pickerBait = {
    title: '选择鱼饵',
    render: function (root) {
      var s = St.get();
      var list = U.el('div', 'pick-list');
      G.BAITS.forEach(function (b) {
        var have = St.baitCount(b.id);
        var can = b.free || have > 0;
        var row = U.el('div', 'pick-row' + (s.baitSel === b.id ? ' on' : (can ? '' : ' off')));
        row.innerHTML = '<div class="sh-ico" style="background:' + b.color + '"></div>' +
          '<div class="pr-main"><div class="pr-name">' + b.name + '</div>' +
          '<div class="pr-desc">' + b.desc + '<br>咬口时间 ×' + b.speed.toFixed(2) +
          ' ｜ 稀有 ×' + b.rareMul.toFixed(2) + (b.legendMul > 1 ? ' ｜ 传说 ×' + b.legendMul.toFixed(2) : '') + '</div></div>' +
          '<div class="pr-right' + (b.free ? ' free' : '') + '">' + (b.free ? '无限' : '×' + have) + '</div>';
        U.on(row, 'click', function () {
          if (!can) { G.Audio.deny(); G.State.emit('toast', { text: '没有这种鱼饵了，去商店买', kind: 'warn' }); return; }
          St.selectBait(b.id);
          G.Audio.click();
          close();
        });
        list.appendChild(row);
      });
      root.appendChild(list);
      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '12px';
      /* ⚠️ 这句必须与 v0.5.7 的口径一致：抛竿扣 1，但**提前收杆整枚退回**
         （鱼咬过钩就不退）。只写「每抛一竿消耗一个」等于说错 ——
         GDD §6.1 与说明书都写了退还，界面漏了会让玩家以为收杆也亏饵。 */
      tip.textContent = '鱼饵每抛一竿消耗一个。鱼还没咬钩时「收杆」（提前收杆）的鱼饵会退回；' +
        '蚯蚓无限免费，永远不会让你空军。';
      root.appendChild(tip);
    },
  };

  VIEWS.pickerRod = {
    title: '选择鱼竿',
    render: function (root) {
      var s = St.get();
      var list = U.el('div', 'pick-list');
      G.RODS.forEach(function (r) {
        var owned = s.rods.indexOf(r.id) >= 0;
        var row = U.el('div', 'pick-row' + (s.rodSel === r.id ? ' on' : (owned ? '' : ' off')));
        row.innerHTML = '<div class="sh-ico">' + r.icon + '</div>' +
          '<div class="pr-main"><div class="pr-name">' + r.name + '</div>' +
          '<div class="pr-desc">' + r.desc + '<br>稀有权重 ×' + r.rareMul.toFixed(2) + ' ｜ 收线 ×' + r.reel.toFixed(2) + '</div></div>' +
          '<div class="pr-right">' + (owned ? '已拥有' : U.coin(r.price)) + '</div>';
        U.on(row, 'click', function () {
          if (!owned) { G.Audio.deny(); G.State.emit('toast', { text: '还没买，去商店看看', kind: 'warn' }); return; }
          St.selectRod(r.id); G.Audio.click(); close();
        });
        list.appendChild(row);
      });
      root.appendChild(list);
    },
  };

  VIEWS.pickerLine = {
    title: '选择鱼线',
    render: function (root) {
      var s = St.get();
      var list = U.el('div', 'pick-list');
      G.LINES.forEach(function (r) {
        var owned = s.lines.indexOf(r.id) >= 0;
        var row = U.el('div', 'pick-row' + (s.lineSel === r.id ? ' on' : (owned ? '' : ' off')));
        row.innerHTML = '<div class="sh-ico">' + r.icon + '</div>' +
          '<div class="pr-main"><div class="pr-name">' + r.name + '</div>' +
          '<div class="pr-desc">' + r.desc + '<br>张力上限 ' + r.tensionMax + '</div></div>' +
          '<div class="pr-right">' + (owned ? '已拥有' : U.coin(r.price)) + '</div>';
        U.on(row, 'click', function () {
          if (!owned) { G.Audio.deny(); G.State.emit('toast', { text: '还没买，去商店看看', kind: 'warn' }); return; }
          St.selectLine(r.id); G.Audio.click(); close();
        });
        list.appendChild(row);
      });
      root.appendChild(list);
    },
  };

  /* =========================================================
     离线补算报告
     ========================================================= */
  VIEWS.offline = {
    title: '挂机收获',
    render: function (root, r) {
      /* ⚠️ `r` 由 main.js 的 `F.offlineCatchUp()` 结果传进来，但 refresh() 走的是
         `renderCurrent()`（**不带参数**）—— 任何一次不带 payload 的打开都会在
         `r.seconds` 上抛 TypeError，把整块面板炸成空白。这里统一兜底：
         数字全部过一遍 numOr0()，没有数据就渲染空态。 */
      r = r || {};
      var secs = numOr0(r.seconds), n = numOr0(r.count);
      if (!secs && !n) {
        root.appendChild(U.el('div', 'empty-tip',
          '这次没有挂机记录（离开时间太短，或者没开挂机）。'));
        return;
      }
      root.innerHTML =
        '<div class="hint-text" style="font-size:13px">你离开了 <b>' + U.dur(secs) + '</b>，' +
        '挂机替你完成了 <b>' + n + '</b> 次抛竿。</div>';
      var g = U.el('div', 'stat-grid');
      g.style.marginTop = '14px';
      g.innerHTML =
        '<div class="stat-box"><div class="sb-label">钓获</div><div class="sb-value">' + n + '<small>条</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">收入</div><div class="sb-value">' + U.coin(numOr0(r.coin)) + '<small>金</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">史诗 / 传说</div><div class="sb-value">' + numOr0(r.rare) + '<small>条</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">新增图鉴</div><div class="sb-value">' + numOr0(r.kinds) + '<small>种</small></div></div>';
      root.appendChild(g);
      /* 代表渔获：离线补算是抽样折算的，但玩家总得看到「具体钓到了什么」 */
      if (r.recent && r.recent.length) {
        var rl = U.el('div', 'offline-list');
        rl.style.marginTop = '14px';
        rl.innerHTML = '<div class="sb-label">离线期间的代表渔获</div>' +
          r.recent.map(function (x) {
            return '<div class="ol-row"><span class="ol-name">' + esc(x.fish.name) + '</span>' +
              '<span class="ol-note">' + esc(x.color.name) + ' · ' + U.kg(x.kg) + '</span>' +
              '<span class="ol-coin">+' + U.coin(x.price) + '</span></div>';
          }).join('');
        root.appendChild(rl);
      }
      if (r.unlocks && r.unlocks.length) {
        var t = U.el('div', 'hint-text');
        t.style.marginTop = '12px';
        t.innerHTML = '🎉 解锁新钓场：<b>' + r.unlocks.map(function (f) { return f.name; }).join('、') + '</b>';
        root.appendChild(t);
      }
      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '12px';
      tip.textContent = '离线补算上限 ' + Math.round(CFG.idle.maxCatchUp / 3600) +
        ' 小时。挂机期间稀有鱼概率 ×' + CFG.idle.rareWeightMul.toFixed(2) + '。';
      root.appendChild(tip);
    },
  };

  /* =========================================================
     结算卡片
     ========================================================= */
  var pendingCatch = null;

  function showCatch(info) {
    pendingCatch = info;
    catchCard.className = 'catch-card r' + info.rar;
    catchCard.classList.remove('hidden');
    U.$('#ccName').textContent = info.fish.name;

    var tags = U.$('#ccTags');
    tags.innerHTML = '<span class="cc-tag rar' + info.rar + '">' + CFG.rarity[info.rar].name + '</span>' +
      '<span class="cc-tag plain">' + info.color.name + '</span>' +
      (info.isNew ? '<span class="cc-tag" style="background:#3fbf7f">新发现</span>' : '') +
      (info.isRecord && !info.isNew ? '<span class="cc-tag" style="background:#e8a020">新纪录</span>' : '');

    var rows = U.$('#ccRows');
    /* ⚠️ 这一行原来写的是「体长参考」，但算的其实是**体重**占该鱼种常规上限的比例 ——
       游戏里没有「体长」这个数据（fishart 里的 L 是绘制像素，与鱼本身无关），
       写「体长」等于凭空造了一个玩家会去找的属性。
       另外 CFG.weight.giantProb 有 3% 的「巨物」会在常规上限之上再 ×1.55，
       那时显示「155% 上限」自相矛盾 —— 得点名它是巨物。 */
    var kgPct = Math.round(info.kg / (info.fish.maxKg || 1) * 100);
    rows.innerHTML =
      '<div class="cc-row"><span>重量</span><span>' + U.kg(info.kg) + '</span></div>' +
      '<div class="cc-row"><span>体重占比</span><span>' + kgPct + '%' +
        (kgPct > 100 ? '　<span class="cc-tag" style="background:#e8a020">巨物</span>' : '') +
        '</span></div>' +
      '<div class="cc-row"><span>颜色系数</span><span>×' + info.color.valueMul.toFixed(2) + '</span></div>' +
      '<div class="cc-row"><span>卖出价</span><span>' + U.coin(info.price) + ' 金' + (info.isNew ? '（图鉴奖励 ×' + CFG.economy.firstCatchBonus + '）' : '') + '</span></div>' +
      '<div class="cc-row"><span>图鉴累计</span><span>' + (St.bookEntry(info.fish.id).n) + ' 条</span></div>';

    /* 结算卡是两个真选项：卖出拿钱 / 收进鱼护留着。
       （挂机时没有玩家点，走自动卖出，见 fishing.js） */
    U.$('#ccSell').textContent = '卖出 ' + U.coin(info.price) + ' 金';
    var keepBtn = U.$('#ccKeep');
    var netN = St.netCount(), netCap = St.get().netCap;
    if (St.netFull()) {
      keepBtn.classList.add('hidden');
    } else {
      keepBtn.classList.remove('hidden');
      keepBtn.textContent = '收进鱼护 ' + netN + '/' + netCap;
    }

    // 绘制
    var cv = catchCanvas;
    var dpr = G.Platform.sys.dpr();
    cv.width = 360 * dpr; cv.height = 200 * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, '#eaf7ff'); grad.addColorStop(1, '#c6e9fb');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 360, 200);
    // 水波
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
    for (var i = 0; i < 4; i++) {
      ctx.beginPath();
      for (var x = 0; x <= 360; x += 10) {
        var y = 150 + i * 14 + Math.sin(x * 0.05 + i) * 3;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    var L = Math.min(230, 90 + Math.log(1 + info.kg) * 26);
    L = U.clamp(L, 110, 250);
    G.FishArt.draw(ctx, info.fish, 180, 96, L, {
      tint: info.color.tint, tintAmt: 0.55, t: 0.8,
    });

    // 阶段音效交给 fishing.js
  }

  function hideCatch() {
    catchCard.classList.add('hidden');
    pendingCatch = null;
  }
  function isCatchOpen() { return !catchCard.classList.contains('hidden'); }

  function initCatchButtons(onDone) {
    /* info 必须在 hideCatch() 之前取，否则 pendingCatch 已经被清空 */
    function fire(action) {
      var info = pendingCatch;
      if (action === 'sell') G.Audio.coin(); else G.Audio.click();
      hideCatch();
      if (onDone) onDone(action, info);
    }
    U.on(U.$('#ccSell'), 'click', function () { fire('sell'); });
    U.on(U.$('#ccKeep'), 'click', function () { fire('keep'); });
  }

  /* 空格 / 点画面把结算卡收掉时，默认按「卖出」处理，
     否则玩家会莫名其妙少一笔钱 */
  function dismissCatch(onDone) {
    var info = pendingCatch;
    if (!info) return;
    G.Audio.coin();
    hideCatch();
    if (onDone) onDone('sell', info);
  }
  /* ⚠️ `getPendingCatch()` 已删：全项目零调用（结算卡的 payload 只有本模块用）。 */
  return {
    init: init, open: open, close: close, refresh: refresh, isOpen: isOpen,
    current: currentView,
    setOnClose: setOnClose,
    showCatch: showCatch, isCatchOpen: isCatchOpen,
    /* hideCatch 是内部实现（fire() / dismissCatch 用），不导出 */
    initCatchButtons: initCatchButtons, dismissCatch: dismissCatch,
    VIEWS: VIEWS,
  };
})();
