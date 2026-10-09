/* =========================================================
   devtools.js  —  开发者面板（不参与正式玩法）
   =========================================================
   开启方式：网址后面加 ?dev  或  #dev
     例：http://127.0.0.1:8765/?dev
   也可以在浏览器控制台直接用：
     G.Cheat.unlockAll()      解锁全部钓场
     G.Cheat.fillBook()       填满图鉴（每个鱼种各 1 条）
     G.Cheat.fillColors()     填满所有颜色组合
     G.Cheat.addCoin(1e6)     加金币
     G.Cheat.clearSave()      清档
   ========================================================= */
window.G = window.G || {};

G.Cheat = (function () {
  var U = G.U, St = G.State;

  function unlockAll() {
    var s = St.get();
    G.FIELDS.forEach(function (f) { s.unlocked[f.id] = true; });
    St.save(true); St.emit('shop');
    G.Hud.syncAll();
    return '已解锁 ' + G.FIELDS.length + ' 个钓场';
  }

  /* 填图鉴：每个鱼种各 1 条（随机重量/颜色） */
  function fillBook() {
    var s = St.get();
    G.FISH.forEach(function (f) {
      if (s.book[f.id]) return;
      var kg = G.Loot.rollKg(f);
      St.recordCatch(f, kg, G.Loot.rollColor(f.rar).key);
    });
    St.save(true);
    checkUnlocksQuiet();
    G.Hud.syncAll();
    return '图鉴已填满：' + Object.keys(s.book).length + ' 种';
  }

  /* 填满所有「品种 × 颜色」组合 */
  function fillColors() {
    /* ⚠️ 图鉴条目的结构（n / maxKg / colors / first）由 state.js 的 recordCatch 负责建，
       这里**不要自己拼一份** —— 抄一遍 schema 等于多一个会悄悄漂移的定义，
       而且「条目缺 colors」（老档 / 被改过的档）时会直接抛异常。
       查已有颜色前先确认 colors 存在，缺了就当没有，交给 recordCatch 补。 */
    G.FISH.forEach(function (f) {
      G.CONFIG.colorMorphs.forEach(function (cm) {
        var e = St.bookEntry(f.id);
        if (e && e.colors && e.colors[cm.key]) return;   // 这个颜色已经登记过了
        St.recordCatch(f, G.Loot.rollKg(f), cm.key);
      });
    });
    St.save(true);
    checkUnlocksQuiet();
    G.Hud.syncAll();
    return '颜色已填满：' + St.colorProgress().got + ' / ' + St.colorProgress().total;
  }

  function checkUnlocksQuiet() {
    var news = St.checkUnlocks();
    if (news.length && G.Hud && G.Hud.toast) {
      news.forEach(function (f) { G.Hud.toast({ text: '解锁：' + f.name, kind: 'good' }); });
    }
  }

  function addCoin(n) {
    St.addCoin(n || 100000);
    G.Hud.syncCoin(true);
    return '金币 = ' + St.get().coin;
  }

  function setPlayTime(hours) {
    St.get().playTime = Math.max(St.get().playTime, (hours || 0) * 3600);
    St.save(true); G.Hud.syncStats();
    return '游玩时长 = ' + (hours || 0) + ' h';
  }

  function clearSave() {
    /* `St.reset()` 自己会 `emit('reset')`，main.js 负责重载页面 —— 这里别再加一次
       （以前两处都调 → 双重重载，控制台里是 ERR_ABORTED）。 */
    St.reset();
  }

  /* ---------------- 长线目标（B5） ---------------- */
  /* 把三条任务的「当天基准」倒推成 当前值 − 目标值，
     进度条刚好满格、文案显示 8/8 → 立刻变成「已完成可领取」。
     比伪造各种统计计数靠谱，也不依赖具体任务类型。 */
  function finishQuests() {
    if (!G.Goals) return '无目标系统';
    var d = St.get().daily;
    if (!d) return '没有每日任务';
    d.q.forEach(function (q) {
      var t = null;
      G.QUEST_TPL.forEach(function (x) { if (x.id === q.tpl) t = x; });
      if (!t || !G.Goals.metrics[t.metric]) return;
      d.base[t.metric] = G.Goals.metrics[t.metric](St.get(), q.key, d) - q.need;
      q.seen = false;
    });
    St.save(true);
    G.Goals.check(null);
    G.Hud.syncGoalBadge();
    return '每日任务已标记完成';
  }

  /* 解锁全部装饰（含限定装饰）——用来给文档出「满装饰钓场」截图 */
  function allDecors() {
    G.DECORS.forEach(function (d) {
      if (St.get().decors.indexOf(d.id) < 0) St.get().decors.push(d.id);
    });
    St.save(true);
    G.Scene.setDecor(St.get().decors);
    return '装饰已解锁 ' + St.get().decors.length + ' / ' + G.DECORS.length + ' 件';
  }

  function addEco(n) {
    St.get().eco = Math.max(0, (St.get().eco || 0) + (n || 100));
    St.save(true);
    return '生态值 = ' + St.get().eco;
  }

  function addMedals(n) {
    St.get().medals = Math.max(0, (St.get().medals || 0) + (n || 10));
    St.save(true);
    if (G.Goals) G.Goals.check(null);
    return '纪念币 = ' + St.get().medals;
  }

  /* ---------------- 错误日志（E4 空壳的查看入口） ---------------- */
  function dumpTrack() {
    if (!G.Track) return '无 Track 模块';
    return G.Track.dump();
  }
  function trackCount() {
    if (!G.Track) return '无 Track 模块';
    /* 环冲是落盘的：刷新后接回来的条数要标出来，否则会以为是本次会话新报的 */
    var prev = G.Track.restored ? G.Track.restored() : 0;
    return '日志 ' + G.Track.count() + ' 条（上限 ' +
      ((G.CONFIG.track && G.CONFIG.track.buffer) || '?') + '）' +
      (prev ? '，其中 ' + prev + ' 条来自上次会话' : '');
  }
  function copyTrack() {
    if (!G.Track) return '无 Track 模块';
    var text = G.Track.dump();
    /* 剪贴板是平台能力（开发者面板不进正式包，但同一条规矩照走 —— 免得
       「只在 devtools 里直连浏览器 API」变成下次移植时的漏网之鱼） */
    G.Platform.clipboard.write(text).then(function (okCopy) {
      if (!okCopy) { try { console.log(text); } catch (e) {} }
    });
    return '日志已复制（' + G.Track.count() + ' 条，失败则打到控制台）';
  }

  /* ---------------- 面板 ---------------- */
  var BTNS = [
    ['解锁全部钓场', function () { return unlockAll(); }],
    ['填满图鉴（品种）', function () { return fillBook(); }],
    ['填满全部颜色', function () { return fillColors(); }],
    ['一键全填', function () { unlockAll(); fillBook(); return fillColors(); }],
    ['+10 万金币', function () { return addCoin(100000); }],
    ['时长 +1000h', function () { return setPlayTime(1000); }],
    ['完成每日任务', function () { return finishQuests(); }],
    ['+10 纪念币', function () { return addMedals(10); }],
    ['+100 生态值', function () { return addEco(100); }],
    ['解锁全部装饰', function () { return allDecors(); }],
    ['日志条数', function () { return trackCount(); }],
    /* 反作弊（N2）的观察入口。本模块**只做 L1 标记**（不拦 / 不封 / 不改游戏数据），
       所以这里也只能「看」和「清标记」—— 没有「封禁」这类按钮，是有意的。
       它同时是 `G.Integrity.stats/clear` 的消费方（项目删过没有消费方的导出）。 */
    ['完整性标记', function () {
      if (!G.Integrity) return '未加载 G.Integrity';
      return G.Integrity.stats();
    }],
    ['清空完整性标记', function () {
      if (!G.Integrity) return '未加载 G.Integrity';
      var n = G.Integrity.clear();
      St.save(true);
      return '已清 ' + n + ' 条标记（游戏数据一条未动）';
    }],
    /* 素材家底。它是 `G.Assets.mode()` 的**唯一消费方** ——
       项目删过没有消费方的 `isWeb`，所以「加能力必须同时有读它的地方」。
       用处很具体：客户机 / 双击打开时卡面不出来，先看这一行是 inline 还是 external。 */
    ['素材家底', function () {
      if (!G.Assets) return '未加载 G.Assets';
      var u = G.Assets.used();
      return '模式 ' + G.Assets.mode() + '｜已加载 ' + u.ok + '｜失败 ' + u.fail +
             '｜缓存 ' + u.cached + '｜目录 assets/cards/';
    }],
    ['导出日志', function () { return copyTrack(); }],
    ['清空日志', function () { G.Track && G.Track.clear(); return '已清空（含磁盘）'; }],
    ['造一个错误', function () { try { null.x = 1; } catch (e) { G.Track.error('devtools 自测', e); } return '已记录 1 条'; }],
    ['清档重开', function () { clearSave(); return 'reloading'; }],
  ];

  function mount() {
    /* DOM 一律走 U.$ / U.el（同 ㊱ 节的字面量口径：裸 document.* 只许留在平台层与 util.js） */
    if (U.$('#devBar')) return;
    var bar = U.el('div', 'dev-bar collapsed');
    bar.id = 'devBar';                     // 默认收起：十几颗按钮全展开会遮住画面底部
    var log = U.el('span', 'dev-log', 'DEV');
    /* 展开 / 收起。收起状态下只剩「工具」这一颗按钮，不再挡场景 */
    var toggle = U.el('button', 'dev-btn dev-toggle');
    function setCollapsed(v) {
      bar.classList.toggle('collapsed', v);
      toggle.textContent = v ? '工具 ▸' : '工具 ▾';
    }
    setCollapsed(true);
    toggle.onclick = function () { setCollapsed(!bar.classList.contains('collapsed')); };
    bar.appendChild(toggle);
    BTNS.forEach(function (b) {
      var btn = U.el('button', 'dev-btn', b[0]);
      if (b[0] === '清档重开') btn.classList.add('danger');
      btn.onclick = function () {
        var r = b[1]();
        log.textContent = r;
        setTimeout(function () { log.textContent = 'DEV'; }, 3000);
      };
      bar.appendChild(btn);
    });
    bar.appendChild(log);
    U.$('body').appendChild(bar);
    console.log('[devtools] 开发者面板已挂载（默认收起）。控制台可用 G.Cheat.*');
  }

  function boot() {
    var q = location.search || '', h = location.hash || '';
    if (/[?&]dev\b/.test(q) || /dev/.test(h)) {
      G.Platform.sys.onReady(mount);   // 启动时机走平台层（第 ㊱ 节盯字面量位置）
    }
  }
  boot();

  return {
    unlockAll: unlockAll, fillBook: fillBook, fillColors: fillColors,
    addCoin: addCoin, setPlayTime: setPlayTime, clearSave: clearSave,
    finishQuests: finishQuests, addMedals: addMedals, addEco: addEco, allDecors: allDecors,
    dumpTrack: dumpTrack, trackCount: trackCount,
    mount: mount,
  };
})();
