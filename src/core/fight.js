/* =========================================================
   fight.js  —  张力拉扯博弈（核心手感）
   =========================================================
   规则：
     · 按住（鼠标左键 / 空格）→ 收线：进度上升，张力上升
     · 松开 → 放线：进度缓慢回落，张力下降
     · 鱼会不定时「逃窜」，逃窜期间张力急剧上升
       —— 逃窜前 0.55s 会有预警，此时必须松开
     · 张力到达上限并持续 snapGrace 秒 → 断线
     · 张力长时间贴地（松线）→ 脱钩
     · 进度满 100 → 成功
   ========================================================= */
window.G = window.G || {};

G.Fight = (function () {
  var U = G.U, CFG = G.CONFIG;

  var F = null;              // 当前战局
  var SAFE = CFG.fight.safeRatio;   // 张力安全线（占比），见 config.js

  function begin(o) {
    var rar = CFG.rarity[o.fish.rar];
    var base = rar.fight;

    // 体型系数：同一鱼种越重越难拉
    var span = Math.max(0.0001, o.fish.maxKg - o.fish.minKg);
    var tt = U.clamp((o.kg - o.fish.minKg) / span, 0, 1);
    var sizeK = 0.88 + 0.42 * tt;

    var tensionMax = o.tensionMax || CFG.fight.baseTensionMax;
    var reelMul = o.reelMul || 1;

    F = {
      fish: o.fish,
      kg: o.kg,
      rar: o.fish.rar,

      tensionMax: tensionMax,
      tension: tensionMax * 0.16,
      progress: 8,

      reelPower: base.reelPower * reelMul,
      slackPull: base.slackPull * sizeK,
      tensionRise: base.tensionRise,
      tensionFall: base.tensionFall,
      dashPower: base.dashPower * sizeK,
      dashDur: base.dashDur,
      dashGapMin: base.dashGapMin * (1.35 - sizeK * 0.35),
      dashGapMax: base.dashGapMax * (1.35 - sizeK * 0.35),

      dashing: false,
      dashLeft: 0,
      nextDash: U.range(base.dashGapMin, base.dashGapMax) * 0.6,
      warn: 0,
      warned: false,

      snapTimer: 0,
      slackTimer: 0,
      elapsed: 0,
      struggle: 0,       // 0~1，用于画面表现
      over: false,
      result: null,
      events: [],
    };
    return F;
  }

  function update(dt, holding) {
    if (!F || F.over) return F;

    F.elapsed += dt;
    var prevT = F.tension;

    /* --- 逃窜计时 --- */
    if (F.dashing) {
      F.dashLeft -= dt;
      if (F.dashLeft <= 0) {
        F.dashing = false;
        F.nextDash = U.range(F.dashGapMin, F.dashGapMax);
      }
    } else {
      F.nextDash -= dt;
      if (F.nextDash <= CFG.fight.dashWarnLead) {
        F.warn = 1 - Math.max(0, F.nextDash) / CFG.fight.dashWarnLead;
        if (!F.warned) { F.warned = true; push('warn'); }
      } else {
        F.warn = 0;
      }
      if (F.nextDash <= 0) {
        F.dashing = true; F.warned = false; F.warn = 0;
        F.dashLeft = F.dashDur;
        push('dash');
      }
    }

    /* --- 力竭：进度越高，鱼越没力气（保证对局收敛，也符合真实手感）--- */
    var tire = 1 - 0.22 * U.clamp((F.progress - 20) / 80, 0, 1);
    F.tire = tire;

    /* --- 张力 --- */
    var d = 0;
    if (holding) d += F.tensionRise;
    else d -= F.tensionFall;
    if (F.dashing) d += F.dashPower * tire;
    F.tension += d * dt;

    /* --- 进度 --- */
    if (holding) {
      F.progress += F.reelPower * dt;
    } else {
      F.progress -= F.slackPull * tire * dt;
    }

    /* --- 表现量 --- */
    var target = F.dashing ? 1 : (holding ? 0.35 + (F.tension / F.tensionMax) * 0.5 : 0.05);
    F.struggle += (target - F.struggle) * Math.min(1, dt * 6);

    /* --- 判定 --- */
    if (F.tension >= F.tensionMax) {
      F.tension = F.tensionMax;
      F.snapTimer += dt;
      if (F.snapTimer >= CFG.misc.snapGrace) return finish('snap');
    } else {
      F.snapTimer = 0;
    }

    if (F.tension <= CFG.fight.slackSoft) {
      F.slackTimer += dt;
      if (F.slackTimer >= CFG.fight.slackGrace) return finish('escape');
    } else {
      F.slackTimer = 0;
    }

    if (F.progress >= 100) { F.progress = 100; return finish('success'); }
    if (F.progress < 0) F.progress = 0;

    // 张力偶发提示事件
    if (prevT < F.tensionMax * SAFE && F.tension >= F.tensionMax * SAFE) push('overSafe');
    return F;
  }

  function push(k) { if (F) F.events.push(k); }

  function finish(result) {
    F.over = true;
    F.result = result;
    return F;
  }

  function drainEvents() {
    if (!F) return [];
    var e = F.events.slice(); F.events.length = 0; return e;
  }

  function end() { F = null; }
  function get() { return F; }

  /* 供 UI：张力占比、安全线、进度 */
  function snapshot() {
    if (!F) return null;
    return {
      tension01: U.clamp(F.tension / F.tensionMax, 0, 1),
      safe01: SAFE,
      progress01: U.clamp(F.progress / 100, 0, 1),
      dashing: F.dashing,
      warn: F.warn,
      danger: F.tension >= F.tensionMax * SAFE,
      elapsed: F.elapsed,
    };
  }

  return {
    begin: begin, update: update, end: end, get: get,
    snapshot: snapshot, drainEvents: drainEvents,
    SAFE: SAFE,
  };
})();
