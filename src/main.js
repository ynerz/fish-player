/* =========================================================
   main.js  —  启动与主循环
   ========================================================= */
(function () {
  var U = G.U, St = G.State, Hud = G.Hud, S = G.Scene, F = G.Fishing, P = G.Panels;
  var last = 0, hudTimer = 0, lastState = '', hiddenAt = 0, bootDone = false;
  var blurred = false;   /* 窗口失焦（切到别的应用）时也停掉逻辑与计时 */
  /* 音频有没有被「用户第一次手势」激活（见 boot 里的 arm）。放在模块级是因为
     「时段 / 天气变了要不要顺手换音乐」那个回调也要看它 —— 见 retuneBgm。 */
  var armed = false;

  /* 当前条件（钓场 + 时段 + 天气）该放的那首曲子。
     三个调用点（首次手势 / 切钓场 / 时段天气变化）共用这一处合成 ——
     「同一件事写 N 遍」是本项目踩得最多的坑型，这里一开始就收口。 */
  function bgmOf() {
    var f = G.FIELD_MAP[St.get().field] || G.FIELDS[0];
    return G.Weather.bgmSpec(f.theme.bgm);
  }

  /* 只在「玩家要音乐」时才换参数。⚠️ 不能无条件调 `startBgm()` ——
     它会把「用户想听音乐」的意图位（`bgmWant`）点亮，于是
     「关掉音乐 → 变一次天 → 音乐自己回来了」，而玩家压根没按过音乐开关。
     （同一条理由：arm()` 之前也不许调，否则会凭空建一个 suspended 的
       AudioContext，还提前把意图位置成 true。） */
  function retuneBgm() {
    if (!armed) return;
    var se = St.get().settings;
    if (se.sound && se.music) G.Audio.startBgm(bgmOf());
  }

  function boot() {
    /* ---------- 错误采集（先挂上：后面任何一步崩了，日志里都有「崩在哪一步」） ---------- */
    if (G.Track) G.Track.init();

    /* ---------- 存档 ---------- */
    /* 账号/档案必须先就绪：它决定存档键（每个账号一份档），
       老档会在 Profile.init() 里被搬到默认档案下，进度不丢。 */
    if (G.Profile && G.Profile.init) G.Profile.init();
    St.load();
    var s = St.get();

    G.Audio.setEnabled(s.settings.sound);
    G.Audio.setVolume(s.settings.volume);
    G.Audio.setMusicVolume(s.settings.musicVol);

    /* ---------- 长线目标（每日任务 / 成就 / 称号） ---------- */
    G.Goals.init();

    /* ---------- 反作弊 · 本地完整性检测（N2） ----------
       读档即审一遍：改档的人不必等钓到鱼才被记上。
       只做 L1 标记，不拦、不封、不改任何游戏数据（见 src/core/integrity.js 头部）。 */
    if (G.Integrity) G.Integrity.init(s);

    /* ---------- 天气与时段 ---------- */
    G.Weather.init(Math.random());
    /* 天气 / 时段一变：顶栏芯片刷新 + 音乐换参数。
       ⚠️ `Weather.on` 是这些条件变化的**唯一**出口（随机换天、跨时段、devtools 的
          `Weather.set` 都会走到这里），所以音乐接线挂这儿就够了，不用逐处接。
       ⚠️ `startBgm` 只换参数、**不重启调度器**（见 audio.js）—— 换时段时音乐
          接着往下走、和弦自然换过去，不会「从头来一遍」。 */
    G.Weather.on(function (sn) {
      Hud.setWeather(sn);
      retuneBgm();
    });
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
        Hud.toast({ text: v ? '已开启挂机，自动帮你上鱼（稀有 ×' +
          G.CONFIG.idle.rareWeightMul.toFixed(2) + '）' : '已关闭挂机', kind: v ? 'good' : '' });
        if (v) Hud.syncDeck();
      },
    });
    Hud.setField(field);
    Hud.syncAll();

    /* 读档出过问题就明确说一声（主存档退备份 / 全废重置）。
       静默清零比白屏更让人抓狂 —— 玩家至少要知道"为什么我的进度没了"。 */
    var loadNote = St.loadNote && St.loadNote();
    if (loadNote) setTimeout(function () { Hud.toast({ text: '⚠️ ' + loadNote, kind: 'bad' }); }, 600);
    /* 存档落在**内存**里 = 「关掉页面进度就没了」，而界面上完全看不出来
       （设置面板有一行小字写着落盘位置，但没人会去看）。
       这是 warn 级：不是崩溃，但玩家的损失是真实的、而且事后无从追溯。 */
    if (G.Track && G.Platform.storage.kind() === 'memory') {
      G.Track.warn('存储不可用，存档只在内存里（关掉页面即丢档）', { stage: 'boot' });
    }

    /* ---------- 新手引导（首次抛竿前就出现，非阻塞气泡） ---------- */
    G.Tutorial.init();

    /* ---------- 陪伴助手（N6） ----------
       助手只决定「什么时候说哪一句、要不要出声」；气泡与语音能力都从外面给它。
       ⚠️ 文字气泡**永远有**（语音只是加成）—— 所以关掉语音之后助手仍在说话，
       只是不出声（`core/assistant.js` 口径 ①）。 */
    G.Assistant.init({
      toast: function (line) { Hud.toast({ text: line.text }); },
    });

    /* ---------- 隔壁钓鱼佬（N7） ----------
       事件引擎只决定「什么时候碰上谁、他说什么、触发过几次」；画面（他站在哪）
       交给场景层，对话交给面板层（复用同一个 modal，不新建弹层体系）。
       ⚠️ 考虑触发的时机**只有两处**（见 onMiss / onCatchCardClosed）——
         都在「一竿已经结算完、回到 idle」之后，绝不在 wait / fight 中途插进来。 */
    if (G.Story) {
      G.Story.init({ onEvent: onStoryEvent });
      S.setNeighbors(G.Story.neighbors());
    }

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
    /* 重置存档 → 整页重载（走适配层；面板那边只负责调 St.reset()，别重复 reload） */
    St.on('reset', function () { G.Platform.sys.reload(); });
    /* 切钓场 → 换背景音乐。走**状态事件**而不是跟着 UI 走：
       钓场能从钓场列表 / 鱼种面板 / 重置存档好几处切换，
       逐个接线迟早漏一处（而漏了的表现是「音乐还是上一个湖的」，很难被发现）。 */
    St.on('field', function (fid) {
      /* 邻居是**按钓场**站的人（N7 五期 / N11 一期：一片可以有两位）：
         切了钓场就可能换人 / 换站位 / 由一位变两位 —— 少了这一句，画面会一直画着
         上一个钓场那几位（不报错，像鬼影），而对话里的人已经换了。
         ⚠️ 放在 `FIELD_MAP` 那道守卫**之前**：钓场 id 不认时也该把人撤掉（`neighbors()` 给空数组），
            而不是把上一位留在画面上。 */
      if (G.Story && S.setNeighbors) S.setNeighbors(G.Story.neighbors());
      /* 到了这一片水 —— 站着的两位可能正聊着（N11 二期：玩家旁观，不用点他们）。
         🔴 **必须延到这一栈跑完之后**：切钓场是从钓场面板里点的，此刻面板还开着，
            直接问必然被「面板开着」那道门（与 `consider()` 同款）拦掉，而且
            **不报错**（表现只是「从来没听见过他们聊天」）。
            `arriveSoon()` 就是那一层延后（`setTimeout(…, 0)`），别在这里直接调 `arrive()`。 */
      if (G.Story && G.Story.arriveSoon) G.Story.arriveSoon();
      if (!G.FIELD_MAP[fid]) return;
      var se = St.get().settings;
      if (se.sound && se.music) G.Audio.startBgm(bgmOf());
    });
    St.on('goals', function () {
      Hud.setTitle(G.Goals.equipped());
      /* 徽标平时靠 0.4 秒一次的 syncStats() 顺带刷；这里补一次，
         让「刚好完成一条任务」时角标立刻出现，不等下一拍 */
      Hud.syncGoalBadge();
      if (P.current() === 'goals') P.refresh();
    });

    /* ---------- 首次交互激活音频 ----------
       ⚠️ 必须在**用户第一次手势**里做：浏览器的自动播放策略会把没有手势的
       AudioContext 挂成 suspended。环境音与 BGM 都是**常驻节点**（不像一次性音效
       那样每次调用都有机会补救），这一步漏了就是「整局没声音」，而且不报任何错。 */
    function arm() {
      if (armed) return; armed = true;
      var se = St.get().settings;
      G.Audio.setEnabled(se.sound);
      if (!se.sound) return;
      if (se.ambient) G.Audio.startAmbience();
      if (se.music) G.Audio.startBgm(bgmOf());
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
       （flying 状态天然是 no-op），所以直接透传即可。
       ⚠️ 唯一的例外是「点隔壁那位搭话」（N7 二期）：它必须在 handlePress **之前**
       拦一道，否则点他会变成抛竿。拦截条件写在 tryTalkAt() 里，同样是「先问过
       钓鱼状态」，绝不在 wait / fight / bite 里抢走收线与提竿。 */
    G.Platform.input.down(U.$('#scene'), function (ev) {
      if (tryTalkAt(ev)) return;
      handlePress();
    });

    /* ---------- 网页隐藏 / 显示 ---------- */
    G.Platform.sys.onVisibility(function () {
      if (!G.Platform.sys.isVisible()) {
        hiddenAt = Date.now();
        St.save(true);
        /* 切走就闭嘴：合成人声不属于这个页面，把它留在后台继续念
           （玩家切到别的标签页还在听钓鱼佬说话）是最没道理的一种「背景音」。 */
        if (G.Platform.speech) G.Platform.speech.stop();
      } else {
        last = G.Platform.sys.now();
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
    G.Platform.sys.onBlur(function () { blurred = true; St.save(true); });
    G.Platform.sys.onFocus(function () { blurred = false; last = G.Platform.sys.now(); });

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
    /* 起手先把 `last` 对齐到平台时钟：下一帧的 dt 才不会因为
       「boot 花了多久」而算出一个大跳（loop 里还有一层 <0 / >0.05 的夹紧兜底）。 */
    last = G.Platform.sys.now();
    G.Platform.sys.raf(loop);
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
    /* 比试（N7 四期）：这一竿的成果要喂给事件判定（口径 ⑦）。
       ⚠️ 引擎自己会拦「没在比试 / 挂机上的鱼」两种情况，这里不做第二份判断 ——
          「挂机不算」的判据只有一处（`core/story.js` 的 `noteCatch()`）。 */
    if (G.Story) G.Story.noteCatch(info.kg);
    /* 陪伴助手：传说鱼 / 破纪录时接一句话（挂机 / 普通鱼由它自己判断，这里不写白名单） */
    G.Assistant.onCatch(info);

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
    /* 结算刚收尾、回到 idle —— 这是「可以碰上隔壁钓鱼佬」的时机之一 */
    if (G.Story) G.Story.consider();
  }

  /* 隔壁钓鱼佬真的开口了（引擎已经记完账）→ 开对话。
     复用现有 modal：底栏会自动进禁用态、ESC / 点遮罩都能关，不必另写一套。
     ⚠️ 带 `duel` 的那条（比试开场）顺手提一句「比试开始了」—— 顶栏那枚倒计时芯片
        是慢慢出现的，一句即时提示能让玩家立刻把注意力放到这次比试上。 */
  function onStoryEvent(ev, npc) {
    if (ev.duel) Hud.toast({ text: '⚔ 比试开始 —— 这一会儿谁上的鱼更沉', kind: 'good' });
    P.open('dialog', dialogPayload(ev, npc));
  }

  /* 对话面板要的全部载荷。**写成「造一个对象并裸返回」的函数**（与 `core/story.js`
     的 `payload()` 同一个写法）：`title / npc / lines / choices` 都是喂给 UI 的数据，
     `onPick` 是 UI 自己的接线（点了选项找谁要下一段）—— 对象整体交给 `panels.js`，
     不是本模块的内部状态。 */
  function dialogPayload(ev, npc) {
    var d = { title: ev.title, npc: npc, lines: ev.lines };
    /* 旁观对话（N11 二期）：`duo` 是「谁说了哪一句」、`head` 是面板头那一行（两个人一起出现）
       —— 两位说话人时没有单一的「他」，所以 `npc` 是 null、`lines` 也不出现。
       对象整体交给 `panels.js`，本模块不替它决定怎么画。 */
    if (ev.duo && ev.duo.length) {
      d.duo = ev.duo;
      d.head = ev.head || '';
    }
    if (ev.choices && ev.choices.length) {
      d.choices = ev.choices;
      d.onPick = function (i) { pickBranch(ev, i); };
    }
    return d;
  }

  /* 玩家在分支里点了一项（N7 三期）：引擎把那一项的台词作为下一段交回来
     （同时把选择记进存档）。没有下一段（越界 / 内容表没配）就收起面板 ——
     与 `tryTalkAt()` 那条同款：「点了没反应」比「弹一张空卡」好排查。 */
  function pickBranch(ev, i) {
    var next = G.Story.choose(ev, i);
    if (next) P.open('dialog', next);
    else P.close();
  }

  /* 点在邻居身上了吗？是 → 他搭一句，返回 true（调用方不要再走 handlePress）。
     🔴 顺序与守卫（这几条缺一条都会变成「玩家点了没反应」或更糟）：
       ① **只有 idle 才拦**：wait / bite / fight 里点画布分别是「放弃 / 提竿 / 收线」，
          被搭话抢走就是这一轮最严重的回归（本项目真发生过左右不对称那种事）；
       ② **挂机不拦**：人在挂机时点一下多半是想操作，弹对话会挡住；
       ③ **面板 / 结算卡开着不拦**：handlePress() 本来就要处理「关掉结算卡」这件事；
       ④ 坐标用**画布矩形**换算成逻辑像素（`Scene` 的命中框走的就是逻辑坐标，
          高 DPI 下 canvas.width 是 dpr 倍，拿 offsetWidth 那一套会对不上）。
          ⚠️ 矩形的**取法**必须与 `scene.js` 的 `resize()` 一致：它量的是
          `cv.parentElement`（画布铺满父级，行内样式由 CSS 给）。这里也量父级，
          量自己会在父级有内边距 / 边框时整块偏掉（而且偏得不多，最难发现）。 */
  function tryTalkAt(ev) {
    if (!G.Story || !ev) return false;
    if (F.getState() !== 'idle') return false;
    if (F.isIdleMode && F.isIdleMode()) return false;
    if (P.isOpen() || P.isCatchOpen()) return false;
    var el = U.$('#scene');
    if (!el || !el.getBoundingClientRect) return false;
    var host = el.parentElement || el;
    if (!host.getBoundingClientRect) return false;
    var r = host.getBoundingClientRect();
    /* 命中框给的是**被点到的那一位的 id**（N11 一期：同一片水里可能有两位）——
       拿它去问「跟这位说话」。少了这一步，同场两位时会退化成「画一个、说另一个」，
       而且**不报错**（玩家只会觉得点错了人）。 */
    var hitNpc = S.hitNeighbor(ev.clientX - r.left, ev.clientY - r.top);
    if (!hitNpc) return false;
    var d = G.Story.talk(hitNpc);
    if (!d) return false;          /* 他没话可说 ⇒ 落回「抛竿」，不弹空白对话卡 */
    P.open('dialog', d);
    return true;
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
      /* 卖出（含鱼护满时的兜底）—— 走 State 的「卖鱼入账」出口，
         金币与「累计卖鱼收入」一起涨，别在这里手写 stats.totalValue */
      G.State.sellFish(info.price);
      Hud.syncCoin(true);
    }
    onCatchCardClosed();
    if (P.isOpen()) P.refresh();
  }

  function onMiss(result, pending, fee) {
    /* 陪伴助手：只有断线会说一句（脱钩 / 错过咬口在下面已经有提示，不重复说） */
    G.Assistant.onMiss(result);
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
    /* 丢了一竿、回到 idle —— 另一处「可以碰上隔壁钓鱼佬」的时机
       （挂机那一支上面已经 return 了：人不在屏幕前，弹对话只会打断他回来后的操作）
       🔴 `result` 就是**这一竿的结局**（`snap` 断线 / `escape` 脱钩 / `miss` 错过咬口），
          一并交给引擎 —— 带 `cond.after` 的事件靠它表达「他是在你刚跑鱼之后才开口的」。
          ⚠️ 这个调用点曾经**整条是死的**：`fishing.js` 的 `resolve()` 先回调、后把状态收到
             `idle`，于是 `consider()` 的 idle 门在这一刻恒不通过 —— 不报错，事件永远不来。
             已修在 `fishing.js`（「一竿结束」是回调**之前**就该成立的事实），
             `verify` 第 50 节盯着那个顺序。 */
    if (G.Story) G.Story.consider(result);
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
    if (frameAcc < FRAME_MIN) { G.Platform.sys.raf(loop); return; }
    var step = Math.min(frameAcc / 1000, 0.05);
    frameAcc = 0;
    dt = step;

    /* 结算卡必停（玩家正在看渔获）。普通面板只停**手动**钓：
       面板开着时输入通道是关的（modal-open 时 #deck 是 pointer-events:none，
       handlePress 也有 P.isOpen() 守卫），逻辑却照跑 —— 咬口 / 逃窜照常倒计时，
       玩家却一步都操作不了：手动钓必然断线或漏咬口（「看一眼图鉴就断一根线」）。
       挂机没有这个矛盾（自动驾驶不需要输入），浏览面板继续钓正是挂机的核心预期，
       所以 `!isIdleMode()` 守着 —— 别把 2026-10-08「挂机时开图鉴鱼就不咬」那个坑放回来。 */
    var paused = P.isCatchOpen() || (!F.isIdleMode() && P.isOpen());

    var focused = G.Platform.sys.isVisible() && !blurred;
    if (focused) {
      St.tick(dt);
      St.tankTick(dt);         // 水族箱被动收益（内部每 30 秒结算一次）
      G.Weather.update(dt);
      G.Goals.tick(dt);        // 跨天自动重掷每日任务（内部按 3 秒节流）
    }

    if (!paused && focused) {
      F.update(dt);
      /* 鱼力竭提示：（tire 由 fight.js 按进度算，「报过没有」也归它管） */
      if (G.Fight.tireHint()) Hud.toast({ text: '鱼开始力竭了，顺势收线！', kind: 'good' });
    }

    /* 新手引导：失焦时 dt 传 0，只保持显示不推进进度 */
    var fsnap = F.getState() === 'fight' ? G.Fight.snapshot() : null;
    G.Tutorial.update(focused ? dt : 0, F.getState(), {
      holding: F.isHolding(),
      dashing: !!(fsnap && fsnap.dashing),
    });

    /* 比试（N7 四期）：到点就结算。⚠️ **每帧问一次**，不是只在结算卡关闭时问 ——
       窗口是在「几竿之后」到点的，那时候玩家多半正闲着，等下一竿结算才冒出来会
       让人以为这一场没下文。门（idle / 非挂机 / 无面板）全在引擎里，这里不重复判。 */
    if (focused && G.Story) G.Story.settleDuel();

    /* ⚠️ 失焦时**连渲染一起停**。
       失焦 = 暂停（上面 St.tick / Weather / Goals / F.update 全都按 focused 拦住了），
       画面本来就是静止的；原来这里无条件 `S.render(dt)`，多显示器下切到别的应用，
       游戏还在按 60fps 重画水面 / 云 / 粒子（浏览器只在标签页不可见时才节流 rAF，
       「窗口失焦但页面可见」不节流）—— 纯烧电。
       回来时 focus 事件把 blurred 置回 false，下一帧照常渲染。 */
    if (focused) S.render(dt);

    if (focused && F.getState() === 'fight') Hud.updateFight(G.Fight.snapshot());

    hudTimer += dt;
    if (focused && hudTimer > 0.4) {
      hudTimer = 0;
      Hud.syncStats();
      /* 比试那枚倒计时芯片：每 0.4 秒问一次引擎要数据（没有进行中的比试 ⇒ null ⇒ 收起） */
      if (G.Story) Hud.setDuel(G.Story.duelInfo());
    }

    G.Platform.sys.raf(loop);
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

  /* 启动时机也走平台层：Web 端是 DOMContentLoaded，小程序端是直接调 ——
     业务代码里不再出现 document.readyState / addEventListener（第 ㊱ 节盯）。 */
  G.Platform.sys.onReady(safeBoot);
})();
