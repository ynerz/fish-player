/* =========================================================
   story.js  —  隔壁钓鱼佬与意外小事件（N7 骨架）
   =========================================================
   它**只有判定：没有界面、不画场景、不碰游戏数据**。
     · 内容（NPC / 事件 / 台词）在 `src/data/story.js`
     · 画面（他站在哪）由 `G.Scene.setNeighbor(G.Story.neighbor())` 消费
     · 对话由 UI 层负责（`main.js` 拿 `init({ onEvent })` 给的回调去开面板）
   （与 `G.Fishing` 的 `cb.onCatch / cb.onMiss`、`G.Assistant` 的 `cb.toast` 同一套写法。）

   🔴 四条口径（改之前先读，理由都在这儿）：

     ① **必须确定性可复现**：触发走「同一份存档 + 同一组条件 + 同一个序号 ⇒
        同一个结果」的**哈希伪随机**（与 `G.Goals` 的「种子 + 现算」同一套思路），
        **不用 `Math.random()`**。否则「这条我上次见过没」和「测试怎么跑」
        两边都对不上 —— 而本项目所有门禁都建立在「可定点复现」上。

     ② **不打断钓鱼**：只在「一竿已经结算完、回到 idle」的那一刻考虑触发
        （由 `main.js` 在 `onMiss` / 结算卡关闭时调 `consider()`）。
        绝不在 wait / fight 中途插进来 —— 那会把玩家正在拉的鱼冻在面板后面。
        挂机（自动钓鱼）与「面板/结算卡开着」时也一律不触发：人不在屏幕前时
        弹对话是打扰，而两层 modal 叠在一起会互相打架。

     ③ **奖励红线**：事件只能给「称号 / 纯外观」，不许给金币 / 鱼饵 / 装备 / 掉率。
        本模块把 `reward` 交出去但**自己不落地任何数值奖励** —— 给东西要走专门的
        口径与断言（`verify` 第 50 节盯着 reward 的键）。本轮两条事件 reward 为空。

     ④ **存档只记事实**：`s.story.fired`（各事件触发过几次，`once` 就靠它）与
        `s.story.at`（最近一次触发的时刻）。重开游戏「这条我见过没」不会变。
   ========================================================= */

window.G = window.G || {};

