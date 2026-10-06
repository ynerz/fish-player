/* =========================================================
   tutorial.js  —  新手引导（v0.5.3）
   =========================================================
   目的：第一次玩的人不知道「按住收线 / 松手放线 / 躲逃窜」
   这三件事，第一条鱼基本必断线。这里用非阻塞气泡依次教完。

   设计约束（改这个文件前先读）
   · **非阻塞**：气泡 pointer-events:none，玩家照常操作；
     只有右上角的「跳过」是可点的。绝不拦抛竿按钮。
   · **进度在存档里**（S.tut = {step, done}），中途关页面下次接着走；
     老存档在 migrate() 里被标成「已看过」，不会被刷教学。
   · **只在手动模式推进**：开了挂机就整体藏起来 —— AI 会替玩家完成
     这些动作，教不了人；关掉挂机后从当前步骤继续。
   · 文案 / 阶段 / 位置全在 `config.tutorial.steps`，
     这里只放「怎么算学会」（RULES）。两者必须一一对应，
     tools/verify.js 第 ⑩ 节会扫源码断言。
   · update() 每帧都被主循环调用，所以 paint() 必须只在内容变化时
     才写 DOM（靠 painted 这个 key），不要每帧重排。
   ========================================================= */
window.G = window.G || {};

G.Tutorial = (function () {
  var U = G.U, St = G.State, CFG = G.CONFIG;

  var el = { box: null, idx: null, text: null, tip: null, skip: null };

  var curFs = 'idle';     // 本帧的钓鱼状态（由 update 传入，模块内不查 Fishing）
  var prevFs = '';        // 上一帧的状态，用来识别「刚抛竿」「刚进拉扯」
  var holdAcc = 0;        // 本场拉扯「按住」累计秒数
  var wasHold = false;    // 上一帧是否按住（用来取「刚松手」这一沿）
  var wasDash = false;    // 上一帧是否在逃窜（用来取「刚躲过」这一沿）
  var finishLeft = -1;    // >0 = 收尾那句的剩余停留时间
  var painted = '';       // 已渲染内容的 key，避免每帧重复写 DOM
  var glowEl = null;      // 当前高亮的元素

  var FINISH_TEXT = '就这套节奏：<b>按住收线 → 碰到黄线松手 → 鱼发力时躲一下</b>';
  var FINISH_TIP  = '随时可以在「设置」里重看这段引导';

  function steps() { return (CFG.tutorial && CFG.tutorial.steps) || []; }
  function tut() { return St.get().tut; }
  function active() {
    return !!(CFG.tutorial && CFG.tutorial.enabled) && !tut().done;
  }

  /* 每条步骤的完成条件 —— ev 有两种：
       {kind:'state', state:'flying'|'fight'|...}  钓鱼状态刚变化的那一帧
       {kind:'tick',  holdAcc, released, dodged}    拉扯过程中的每帧
     ⚠️ id 必须和 config.tutorial.steps[].id 一致（verify.js 会比对）。 */
  var RULES = {
    cast: function (ev) {
      return ev.kind === 'state' && ev.state === 'flying';
    },
    strike: function (ev) {
      return ev.kind === 'state' && ev.state === 'fight';
    },
    hold: function (ev) {
      return ev.kind === 'tick' && ev.holdAcc >= CFG.tutorial.holdNeed;
    },
    release: function (ev) {
      return ev.kind === 'tick' && ev.released;
    },
    dash: function (ev) {
      return ev.kind === 'tick' && ev.dodged;
    },
  };

  /* ---------------- DOM ---------------- */
  function init() {
    el.box  = U.$('#tutBubble');
    el.idx  = U.$('#tutIdx');
    el.text = U.$('#tutText');
    el.tip  = U.$('#tutTip');
    el.skip = U.$('#tutSkip');
    if (!el.box) return;
    U.on(el.skip, 'click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (e && e.preventDefault) e.preventDefault();
      finish();
    });
  }

  /* 目标元素上加一圈呼吸光晕，让玩家知道「说的是这个东西」 */
  function glow(sel) {
    var t = sel ? U.$(sel) : null;
    if (glowEl === t) return;
    if (glowEl) glowEl.classList.remove('tut-glow');
    glowEl = t;
    if (glowEl) glowEl.classList.add('tut-glow');
  }

  /* 只读状态、决定气泡说什么 —— 不改任何进度 */
  function paint() {
    if (!el.box) return;
    var s = St.get();
    var i = s.tut.step, list = steps();
    var st = null, mode = 'hide';

    if (finishLeft > 0) mode = 'finish';
    else if (active() && !s.settings.idle && list[i] && list[i].showWhen === curFs) {
      st = list[i];
      mode = 'step';
    }

    var key = mode + '|' + i + '|' + curFs + '|' + (active() ? 1 : 0) + (s.settings.idle ? 1 : 0);
    if (key === painted) return;
    painted = key;

    if (mode === 'hide') { el.box.className = 'tut-bubble hidden'; glow(null); return; }

    if (mode === 'finish') {
      el.box.className = 'tut-bubble at-fight';
      el.idx.textContent = '学会了';
      el.text.innerHTML = FINISH_TEXT;
      el.tip.textContent = FINISH_TIP;
      el.skip.classList.add('hidden');
      glow(null);
      return;
    }

    el.box.className = 'tut-bubble at-' + st.place;
    el.idx.textContent = '第 ' + (i + 1) + ' / ' + list.length + ' 步';
    el.text.innerHTML = st.text;
    el.tip.textContent = st.tip || '';
    el.skip.classList.remove('hidden');
    glow(st.place === 'btn' ? '#btnAction' : '#fightUI');
  }

  function sfx(name, arg) {
    if (G.Audio && typeof G.Audio[name] === 'function') G.Audio[name](arg);
  }

  /* 学会一步 / 收尾 */
  function advance() {
    var t = tut(), list = steps();
    t.step = Math.min(list.length, t.step + 1);
    if (t.step >= list.length) {
      t.done = true;
      finishLeft = CFG.tutorial.doneHold;
      sfx('unlock');
    } else {
      sfx('click');
    }
    St.scheduleSave();
  }

  /* 跳过：不写 done=false 之外的东西，直接标成已看过 */
  function finish() {
    var t = tut();
    t.step = steps().length;
    t.done = true;
    finishLeft = -1;
    sfx('deny');
    St.scheduleSave();
    St.emit('toast', { text: '新手引导已跳过，可在「设置」里重看', kind: '' });
    paint();
  }

  /* 设置面板里的「重看」 */
  function restart() {
    var t = tut();
    t.step = 0;
    t.done = false;
    finishLeft = -1;
    holdAcc = 0; wasHold = false; wasDash = false;
    prevFs = '';          // 清掉上一帧状态，下一帧重新识别「刚抛竿 / 刚进拉扯」
    painted = '';
    St.scheduleSave();
    St.emit('toast', { text: '引导从头开始：先点「抛竿」', kind: 'good' });
  }

  /* ---------------- 主循环 ----------------
     dt    本帧时长（缩放/失焦时传 0 = 不推进但保持显示）
     fs    钓鱼状态（G.Fishing.getState()）
     input 玩家输入快照 {holding, dashing}
           —— holding 来自 G.Fishing.isHolding()，dashing 来自 Fight 快照。
           刻意不直接依赖 G.Fishing / G.Fight，这样状态机可以在 Node 里单测。 */
  function update(dt, fs, input) {
    curFs = fs || 'idle';
    dt = dt > 0 ? dt : 0;
    input = input || {};

    /* 收尾那句只倒计时，不再关心任何输入 */
    if (finishLeft > 0) {
      finishLeft -= dt;
      if (finishLeft <= 0) finishLeft = -1;
      prevFs = curFs;
      paint();
      return;
    }

    if (active() && !St.get().settings.idle && dt > 0) {
      /* 换状态的那一帧先清掉上一场的输入累计，否则「上一竿松的手」
         会被算成这一竿的松手 */
      if (curFs !== prevFs) { holdAcc = 0; wasHold = false; wasDash = false; }

      var holding = !!input.holding;
      var dashing = !!input.dashing;
      var released = !holding && wasHold;
      var dodged = !dashing && wasDash;

      /* 先累计再判定：玩家按住满 holdNeed 秒的那一帧就学会 */
      if (curFs === 'fight' && holding) holdAcc += dt;

      var list = steps(), i = St.get().tut.step;
      var rule = RULES[list[i] && list[i].id];
      if (rule) {
        var evs = [];
        if (curFs !== prevFs) evs.push({ kind: 'state', state: curFs });
        if (curFs === 'fight') evs.push({ kind: 'tick', holdAcc: holdAcc, released: released, dodged: dodged });
        for (var k = 0; k < evs.length; k++) {
          if (rule(evs[k])) { advance(); break; }
        }
      }
      wasHold = holding;
      wasDash = dashing;
      prevFs = curFs;
    } else {
      prevFs = curFs;
    }

    paint();
  }

  return {
    init: init, update: update, restart: restart, finish: finish,
    active: active,
    stepIndex: function () { return St.get().tut.step; },
    stepCount: function () { return steps().length; },
    /* 调试用：开发者面板 / 控制台里可以直接跳到最后一步 */
    isFinished: function () { return !!St.get().tut.done; },
  };
})();
