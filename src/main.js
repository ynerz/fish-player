/* =========================================================
   main.js  —  启动与主循环
   ========================================================= */
(function () {
  var U = G.U, St = G.State, Hud = G.Hud, S = G.Scene, F = G.Fishing, P = G.Panels;
  var last = 0, hudTimer = 0, lastState = '', hiddenAt = 0, bootDone = false;
  var blurred = false;   /* 窗口失焦（切到别的应用）时也停掉逻辑与计时 */

  function boot() {
    /* ---------- 错误采集（先挂上：后面任何一步崩了，日志里都有「崩在哪一步」） ---------- */
    if (G.Track) G.Track.init();

    /* ---------- 存档 ---------- */
    St.load();
    var s = St.get();

    G.Audio.setEnabled(s.settings.sound);
    G.Audio.setVolume(s.settings.volume);

    /* ---------- 长线目标（每日任务 / 成就 / 称号） ---------- */
    G.Goals.init();

    /* ---------- 天气与时段 ---------- */
    G.Weather.init(Math.random());
    G.Weather.on(function (sn) { Hud.setWeather(sn); });
    Hud.setWeather(G.Weather.snapshot());

    /* ---------- 场景 ---------- */
    var field = G.FIELD_MAP[s.field] || G.FIELDS[0];
    S.init(U.$('#scene'));
    S.setField(field);
    S.setDecor(s.decors);

    /* ---------- UI ---------- */
    P.init();
    P.initCatchButtons(catchDone);

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

    /* ---------- 新手引导（首次抛竿前就出现，非阻塞气泡） ---------- */
    G.Tutorial.init();

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
    St.on('net', function () { if (P.current() === 'net') P.refresh(); });
    /* 水族箱被动收益：只静默更新数字，不闪（钱是躺着来的，闪会让人以为出错） */
    St.on('tankyield', function () { Hud.syncCoin(false); });
    St.on('eco', function () { if (P.current() === 'net') P.refresh(); });
    St.on('reset', function () { location.reload(); });
    St.on('goals', function () {
      Hud.setTitle(G.Goals.equipped());
      /* 徽标平时靠 0.4 秒一次的 syncStats() 顺带刷；这里补一次，
         让「刚好完成一条任务」时角标立刻出现，不等下一拍 */
      Hud.syncGoalBadge();
      if (P.current() === 'goals') P.refresh();
    });

    /* ---------- 首次交互激活音频 ---------- */
    var armed = false;
    function arm() {
      if (armed) return; armed = true;
      if (St.get().settings.sound && St.get().settings.ambient) {
        G.Audio.setEnabled(true);
        G.Audio.startAmbience();
      }
    }
    G.Platform.input.down(window, arm);
    G.Platform.input.key(arm, true);

    /* ---------- 天气/时段 芯片点一下可以看说明 ---------- */
    U.on(U.$('#weatherChip'), 'click', function () {
      var sn = G.Weather.snapshot();
      Hud.toast({ text: sn.wx.icon + ' ' + sn.wx.name + '：' + sn.wx.tips, kind: '' });
      Hud.toast({ text: sn.tm.icon + ' ' + sn.tm.name + '：' + sn.tm.tip, kind: '' });
    });

    /* ---------- 画布点击 = 主按钮 ----------
       ⚠️ 这里**不要**再按 state 写白名单。踩过的坑：白名单只列了
       idle/bite/waiting、漏了 fight，于是「拉扯中按住画布」收不了线，
       而松手是全局监听（pointerup 绑在 window）→ 左右不对称，鱼必脱钩，
       且不报任何错。handlePress() 自身已经处理了全部状态与面板守卫
       （flying 状态天然是 no-op），所以直接透传即可。 */
    G.Platform.input.down(U.$('#scene'), function () {
      handlePress();
    });

    /* ---------- 网页隐藏 / 显示 ---------- */
    U.on(document, 'visibilitychange', function () {
      if (document.hidden) {
        hiddenAt = Date.now();
        St.save(true);
      } else {
        last = performance.now();
        /* 页面重新可见：先结算水族箱的被动收益（与挂机开关无关） */
        if (hiddenAt) {
          var t2 = St.tankCatchUp((Date.now() - hiddenAt) / 1000);
          if (t2.coin > 0) {
            Hud.toast({ text: '🐠 水族箱产出 ' + U.coin(t2.coin) + ' 金', kind: 'good' });
            Hud.syncAll();
          }
        }
        if (hiddenAt && St.get().settings.idle) {
          var away = (Date.now() - hiddenAt) / 1000;
          if (away > 90) {
            var r = F.offlineCatchUp(away, avgCycle());
            if (r) {
              Hud.toast({ text: '挂机期间又上了 ' + r.count + ' 条鱼，入账 ' + U.coin(r.coin) + ' 金', kind: 'good' });
              if (r.recent) r.recent.forEach(function (x) { Hud.pushCatch(x); });
              Hud.syncAll();
              if (r.unlocks && r.unlocks.length) onUnlock(r.unlocks);
            }
          }
        }
        hiddenAt = 0;
      }
    });

    /* ---------- 窗口失焦：多显示器下切走也要停，只靠 visibilitychange 不够 ---------- */
    U.on(window, 'blur', function () { blurred = true; St.save(true); });
    U.on(window, 'focus', function () { blurred = false; last = performance.now(); });

    /* ---------- 关闭前保存 ---------- */
    U.on(window, 'beforeunload', function () { St.save(true); });
    setInterval(function () { St.save(false); }, G.CONFIG.misc.autoSaveInterval * 1000);

    /* ---------- 水族箱离线收益 ----------
       ⚠️ 刻意不看 settings.idle：那条开关管的是「挂机钓鱼」，
          水族箱是被动收益，没开挂机也该产。上限沿用 idle.maxCatchUp。 */
    var awaySec = (Date.now() - (s.lastSeen || Date.now())) / 1000;
    var ty = St.tankCatchUp(awaySec);
    if (ty.coin > 0) {
      setTimeout(function () {
        Hud.toast({
          text: '🐠 水族箱在你不在的时候产出 ' + U.coin(ty.coin) + ' 金' +
                (ty.capped ? '（已按 ' + Math.round(G.CONFIG.idle.maxCatchUp / 3600) + ' 小时上限结算）' : ''),
          kind: 'good',
        });
      }, 1200);
    }

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
  /* 单竿期望耗时（秒）= 期望咬口（含 biteMul）+ 期望拉扯
     与 tools/balance.js 的 cycleOf() 用同一套口径，离线补算才准。 */
  function avgCycle() {
    var f = G.FIELD_MAP[St.get().field] || G.FIELDS[0];
    var w = G.Loot.rarityWeights(f, { bait: null, rod: null, idle: true });
    var tw = w.reduce(function (a, b) { return a + b; }, 0);
    var ex = G.CONFIG.misc.fightExpect;
    var sum = 0;
    for (var i = 0; i < 4; i++) {
      sum += (w[i] / tw) * (G.Loot.biteTime(i, { field: f }) + ex[i]);
    }
    return Math.max(5, sum);
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
    if (P.isCatchOpen()) { P.dismissCatch(catchDone); return; }
    var st = F.getState();
    if (st === 'fight') { F.press(); return; }
    if (st === 'bite') { F.press(); return; }
    if (st === 'idle') { F.press(); return; }
    if (st === 'waiting') { F.giveUp(); return; }
  }

  /* ---------------- 渔获 ---------------- */
  function onCatch(info) {
    Hud.syncAll();
    /* 每一竿的收获都进播报栏 —— 挂机时也能看到钓到了什么 */
    Hud.pushCatch(info);

    if (G.Fishing.isIdleMode()) {
      // 挂机不打断操作，只在值得看的时候补一条醒目提示
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

  /* 结算卡的两个出口：卖出（默认）/ 收进鱼护 */
  function catchDone(action, info) {
    if (info) {
      if (action === 'keep' && G.State.toNet(info.fish, info.kg, info.color.key)) {
        var ns = G.State.get();
        Hud.toast({ text: '收进鱼护　' + G.State.netCount() + '/' + ns.netCap, kind: 'good' });
        onCatchCardClosed();
        if (P.isOpen()) P.refresh();
        return;
      }
      if (action === 'keep') {
        Hud.toast({ text: '鱼护满了，先卖几条或扩容', kind: 'warn' });
      }
      /* 卖出（含鱼护满时的兜底） */
      G.State.addCoin(info.price);
      G.State.get().stats.totalValue += info.price;
      Hud.syncCoin(true);
    }
    onCatchCardClosed();
    if (P.isOpen()) P.refresh();
  }

  function onMiss(result, pending, fee) {
    if (G.Fishing.isIdleMode()) return;
    if (result === 'snap') {
      Hud.toast({
        text: '啪！线断了，鱼跑了' + (fee ? '　修理鱼线 -' + U.coin(Math.round(fee)) + ' 金' : ''),
        kind: 'bad',
      });
      if (fee) Hud.syncCoin(true);
    } else if (result === 'escape') {
      Hud.toast({ text: '松线太久，鱼脱钩了', kind: 'bad' });
    } else {
      Hud.toast({ text: '没抓住咬口，鱼跑了', kind: 'warn' });
    }
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
  var frameAcc = 0;
  var FRAME_MIN = 1000 / 60;   // 逻辑与渲染都锁在 60fps，高刷屏不再空转

  function loop(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.05);

    /* 帧率上限：144Hz 屏幕上原本会跑满 144 帧，白白耗电发热 */
    frameAcc += dt * 1000;
    if (frameAcc < FRAME_MIN) { requestAnimationFrame(loop); return; }
    var step = Math.min(frameAcc / 1000, 0.05);
    frameAcc = 0;
    dt = step;

    /* 只有「结算卡」会打断钓鱼 —— 玩家正在看渔获。
       浏览图鉴 / 商店 / 统计时挂机继续跑，否则挂机游戏的核心预期就废了。 */
    var paused = P.isCatchOpen();

    var focused = document.visibilityState === 'visible' && !blurred;
    if (focused) {
      St.tick(dt);
      St.tankTick(dt);         // 水族箱被动收益（内部每 30 秒结算一次）
      G.Weather.update(dt);
      G.Goals.tick(dt);        // 跨天自动重掷每日任务（内部按 3 秒节流）
    }

    if (!paused && focused) {
      F.update(dt);
      /* 鱼力竭提示 */
      var f = G.Fight.get();
      if (f && f.tire !== undefined && f.tire < 0.62 && !f._tiredNote) {
        f._tiredNote = true;
        Hud.toast({ text: '鱼开始力竭了，顺势收线！', kind: 'good' });
      }
    }

    /* 新手引导：失焦时 dt 传 0，只保持显示不推进进度 */
    var fsnap = F.getState() === 'fight' ? G.Fight.snapshot() : null;
    G.Tutorial.update(focused ? dt : 0, F.getState(), {
      holding: F.isHolding(),
      dashing: !!(fsnap && fsnap.dashing),
    });

    S.render(dt);

    if (F.getState() === 'fight') Hud.updateFight(G.Fight.snapshot());

    hudTimer += dt;
    if (hudTimer > 0.4) { hudTimer = 0; Hud.syncStats(); }

    requestAnimationFrame(loop);
  }

  /* ---------------- go ----------------
     boot 里抛异常原来就是白屏、什么都不留。现在至少把「崩在启动阶段」
     连同当时的版本 / 钓场 / 钓鱼状态记进 G.Track，方便回捞。 */
  function safeBoot() {
    try {
      boot();
    } catch (e) {
      if (G.Track) G.Track.error('boot 启动失败', e, { stage: 'boot' });
      throw e;    // 原样抛出去，控制台照旧能看到完整栈
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeBoot);
  } else {
    safeBoot();
  }
})();
