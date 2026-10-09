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
  var castBait = null;     // 本竿实际生效的鱼饵（提前收杆时要退回）
  var castPrevSel = null;  // 本竿把最后一枚用掉、自动切回蚯蚓之前的选饵（一并还原）
  var castEnv = null;      // 本竿**抛竿那一刻**的天气 / 时段（结算归因要用它，见 resolve）
  var reelAcc = 0;         // 「收线咔哒」自上次发声以来累计收进的进度（见 fight 分支）
  var reelLast = null;     // 上一帧的进度（用来算增量；null = 本局还没起算）
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
    castBait = null; castPrevSel = null; castEnv = null;
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
    /* ⚠️ 先消耗、并**用它的返回值**决定这一竿的鱼饵。
       不要再写「consumeBait() 之后读 curBait()」——
       用掉最后一枚时 baitSel 已经切回蚯蚓，那一枚鱼饵会白花（见 state.js 的注释）。 */
    var selBefore = s.baitSel;
    var usedBait = St.consumeBait();
    castBait = usedBait;
    /* 用掉最后一枚会顺带把选饵切回蚯蚓。若后来提前收杆把饵退了回来，
       这处副作用也要一起还原，否则「饵回到背包里、但选中的还是蚯蚓」。 */
    castPrevSel = (s.baitSel !== selBefore) ? selBefore : null;

    // 决定这一竿的渔获
    /* ⚠️ 天气 / 时段要**在这一刻取一次并留到结算**。
       这一竿的鱼是在抛竿时定的，可一场传说鱼要拉扯好几分钟，
       中途完全可能变天 / 天黑 —— 结算时再读环境就会记到「上鱼那一刻」的天气上，
       和「在雨天钓 N 条」这类任务的直觉不一致。 */
    castEnv = G.Weather.isReady() ? G.Weather.env() : null;
    pending = Loot.generate(field, {
      bait: usedBait,
      rod: St.curRod(),
      idle: isIdleMode(),
      env: castEnv,
    });

    s.stats.casts++;
    state = 'flying';
    timer = 0;
    holding = false;
    G.Scene.cast();
    if (cb.onState) cb.onState('flying');
    return true;
  }

  /* ---------------- 提前收杆 ----------------
     鱼还没咬钩就收线 → **这一竿不消耗鱼饵**（用户口径）：
     把 cast 时扣掉的那枚退回来；若那一枚正好是背包里的最后一枚
     （consumeBait 顺带把选饵切成了蚯蚓），选饵也一并还原。 */
  function giveUp() {
    if (state !== 'waiting') return false;
    var refunded = castBait ? St.refundBait(castBait.id) : false;
    if (refunded && castPrevSel && St.get().baitSel === 'worm') St.selectBait(castPrevSel);
    hardReset();
    G.Audio.click();
    if (cb.onToast) cb.onToast({
      text: refunded ? '收杆了，这一竿的鱼饵已退回' : '收杆了，这一竿放弃',
      kind: '',
    });
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
    G.Scene.beginFight();
    G.Fight.begin({
      fish: pending.fish,
      kg: pending.kg,
      tensionMax: St.curLine().tensionMax,
      reelMul: St.curRod().reel,
    });
    /* 收线咔哒重新起算：别把上一局剩下的进度带进来。
       ⚠️ 这里**不去问 G.Fight 要起始进度**（`begin()` 的返回值 / `get()` 的字段）——
          战局对象是别人的实现，单测里还会被桩替掉；本局只要「从零开始累计」就够了。 */
    reelAcc = 0; reelLast = null;
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
         每日任务与成就都从这里取数（见 src/core/goals.js）。
         ⚠️ 鱼饵必须用 `castBait`（这一竿**实际生效**的那枚），
            不能回头读「当前选中的鱼饵」：用掉最后一枚的瞬间 baitSel 已被切回蚯蚓，
            再读现值就会把这一竿错记到蚯蚓名下（「用面团钓 N 条」永远差一条），
            和 `cast()` 里修过的是同一个坑。 */
      var rec = St.recordCatch(fish, kg, color.key, {
        /* castBait 在 resolve 时必定还在（只有 cast() 能进这局，hardReset 会同时回到 idle）。
           真为空就记 null —— recordDims 会跳过，宁可少记一条，也别错记成别人的鱼饵。 */
        bait: castBait ? castBait.id : null,
        env: castEnv,
      });
      St.noteResult(true);
      /* 埋点：传说鱼是**调平衡最需要的一条数据** —— 多久出一条、在哪个钓场、什么颜色，
         离线仿真给不出这些（tools/balance.js 算的是期望值，不是真实出货）。
         ⚠️ `G.Track.event` 是 track.js 里早就留好的采集点，但此前**全项目零调用**；
            一个没人调用的采集点等于没有。它只进内存环形缓冲 + 落盘，不联网。
         ⚠️ 只记**真的稀有**的事，别把「破个人纪录」这类也记上 ——
            环形缓冲就那么大（CFG.track.buffer），刷满了会把真正的错误挤出去。 */
      if (G.Track && fish.rar >= 3) {
        G.Track.event('legendary', { fish: fish.id, field: field.id, kg: kg, color: color.key });
      }
      var price = Loot.price(fish, kg, color, rec.isNew);
      var s = St.get();
      s.stats.catches++;
      /* 反作弊（N2）：把这一竿记进完整性证据环。
         ⚠️ 只在这条**真玩出来**的路径上记 —— 离线补算（下面 `offlineCatchUp`）与
            devtools 都不走 `resolve()`，它们的渔获不是玩家动作，记进去只会污染判据。
         本模块只做 L1 标记（不拦 / 不封 / 不改任何游戏数据），判据全是纯函数。 */
      if (G.Integrity) G.Integrity.note(fish, color.key);
      /* ⚠️ 这里**不**直接加钱。
         手动钓上来的鱼由结算卡决定「卖出 / 收进鱼护」；
         挂机时没有玩家点卡片，统一自动卖出（见 config.storage.idleAutoSell）。 */
      if (isIdleMode()) {
        s.stats.idleCatches++;
        if (CFG.storage.idleAutoSell) {
          St.sellFish(price);
        } else if (!St.toNet(fish, kg, color.key)) {
          St.sellFish(price);
        }
      }

      G.Scene.sparkle(rec.isNew ? 34 : (fish.rar >= 2 ? 26 : 12), fish.rar);
      /* 稀有颜色的「一闪」：音画必须在**同一时刻** —— 画面在闪、耳朵里也要有那一声，
         否则那道星点只是「贴上去的」。只对非原色播（原色占七成，每次都响就成了噪音）。 */
      if (color.key !== 'normal') G.Audio.glint();
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
    /* 这一竿到此为止：鱼已经咬过钩（钓上 / 脱钩 / 断线 / 错过咬口），
       饵就是花掉了，不许再被后续的 giveUp 退回来 */
    castBait = null; castPrevSel = null; castEnv = null;
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
          /* 水下鱼影：抛竿落定后让「咬钩的那条鱼」在水下游过来 ——
             这一段（最长 10 分钟）原来屏幕上什么都没有，只有一个浮漂在漂。
             影子的大小只跟体重有关，不暴露稀有度，与「等得久 = 大鱼」口径一致。
             清理由 Scene.endFight() 统一负责（上岸 / 失败 / 提前收杆 / 换场都会走到）。 */
          G.Scene.showShadow(pending.fish, pending.kg);
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
          /* 收线咔哒（`Audio.tick`）：每**收进** reelTickStep 个进度点响一声。
             ⚠️ 按进度打点而不是按固定时间打点：进度涨得快 → 响得密，
                玩家不看张力条也听得出「这条拉得动」；按时间打点的话，
                一条 50 秒的传说鱼和一条 7 秒的小杂鱼会响得一样密（config.misc.fightExpect）。
             ⚠️ 只累计**正向**的进度：松手放线时进度会回落，那一段不算「收进来」。
                不这么做的话，松手再收要先把放掉的追回来才重新响 —— 听感像「突然哑了」。 */
          if (holding && reelLast != null && f.progress > reelLast) {
            reelAcc += f.progress - reelLast;
            while (reelAcc >= CFG.misc.reelTickStep) {
              reelAcc -= CFG.misc.reelTickStep;
              G.Audio.tick();
            }
          }
          reelLast = f.progress;
          /* 画面用的表现量走 snapshot（战局状态的唯一对外出口），
             这里只保留「控制流」用的原始字段：over / result / elapsed */
          var view = G.Fight.snapshot();
          G.Scene.setRodBend((view.struggle01 - 0.15) * 1.3 + (view.dashing ? 0.35 : 0));
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
    /* ⚠️ 不做数就退：NaN / 负数 / 无穷会一路溜进下面的抽样与累加
       （`s.stats.catches += n` 直接把 NaN 写进统计，而且不报错）。
       lastSeen 是从存档里读出来的，脏档兜底扫不到的键可能不是数字。 */
    if (!isFinite(seconds) || seconds < 60) return null;
    seconds = Math.min(seconds, CFG.idle.maxCatchUp);
    var s = St.get();
    var cycle = onlineCycle || 35;
    if (!isFinite(cycle) || cycle <= 0) cycle = 35;
    var n = Math.floor(seconds / cycle);
    if (n <= 0) return null;

    // 用「期望收益」而不是逐条模拟，避免卡顿
    var sumCoin = 0, gained = {}, rareGot = 0, newKinds = 0, recent = [];
    var sample = Math.min(n, 4000);
    /* 从抽样里匀出几条「代表渔获」带回去给播报栏 / 收获面板 ——
       否则玩家回来只看到一句「又上了 N 条鱼」，不知道钓到了什么 */
    var stride = Math.max(1, Math.floor(sample / 5));
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
      if (recent.length < 5 && i % stride === 0) {
        recent.push({
          fish: g.fish, kg: g.kg, color: g.color, price: p,
          rar: g.fish.rar, isNew: isNew, isRecord: false,
        });
      }
    }
    var scale = n / sample;
    sumCoin = Math.round(sumCoin * scale);
    rareGot = Math.round(rareGot * scale);
    newKinds = Math.round(newKinds * scale);

    // 写进图鉴（按比例折算成整数条）
    /* ctx 必须一起传：每日任务里有「用某鱼饵钓 N 条」这类分维任务，
       离线补算不传 ctx 就会让这些任务在挂机后进度纹丝不动。
       天气 / 时段继续用中性值（离线会跨过很多次变天，硬记一个反而失真）。 */
    var offlineCtx = { bait: St.curBait().id, env: G.Weather.neutral() };
    Object.keys(gained).forEach(function (id) {
      var c = Math.max(1, Math.round(gained[id] * scale));
      var fish = G.FISH_ID[id];
      for (var k = 0; k < c; k++) {
        St.recordCatch(fish, G.Loot.rollKg(fish), G.Loot.rollColor(fish.rar).key, offlineCtx);
      }
    });

    St.sellFish(sumCoin);
    s.stats.catches += n;
    s.stats.idleCatches += n;
    var ups = St.checkUnlocks();
    St.save(true);
    /* 离线补算也可能推进成就（挂机几千条），这里补一次判定 */
    if (G.Goals) G.Goals.check(null);
    return { count: n, coin: sumCoin, rare: rareGot, kinds: newKinds, seconds: seconds, unlocks: ups, recent: recent };
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
