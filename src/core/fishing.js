/* =========================================================
   fishing.js  —  钓鱼主循环状态机
   =========================================================
   idle → flying → waiting → bite → fight → resolve → idle
   · 抛竿时就已经决定这一竿会钓到什么（隐藏），上鱼时间由该鱼的稀有度决定
   · waiting 期间可以「提前收杆」放弃这一竿
   · bite 窗口内必须提竿，否则鱼跑掉
   · fight 是张力拉扯博弈（见 fight.js）
   · 挂机时由自动驾驶 AI 完成提竿与收线
   ========================================================= */
window.G = window.G || {};

G.Fishing = (function () {
  var U = G.U, CFG = G.CONFIG, Loot = G.Loot, St = null;

  var field = null;
  var state = 'idle';
  var timer = 0;
  var pending = null;      // 本竿预定的渔获
  var waitLeft = 0;
  var biteLeft = 0;
  var holding = false;
  var autoHold = true;
  var autoHoldTimer = 0;
  var catchCount = 0;      // 挂机累计（用于合并播报）
  var cb = {};

  function init(callbacks) {
    St = G.State;
    cb = callbacks || {};
    field = G.FIELD_MAP[St.get().field] || G.FIELDS[0];
  }

  function setField(f) {
    field = f;
    hardReset();
  }

  function hardReset() {
    state = 'idle';
    timer = 0; pending = null;
    waitLeft = 0; biteLeft = 0; holding = false;
    catchCount = 0;   // 挂机累计播报重新计数，避免跨场/跨状态乱触发
    G.Fight.end();
    G.Scene.endFight();
  }

  function isIdleMode() { return !!St.get().settings.idle; }
  function getState() { return state; }
  function getPending() { return pending; }
  /* 玩家当前是否按住收线 —— 新手引导靠它判断「学会按住 / 刚松手」 */
  function isHolding() { return holding; }

  /* ---------------- 抛竿 ---------------- */
  function canCast() { return state === 'idle'; }

  function cast() {
    if (!canCast()) return false;
    var s = St.get();
    St.consumeBait();

    // 决定这一竿的渔获
    pending = Loot.generate(field, {
      bait: St.curBait(),
      rod: St.curRod(),
      idle: isIdleMode(),
      env: G.Weather.isReady() ? G.Weather.env() : null,
    });

    s.stats.casts++;
    state = 'flying';
    timer = 0;
    holding = false;
    G.Scene.cast();
    if (cb.onState) cb.onState('flying');
    return true;
  }

  /* ---------------- 提前收杆 ---------------- */
  function giveUp() {
    if (state !== 'waiting') return false;
    hardReset();
    G.Audio.click();
    if (cb.onToast) cb.onToast({ text: '收杆了，这一竿放弃', kind: '' });
    if (cb.onState) cb.onState(state);
    return true;
  }

  /* ---------------- 提竿 ---------------- */
  function strike() {
    if (state !== 'bite') return false;
    startFight();
    return true;
  }

  function startFight() {
    state = 'fight';
    timer = 0;
    autoHold = true; autoHoldTimer = 0;
    G.Scene.beginFight(pending.fish);
    G.Fight.begin({
      fish: pending.fish,
      kg: pending.kg,
      tensionMax: St.curLine().tensionMax,
      reelMul: St.curRod().reel,
    });
    if (cb.onState) cb.onState('fight');
  }

  /* ---------------- 结算 ---------------- */
  function resolve(result) {
    var fish = pending ? pending.fish : null;
    var kg = pending ? pending.kg : 0;
    var color = pending ? pending.color : null;
    G.Scene.endFight();
    G.Fight.end();

    if (result === 'success') {
      /* ctx 里的鱼饵 / 天气 / 时段会写进 stats 的分维计数，
         每日任务与成就都从这里取数（见 src/core/goals.js） */
      var rec = St.recordCatch(fish, kg, color.key, {
        bait: St.curBait().id,
        env: G.Weather.isReady() ? G.Weather.env() : null,
      });
      St.noteResult(true);
      var price = Loot.price(fish, kg, color, rec.isNew);
      var s = St.get();
      s.stats.catches++;
      /* ⚠️ 这里**不**直接加钱。
         手动钓上来的鱼由结算卡决定「卖出 / 收进鱼护」；
         挂机时没有玩家点卡片，统一自动卖出（见 config.storage.idleAutoSell）。 */
      if (isIdleMode()) {
        s.stats.idleCatches++;
        if (CFG.storage.idleAutoSell) {
          St.addCoin(price);
          s.stats.totalValue += price;
        } else if (!St.toNet(fish, kg, color.key)) {
          St.addCoin(price);
          s.stats.totalValue += price;
        }
      }

      G.Scene.sparkle(rec.isNew ? 34 : (fish.rar >= 2 ? 26 : 12), fish.rar);
      G.Scene.splash(fish.rar >= 2 ? 1.6 : 1);
      G.Audio.success(fish.rar);
      if (rec.isNew || rec.isRecord) setTimeout(function () { G.Audio.newRecord(); }, 320);

      var unlocks = St.checkUnlocks();
      if (cb.onCatch) cb.onCatch({
        fish: fish, kg: kg, color: color, price: price,
        isNew: rec.isNew, isRecord: rec.isRecord,
        rar: fish.rar, unlocks: unlocks,
      });
      if (unlocks.length && cb.onUnlock) cb.onUnlock(unlocks);

      catchCount++;
      if (isIdleMode() && catchCount % CFG.idle.batchToast === 0 && cb.onToast) {
        cb.onToast({ text: '挂机已上 ' + catchCount + ' 条鱼', kind: 'good' });
      }
    } else {
      var st = St.get();
      var fee = 0;
      St.noteResult(false);          // 断线 / 脱钩 / 错过咬口都打断「连续成功」
      if (result === 'snap') {
        st.stats.snaps++;
        G.Audio.snap(); G.Scene.splash(1.5);
        /* 断线要付鱼线修理费 —— 否则「断线」和「主动放弃」收益完全一样，
           玩家没有理由认真躲逃窜，张力玩法就没有张力。 */
        fee = Math.max(
          CFG.snap.repairMin,
          Math.round(St.curLine().price * CFG.snap.repairPct)
        );
        fee = Math.min(fee, Math.floor(st.coin));
        if (fee > 0) St.spend(fee);
      } else {
        st.stats.escapes++; G.Audio.escape(); G.Scene.splash(0.8);
      }
      if (cb.onMiss) cb.onMiss(result, pending, fee);
    }

    pending = null;
    state = 'idle';
    timer = 0;
    autoHold = true;
    St.scheduleSave();
    /* 每日任务 / 成就的完成判定与播报统一走 Goals，
       这里只负责「这一竿结束了」这个时机 */
    if (G.Goals) G.Goals.check(result === 'success' ? { fish: fish, kg: kg, rar: fish.rar } : null);
    if (cb.onState) cb.onState(state);
  }

  /* ---------------- 主更新 ---------------- */
  function update(dt) {
    if (!St) return;
    var s = St.get();
    var idleOn = !!s.settings.idle;

    switch (state) {

      case 'idle':
        if (idleOn) {
          timer += dt;
          if (timer > CFG.misc.idleCastDelay) cast();
        }
        break;

      case 'flying':
        timer += dt;
        if (timer >= CFG.misc.flyTime) {
          state = 'waiting';
          waitLeft = pending.wait;
          G.Scene.beginWait();
          if (cb.onState) cb.onState('waiting');
        }
        break;

      case 'waiting':
        waitLeft -= dt;
        // 提前收杆提示：临近咬钩时给个暗示（8 秒内浮漂轻微异动）
        if (waitLeft <= CFG.misc.biteHintLead && !pending._hinted) {
          pending._hinted = true;
          G.Scene.floatNudge();          // 浮漂轻微异动：这是「提前收杆」唯一的价值来源
          G.Audio.hint();
        }
        if (waitLeft <= 0) {
          state = 'bite';
          biteLeft = CFG.misc.biteWindow[CFG.rarity[pending.rar].key] || 1.5;
          G.Scene.bite();
          G.Audio.bite();
          if (cb.onState) cb.onState('bite');

          if (idleOn) {
            // 挂机：延迟一点自动提竿，看起来像在操作
            biteLeft = Math.min(biteLeft, CFG.misc.idleStrikeHold);
          }
        }
        break;

      case 'bite':
        biteLeft -= dt;
        if (idleOn && biteLeft <= 0) { startFight(); break; }
        if (biteLeft <= 0) resolve('miss');   // 错过咬钩
        break;

      case 'fight':
        timer += dt;
        var f = G.Fight.get();
        /* 兜底：战局对象丢了（异常情况）→ 直接回到可抛竿状态，避免卡死 */
        if (!f) {
          pending = null;
          G.Scene.endFight();
          state = 'idle'; timer = 0;
          if (cb.onState) cb.onState(state);
          break;
        }

        if (isIdleMode()) {
          stepAuto(dt, f);
        } else {
          G.Fight.update(dt, holding);
        }
        f = G.Fight.get();
        if (f) {
          G.Scene.setRodBend((f.struggle - 0.15) * 1.3 + (f.dashing ? 0.35 : 0));
          var evs = G.Fight.drainEvents();
          for (var i = 0; i < evs.length; i++) {
            if (evs[i] === 'dash') G.Scene.splash(0.4);
            if (evs[i] === 'overSafe' && cb.onToast) cb.onToast({ text: '张力过高！松手！', kind: 'bad' });
          }
          if (f.over) resolve(f.result);
          else if (f.elapsed > CFG.misc.fightTimeout) resolve('escape');   // 兜底：单场拉扯上限
        }
        break;
    }
  }

  /* 自动驾驶 AI */
  function stepAuto(dt, f) {
    var a = CFG.idle.auto;
    autoHoldTimer += dt;
    if (autoHoldTimer >= a.react) {
      autoHoldTimer = 0;
      var maxT = f.tensionMax;
      if (f.dashing || f.warn > a.warn) autoHold = false;
      else if (f.tension >= maxT * a.hi) autoHold = false;
      else if (f.tension <= maxT * a.lo) autoHold = true;
    }
    G.Fight.update(dt, autoHold);
  }

  /* ---------------- 输入 ---------------- */
  function press() {
    if (state === 'fight') { holding = true; return; }
    if (state === 'bite') { strike(); return; }
    if (state === 'idle') { cast(); return; }
    if (state === 'waiting') { /* 由主按钮走 giveUp */ }
  }
  function release() {
    if (state === 'fight') holding = false;
  }

  /* ---------------- 离线补算 ----------------
     页面关闭期间如果开着挂机，回来时按保守速率补一部分收益 */
  function offlineCatchUp(seconds, onlineCycle) {
    seconds = Math.min(seconds, CFG.idle.maxCatchUp);
    if (seconds < 60) return null;
    var s = St.get();
    var cycle = onlineCycle || 35;
    var n = Math.floor(seconds / cycle);
    if (n <= 0) return null;

    // 用「期望收益」而不是逐条模拟，避免卡顿
    var sumCoin = 0, gained = {}, rareGot = 0, newKinds = 0;
    var sample = Math.min(n, 4000);
    for (var i = 0; i < sample; i++) {
      /* 离线期间会跨过很多次天气变化，这里用「中性环境」，
         保证与 tools/balance.js 的节奏表口径一致 */
      var g = Loot.generate(field, { bait: null, rod: null, idle: true, env: G.Weather.neutral() });
      var isNew = !St.isCaught(g.fish.id);
      var p = Loot.price(g.fish, g.kg, g.color, false);
      sumCoin += p;
      gained[g.fish.id] = (gained[g.fish.id] || 0) + 1;
      if (g.fish.rar >= 2) rareGot++;
      if (isNew) newKinds++;
    }
    var scale = n / sample;
    sumCoin = Math.round(sumCoin * scale);
    rareGot = Math.round(rareGot * scale);
    newKinds = Math.round(newKinds * scale);

    // 写进图鉴（按比例折算成整数条）
    Object.keys(gained).forEach(function (id) {
      var c = Math.max(1, Math.round(gained[id] * scale));
      var fish = G.FISH_ID[id];
      for (var k = 0; k < c; k++) {
        St.recordCatch(fish, G.Loot.rollKg(fish), G.Loot.rollColor(fish.rar).key);
      }
    });

    St.addCoin(sumCoin);
    s.stats.catches += n;
    s.stats.idleCatches += n;
    s.stats.totalValue += sumCoin;
    var ups = St.checkUnlocks();
    St.save(true);
    /* 离线补算也可能推进成就（挂机几千条），这里补一次判定 */
    if (G.Goals) G.Goals.check(null);
    return { count: n, coin: sumCoin, rare: rareGot, kinds: newKinds, seconds: seconds, unlocks: ups };
  }

  return {
    init: init, update: update, setField: setField,
    cast: cast, giveUp: giveUp, strike: strike,
    press: press, release: release,
    getState: getState, getPending: getPending,
    isIdleMode: isIdleMode, isHolding: isHolding, hardReset: hardReset,
    offlineCatchUp: offlineCatchUp,
  };
})();
