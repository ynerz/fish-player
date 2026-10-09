/* =========================================================
   hud.js  —  顶栏 / 底栏 / 按钮 / 提示 / 拉扯 UI
   ========================================================= */
window.G = window.G || {};

G.Hud = (function () {
  var U = G.U, St = G.State, CFG = G.CONFIG;
  var el = {};
  var handlers = {};
  var fightVisible = false;

  function init(h) {
    handlers = h || {};
    el.coin  = U.$('#statCoin .val');
    el.time  = U.$('#statTime .val');
    el.book  = U.$('#statBook .val');

    el.slotBait = U.$('#slotBait');
    el.slotRod  = U.$('#slotRod');
    el.slotLine = U.$('#slotLine');

    el.chkIdle  = U.$('#chkIdle');
    el.btn      = U.$('#btnAction');
    el.bite     = U.$('#biteHint');
    el.fight    = U.$('#fightUI');
    el.barProg  = U.$('#barProg');
    el.barTen   = U.$('#barTension');
    el.fightTip = U.$('#fightTip');
    el.toasts   = U.$('#toasts');
    el.badgeName = U.$('.fb-name');
    el.badgeSub  = U.$('.fb-sub');
    el.idleChip  = U.$('#idleChip');
    el.duelChip  = U.$('#duelChip');
    el.catchLog  = U.$('#catchLog');
    el.wxIcon    = U.$('#wxIcon');
    el.wxText    = U.$('#wxText');
    el.wxChip    = U.$('#weatherChip');
    el.hudTitle  = U.$('#hudTitle');
    el.goalBadge = U.$('#goalBadge');
    el.zoneSafe  = U.$('.tension-track .zone-safe');
    el.dangerMark = U.$('.tension-track .danger-mark');

    /* 安全区带宽度 / 危险线位置都从 CFG.fight.safeRatio 算，
       避免「fight.js 里改 0.78、CSS 里还写着 78%」这种两份硬编码 */
    if (el.zoneSafe)   el.zoneSafe.style.width  = (G.Fight.SAFE * 100) + '%';
    if (el.dangerMark) el.dangerMark.style.left = (G.Fight.SAFE * 100) + '%';

    /* 顶栏按钮
       ⚠️ 弹层**不覆盖顶栏**（`.modal` 从 `top:var(--hud-h)` 开始，见 style.css），
          所以面板开着的时候标签页仍然点得到，可以就地切换：
          · 点别的标签页 → 直接换面板
          · 点当前正开着的那个 → 收起来（当成开关用）
      曾经 `.modal` 是 `inset:0; z-index:50`，把整条顶栏盖住 →
          点击落在遮罩上只会关面板，切个面板要点两次。 */
    U.$$('.tab').forEach(function (b) {
      U.on(b, 'click', function () {
        var p = b.getAttribute('data-panel');
        if (G.Panels.isOpen() && G.Panels.current() === p) {
          G.Panels.close();
        } else {
          G.Panels.open(p);
          setActiveTab(p);
        }
      });
    });
    G.Panels.setOnClose(function () { setActiveTab(null); });

    /* 底栏槽位 */
    U.on(el.slotBait, 'click', function () { G.Panels.open('pickerBait'); });
    U.on(el.slotRod,  'click', function () { G.Panels.open('pickerRod'); });
    U.on(el.slotLine, 'click', function () { G.Panels.open('pickerLine'); });

    /* 挂机开关 */
    U.on(el.chkIdle, 'change', function () {
      St.setIdle(el.chkIdle.checked);
      if (handlers.onIdleToggle) handlers.onIdleToggle(el.chkIdle.checked);
    });

    /* 主按钮：按下 = 抛竿/提竿/收线，抬起 = 放线
       统一走 G.Platform.input，小程序端换成 touchstart/touchend 即可 */
    var PI = G.Platform.input;
    PI.down(el.btn, function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (handlers.onPress) handlers.onPress();
    });
    PI.up(function () {
      if (handlers.onRelease) handlers.onRelease();
    });
    PI.cancel(el.btn, function () {
      if (handlers.onRelease) handlers.onRelease();
    });
    PI.leave(el.btn, function () {
      if (handlers.onRelease) handlers.onRelease();
    });
    /* 兜底：指针在窗口外抬起（拖到浏览器外 / 切成别的应用）收不到 pointerup，
       不补这一条就会「一直收线」直到断线 */
    G.Platform.sys.onBlur(function () {
      if (handlers.onRelease) handlers.onRelease();
    });

    /* 键盘：空格（小程序端没有键盘，这段在 weapp 版里删掉即可） */
    PI.key(function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (handlers.onPress) handlers.onPress();
      }
    }, true);
    PI.key(function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        if (handlers.onRelease) handlers.onRelease();
      }
    }, false);

    syncAll();
  }

  function setActiveTab(name) {
    U.$$('.tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-panel') === name);
    });
  }

  /* ---------------- 同步 ---------------- */
  function syncAll() { syncCoin(); syncStats(); syncDeck(); syncTitle(); }

  /* 佩戴中的称号（纯展示，长线目标的奖励） */
  function setTitle(t) {
    if (!el.hudTitle) return;
    var name = t && t.id ? t.name : '';
    el.hudTitle.textContent = name;
    el.hudTitle.classList.toggle('hidden', !name);
    el.hudTitle.title = name ? ('称号：' + name + '（来自' + t.from + '）') : '';
  }
  function syncTitle() { if (G.Goals) setTitle(G.Goals.equipped()); }

  /* 顶栏「目标」角标：有几条已完成但没领的任务。
     每 0.4 秒被 syncStats() 问一次，所以这里只在「数变了」的时候才动 DOM
     （`-1` 是哨兵值：首次一定写一次）。计数本身也换成了不生成文案的实现，
     见 goals.js 的 medalClaimable()。 */
  var goalBadgeN = -1;
  function syncGoalBadge() {
    if (!el.goalBadge || !G.Goals) return;
    var n = G.Goals.medalClaimable();
    if (n === goalBadgeN) return;
    goalBadgeN = n;
    el.goalBadge.textContent = n > 0 ? String(n) : '';
    el.goalBadge.classList.toggle('hidden', n <= 0);
  }

  function syncCoin(flash) {
    el.coin.textContent = U.coin(St.get().coin);
    if (flash) {
      var s = U.$('#statCoin');
      s.classList.remove('flash');
      void s.offsetWidth;
      s.classList.add('flash');
    }
  }

  function syncStats() {
    var s = St.get();
    el.time.textContent = U.clock(s.playTime);
    var p = St.fieldProgress(s.field);
    el.book.textContent = p.got + '/' + p.total;
    syncGoalBadge();
  }

  function syncDeck() {
    var s = St.get();
    var b = St.curBait(), r = St.curRod(), l = St.curLine();
    var cnt = St.baitCount(b.id);
    el.slotBait.querySelector('.slot-value').textContent = b.name;
    el.slotBait.querySelector('.slot-note').textContent = b.free ? '无限' : '剩余 ' + cnt;

    el.slotRod.querySelector('.slot-value').textContent = r.name;
    el.slotRod.querySelector('.slot-note').textContent = '稀有 +' + Math.round((r.rareMul - 1) * 100) + '%';

    el.slotLine.querySelector('.slot-value').textContent = l.name;
    el.slotLine.querySelector('.slot-note').textContent = '张力上限 ' + l.tensionMax;

    el.chkIdle.checked = !!s.settings.idle;
    el.idleChip.classList.toggle('hidden', !s.settings.idle);
  }

  /* ---------------- 比试（N7 四期） ----------------
     限时比试进行中时，顶栏挂一枚倒计时芯片：目标 / 自己这一场最大的那条 / 剩余时间。
     🔴 它**不是装饰**：比试的窗口有 4 分钟，只靠开场那 2.5 秒的 toast，玩家根本
        不知道自己还在比 —— 这枚芯片就是「比试进行中」唯一的常驻可见提示。
     `o` 为 null = 没有进行中的比试 ⇒ 收起（`main.js` 每 0.4 秒问一次引擎）。
     ⚠️ 文案里的数字全部**现算**（`U.kg()` 与剩余秒数），不写死任何阈值；
        自己还没上鱼时显示「—」而不是 `0 g`（0 g 看着像一条真鱼）。 */
  function setDuel(o) {
    if (!el.duelChip) return;
    if (!o) { el.duelChip.classList.add('hidden'); return; }
    var sec = Math.max(0, Math.ceil((o.leftMs || 0) / 1000));
    var mm = Math.floor(sec / 60), ss = sec % 60;
    el.duelChip.classList.remove('hidden');
    el.duelChip.textContent = '⚔ 比试 · 目标 ' + U.kg(o.target || 0)
      + ' · 你 ' + ((o.best > 0) ? U.kg(o.best) : '—')
      + ' · ' + mm + ':' + (ss < 10 ? '0' : '') + ss;
    el.duelChip.title = '限时比最大重量：时间到之前上一条比目标更沉的鱼就算赢';
  }

  /* ---------------- 天气 / 时段 ---------------- */  function setWeather(sn) {
    if (!sn || !el.wxText) return;
    el.wxIcon.textContent = sn.wx.icon + sn.tm.icon;
    el.wxText.textContent = sn.wx.name + ' · ' + sn.tm.name + ' ' + sn.clock;
    /* 稀有加成明显时给个高亮，让玩家看得出「现在是好时机」。
       阈值读 config（原来写死 1.2，改了天气倍率它就失去意义了） */
    var good = sn.rareMul >= CFG.weather.goodMul;
    el.wxChip.classList.toggle('good', good);
    el.wxChip.title = sn.wx.name + '（' + sn.wx.tips + '）／' + sn.tm.name + '（' + sn.tm.tip + '）' +
      '\n稀有档权重 ×' + sn.rareMul.toFixed(2) + '　稀有颜色 ×' + sn.colorBoost.toFixed(2) +
      '\n接下来 ' + Math.max(1, Math.round(sn.left / 60)) + ' 分钟左右会变天';
  }

  function setField(f) {
    el.badgeName.textContent = f.name;
    el.badgeSub.textContent = f.rank + ' 级钓场 · ' + f.sub;
  }

  /* ---------------- 主按钮 ---------------- */
  function setAction(label, opt) {
    opt = opt || {};
    el.btn.textContent = label;
    el.btn.disabled = !!opt.disabled;
    el.btn.classList.toggle('reel', !!opt.reel);
  }

  /* ---------------- 咬钩提示 ---------------- */
  function showBite(v) { el.bite.classList.toggle('hidden', !v); }

  /* ---------------- 拉扯 UI ---------------- */
  function showFight(v) {
    fightVisible = !!v;
    el.fight.classList.toggle('hidden', !v);
  }

  /* 提示文案的四个分支之间来回切，而 updateFight 是**每帧**被调的
     （main.js：`if (focused && F.getState() === 'fight') Hud.updateFight(...)`）。
     以前无条件写 innerHTML → 浏览器每帧都把同一段 HTML 重新解析一遍（纯白跑）。
     缓存最后一次的文案，变了才写。

     文案的**选择**抽成纯函数 `fightTip(s)`：它不碰 DOM，所以 test.js 能在 Node 里
     直接调它 —— 光扫源码只能证明「这句话还在」，真调一次才能证明「哪个分支真的会被走到」。
     阈值也不许再写死在 UI 里：`warn > 0.4` 与 `config.fight.dashWarnLead` 是同一族
     （调了预警时长，提示出现的时刻就跟着变），所以走 `CFG.fight.warnTipAt`。 */
  function fightTip(s) {
    if (!s) return '';
    if (s.dashing) return '<b style="color:#e8595c">鱼在发力！松手！</b>';
    if (s.warn > CFG.fight.warnTipAt) return '<b style="color:#e8a020">要逃窜了，准备松手</b>';
    if (s.danger) return '<b style="color:#e8a020">张力偏高，别一直收</b>';
    return '按住 <kbd>空格</kbd> 或 <kbd>鼠标左键</kbd> 收线，松开放线';
  }

  var fightTipCache = '';

  function updateFight(s) {
    if (!fightVisible || !s) return;
    el.barProg.style.width = (s.progress01 * 100).toFixed(1) + '%';
    el.barTen.style.width = (s.tension01 * 100).toFixed(1) + '%';
    var tip = fightTip(s);
    if (tip !== fightTipCache) {
      fightTipCache = tip;
      el.fightTip.innerHTML = tip;
    }
  }

  /* ---------------- 渔获播报 ----------------
     挂机时不再只弹史诗/传说，所有渔获都进这条流，
     玩家随时能看到钓到了什么。 */
  function pushCatch(info) {
    if (!el.catchLog) return;
    var row = U.el('div', 'cl-row r' + info.rar);
    var dot = info.color && info.color.tint ? info.color.tint : '#a9c7da';
    row.innerHTML =
      '<i style="background:' + dot + '"></i>' +
      '<b>' + info.fish.name + '</b>' +
      '<span class="cl-kg">' + U.kg(info.kg) + '</span>' +
      '<span class="cl-coin">+' + U.coin(info.price) + '</span>' +
      (info.isNew ? '<em>新</em>' : (info.isRecord ? '<em style="background:#e8a020">纪录</em>' : ''));
    row.title = info.fish.name + ' · ' + info.color.name + ' · ' + U.kg(info.kg) + ' · +' + info.price + ' 金';
    el.catchLog.insertBefore(row, el.catchLog.firstChild);
    while (el.catchLog.children.length > 9) el.catchLog.removeChild(el.catchLog.lastChild);
  }

  /* ⚠️ `clearCatchLog()` 已删：全项目零调用（换钓场 / 清档都会整页刷新）。 */

  /* ---------------- 提示 ---------------- */
  function toast(o) {
    var t = U.el('div', 'toast ' + (o.kind || ''), o.text);
    el.toasts.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2500);
    // 最多留 4 条
    while (el.toasts.children.length > 4) el.toasts.removeChild(el.toasts.firstChild);
  }

  /* ⚠️ `el`（DOM 元素缓存表）不再对外导出：全项目零消费（一开始是想给调试用的，
     但 docs/开发者文档.md §11「调试与开发者面板」的调试入口清单里也没有它）。需要哪个元素就补一个真正的
     读取接口，别把整张表挂出去。 */
  return {
    init: init, syncAll: syncAll, syncCoin: syncCoin, syncStats: syncStats, syncDeck: syncDeck,
    setAction: setAction, showBite: showBite, showFight: showFight, updateFight: updateFight,
    fightTip: fightTip,
    toast: toast, setField: setField, setWeather: setWeather,
    setTitle: setTitle, syncTitle: syncTitle, syncGoalBadge: syncGoalBadge,
    pushCatch: pushCatch, setDuel: setDuel,
  };
})();
