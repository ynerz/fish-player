import io

def patch(p, pairs):
    s = io.open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, p + ' :: NOT FOUND >> ' + a[:90]
        s = s.replace(a, b, 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('ok', p)

# ---------- 1) config.js：把散落的硬编码收进来 ----------
patch('src/data/config.js', [
("""  version   : '0.3.4',
  saveKey   : 'fishplayer.save.v1',
  saveKeyBak: 'fishplayer.save.v1.bak',""",
"""  version   : '0.4.0',
  saveKey   : 'fishplayer.save.v1',
  saveKeyBak: 'fishplayer.save.v1.bak',

  /* 是否把「设计时长」也当作硬性解锁门槛。
     用户口径：只需要收藏即可 → false（时长只做展示与预估）。 */
  unlockHoursAsGate: false,"""),

("""  fight: {
    baseTensionMax : 100,   // 基础张力上限（鱼线可提升，见 items.js）
    slackGrace     : 1.6,   // 张力 < slackSoft 持续超过这个秒数 → 脱钩
    slackSoft      : 6,     // 判定为「松线」的张力阈值
    dashWarnLead   : 0.55,  // 逃窜前多久给预警（秒）
    progLossOnFail : 0,     // 失败时的额外惩罚（0 = 仅鱼跑掉）
  },""",
"""  fight: {
    baseTensionMax : 100,   // 基础张力上限（鱼线可提升，见 items.js）
    slackGrace     : 1.6,   // 张力 < slackSoft 持续超过这个秒数 → 脱钩
    slackSoft      : 6,     // 判定为「松线」的张力阈值
    dashWarnLead   : 0.55,  // 逃窜前多久给预警（秒）
    /* 张力安全线（占比）—— HUD 里绿色安全区带的宽度、红色危险线
       的位置都由这个值算出来，不要再往 CSS 里写死 78%。 */
    safeRatio      : 0.78,
  },

  /* ---------------------------------------------------------
     失败的代价
     ---------------------------------------------------------
     断线要付出「鱼线修理费」，脱钩不额外扣钱。
     修理费 = 当前鱼线价格 × repairPct，保底 repairMin。
     --------------------------------------------------------- */
  snap: {
    repairPct : 0.02,
    repairMin : 20,
  },"""),

("""  misc: {
    // 咬钩窗口：浮漂下沉后玩家必须在这个时间内点收杆
    biteWindow: { common:1.6, rare:1.5, epic:1.4, legend:1.2 },
    // 自动保存间隔（秒）
    autoSaveInterval: 10,
    // 长按收线的张力「过载」缓冲：张力到达上限后还能撑多久算断线
    snapGrace: 0.45,
  },""",
"""  misc: {
    // 咬钩窗口：浮漂下沉后玩家必须在这个时间内点收杆
    biteWindow: { common:1.6, rare:1.5, epic:1.4, legend:1.2 },
    // 自动保存间隔（秒）
    autoSaveInterval: 10,
    // 长按收线的张力「过载」缓冲：张力到达上限后还能撑多久算断线
    snapGrace: 0.45,

    /* ---- 下面是原先散落在逻辑代码里的手感参数，统一收到这里 ---- */
    flyTime       : 0.85,      // 抛竿动画时长（秒）
    fightTimeout  : 300,       // 单场拉扯硬上限（秒），超时判脱钩防止卡死
    idleStrikeHold: 0.45,      // 挂机时自动提竿的延迟上限（秒）
    idleCastDelay : 0.5,       // 挂机时回到 idle 后多久自动抛下一竿
    biteHintLead  : 8,         // 咬钩前多少秒开始给浮漂异动提示
    /* 各稀有度的期望拉扯耗时（秒，含失败重来）。
       fight.js 的实际对局由 tools/balance.js 仿真，这里是「期望值」，
       离线补算与所有数值工具共用同一份口径。 */
    fightExpect   : [7.3, 22, 34, 50],
  },"""),
])

# ---------- 2) fight.js：SAFE 改为读 config ----------
patch('src/core/fight.js', [
("""  var F = null;              // 当前战局
  var SAFE = 0.78;           // 张力安全线（占比）""",
"""  var F = null;              // 当前战局
  var SAFE = CFG.fight.safeRatio;   // 张力安全线（占比），见 config.js"""),
])

# ---------- 3) hud.js：安全区带宽度由 JS 写入，不再依赖 CSS 写死 ----------
patch('src/ui/hud.js', [
("""    el.catchLog  = U.$('#catchLog');""",
"""    el.catchLog  = U.$('#catchLog');
    el.zoneSafe  = U.$('.tension-track .zone-safe');
    el.dangerMark = U.$('.tension-track .danger-mark');

    /* 安全区带宽度 / 危险线位置都从 CFG.fight.safeRatio 算，
       避免「fight.js 里改 0.78、CSS 里还写着 78%」这种两份硬编码 */
    if (el.zoneSafe)   el.zoneSafe.style.width  = (G.Fight.SAFE * 100) + '%';
    if (el.dangerMark) el.dangerMark.style.left = (G.Fight.SAFE * 100) + '%';"""),
])

# ---------- 4) main.js：avgCycle 改用统一口径；挂机不被面板打断 ----------
patch('src/main.js', [
("""  /* ---------------- 状态 ---------------- */
  function avgCycle() {
    var f = G.FIELD_MAP[St.get().field] || G.FIELDS[0];
    var sum = 0, tot = 0;
    f.rarity.forEach(function (v, i) {
      sum += v * ((G.CONFIG.rarity[i].timeMin + G.CONFIG.rarity[i].timeMax) / 2 + 12);
      tot += v;
    });
    return Math.max(12, sum / tot);
  }""",
"""  /* ---------------- 状态 ---------------- */
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
  }"""),

("""    var paused = P.isCatchOpen() || P.isOpen();

    if (document.visibilityState === 'visible') St.tick(dt);

    if (!paused) {
      F.update(dt);""",
"""    /* 只有「结算卡」会打断钓鱼 —— 玩家正在看渔获。
       浏览图鉴 / 商店 / 统计时挂机继续跑，否则挂机游戏的核心预期就废了。 */
    var paused = P.isCatchOpen();

    var focused = document.visibilityState === 'visible' && !blurred;
    if (focused) St.tick(dt);

    if (!paused && focused) {
      F.update(dt);"""),

("""  var last = 0, hudTimer = 0, lastState = '', hiddenAt = 0, bootDone = false;""",
"""  var last = 0, hudTimer = 0, lastState = '', hiddenAt = 0, bootDone = false;
  var blurred = false;   /* 窗口失焦（切到别的应用）时也停掉逻辑与计时 */"""),

("""    /* ---------- 关闭前保存 ---------- */
    U.on(window, 'beforeunload', function () { St.save(true); });""",
"""    /* ---------- 窗口失焦：多显示器下切走也要停，只靠 visibilitychange 不够 ---------- */
    U.on(window, 'blur', function () { blurred = true; St.save(true); });
    U.on(window, 'focus', function () { blurred = false; last = performance.now(); });

    /* ---------- 关闭前保存 ---------- */
    U.on(window, 'beforeunload', function () { St.save(true); });"""),
])

# ---------- 5) fishing.js：硬编码参数收进 config ----------
patch('src/core/fishing.js', [
("""        if (timer >= 0.85) {""",
"""        if (timer >= CFG.misc.flyTime) {"""),
("""        if (waitLeft <= 8 && !pending._hinted) { pending._hinted = true; }""",
"""        if (waitLeft <= CFG.misc.biteHintLead && !pending._hinted) {
          pending._hinted = true;
          G.Scene.floatNudge();          // 浮漂轻微异动：这是「提前收杆」唯一的价值来源
          G.Audio.hint();
        }"""),
("""            biteLeft = Math.min(biteLeft, 0.45);""",
"""            biteLeft = Math.min(biteLeft, CFG.misc.idleStrikeHold);"""),
("""          if (timer > 0.5) cast();""",
"""          if (timer > CFG.misc.idleCastDelay) cast();"""),
("""          else if (f.elapsed > 300) resolve('escape');   // 兜底：单场拉扯不超过 5 分钟""",
"""          else if (f.elapsed > CFG.misc.fightTimeout) resolve('escape');   // 兜底：单场拉扯上限"""),
])

# ---------- 6) state.js / fields.js：解锁门槛开关搬家 ----------
patch('src/core/state.js', [
("""    if (ok && G.UNLOCK_HOURS_AS_GATE && f.unlockHours > 0) {""",
"""    if (ok && CFG.unlockHoursAsGate && f.unlockHours > 0) {"""),
])

patch('src/data/fields.js', [
("""   时长字段（unlockHours）仅作「设计参考」与展示，
   当前版本不作为硬性门槛 —— 想改成硬门槛，把
   CFG.minHoursAsGate 打开即可（见下方 GATE 常量）。""",
"""   时长字段（unlockHours）仅作「设计参考」与展示，
   当前版本不作为硬性门槛 —— 想改成硬门槛，
   把 config.js 里的 `unlockHoursAsGate` 改成 true 即可。"""),
("""/* 是否把「设计时长」也作为硬性解锁门槛。
   用户口径：只需要收藏即可 → false。 */
G.UNLOCK_HOURS_AS_GATE = false;

""", ""),
])

# ---------- 7) tools/balance.js：waitTime 必须带上 field，否则咬口倍率不生效 ----------
patch('tools/balance.js', [
("""function waitTime(rar) {
  const r = CFG.rarity[rar];
  return U.range(r.timeMin, r.timeMax);
}""",
"""/* ⚠️ 必须把 field 传进 Loot.biteTime —— 它会给「普通 / 稀有」两档乘 biteMul。
   之前这里漏了参数，导致 B/A/S/SS/SSS 场的每小时收益被系统性高估
   （SSS 报 24313、实际只有 12176）。游戏本体走的是同一条路径。 */
function waitTime(rar, field) {
  return G.Loot.biteTime(rar, { field: field });
}"""),
("""    sumWait += waitTime(fish.rar);""",
"""    sumWait += waitTime(fish.rar, field);"""),
("""const FIGHT_EXP = [7.3, 22, 34, 50];   // 每竿期望耗时（含失败重来），秒""",
"""const FIGHT_EXP = CFG.misc.fightExpect;   // 每竿期望耗时（含失败重来），秒"""),
])
