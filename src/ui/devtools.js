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
    var s = St.get();
    G.FISH.forEach(function (f) {
      var e = s.book[f.id];
      if (!e) {
        e = s.book[f.id] = { n: 0, maxKg: 0, colors: {}, first: Date.now() };
      }
      G.CONFIG.colorMorphs.forEach(function (cm) {
        if (e.colors[cm.key]) return;
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
    St.reset();
    location.reload();
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

  function addMedals(n) {
    St.get().medals = Math.max(0, (St.get().medals || 0) + (n || 10));
    St.save(true);
    if (G.Goals) G.Goals.check(null);
    return '纪念币 = ' + St.get().medals;
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
    ['清档重开', function () { clearSave(); return 'reloading'; }],
  ];

  function mount() {
    if (document.getElementById('devBar')) return;
    var bar = document.createElement('div');
    bar.id = 'devBar';
    bar.className = 'dev-bar';
    var log = document.createElement('span');
    log.className = 'dev-log';
    log.textContent = 'DEV';
    BTNS.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'dev-btn';
      btn.textContent = b[0];
      if (b[0] === '清档重开') btn.classList.add('danger');
      btn.onclick = function () {
        var r = b[1]();
        log.textContent = r;
        setTimeout(function () { log.textContent = 'DEV'; }, 3000);
      };
      bar.appendChild(btn);
    });
    bar.appendChild(log);
    document.body.appendChild(bar);
    console.log('[devtools] 开发者面板已挂载。控制台可用 G.Cheat.*');
  }

  function boot() {
    var q = location.search || '', h = location.hash || '';
    if (/[?&]dev\b/.test(q) || /dev/.test(h)) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
      else mount();
    }
  }
  boot();

  return {
    unlockAll: unlockAll, fillBook: fillBook, fillColors: fillColors,
    addCoin: addCoin, setPlayTime: setPlayTime, clearSave: clearSave,
    mount: mount,
  };
})();
