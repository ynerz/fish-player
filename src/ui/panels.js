/* =========================================================
   panels.js  —  各类弹层：钓场 / 图鉴 / 商店 / 统计 / 设置 / 结算卡
   ========================================================= */
window.G = window.G || {};

G.Panels = (function () {
  var U = G.U, St = G.State, CFG = G.CONFIG;
  var modal, titleEl, bodyEl, closeBtn;
  var catchCard, catchCanvas;
  var current = null;
  var onCloseCb = null;

  /* 小时 → 中文时长 */
  function fmtH(h) {
    if (!h) return '—';
    if (h < 1) return Math.round(h * 60) + ' 分钟';
    if (h < 24) return (Math.round(h * 10) / 10) + ' 小时';
    return (Math.round(h / 24 * 10) / 10) + ' 天';
  }

  function init() {
    modal = U.$('#modal');
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
    }
    renderCurrent(arg);
    modal.classList.remove('hidden');
    G.Audio.click();
  }

  function close() {
    modal.classList.add('hidden');
    bodyEl.innerHTML = '';
    current = null;
    if (onCloseCb) { var f = onCloseCb; onCloseCb = null; f(); }
  }

  function refresh() {
    if (isOpen()) renderCurrent();
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

        var rankColor = { D:'#8b98a5', C:'#5aa9d6', B:'#3f8f5f', A:'#2b6fc4', S:'#3b4a8f', SS:'#5b3fa8', SSS:'#a87a1f' }[f.rank] || '#1f8fd6';
        card.innerHTML =
          (s.field === f.id ? '<div class="fc-ribbon">当前</div>' : '') +
          '<div class="fc-top">' +
            '<div class="fc-rank" style="background:' + rankColor + '">' + f.rank + '</div>' +
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

      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '14px';
      tip.innerHTML =
        '<b>解锁规则</b>：本钓场图鉴收集达 <b>80%</b> 即可解锁下一个钓场；' +
        '隐藏钓场 <b>SS / SSS</b> 需要前面所有钓场 <b>100%</b> 收满。<br>' +
        '<b>关于时长</b>：时长不是解锁门槛，只是按当前掉率算出来的<b>期望耗时</b>（' +
        '由 <code>tools/solve-drop.js</code> 反推、<code>tools/balance.js</code> 复核）。' +
        '七个钓场全部 100% 收满约 <b>' + fmtH(G.FIELDS[G.FIELDS.length - 1].estUnlockHours +
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
  var bookFilter = { field: null, rarity: -1, sel: null };

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

  /* 颜色概率总和（用于归一化，避免百分比写错时算出负数概率） */
  function colorProbTotal() {
    var t = 0;
    CFG.colorMorphs.forEach(function (c) { t += c.prob; });
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

  /* ---------------- 鱼种详情页：看这一条鱼各种颜色的收集情况 ---------------- */
  function renderFishDetail(root, fid) {
    var f = G.FISH_ID[fid];
    if (!f) { bookFilter.sel = null; VIEWS.book.render(root); return; }

    var e = St.bookEntry(fid);
    var fld = G.FIELD_MAP[f.field] || {};
    var pFish = baseFishProb(f);
    var cTotal = colorProbTotal();
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

    var cv = document.createElement('canvas');
    cv.className = 'fd-canvas';
    cv.width = 380; cv.height = 190;
    card.appendChild(cv);

    /* 展示「已收集到的最稀有颜色」，没收集过就画剪影 */
    var best = null;
    CFG.colorMorphs.forEach(function (cm) {
      if (!(e && e.colors && e.colors[cm.key])) return;
      if (!best || cm.prob < best.prob) best = cm;
    });

    (function () {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
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
      var p = cm.prob / cTotal;
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
    tip.innerHTML = '期望竿数按<b>基础掉率</b>计算（未计入鱼饵 / 鱼竿的稀有权重加成，实际会更快）。' +
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

      var head = U.el('div', 'book-head');
      var colStat = St.colorProgress();
      head.innerHTML = '<div><b style="font-size:15px">全图鉴收集进度</b>' +
        '<div class="book-sum">' +
          '<span>品种 <b>' + g.got + '</b> / ' + g.total + '　(' + (g.pct * 100).toFixed(1) + '%)</span>' +
          '<span>颜色 <b>' + colStat.got + '</b> / ' + colStat.total + '　(' + (colStat.pct * 100).toFixed(1) + '%)</span>' +
        '</div>' +
        '<div class="hint-text" style="margin-top:4px">' +
          '⚠️ <b>解锁只看「品种」</b>，颜色只是收藏彩蛋，不参与任何解锁判定。' +
        '</div></div>';

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
      root.appendChild(rarRow);

      var list = G.FISH.filter(function (f) {
        if (bookFilter.field !== 'ALL' && f.field !== bookFilter.field) return false;
        if (bookFilter.rarity >= 0 && f.rar !== bookFilter.rarity) return false;
        return true;
      });

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
        var cv = document.createElement('canvas');
        cv.width = 260; cv.height = 112;
        item.appendChild(cv);
        var sub = U.el('div', 'bi-name', e ? f.name : '？？？');
        item.appendChild(sub);
        var tag = U.el('div', 'bi-tag rar' + f.rar, e ? CFG.rarity[f.rar].name : '未发现');
        item.appendChild(tag);
        var colorsRow = U.el('div', 'bi-colors');
        CFG.colorMorphs.forEach(function (cm, ci) {
          var has = !!(e && e.colors && e.colors[cm.key]);
          var dot = U.el('i', has ? 'on' : '');
          dot.style.background = cm.tint || '#a9c7da';
          dot.title = cm.name + (has ? ' ✓ 已收集' : ' ✗ 未收集');
          colorsRow.appendChild(dot);
        });
        item.appendChild(colorsRow);
        item.title = f.name + '　颜色 ' +
          (e ? CFG.colorMorphs.filter(function (c) { return e.colors && e.colors[c.key]; }).length : 0) + '/' + CFG.colorMorphs.length;
        if (e) {
          var rec = U.el('div', 'bi-record', '最大 ' + U.kg(e.maxKg) + ' · ' + e.n + ' 条');
          item.appendChild(rec);
        } else {
          var c0 = U.el('div', 'bi-sub', '体重 ' + U.kg(f.minKg) + '~' + U.kg(f.maxKg));
          item.appendChild(c0);
        }
        grid.appendChild(item);

        // 延迟绘制，避免一次性卡顿
        setTimeout(function () {
          var ctx = cv.getContext('2d');
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          cv.width = 260 * dpr; cv.height = 112 * dpr;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (e) {
            /* 显示已收集到的「最稀有颜色」（按概率取最小，不依赖数组顺序） */
            var best = null;
            CFG.colorMorphs.forEach(function (cm) {
              if (!(e.colors && e.colors[cm.key])) return;
              if (!best || cm.prob < best.prob) best = cm;
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
        }, 0);
      });

      if (!list.length) root.appendChild(U.el('div', 'empty-tip', '没有符合条件的鱼'));
      else root.appendChild(grid);

      var lg = U.el('div', 'legend-list');
      lg.style.marginTop = '14px';
      CFG.rarity.forEach(function (r, i) {
        lg.innerHTML += '<span class="lg"><i style="background:' + r.color + '"></i>' + r.name + '</span>';
      });
      CFG.colorMorphs.forEach(function (c) {
        lg.innerHTML += '<span class="lg"><i style="background:' + (c.tint || '#8b98a5') + '"></i>' + c.name +
                        ' ' + fmtPct(c.prob / colorProbTotal()) + '　售价 ×' + c.valueMul.toFixed(2) + '</span>';
      });
      root.appendChild(lg);
      var ctip = U.el('div', 'hint-text');
      ctip.style.marginTop = '8px';
      ctip.innerHTML = '每种鱼最多可能有 6 种颜色。图鉴里显示的图案是<b>你收集到的最稀有颜色</b>，' +
                       '下面 6 个小圆点代表该颜色的收集状态。<b>点任意一条鱼可以查看它的颜色收集详情</b>。' +
                       '颜色只影响外观和售价，<b>不影响解锁</b>。';
      root.appendChild(ctip);
    },
  };

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
          else right = '<button class="sh-buy">买 ' + b.pack + ' 个</button>' +
                       '<div class="sh-price" style="text-align:center;margin-top:4px">' + U.coin(b.price * b.pack) + ' 金</div>';
          var desc = b.desc + ' ｜ 上鱼速度 ×' + b.speed.toFixed(2) +
                     ' ｜ 稀有权重 ×' + b.rareMul.toFixed(2) +
                     (b.legendMul > 1 ? ' ｜ 传说 ×' + b.legendMul.toFixed(2) : '') +
                     ' ｜ 持有 ' + (b.free ? '∞' : have);
          shopRow('🪱', b.name, desc, right, function () {
            if (b.free) { St.selectBait(b.id); G.Audio.click(); refresh(); G.State.emit('bait'); return; }
            var r = St.buyBait(b.id, 1);
            if (!r.ok) { G.Audio.deny(); G.State.emit('toast', { text: r.msg, kind: 'bad' }); return; }
            G.Audio.coin();
            G.State.emit('toast', { text: '购入 ' + b.name + ' ×' + r.amount, kind: 'good' });
            if (!St.baitCount(s.baitSel) && s.baitSel !== 'worm') St.selectBait(b.id);
            refresh();
          }, s.baitSel === b.id ? 'owned' : '');
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
        G.DECORS.forEach(function (r) {
          var owned = s.decors.indexOf(r.id) >= 0;
          var right = owned ? '<button class="sh-buy equipped">已拥有</button>'
            : '<button class="sh-buy"' + (s.coin < r.price ? ' disabled' : '') + '>购买</button>' +
              '<div class="sh-price" style="text-align:center;margin-top:4px">' + U.coin(r.price) + ' 金</div>';
          shopRow(r.icon, r.name, r.desc, right, function () {
            if (owned) return;
            var res = St.buyDecor(r.id);
            if (!res.ok) { G.Audio.deny(); G.State.emit('toast', { text: res.msg, kind: 'bad' }); return; }
            G.Audio.coin();
            G.State.emit('toast', { text: '获得装饰：' + r.name, kind: 'good' });
            G.Scene.setDecor(s.decors);
            refresh();
          }, owned ? 'owned' : '');
        });
        var tip = U.el('div', 'hint-text');
        tip.style.marginTop = '12px';
        tip.textContent = '装饰纯外观，购买后会真实出现在钓场里。';
        root.appendChild(tip);
      }

      if (shopTab === 'paid') {
        var m = CFG.monetization;
        var info = U.el('div', 'hint-text');
        info.innerHTML =
          '<b>本版本为单机版，全部付费点暂未开启</b>（' + (m.enabled ? '已开启' : '开关关闭') + '）。<br>' +
          '以下是策划案里的付费设计，代码里已预留接口，接小程序 / Steam 时再打开：<br><br>';
        var rows = [
          ['🎣', '稀有鱼竿', '钓到稀有鱼的概率提高 20%（已实现为鱼竿稀有权重 ×1.08~×1.45）'],
          ['📅', '月卡 · 自动挂机', '挂机自动帮上鱼，稀有鱼概率下降 5%（当前免费开放）'],
          ['📤', '分享得鱼竿', '分享给好友可获得鱼竿，稀有鱼概率 +10%'],
          ['🎬', '视频兑换码', '做视频发布到平台可领取兑换码，解锁挂机自动上鱼'],
          ['📺', '看广告', '观看广告获得 1 小时挂机券'],
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
      g1.innerHTML =
        box('累计游玩时长', U.clock(s.playTime)) +
        box('金币', U.num(Math.round(s.coin))) +
        box('总抛竿数', U.num(st.casts)) +
        box('总钓获', U.num(st.catches)) +
        box('图鉴收集', gp.got + ' / ' + gp.total) +
        box('图鉴完成度', (gp.pct * 100).toFixed(1), '%') +
        box('当前钓场预计收满', fmtH((G.FIELD_MAP[s.field] || {}).estOwnHours || 0)) +
        box('全部收满预计', fmtH(G.FIELDS[G.FIELDS.length - 1].estUnlockHours + G.FIELDS[G.FIELDS.length - 1].estOwnHours));
      root.appendChild(g1);

      root.appendChild(U.el('div', 'section-title', '记录'));
      var g2 = U.el('div', 'stat-grid');
      var maxFish = st.maxKgFish ? (G.FISH_ID[Object.keys(G.FISH_ID).find(function (k) { return G.FISH_ID[k].name === st.maxKgFish; })] || {}).name : '';
      g2.innerHTML =
        box('最大重量', U.kg(st.maxKg)) +
        box('该记录鱼种', (st.maxKgFish || '—')) +
        box('累计卖鱼收入', U.coin(st.totalValue)) +
        box('断线次数', U.num(st.snaps)) +
        box('脱钩次数', U.num(st.escapes)) +
        box('挂机钓获', U.num(st.idleCatches));
      root.appendChild(g2);

      root.appendChild(U.el('div', 'section-title', '各钓场进度'));
      var g3 = U.el('div', 'shop-list');
      G.FIELDS.forEach(function (f) {
        var p = St.fieldProgress(f.id);
        var unlocked = !!s.unlocked[f.id];
        var need = f.collectionPct >= 1 ? p.total : St.needCount(p.total, f.collectionPct || 0.8);
        var row = U.el('div', 'shop-item' + (unlocked ? '' : ''));
        row.innerHTML = '<div class="sh-ico" style="font-weight:800;color:#fff;background:' +
            ({ D:'#8b98a5', C:'#5aa9d6', B:'#3f8f5f', A:'#2b6fc4', S:'#3b4a8f', SS:'#5b3fa8', SSS:'#a87a1f' }[f.rank]) + '">' + f.rank + '</div>' +
          '<div class="sh-main"><div class="sh-name">' + (f.hidden && !unlocked ? '？？？' : f.name) + '</div>' +
          '<div class="sh-desc">图鉴 ' + p.got + '/' + p.total + '（' + (p.pct * 100).toFixed(0) + '%）' +
          (unlocked ? ' ｜ 已解锁' : ' ｜ ' + (f.requireFull ? '需前置 100%' : '需 ' + Math.round((f.collectionPct || 0.8) * 100) + '%')) + '</div></div>';
        g3.appendChild(row);
      });
      root.appendChild(g3);
    },
  };

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

      row('音效', '开关全部程序化音效与环境水声', '<button class="btn-ghost" id="setSound">' +
        (s.settings.sound ? '已开启' : '已关闭') + '</button>', function (c) {
        U.on(c.querySelector('#setSound'), 'click', function () {
          s.settings.sound = !s.settings.sound;
          G.Audio.setEnabled(s.settings.sound);
          if (s.settings.sound && s.settings.ambient) G.Audio.startAmbience();
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

      row('音量', '整体音量 0 ~ 100', '<input type="range" id="setVol" min="0" max="100" value="' +
        Math.round(s.settings.volume * 100) + '">', function (c) {
        U.on(c.querySelector('#setVol'), 'input', function (e) {
          var v = e.target.value / 100;
          s.settings.volume = v;
          G.Audio.setVolume(v);
          St.scheduleSave();
        });
      });

      row('挂机', '自动抛竿、自动提竿、自动收线（稀有鱼概率 ×0.95）',
        '<button class="btn-ghost" id="setIdle">' + (s.settings.idle ? '已开启' : '已关闭') + '</button>',
        function (c) {
          U.on(c.querySelector('#setIdle'), 'click', function () {
            var v = !s.settings.idle;
            St.setIdle(v);
            U.$('#chkIdle').checked = v;
            refresh();
          });
        });

      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '16px';
      tip.innerHTML =
        '当前版本 <b>v' + CFG.version + '</b> ｜ 存档保存在浏览器 localStorage，清缓存会丢档。<br>' +
        '快捷键：<kbd>空格</kbd> 抛竿 / 提竿 / 收线。';
      root.appendChild(tip);

      row('重置存档', '清空所有进度，重新开始。此操作不可撤销。',
        '<button class="btn-ghost danger" id="setReset">重置</button>', function (c) {
        U.on(c.querySelector('#setReset'), 'click', function () {
          if (!confirm('确定要清空所有进度吗？此操作不可撤销。')) return;
          St.reset();
          location.reload();
        });
      });

      row('导出存档', '把存档 JSON 复制到剪贴板，方便备份',
        '<button class="btn-ghost" id="setExport">导出</button>', function (c) {
        U.on(c.querySelector('#setExport'), 'click', function () {
          var txt = JSON.stringify(St.get());
          if (navigator.clipboard) navigator.clipboard.writeText(txt);
          G.State.emit('toast', { text: '存档已复制到剪贴板', kind: 'good' });
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
          '<div class="pr-desc">' + b.desc + '<br>速度 ×' + b.speed.toFixed(2) +
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
      tip.textContent = '鱼饵每抛一竿消耗一个。蚯蚓无限免费，永远不会让你空军。';
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
      root.innerHTML =
        '<div class="hint-text" style="font-size:13px">你离开了 <b>' + U.dur(r.seconds) + '</b>，' +
        '挂机替你完成了 <b>' + r.count + '</b> 次抛竿。</div>';
      var g = U.el('div', 'stat-grid');
      g.style.marginTop = '14px';
      g.innerHTML =
        '<div class="stat-box"><div class="sb-label">钓获</div><div class="sb-value">' + r.count + '<small>条</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">收入</div><div class="sb-value">' + U.coin(r.coin) + '<small>金</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">史诗 / 传说</div><div class="sb-value">' + r.rare + '<small>条</small></div></div>' +
        '<div class="stat-box"><div class="sb-label">新增图鉴</div><div class="sb-value">' + r.kinds + '<small>种</small></div></div>';
      root.appendChild(g);
      if (r.unlocks && r.unlocks.length) {
        var t = U.el('div', 'hint-text');
        t.style.marginTop = '12px';
        t.innerHTML = '🎉 解锁新钓场：<b>' + r.unlocks.map(function (f) { return f.name; }).join('、') + '</b>';
        root.appendChild(t);
      }
      var tip = U.el('div', 'hint-text');
      tip.style.marginTop = '12px';
      tip.textContent = '离线补算上限 8 小时。挂机期间稀有鱼概率 ×0.95。';
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
    rows.innerHTML =
      '<div class="cc-row"><span>重量</span><span>' + U.kg(info.kg) + '</span></div>' +
      '<div class="cc-row"><span>体长参考</span><span>' + (info.kg / (info.fish.maxKg || 1) * 100).toFixed(0) + '% 上限</span></div>' +
      '<div class="cc-row"><span>颜色系数</span><span>×' + info.color.valueMul.toFixed(2) + '</span></div>' +
      '<div class="cc-row"><span>卖出价</span><span>' + U.coin(info.price) + ' 金' + (info.isNew ? '（图鉴奖励 ×' + CFG.economy.firstCatchBonus + '）' : '') + '</span></div>' +
      '<div class="cc-row"><span>图鉴累计</span><span>' + (St.bookEntry(info.fish.id).n) + ' 条</span></div>';

    U.$('#ccSell').textContent = '收下 ' + U.coin(info.price) + ' 金';
    U.$('#ccKeep').classList.add('hidden');

    // 绘制
    var cv = catchCanvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    U.on(U.$('#ccSell'), 'click', function () {
      G.Audio.coin();
      hideCatch();
      if (onDone) onDone();
    });
  }

  return {
    init: init, open: open, close: close, refresh: refresh, isOpen: isOpen,
    setOnClose: setOnClose,
    showCatch: showCatch, hideCatch: hideCatch, isCatchOpen: isCatchOpen,
    initCatchButtons: initCatchButtons,
    VIEWS: VIEWS,
  };
})();
