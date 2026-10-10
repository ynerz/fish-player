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
        🔴 **这个门依赖一个时序事实**：「一竿结束了」必须在 `cb.onMiss` / `cb.onCatch`
           回调**之前**成立。它由 `fishing.js` 的 `resolve()` 保证（N7 六期修）——
           先回调后改状态的话，`onMiss` 里那次 `consider()` 的 idle 门**恒不通过**，
           「丢了一竿」这条触发路整条是死的，而且**不报任何错**。
           `verify` 第 50 节盯着 `resolve()` 里的先后顺序。

     ③ **奖励红线**：事件只能给「称号 / 纯外观」，不许给金币 / 鱼饵 / 装备 / 掉率。
        本模块把 `reward` 交出去但**自己不落地任何数值奖励** —— 给东西要走专门的
        口径与断言（`verify` 第 50 节盯着 reward 的键）。本轮两条事件 reward 为空。

     ④ **存档只记事实**：`s.story.fired`（各事件触发过几次，`once` 就靠它）、
        `s.story.at`（最近一次触发的时刻）、`s.story.talk`（跟各 NPC 主动搭话过几次，
        闲聊池靠它轮流）、`s.story.pick`（各事件**每个选项各被选过几次**，
        `need` 那道门与以后的任何「上次我选了什么」都靠它）与 `s.story.duel`
        （**比试那一本账**：进行中的窗口 + 累计战绩 `wins` / `losses`）。
        重开游戏这些事实都不会变。

     ⑤ **主动搭话（`talk()`）不走概率**：玩家点了画布上那个人，就该有回应 ——
        概率门是给「事件找上门」用的（无端弹窗需要克制），不是给「玩家主动问」用的。
        轮换靠 `s.story.talk` 计数**取模**：同一次点击在同一份存档上永远给同一句，
        而连点不会卡在第一句上。**它同样不许碰 `Math.random()`**（口径 ①）。

     ⑥ **有分支的互动（N7 三期）**：事件可以带 `choices`（≥2 项）—— 面板把他的
        `lines` 说完就摆出这些按钮，`choose(ev, i)` 把第 i 项的台词作为**下一段**交回去，
        并把「选了哪一项」记进 `s.story.pick[事件 id]`（**计数数组**，下标 = 选项序号）。
        · `need: { pick: '<事件 id>', opt: <序号> }` = 「那条事件的那一项被选过至少一次」
          才可能出现 —— 这是「选择真的改了世界」的**唯一机制**（`repay` 靠它）。
        · 记的是**计数**不是「最后一次选了啥」：同一条事件可以重复触发
          （`borrow` 就是 `once: false`），只存最后一次会让先前的选择凭空消失。
        · 🔴 **没有第二套「好感度」**：`fired` / `talk` / `pick` 就是这个世界的全部事实 ——
          再添一个 `favor` 数值只会多一份真相，而且**没有任何消费方**（死字段那类问题）。
        · `choose()` 与 `talk()` 同款：**不走概率门**（玩家已经点了，回应必须来），
          越界 / 那条事件没有 `choices` ⇒ 给 `null`（调用方据此收起面板，不猜一项）。

     ⑦ **限时比试（N7 四期）** —— 唯一一条**会动渔获管线**的互动，比叙事分支多一个维度：
        · 带 `duel: { ms, pool, win, lose }` 的事件命中 ⇒ `startDuel()` 把「他这一场的那条鱼」
          （鱼名 + 重量）**按哈希定死**并存进 `s.story.duel`，窗口到点才算。
          ⇒ 同一份存档 + 同一组条件 + 同一个序号，他永远是同一条同重的鱼（口径 ①）。
        · **玩家这一侧靠 `noteCatch(kg)` 喂进来**：`main.js` 在每次成功上鱼时调它。
          ⚠️ **挂机上的鱼不算**（见 `noteCatch()` 里那句）—— 比的是「你亲手钓」。
        · 结算在 `settleDuel()`（主循环每帧问一次）：到点 **且** 人回到 idle、没挂机、
          没面板开着才结算 —— 与 `consider()` 同款四道门，绝不打断玩家手里那一竿。
          结算完把结果当成**一次普通对话**交给同一个 `cb.onEvent`（UI 不必认识比试）。
        · 窗口刚过、玩家手里那一竿还在拉 ⇒ 那一条**仍然算数**（判「进行中」只看 `end > 0`，
          只有结算才清零）。时间到的那一刻不去抢玩家手里的鱼。
        · 🔴 **平局算他赢**（严格 `>` 才算你赢）。`wins` / `losses` 是**持久事实**，
          新开一场只重置窗口字段，**不清战绩**。
        · 🔴 **一次只比一场**：`tryFire()` 里有一道守卫（已有未结算的比试时跳过 `duel` 事件）。
          没有它会让第二场把第一场的窗口整个覆盖掉 —— 第一场就凭空消失了。

     ⑧ **「现在站在这里的是谁」只有一个回答处**（N7 五期）：`curNpcId()` 拿**当前钓场**
        去查 NPC 表里的 `fields`（站位表）—— 内容表写「他站哪几片」，引擎负责挑。
        它同时服务三件事：`neighbor()`（画谁）、`talk()`（跟谁说）、`tryFire()`（谁的事会发生）。
        · 🔴 **事件过一道 NPC 门**：`tryFire()` 跳过 `ev.npc !== p.npc` 的事件。
          少了它，海边会跳出老陈的「借线」—— 画面上站着阿海、弹窗里却是老陈在说话，
          **不报任何错**（`verify` 第 50 节从内容表这一侧盯着「事件的人必须在那条事件
          列出的每个钓场都在场」）。
        · **没人在的钓场** ⇒ `curNpcId()` 给 `''` ⇒ `neighbor()` 给 `null`（场景不画人）、
          一条事件都不参与抽签（`p.npc === ''` 谁都对不上）。这不报错，是**有意**的。
        · ⚠️ 与 `cond.field` 是**两件事**，不重复：`fields` 说「这个人站哪几片」，
          `cond.field` 说「这件事在哪几片能发生」（同一个人也可以只在其中一片办某一件事）。
     ⑨ **「上一竿的结局」也是条件**（N7 六期）：事件可以带 `cond.after: ['snap','escape',…]`,
        意思是**只在刚丢了鱼之后**才开口（值 = `fishing.js` 丢竿回调给的那几个结局）。
        它是**门**不是条件指纹 —— 与 `npc` 同款：
        · 由调用方**逐次带进来**（`consider(after)`），**不落存档、不参与 `seq` 归零**
          （`seq` 仍然只按「钓场|天气|时段」归零）⇒ 不会因为「这次带了结局」而改变
          别的事件的掷点（口径 ① 不受影响）。
        · **只有丢竿那条路会带**：结算卡关闭那处（上鱼 / 卖鱼 / 收护之后）不带 ⇒
          「上鱼之后被人接一句风凉话」这种事不会发生。
        · 脏值（非字符串）一律当**没带**（空字符串）处理：脏档 / 误传对象都不该让
          一条门意外打开。
     ⑩ **「图鉴门」也是条件**（N7 七期）：事件可以带 `cond.have: ['<鱼种 id>', …]` ——
        这几条里**任意一条**已经在图鉴里，这道门才开（⇒ 事件跟着玩家的**进度**走，
        而不是只看钓场 / 天气 / 时段）。与 `npc` / `after` 同款，它是**门**：
        · 由 `condOk()` 逐次现算（读的是**当前存档的图鉴**）⇒ **不落存档、不进 `ctxKey`**，
          于是它不参与 `rollFor()` ⇒ 加这道门**不会挪动别的事件的掷点**（口径 ① 不受影响）。
        · 🔴 **「钓到过没有」只有一处真相**：判定走 `G.State.isCaught()`（图鉴那一份），
          **不在这儿重读 `s.book`** —— 同一个事实写两遍迟早分家（图鉴字段口径改一次，
          两边就开始各说各话），而且不会报错。取不到那一层时按「没钓到」处理。
        · 脏值（不是数组 / 空数组 / 里面躺着不存在的鱼种 id / 非字符串元素）一律
          **当门不开**：宁可这条事件不出现，也不让它「因为存档脏了反而天天冒出来」。
          写错 id 同样**不报错**，只会静默地永不触发 ⇒ `verify` 第 50 节拿 `G.FISH_ID`
          现算值域（抓的就是这个）。
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
  /* 按 id 找一条事件（比试结算要回内容表拿 `win` / `lose` 台词）。
     ⚠️ 找不到给 null —— 内容表里删掉那条事件之后，存档里那场比试不该把引擎带崩。 */
  function evOf(id) {
    var list = evs();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /* 存档里的那块（缺字段时给个空壳：脏档 / 老档都不该让这里抛） */
  function rec() {
    var s = (G.State && G.State.get) ? G.State.get() : null;
    var t = s && s.story;
    if (!t || typeof t !== 'object') t = {};
    if (!t.fired || typeof t.fired !== 'object') t.fired = {};
    if (!t.at || typeof t.at !== 'object') t.at = {};
    if (!t.talk || typeof t.talk !== 'object') t.talk = {};
    if (!t.pick || typeof t.pick !== 'object') t.pick = {};
    if (!t.duel || typeof t.duel !== 'object') t.duel = {};
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

  /* 图鉴里有没有这一条（口径 ⑩）。🔴 **不在这儿重写一份 `s.book` 判断** ——
     「钓到过没有」的真相只有一处：`G.State.isCaught()`。
     取不到那一层（脏宿主 / 单测里没挂 State）时按「没钓到」处理：
     这道门宁可关着，也不该在一个残缺的宿主上意外打开。 */
  function caughtOne(id) {
    if (typeof id !== 'string' || !id) return false;
    return !!(G.State && G.State.isCaught && G.State.isCaught(id));
  }

  /* 条件：`cond` 里列出的每一项都要满足；没列的项不参与判定。
     ⚠️ `after`（上一竿的结局，口径 ⑨）**也是**「没列就不参与」：没写它的事件在
        丢竿那一次照样能命中（这道门只对写了它的事件生效）。而 `p.after` 是空串
        （= 这一次没带结局）时，写了 `after` 的事件一律不参与 —— 所以门里写成**空数组**
        等于「永远不匹配」（`verify` 第 50 节要求它是非空数组，就是拦这个）。
     ⚠️ `have`（图鉴门，口径 ⑩）是**「任意一条」语义**：列表里有一条钓到过就开门。
        列表不是数组 / 是空数组 / 元素不是字符串 ⇒ 循环一次都不跑 ⇒ 门恒关（安全方向）。
        `caughtOne()` 非字符串直接给 false，所以脏元素不会意外开门也不会抛。 */
  function condOk(ev, p) {
    var c = ev.cond || {};
    if (c.field && c.field.indexOf(p.field) < 0) return false;
    if (c.wx && c.wx.indexOf(p.wx) < 0) return false;
    if (c.tm && c.tm.indexOf(p.tm) < 0) return false;
    if (c.after && c.after.indexOf(p.after) < 0) return false;
    if (c.have) {
      var hit = false;
      for (var i = 0; i < c.have.length; i++) {
        if (caughtOne(c.have[i])) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  /* 「那条事件的第 i 项被选过几次」—— **纯读、不新建**（`tryFire()` 是纯函数，
     别在判定里往存档里写东西；写是 `choose()` 的事）。 */
  function pickTimes(st, id, i) {
    var a = st.pick && st.pick[id];
    return (a && typeof a === 'object' && typeof a[i] === 'number') ? a[i] : 0;
  }

  /* 存档事实门（`need`）：它引用的那次选择必须**真的发生过**。
     ⚠️ 写错 id / 下标不会报错，只会让这条事件**永远不出现** —— 所以 `verify` 第 50 节
        拿内容表现算（id 必须存在、下标必须落在那条事件的选项范围里），抓的就是这个。 */
  function needOk(ev, st) {
    var n = ev.need;
    if (!n) return true;
    return pickTimes(st, n.pick, n.opt) > 0;
  }

  /* 按顺序挑第一个命中且「过门」的事件。`p` = { field, wx, tm, npc, seq, now }。
     🔴 纯函数（只看入参 + 存档里的已触发记录）：同一份存档 + 同一组入参 ⇒ 同一个结果。
        测试就是靠这条钉住「可复现」，别再往里加 `Math.random()` / `Date` 之类。 */
  function tryFire(p) {
    var st = rec();
    var list = evs();
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      /* 🔴 NPC 门（口径 ⑧）：只让「当前钓场站着的那一位」的事参与抽签。
         少了这一条，海边会跳出老陈的「借线」（画面上是阿海、弹窗里是老陈），且不报错。
         `p.npc` 由 `probeOf()` 从 `curCtx()` 带下来 —— 「谁在场」只有 `curNpcId()` 一处回答。 */
      if (ev.npc !== p.npc) continue;
      if (!condOk(ev, p)) continue;
      if (!needOk(ev, st)) continue;
      if (ev.once && (st.fired[ev.id] || 0) > 0) continue;
      /* 已有**未结算**的比试 ⇒ 不再开第二场（口径 ⑦）。少了这一条，第二场会把
         第一场的窗口整个覆盖掉 —— 玩家刚比到一半的那局就凭空消失了，且不报错。
         ⚠️ 判「进行中」只看 `end > 0`（结算时才清零），与 `noteCatch()` 同一口径。
         这条仍在「纯函数」范围内：它只读存档。 */
      if (ev.duel && st.duel.end > 0) continue;
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

  /* 当前条件（钓场 / 天气 / 时段 / 站着的是谁）。抽成函数是为了让「条件指纹」只有一处拼法，
     `consider()` 与测试都走它。
     ⚠️ 顺带一个硬约束：**返回块里不许出现 `键: 值` 形态的对象字面量** ——
        `verify` 的 `exportKeys()` 是把返回块里所有 `x:` 都当导出名收的，
        写成内联字面量会让 `field` / `wx` 这种普通字段被当成「零调用的死导出」报红。
        （这不是哪个门禁的怪癖：模块的对外面本来就该只有一份清单，字段写在函数体外面更清楚。）
     ⚠️ 这里的 `npc` **不是**「条件」而是「谁在场」（口径 ⑧）：`tryFire()` 拿它过 NPC 门。
        它由 `curNpcId()` 按**当前钓场**现算 ⇒ `seq` 归零那套（条件变了就重掷）不受影响，
        「换了个钓场」本来就会换指纹。 */
  function curCtx() {
    var s = (G.State && G.State.get) ? G.State.get() : null;
    if (!s) return null;
    var sn = (G.Weather && G.Weather.snapshot) ? G.Weather.snapshot() : null;
    return {
      field: s.field,
      wx: (sn && sn.wx) ? sn.wx.key : '',
      tm: (sn && sn.tm) ? sn.tm.key : '',
      npc: curNpcId(),
    };
  }
  /* `tryFire()` 要的那份入参（纯数值，不含对象引用）—— 同样是为了把字面量挪出返回块。
     `after` = **这一竿的结局**（口径 ⑨）：只有丢竿那条路带得进来，空串 = 没带。 */
  function probeOf(c, n, t, after) {
    return { field: c.field, wx: c.wx, tm: c.tm, npc: c.npc, after: after, seq: n, now: t };
  }

  /* ---------------- 对外动作 ---------------- */
  /* 「现在该站在钓场里的那一位」是谁 —— **只有这一处**回答这个问题。
     `neighbor()`（给场景画）与 `talk()`（给玩家点）都走它，`tryFire()` 也吃它的结果
     （口径 ⑧）。
     🔴 判据是**内容表里的 `fields`（站位表）**，不是「取列表里第一个」——
        写成取第一个的话，加第 2 个 NPC 时那个人**永远不出现**，而且不报错。
     ⚠️ 没人在的钓场（没被任何 NPC 列进去 / 钓场 id 是脏值）⇒ 给 `''`：
        场景不画人、一条事件都不参与抽签。这是有意留的空位，不是兜底失败。 */
  function curNpcId() {
    var all = G.STORY_NPCS;
    if (!all || typeof all !== 'object') return '';
    var s = (G.State && G.State.get) ? G.State.get() : null;
    var f = (s && s.field) ? s.field : '';
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i++) {
      var npc = all[keys[i]];
      if (npc && npc.fields && npc.fields.indexOf(f) >= 0) return keys[i];
    }
    return '';
  }

  /* 当前该站在钓场里的那个 NPC。场景层直接吃这个对象：
     `x` 是站位比例、其余是绘制参数。表为空时返回 null（场景层据此不画人）。
     ⚠️ 每次返回**同一个对象**（内容表里的那个），场景每帧都会拿它，别在这儿新建。 */
  function neighbor() {
    var id = curNpcId();
    return id ? (G.STORY_NPCS[id] || null) : null;
  }

  /* 对话面板要的那份载荷。**写成函数而不是在 `talk()` 里直接 `return {…}`** ——
     与 `probeOf()` 同一个理由：返回块里的 `键: 值` 会被 `exportKeys()` 当成导出名。
     `title` 是面板标题：主动搭话走默认「搭话」，事件带自己的标题（`borrow` / `还线` …）——
     **分支的下一段也要带上它**，否则面板在半路会从「借线」变成「搭话」。 */
  function payload(npc, lines, title) {
    var o = {};
    o.npc = npc;
    o.lines = lines;
    o.title = title || '';
    return o;
  }

  /* 玩家**主动点他**（N7 二期）→ 返回对话面板要的载荷，没有可聊的人 / 没有闲聊池时给 null。
     🔴 三条设计口径：
       · **不走概率门**（口径 ⑤）：点了就该有回应；轮到哪句由 `s.story.talk` 计数决定。
       · **只给一句**：搭话是顺手的动作，弹一大段会挡住钓鱼。
       · **不返回空台词**：池子里那条不是非空字符串时给 null（调用方据此落回「抛竿」），
         而不是弹一张空对话卡 —— 「点了没反应」比「弹张空白卡」好排查得多。 */
  function talk() {
    var id = curNpcId();
    if (!id) return null;
    var npc = npcOf(id);
    var pool = (npc && npc.talk) || null;
    if (!pool || !pool.length) return null;

    var st = rec();
    var n = st.talk[id] || 0;
    var line = pool[n % pool.length];
    if (typeof line !== 'string' || !line.trim()) return null;

    st.talk[id] = n + 1;
    if (G.State && G.State.save) G.State.save(true);   /* 与 mark() 同样立刻落盘 */
    return payload(npc, [line]);
  }

  /* 玩家在**分支**里点了一项（N7 三期）→ 返回下一段对话的载荷；
     没有下一段 / 下标不合法 ⇒ `null`（调用方收起面板，**不猜一项**）。
     🔴 三条口径：
       · **不走概率门**（口径 ⑥）：与 `talk()` 同款 —— 玩家已经点了，回应必须来。
       · **选项下标只认内容表**：越界、那条事件没有 `choices`、那一项没有台词 ⇒ 一律 `null`。
         「点了没反应」比「弹一张空白卡」好排查得多。
       · **记的是次数**：`s.story.pick[事件 id][选项下标] += 1`，让「他借到过线」这件事
         在存档里留得住（`repay` 那条的 `need` 就是读它）。**立刻落盘** ——
         与 `mark()` / `talk()` 同一条口径：玩家可能在面板看完就关掉页面。
       · 🔴 那个数组**补成密集的**（每个选项一个 0，不是稀疏数组）：稀疏数组
         JSON 化会变成 `[null,1]` —— 存档读起来像坏数据，也容易被后来的人当成脏档去修。 */
  function choose(ev, i) {
    var cs = (ev && ev.choices) || null;
    if (!cs || !cs.length) return null;
    if (!(i >= 0 && i < cs.length)) return null;
    var c = cs[i];
    if (!c || !Array.isArray(c.lines) || !c.lines.length) return null;

    var st = rec();
    var arr = st.pick[ev.id];
    if (!arr || typeof arr !== 'object' || !Array.isArray(arr)) { arr = []; st.pick[ev.id] = arr; }
    for (var j = 0; j < cs.length; j++) { if (typeof arr[j] !== 'number') arr[j] = 0; }
    arr[i] = arr[i] + 1;
    if (G.State && G.State.save) G.State.save(true);
    return payload(npcOf(ev.npc), c.lines, ev.title);
  }

  /* ---------------- 限时比试（N7 四期，口径 ⑦） ----------------
     一条比试的生命周期（四处，都在本文件里）：
       `consider()` 命中带 `duel` 的事件 ⇒ `startDuel()` 定死他那条鱼 + 写窗口
       ⇒ 玩家每上一条鱼 `noteCatch()` 喂进来
       ⇒ 到点、人回到 idle 时 `settleDuel()` 结算，结果当成一次普通对话交出去。 */

  /* 他这一场的那条鱼：从本钓场 `pool` 那一档的鱼里按哈希抽一条，重量取哈希百分位。
     🔴 纯函数（只吃入参 + 鱼种表）：同一份存档 + 同一组条件 + 同一个序号 ⇒
        永远是同一条鱼、同一个重量（口径 ①）。
     ⚠️ 只读 `G.FISH_BY_FIELD_RARITY`（`Loot` 那条路会掷 `Math.random()`，用不得）；
        档位抽不出鱼 ⇒ `null`（调用方据此**不开赛**，而不是办一场没有对手的比试）。 */
  function rivalOf(ev, p) {
    var d = ev.duel;
    var salt = [p.field, p.wx, p.tm, p.seq, ev.id].join('|');
    var all = G.FISH_BY_FIELD_RARITY || {};
    var bucket = (all[p.field] || [])[d.pool] || [];
    if (!bucket.length) return null;
    var f = bucket[hash32('pick|' + salt) % bucket.length];
    var kg = f.minKg + (f.maxKg - f.minKg) * (hash32('kg|' + salt) / 4294967296);
    return { name: f.name, kg: kg };
  }

  /* 收场：只清**这一场**的窗口字段。🔴 `wins` / `losses` 是持久事实，**不清** ——
     否则「比过几场赢了几个」会在下一场开赛时凭空归零。 */
  function clearDuel(d) {
    d.id = ''; d.end = 0; d.name = ''; d.target = 0; d.best = 0; d.casts = 0;
  }

  /* 开一场：把窗口与「他那条鱼」写进存档。抽不出鱼 / 内容表没配 `ms` ⇒ 不开（不抛）。 */
  function startDuel(ev, p) {
    var dd = ev.duel;
    if (!dd || !(dd.ms > 0)) return false;
    var r = rivalOf(ev, p);
    if (!r) return false;
    var d = rec().duel;
    d.id = ev.id;
    d.end = p.now + dd.ms;
    d.name = r.name;
    d.target = r.kg;
    d.best = 0;
    d.casts = 0;
    if (G.State && G.State.save) G.State.save(true);
    return true;
  }

  /* 存档里的数字兜底：`duel` 的每个字段都是从盘上读回来的，脏档（字符串 / NaN）
     会让 `+1` 变成**字符串拼接**、让 `>` 的比较**恒假** —— 而且两者都不报错。
     与 `state.js` 的 `safeNum()` 同一个态度，只是这里更严（负数也当脏值）。 */
  function numOr0(v) {
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;
  }

  /* 顶栏那枚倒计时芯片要的数据（`main.js` 每半秒问一次）。没有进行中的比试 ⇒ `null`。 */
  function duelInfo() {
    var d = rec().duel;
    if (!d || !(d.end > 0)) return null;
    var o = {};
    o.name = d.name || '';
    o.target = numOr0(d.target);
    o.best = numOr0(d.best);
    o.casts = numOr0(d.casts);
    o.leftMs = Math.max(0, d.end - now());
    return o;
  }

  /* 玩家上了一条鱼（`main.js` 的 `onCatch` 里调）—— 只有「比试进行中 + 不是挂机」才记账。
     ⚠️ 挂机上的鱼**不算**：比的是「你亲手钓」（挂机本来就是二等公民，与
        `config.idle.rareWeightMul` 那条口径同族）。窗口里开着挂机刷出来的重量
        会让这场比试变成走个过场。
     ⚠️ 判「进行中」只看 `end > 0`：窗口刚过、这一竿还在拉的那条**仍然算数** ——
        时间到的那一刻不去抢玩家手里的鱼（结算只发生在 idle 时刻，见 `settleDuel()`）。 */
  function noteCatch(kg) {
    if (!(kg > 0)) return false;
    var d = rec().duel;
    if (!d || !(d.end > 0)) return false;
    if (G.Fishing && G.Fishing.isIdleMode && G.Fishing.isIdleMode()) return false;
    d.casts = numOr0(d.casts) + 1;
    if (kg > numOr0(d.best)) d.best = kg;
    if (G.State && G.State.save) G.State.save(true);   /* 与 mark() / talk() 同样立刻落盘 */
    return true;
  }

  /* 重量文本：走 `U.kg()`（与鱼护 / 结算卡同一套显示口径）。
     ⚠️ 不在这儿另写一份格式化 —— 两处写法迟早分家。 */
  function kgTxt(v) {
    return (G.U && G.U.kg) ? G.U.kg(v) : (Math.round(v * 100) / 100 + ' kg');
  }
  /* 结算台词里的四个占位符。⚠️ 一律用**函数式替换**：鱼名 / 数字里若出现 `$&`
     这类字符，字符串式替换会把它们当替换模式解释掉（静默）。 */
  function fillLine(s, d, bestTxt, scoreTxt) {
    return String(s)
      .replace(/\{name\}/g, function () { return d.name || '那条鱼'; })
      .replace(/\{rival\}/g, function () { return kgTxt(d.target); })
      .replace(/\{best\}/g, function () { return bestTxt; })
      .replace(/\{score\}/g, function () { return scoreTxt; });
  }

  /* 造一条**不在内容表里**的事件对象（比试的结算用）。
     写成「造对象 + 裸返回」的小工厂：字段全在函数体里列清楚，也不在模块顶层的
     返回块里出现内联字面量（硬规矩 31）。 */
  function mkEv(id, npcId, title, lines) {
    var o = {};
    o.id = id;
    o.npc = npcId;
    o.title = title;
    o.lines = lines;
    return o;
  }

  /* 到点就结算。返回那个结果事件，或 `null`（没有进行中的比试 / 没到点 / 门没过）。
     🔴 四道门与 `consider()` **同款**（顺序即优先级）：必须是 idle ⇒ 不能是挂机 ⇒
        不能有面板 / 结算卡开着。前两条是「别打断玩家手里那一竿」，第三条是「两层
        modal 叠在一起会打架」。少任何一条都会出现「鱼还在拉扯、比试结果盖上来」。
     ⚠️ 结果走**同一个 `cb.onEvent`**：UI 层不必认识比试（它只会看到一次普通对话）。
     返回值仍是那种「不是内容表里的」事件对象 —— 调用方按 `id` / `title` / `lines` 用即可。 */
  function settleDuel() {
    var d = rec().duel;
    if (!d || !(d.end > 0)) return null;
    var t = now();
    if (t < d.end) return null;
    if (G.Fishing && G.Fishing.getState && G.Fishing.getState() !== 'idle') return null;
    if (G.Fishing && G.Fishing.isIdleMode && G.Fishing.isIdleMode()) return null;
    if (G.Panels && ((G.Panels.isOpen && G.Panels.isOpen())
      || (G.Panels.isCatchOpen && G.Panels.isCatchOpen()))) return null;

    var ev = evOf(d.id);
    var best = numOr0(d.best), target = numOr0(d.target);
    var win = best > target;                     /* 🔴 平局算他赢（严格大于才算你赢） */
    var lines = (ev && ev.duel) ? (win ? ev.duel.win : ev.duel.lose) : null;
    if (!Array.isArray(lines) || !lines.length) {
      /* 内容表没配结算台词（或那条事件被删了）⇒ 悄悄收场 —— 宁可少一句 flavor，
         也不能把玩家卡在一场**永远结不了**的比试里（窗口字段不清，之后再也开不了新场）。
         ⚠️ 正常情况走不到：`verify` 第 50 节要求 `win` / `lose` 都是非空字符串数组。 */
      clearDuel(d);
      if (G.State && G.State.save) G.State.save(true);
      return null;
    }
    /* 战绩**两边都写**（`0` 而不是缺字段）：只写赢的那个的话，存档里就是 `{wins:1}`
       —— 读 `duel.losses` 的地方拿到 `undefined`。与「计数数组补成密集的」同一条教训：
       稀疏的存档读起来像坏数据（也容易被后来的人当成脏档去修）。
       ⚠️ 先归一化再自增：`wins` 是字符串时 `+1` 会变成拼接（`"3"+1 === "31"`），而且不报错。 */
    d.wins = numOr0(d.wins);
    d.losses = numOr0(d.losses);
    if (win) d.wins++; else d.losses++;
    var bestTxt = (best > 0) ? kgTxt(best) : '空手';
    var scoreTxt = '你 ' + d.wins + ' 胜 ' + d.losses + ' 负';
    /* ⚠️ 台词必须在 `clearDuel()` **之前**填好 —— 它要读 `d.name` / `d.target`。 */
    var out = mkEv(ev.id + (win ? 'Win' : 'Lose'), ev.npc, ev.title, lines.map(function (s) {
      return fillLine(s, d, bestTxt, scoreTxt);
    }));
    clearDuel(d);
    /* 与 `consider()` 共用全局兜底间隔：刚比完别再紧接着碰上一位邻居（会连开两个弹窗）。 */
    lastAt = t;
    if (G.State && G.State.save) G.State.save(true);
    if (cb.onEvent) cb.onEvent(out, npcOf(ev.npc), rewardOf(ev));
    return out;
  }

  /* `init({ onEvent })`：`onEvent(ev, npc, reward)` 由 UI 层实现（现在是开对话面板）。
     没有回调时引擎照旧记账、只是没人看得到（测试里就是这么用的）。 */
  function init(opts) {
    cb.onEvent = (opts && typeof opts.onEvent === 'function') ? opts.onEvent : null;
  }

  /* 一次「可以考虑触发」的时机。调用点只有 main.js 的两处（结算卡关闭 / 丢竿之后），
     外加测试。返回真正触发的那条事件，或 null。
     `after` = **这一竿的结局**（口径 ⑨）：丢竿那处把 `onMiss` 的结果（`snap` / `escape` /
     `miss`）原样带进来，结算卡关闭那处**不带**（上鱼之后不该有人接风凉话）。
     🔴 它**不进 `ctxKey`**：条件指纹仍然只有「钓场|天气|时段」三项 —— 带不带结局
        都不影响 `seq` 的归零与已有事件的掷点（口径 ①）。
     ⚠️ 与 `probeOf()` 同一条纪律：**返回块里不许出现 `键: 值` 形态的对象字面量**
        （`verify` 的 `exportKeys()` 会把它们当成导出名）。
     ⚠️ 四道门（顺序即优先级）：状态必须是 idle → 不能是挂机 → 不能有面板开着 →
        全局间隔没到。前三条是「别打断人」，第四条是「别一分钟碰上俩邻居」。 */
  function consider(after) {
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

    /* 脏值（对象 / 数字 / undefined）一律当「没带结局」—— 它不该让一条门意外打开。 */
    var probe = probeOf(c, seq, t, (typeof after === 'string') ? after : '');
    var ev = tryFire(probe);
    if (!ev) return null;
    lastAt = t;
    mark(ev, t);
    /* 带 `duel` 的事件：顺手开一场比试。⚠️ 顺序在 `mark()` **之后**、回调**之前** ——
       面板打开的那一刻 `duelInfo()` 必须已经是新窗口，否则顶栏芯片会慢一拍
       （玩家先看到对话、半秒后才看到「比试进行中」）。 */
    if (ev.duel) startDuel(ev, probe);
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
    talk: talk,
    choose: choose,
    noteCatch: noteCatch,
    settleDuel: settleDuel,
    duelInfo: duelInfo,
    tryFire: tryFire,
    rollFor: rollFor,
    reset: reset,
  };
})();