G.Story = (function () {

  var cb = { onEvent: null };      /* 有事件真正触发时回调 UI 层（开对话） */
  var seq = 0;                     /* 当前条件下已经「考虑」过几次（条件一变就归零） */
  var ctxKey = '';                 /* 上一次考虑时的条件指纹（钓场|天气|时段） */
  var lastAt = 0;                  /* 上一次真触发的时刻（全局兜底间隔，防同时碰上俩） */

  function cfg() { return (G.CONFIG && G.CONFIG.story) || {}; }
  function now() {
    return (G.Platform && G.Platform.sys && G.Platform.sys.now)
      ? G.Platform.sys.now() : Date.now();
  }
  /* 事件表 / NPC 表：缺表一律按「没有」处理（单测与「内容文件缺失」都落到这条路上，
     不抛异常 —— 与 `G.Assistant` 的 `lines()` 同一个态度）。 */
  function evs() {
    var a = G.STORY_EVENTS;
    return (a && a.length) ? a : [];
  }
  function npcOf(id) {
    var all = G.STORY_NPCS;
    var n = (all && typeof all === 'object') ? all[id] : null;
    return n || null;
  }
  /* 存档里的那块（缺字段时给个空壳：脏档 / 老档都不该让这里抛） */
  function rec() {
    var s = (G.State && G.State.get) ? G.State.get() : null;
    var t = s && s.story;
    if (!t || typeof t !== 'object') t = {};
    if (!t.fired || typeof t.fired !== 'object') t.fired = {};
    if (!t.at || typeof t.at !== 'object') t.at = {};
    if (s) s.story = t;            /* 顺手纠正回去，省得每个调用点各纠正一次 */
    return t;
  }

  /* 32 位 FNV-1a：与 `G.Goals` 的 `hash32()` 同算法。
     ⚠️ 刻意**不复用** `Goals` 内部那个函数 —— 它是模块私有的，为了共用去
        扩 `G.Goals` 的导出面会多一个「只在别处用一次」的接口（第 ㉜ 节那类问题）。 */
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* 这一条事件在「这组条件 + 这个序号」下的掷点（0 ~ 1）。
     🔴 纯函数：同样的入参永远同样的结果 —— 这是口径 ① 的全部实现。 */
  function rollFor(ev, p) {
    return hash32([p.field, p.wx, p.tm, p.seq, ev.id].join('|')) / 4294967296;
  }

  /* 条件：`cond` 里列出的每一项都要满足；没列的项不参与判定。 */
  function condOk(ev, p) {
    var c = ev.cond || {};
    if (c.field && c.field.indexOf(p.field) < 0) return false;
    if (c.wx && c.wx.indexOf(p.wx) < 0) return false;
    if (c.tm && c.tm.indexOf(p.tm) < 0) return false;
    return true;
  }

  /* 按顺序挑第一个命中且「过门」的事件。`p` = { field, wx, tm, seq, now }。
     🔴 纯函数（只看入参 + 存档里的已触发记录）：同一份存档 + 同一组入参 ⇒ 同一个结果。
        测试就是靠这条钉住「可复现」，别再往里加 `Math.random()` / `Date` 之类。 */
  function tryFire(p) {
    var st = rec();
    var list = evs();
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!condOk(ev, p)) continue;
      if (ev.once && (st.fired[ev.id] || 0) > 0) continue;
      var last = st.at[ev.id];
      if (last && (p.now - last) < ev.cooldownMs) continue;
      if (rollFor(ev, p) >= ev.chance) continue;
      return ev;
    }
    return null;
  }

  /* 记一笔「发生了」。**立刻落盘**：玩家可能在对话框弹出前就关掉页面，
     而「这条我见过没」不该因为一次没读完就重来（`once` 靠的就是它）。 */
  function mark(ev, t) {
    var st = rec();
    st.fired[ev.id] = (st.fired[ev.id] || 0) + 1;
    st.at[ev.id] = t;
    if (G.State && G.State.save) G.State.save(true);
    return ev;
  }

  /* 事件奖励：**本模块只把它读出来交出去，自己不落地任何东西**（口径 ③）。
     现在两条事件的 reward 都是空的 —— 真给东西的那一轮要连同「称号怎么解锁」一起做，
     并同步放开 `verify` 第 50 节的奖励白名单。读一次是为了让「配了奖励」这件事
     在这条链路上真的被看见，而不是写进内容表就没人管。 */
  function rewardOf(ev) { return (ev && ev.reward) || {}; }

  /* 当前条件（钓场 / 天气 / 时段）。抽成函数是为了让「条件指纹」只有一处拼法，
     `consider()` 与测试都走它。
     ⚠️ 顺带一个硬约束：**返回块里不许出现 `键: 值` 形态的对象字面量** ——
        `verify` 的 `exportKeys()` 是把返回块里所有 `x:` 都当导出名收的，
        写成内联字面量会让 `field` / `wx` 这种普通字段被当成「零调用的死导出」报红。
        （这不是哪个门禁的怪癖：模块的对外面本来就该只有一份清单，字段写在函数体外面更清楚。） */
  function curCtx() {
    var s = (G.State && G.State.get) ? G.State.get() : null;
    if (!s) return null;
    var sn = (G.Weather && G.Weather.snapshot) ? G.Weather.snapshot() : null;
    return {
      field: s.field,
      wx: (sn && sn.wx) ? sn.wx.key : '',
      tm: (sn && sn.tm) ? sn.tm.key : '',
    };
  }
  /* `tryFire()` 要的那份入参（纯数值，不含对象引用）—— 同样是为了把字面量挪出返回块 */
  function probeOf(c, n, t) { return { field: c.field, wx: c.wx, tm: c.tm, seq: n, now: t }; }

  /* ---------------- 对外动作 ---------------- */
  /* 当前该站在钓场里的那个 NPC（目前只有一个）。场景层直接吃这个对象：
     `x` 是站位比例、其余是绘制参数。表为空时返回 null（场景层据此不画人）。
     ⚠️ 每次返回**同一个对象**（内容表里的那个），场景每帧都会拿它，别在这儿新建。 */
  function neighbor() {
    var all = G.STORY_NPCS;
    if (!all || typeof all !== 'object') return null;
    var keys = Object.keys(all);
    return keys.length ? all[keys[0]] : null;
  }

  /* `init({ onEvent })`：`onEvent(ev, npc, reward)` 由 UI 层实现（现在是开对话面板）。
     没有回调时引擎照旧记账、只是没人看得到（测试里就是这么用的）。 */
  function init(opts) {
    cb.onEvent = (opts && typeof opts.onEvent === 'function') ? opts.onEvent : null;
  }

  /* 一次「可以考虑触发」的时机。调用点只有 main.js 的两处（结算卡关闭 / 丢竿之后），
     外加测试。返回真正触发的那条事件，或 null。
     ⚠️ 四道门（顺序即优先级）：状态必须是 idle → 不能是挂机 → 不能有面板开着 →
        全局间隔没到。前三条是「别打断人」，第四条是「别一分钟碰上俩邻居」。 */
  function consider() {
    if (G.Fishing && G.Fishing.getState && G.Fishing.getState() !== 'idle') return null;
    if (G.Fishing && G.Fishing.isIdleMode && G.Fishing.isIdleMode()) return null;
    if (G.Panels && ((G.Panels.isOpen && G.Panels.isOpen())
      || (G.Panels.isCatchOpen && G.Panels.isCatchOpen()))) return null;

    var c = curCtx();
    if (!c) return null;
    var key = [c.field, c.wx, c.tm].join('|');
    if (key !== ctxKey) { ctxKey = key; seq = 0; }
    seq++;

    var t = now();
    var gap = cfg().minGapMs || 0;
    if (lastAt && (t - lastAt) < gap) return null;

    var ev = tryFire(probeOf(c, seq, t));
    if (!ev) return null;
    lastAt = t;
    mark(ev, t);
    if (cb.onEvent) cb.onEvent(ev, npcOf(ev.npc), rewardOf(ev));
    return ev;
  }

  /* 清掉**内存里**的推进状态（序号 / 条件指纹 / 全局间隔）——
     ⚠️ 它**不碰存档**：「这条我见过没」是存档的事实，不该被一次重置抹掉。
     测试要清存档请直接改 `St.get().story`。 */
  function reset() { seq = 0; ctxKey = ''; lastAt = 0; }

  return {
    init: init,
    consider: consider,
    neighbor: neighbor,
    tryFire: tryFire,
    rollFor: rollFor,
    reset: reset,
  };
})();

