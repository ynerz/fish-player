/* =========================================================
   hud.js  —  顶栏 / 底栏 / 按钮 / 提示 / 拉扯 UI
   ========================================================= */
window.G = window.G || {};

G.Hud = (function () {
  var U = G.U, St = G.State;
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

    /* 顶栏按钮 */
    U.$$('.tab').forEach(function (b) {
      U.on(b, 'click', function () {
        var p = b.getAttribute('data-panel');
        if (G.Panels.isOpen()) { G.Panels.close(); }
        else { G.Panels.open(p); setActiveTab(p); }
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

    /* 主按钮：按下 = 抛竿/提竿/收线，抬起 = 放线 */
    U.on(el.btn, 'pointerdown', function (e) {
      e.preventDefault();
      if (handlers.onPress) handlers.onPress();
    });
    U.on(window, 'pointerup', function () {
      if (handlers.onRelease) handlers.onRelease();
    });
    U.on(el.btn, 'pointerleave', function () {
      if (handlers.onRelease) handlers.onRelease();
    });

    /* 键盘：空格 */
    U.on(window, 'keydown', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (handlers.onPress) handlers.onPress();
      }
    });
    U.on(window, 'keyup', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        if (handlers.onRelease) handlers.onRelease();
      }
    });

    syncAll();
  }

  function setActiveTab(name) {
    U.$$('.tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-panel') === name);
    });
  }

  /* ---------------- 同步 ---------------- */
  function syncAll() { syncCoin(); syncStats(); syncDeck(); }

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

  function updateFight(s) {
    if (!fightVisible || !s) return;
    el.barProg.style.width = (s.progress01 * 100).toFixed(1) + '%';
    el.barTen.style.width = (s.tension01 * 100).toFixed(1) + '%';
    if (s.dashing) el.fightTip.innerHTML = '<b style="color:#e8595c">鱼在发力！松手！</b>';
    else if (s.warn > 0.4) el.fightTip.innerHTML = '<b style="color:#e8a020">要逃窜了，准备松手</b>';
    else if (s.danger) el.fightTip.innerHTML = '<b style="color:#e8a020">张力偏高，别一直收</b>';
    else el.fightTip.innerHTML = '按住 <kbd>空格</kbd> 或 <kbd>鼠标左键</kbd> 收线，松开放线';
  }

  /* ---------------- 提示 ---------------- */
  function toast(o) {
    var t = U.el('div', 'toast ' + (o.kind || ''), o.text);
    el.toasts.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2500);
    // 最多留 4 条
    while (el.toasts.children.length > 4) el.toasts.removeChild(el.toasts.firstChild);
  }

  return {
    init: init, syncAll: syncAll, syncCoin: syncCoin, syncStats: syncStats, syncDeck: syncDeck,
    setAction: setAction, showBite: showBite, showFight: showFight, updateFight: updateFight,
    toast: toast, setField: setField,
    el: el,
  };
})();
