/* =========================================================
   main.js  —  启动与主循环
   ========================================================= */
(function () {
  var U = G.U, St = G.State, Hud = G.Hud, S = G.Scene, F = G.Fishing, P = G.Panels;
  var last = 0, hudTimer = 0, lastState = '', hiddenAt = 0, bootDone = false;

  function boot() {
    /* ---------- 存档 ---------- */
    St.load();
    var s = St.get();

    G.Audio.setEnabled(s.settings.sound);
    G.Audio.setVolume(s.settings.volume);

    /* ---------- 场景 ---------- */
    var field = G.FIELD_MAP[s.field] || G.FIELDS[0];
    S.init(U.$('#scene'));
    S.setField(field);
    S.setDecor(s.decors);

    /* ---------- UI ---------- */
    P.init();
    P.initCatchButtons(function () { onCatchCardClosed(); });

    Hud.init({
      onPress: handlePress,
      onRelease: function () { F.release(); },
      onIdleToggle: function (v) {
        Hud.toast({ text: v ? '已开启挂机，自动帮你上鱼（稀有 ×0.95）' : '已关闭挂机', kind: v ? 'good' : '' });
        if (v) Hud.syncDeck();
      },
    });
    Hud.setField(field);
    Hud.syncAll();

    /* ---------- 钓鱼 ---------- */
    F.init({
      onState: onStateChange,
      onCatch: onCatch,
      onMiss: onMiss,
      onToast: function (o) { Hud.toast(o); },
      onUnlock: onUnlock,
    });

    /* ---------- 事件订阅 ---------- */
    St.on('toast', function (o) { Hud.toast(o); });
    St.on('coin', function () { Hud.syncCoin(true); });
    St.on('bait', function () { Hud.syncDeck(); });
    St.on('shop', function () { Hud.syncDeck(); });
    St.on('idle', function () { Hud.syncDeck(); });
    St.on('reset', function () { location.reload(); });

    /* ---------- 首次交互激活音频 ---------- */
    var armed = false;
    function arm() {
      if (armed) return; armed = true;
      if (St.get().settings.sound && St.get().settings.ambient) {
        G.Audio.setEnabled(true);
        G.Audio.startAmbience();
      }
    }
    U.on(window, 'pointerdown', arm, { once: false });
    U.on(window, 'keydown', arm, { once: false });

    /* ---------- 画布点击 = 主按钮 ---------- */
    U.on(U.$('#scene'), 'pointerdown', function (e) {
      var st = F.getState();
      if (st === 'idle' || st === 'bite' || st === 'waiting') handlePress();
    });

    /* ---------- 网页隐藏 / 显示 ---------- */
    U.on(document, 'visibilitychange', function () {
      if (document.hidden) {
        hiddenAt = Date.now();
        St.save(true);
      } else {
        last = performance.now();
        if (hiddenAt && St.get().settings.idle) {
          var away = (Date.now() - hiddenAt) / 1000;
          if (away > 90) {
            var r = F.offlineCatchUp(away, avgCycle());
            if (r) {
              Hud.toast({ text: '挂机期间又上了 ' + r.count + ' 条鱼，入账 ' + U.coin(r.coin) + ' 金', kind: 'good' });
              Hud.syncAll();
              if (r.unlocks && r.unlocks.length) onUnlock(r.unlocks);
            }
          }
        }
        hiddenAt = 0;
      }
    });

    /* ---------- 关闭前保存 ---------- */
    U.on(window, 'beforeunload', function () { St.save(true); });
    setInterval(function () { St.save(false); }, G.CONFIG.misc.autoSaveInterval * 1000);

    /* ---------- 离线挂机补算 ---------- */
    var away = (Date.now() - (s.lastSeen || Date.now())) / 1000;
    if (s.settings.idle && away > 300) {
      var r = F.offlineCatchUp(away, avgCycle());
      if (r) {
        Hud.syncAll();
        setTimeout(function () { P.open('offline', r); }, 500);
      }
    } else if (away > 86400 * 3) {
      setTimeout(function () {
        Hud.toast({ text: '好久不见，钓场还在等你', kind: 'good' });
      }, 900);
    }

    syncAction();
    bootDone = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }

  /* ---------------- 状态 ---------------- */
  function avgCycle() {
    var f = G.FIELD_MAP[St.get().field] || G.FIELDS[0];
    var sum = 0, tot = 0;
    f.rarity.forEach(function (v, i) {
      sum += v * ((G.CONFIG.rarity[i].timeMin + G.CONFIG.rarity[i].timeMax) / 2 + 12);
      tot += v;
    });
    return Math.max(12, sum / tot);
  }

  function onStateChange(st) {
    syncAction();
    Hud.showBite(st === 'bite');
    Hud.showFight(st === 'fight');
    if (st !== 'fight') Hud.updateFight(null);
  }

  function syncAction() {
    if (P.isCatchOpen()) { Hud.setAction('继 续', {}); return; }
    var st = F.getState();
    switch (st) {
      case 'idle':    Hud.setAction('抛 竿', {}); break;
      case 'flying':  Hud.setAction('抛 竿 中', { disabled: true }); break;
      case 'waiting': Hud.setAction('收 杆', {}); break;
      case 'bite':    Hud.setAction('提 竿 ！', { reel: true }); break;
      case 'fight':   Hud.setAction('收 线 中', { reel: true }); break;
      default:        Hud.setAction('抛 竿', {});
    }
  }

  function handlePress() {
    if (P.isOpen()) return;
    if (P.isCatchOpen()) { P.hideCatch(); onCatchCardClosed(); return; }
    var st = F.getState();
    if (st === 'fight') { F.press(); return; }
    if (st === 'bite') { F.press(); return; }
    if (st === 'idle') { F.press(); return; }
    if (st === 'waiting') { F.giveUp(); return; }
  }

  /* ---------------- 渔获 ---------------- */
  function onCatch(info) {
    Hud.syncAll();

    if (G.Fishing.isIdleMode()) {
      // 挂机模式不弹卡片，只播报值得看的
      if (info.isNew) {
        Hud.toast({ text: '🆕 图鉴新增：' + info.fish.name + '（' + G.CONFIG.rarity[info.rar].name + '）', kind: 'good' });
      } else if (info.rar >= 2) {
        Hud.toast({ text: G.CONFIG.rarity[info.rar].name + '鱼！' + info.fish.name + ' ' + U.kg(info.kg), kind: 'good' });
      }
      return;
    }
    P.showCatch(info);
    syncAction();
  }

  function onCatchCardClosed() {
    syncAction();
    Hud.syncAll();
  }

  function onMiss(result, pending) {
    if (G.Fishing.isIdleMode()) return;
    if (result === 'snap') Hud.toast({ text: '啪！线断了，鱼跑了', kind: 'bad' });
    else if (result === 'escape') Hud.toast({ text: '松线太久，鱼脱钩了', kind: 'bad' });
    else Hud.toast({ text: '没抓住咬口，鱼跑了', kind: 'warn' });
  }

  function onUnlock(list) {
    G.Audio.unlock();
    list.forEach(function (f) {
      Hud.toast({ text: '🎉 解锁新钓场：' + f.name + '（' + f.rank + ' 级）', kind: 'good' });
    });
    var s = St.get();
    if (!s.unlocked[s.field]) {
      St.setField(list[0].id);
      G.Fishing.setField(list[0]);
      S.setField(list[0]);
      Hud.setField(list[0]);
      Hud.syncAll();
    }
    if (P.isOpen()) P.refresh();
  }

  /* ---------------- 主循环 ---------------- */
  function loop(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.05);

    var paused = P.isCatchOpen() || P.isOpen();

    if (document.visibilityState === 'visible') St.tick(dt);

    if (!paused) {
      F.update(dt);
      /* 鱼力竭提示 */
      var f = G.Fight.get();
      if (f && f.tire !== undefined && f.tire < 0.62 && !f._tiredNote) {
        f._tiredNote = true;
        Hud.toast({ text: '鱼开始力竭了，顺势收线！', kind: 'good' });
      }
    }

    S.render(dt);

    if (F.getState() === 'fight') Hud.updateFight(G.Fight.snapshot());

    hudTimer += dt;
    if (hudTimer > 0.4) { hudTimer = 0; Hud.syncStats(); }

    requestAnimationFrame(loop);
  }

  /* ---------------- go ---------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
