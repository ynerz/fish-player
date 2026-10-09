/* =========================================================================
   integrity.js —— 本地完整性检测（反作弊 · **只做 L1 标记**）
   =========================================================================
   用户口径（2026-10-09）：「反作弊（概率异常 → 封禁）」。

   🔴 **先把边界写死**（这一段是本模块存在的理由，改代码前先读）：
     1. 本项目是**纯前端单机**（零依赖 / `file://` 双击可跑），**没有服务端** ⇒
        没有权威数据源；客户端的一切玩家都能改（清 `localStorage` 即重置）。
        所以这里做**不出一丁点安全边界**，只能挡「无心之失」与「改档速通」。
     2. 因此本模块**只产出 L1 标记**：记下来，**不拦截、不封禁、不改任何游戏数据**。
        L2 软封禁 / L3 档案锁定都留着，等真实误报率数据出来再谈（见 `docs/改进待办.md` N2）。
        ⚠️ 这条不是「暂时没做」，是**刻意的**：一上来就封 = 差体验 + 误封不可逆。
        ⇒ 本模块对存档的写权限**只有 `S.integrity` 这一个键**（verify 第 ㊻ 节盯着）。
     3. 判据只认「物理不可能 / 自相矛盾 / 真·极端概率」三类，
        **绝不拿「罕见但会发生」当证据**：实测正常玩家 8 小时挂机能自然出 ~15 个闪光，
        用户最初给的「概率 < 1e-9 才算作弊」与游戏真实概率（综合闪光率 ≈ 1.9%）
        **差 5 个数量级**，照那个口径封禁 = 把活跃玩家全封了。
        ⚠️ 「真·极端概率」判据用的是观测概率的**上界**（`unionBound`），天然保守：
           **上界**都小于阈值才标记 ⇒ 数学上不可能把正常玩家标出来。

   三条判据（**纯函数**：输入只有「存档 + 证据」，不读时钟 / 不读随机数 ⇒ 可定点复现）：
     · `GAP`       物理不可能：两次钓获间隔 < 该场该档的**最短咬口**（`Loot.biteTimeMin`）
                   ——「活体改档」的现场证据，**1 分钟内刷 3 条传说**这种会当场命中
                   （传说档最短咬口 380 s，缩到 60 s 都不可能）。
     · `SAVE_*`    自相矛盾：**同一个函数里一起写的两个计数器**不许出现「不可能的方向」
                   （`Σ book.n > Σ byRar`、`max(book.maxKg) > stats.maxKg`
                   —— 两边都由 `state.js: recordCatch()` 从同一次 `kg` 一起写下，
                    而迁移只可能**丢**图鉴条目，所以「图鉴比计数器还多」严格不可能）。
                   ⚠️ 只判「**严格不可能**」的方向 —— 反向（少算）可能是迁移清理掉的，**不判**。
                   ⚠️ **有意排除**两类看着很自然、实测会误报的判据（先量后改，理由在这里：
                      · `Σ byRar > stats.catches`：离线补算按 `max(1, round(g·scale))` **逐鱼种**折算，
                        `scale > 1`（抽样上限 4000 之上）时条数会多于 `catches += n`；
                      · `stats.catches > stats.casts`：离线补算**只加 catches 不加 casts**
                        （人不在场，没有抛竿动作）⇒ 挂机一次就成立，正常玩家全中。
                     两条都在 `tools/test.js` 里用**真代码路径**（跑一次 8 小时离线补算）
                     钉成「零标记」回归。)
     · `ODDS`      真·极端概率：传说档里闪光的条数，其概率**上界**小于
                   `CFG.integrity.oddsFloor`（union bound，见 `unionBound`）—— 对付「直接改存档」
                   （现场那几次钓获是干净的，但图鉴里的比例离谱）。

   ⏸ **有意不做的一条**（写在这里，免得下次以为漏了）：`docs/改进待办.md` N2 里的第 3 类
      「统计极端（偏离该玩家自己的滚动基线 > 6σ）」—— 它要求先有「观察期基线」，
      而基线要靠这一轮先跑起来才有数据。等 L2 那一轮拿真实数据一起做，别现在硬凑。
   ========================================================================= */
window.G = window.G || {};

G.Integrity = (function () {
  var U = G.U, CFG = G.CONFIG, Loot = G.Loot;

  /* 证据环形缓冲：**只在内存**，不进存档。跨会话的「活体改档」本来就不可信；
     而存档级判据（SAVE_* / ODDS）每次审计都从存档**现算**，不需要历史。 */
  var EV = [];
  var S = null;                 // 当前存档（init 注入）。只读写它的 `integrity` 键。
  var KEY = 'integrity';        // 唯一的存档键（verify 第 ㊻ 节按 blank() 现算比对）

  function cfg() { return CFG.integrity || {}; }
  function lim() { return Math.max(1, cfg().evCap || 120); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  /* ---------------- 存档侧形状（脏档兜底：**扫到嵌套**） ---------------- */
  function bag(s) {
    if (!s || typeof s !== 'object') return null;
    var it = s[KEY];
    if (!it || typeof it !== 'object' || Array.isArray(it)) it = s[KEY] = {};
    if (!Array.isArray(it.flags)) it.flags = [];
    /* 逐条纠正：改档的人往 flags 里塞东西不能把玩家读崩
       （跟 state.js 的 book 条目一个道理：宁可少一条记录，也别让读档炸掉）。 */
    var clean = [];
    it.flags.forEach(function (f) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return;
      if (typeof f.code !== 'string' || !f.code) return;
      clean.push({ code: f.code, n: Math.max(0, Math.round(num(f.n, 0))),
                   at: Math.max(0, num(f.at, 0)), detail: typeof f.detail === 'string' ? f.detail : '' });
    });
    it.flags = clean;
    while (it.flags.length > Math.max(1, cfg().flagCap || 40)) it.flags.shift();
    it.runs = Math.max(0, Math.round(num(it.runs, 0)));
    return it;
  }

  /* ---------------- 判据用的公共量（全部现算，不写死） ---------------- */
  /* 「闪光」= 颜色档里的**最后一档**（配置按 原色 → 彩虹 → 白化 → 黄金 → 闪光 排列，
     这个顺序由 verify 第 ③ 节盯着）。不在代码里写 `'shiny'` 字面量 ——
     颜色键一改名，写死的地方会静默变成「查不到」。 */
  function topMorph() { return CFG.colorMorphs[CFG.colorMorphs.length - 1]; }
  function topRar() { return CFG.rarity.length - 1; }
  /* 最快的鱼饵（咬口时间乘数最小）—— 算「最短可能咬口」时用它，宁可把下界算小一些 */
  function minBaitSpeed() {
    var m = 1;
    (G.BAITS || []).forEach(function (b) { var s = num(b.speed, 1); if (s > 0 && s < m) m = s; });
    return m;
  }

  /* `(m^k) / k!` —— 「n 次机会里出现 k 次小概率事件」尾概率的**上界**（union bound）。
     用 log 空间算，免得 `m^k` 先溢出成 Infinity（那会让判据静默失效）。
     `m ≤ 0` ⇒ 0（不可能发生）。结果只会 ≥ 真值 ⇒ 判据只会漏报，不会误报。 */
  function unionBound(m, k) {
    if (!(m > 0) || !(k > 0)) return m > 0 ? 1 : 0;
    var v = k * Math.log(m), i;
    for (i = 2; i <= k; i++) v -= Math.log(i);
    if (v > 700) return Infinity;          // 溢出成 Infinity：肯定不小于阈值，等于不标记
    return v < -700 ? 0 : Math.exp(v);
  }

  /* ---------------- 判据① 物理不可能（吃证据） ---------------- */
  function jGap(ev, margin) {
    var hits = 0, at = 0, detail = '';
    for (var i = 1; i < ev.length; i++) {
      var a = ev[i - 1], b = ev[i];
      if (!a || !b || !isFinite(a.t) || !isFinite(b.t)) continue;
      var dt = (b.t - a.t) / 1000;
      if (!(dt >= 0)) continue;            // 时间倒流：不是本判据的事，直接跳过
      var need = Loot.biteTimeMin(b.rar, { fieldId: b.fid, bait: { speed: minBaitSpeed() } }) * margin;
      if (dt < need) {
        hits++; at = b.t;
        detail = '两竿只隔 ' + dt.toFixed(1) + ' s，而' + (CFG.rarity[b.rar] ? CFG.rarity[b.rar].name : '?')
          + '档在该钓场最短也要 ' + need.toFixed(1) + ' s';
      }
    }
    return hits ? [{ code: 'GAP', n: hits, at: at, detail: detail }] : [];
  }

  /* ---------------- 判据② 自相矛盾（吃存档） ----------------
     ⚠️ 这里**只留两边都由 `state.js: recordCatch()` 一起写下的量** ——
        拿别的东西当「应当相等」会误报正常玩家（离线补算的折算口径就是这么栽的，
        见文件头「有意排除」那两条 + test.js 的真代码路径回归）。 */
  function jSave(d) {
    var st = d.stats || {}, book = d.book || {};
    var out = [];

    var brSum = 0;
    (Array.isArray(st.byRar) ? st.byRar : []).forEach(function (v) { brSum += Math.max(0, num(v, 0)); });

    var bkSum = 0, bkMaxKg = 0;
    Object.keys(book).forEach(function (id) {
      var e = book[id];
      if (!e || typeof e !== 'object' || Array.isArray(e)) return;
      bkSum += Math.max(0, num(e.n, 0));
      var kg = num(e.maxKg, 0);
      if (kg > bkMaxKg) bkMaxKg = kg;
    });
    /* 图鉴条目数与分维计数在 recordCatch 里同步 +1；迁移只可能**丢**图鉴条目
       （认不出的鱼种 id 会被清掉），所以「图鉴比计数器多」严格不可能。 */
    if (bkSum > brSum) {
      out.push({ code: 'SAVE_BOOK', n: 1, at: 0,
        detail: '图鉴条目合计 ' + bkSum + ' 条 > 分维计数合计 ' + brSum + ' 条' });
    }
    /* `stats.maxKg` 是全局最大体重，图鉴里任何一条都不该比它大（同一次 kg 一起写的）。
       容差 1e-6：两者正常档必然相等或更小。 */
    if (bkMaxKg > num(st.maxKg, 0) + 1e-6) {
      out.push({ code: 'SAVE_MAXKG', n: 1, at: 0,
        detail: '图鉴里最大 ' + bkMaxKg.toFixed(2) + 'kg > 全局记录 ' + num(st.maxKg, 0).toFixed(2) + 'kg' });
    }
    return out;
  }

  /* ---------------- 判据③ 真·极端概率（吃存档） ---------------- */
  /* 统计量：传说档钓获里有多少是**闪光**。上界取 union bound。
     ⚠️ 两个量都取「更大者 / 更大者」，方向都是**把上界放大**（=更保守）：
        · `n` 取 `max(图鉴现算的传说条数, stats.byRar[3])` —— 迁移可能清掉过图鉴条目，
          只按图鉴算会把 n 算小，从而**更**容易报红（那是误报方向）。
        · `p` 取 `colorProb(最高档, 传说)` —— 颜色概率不吃鱼饵 / 天气加成，
          而实际抽取时原色之外的档会被整体放大，所以这是个真上界。 */
  function jOdds(d) {
    var st = d.stats || {}, book = d.book || {};
    var n = Math.max(0, num(Array.isArray(st.byRar) ? st.byRar[topRar()] : 0, 0));
    var k = 0, bkSum = 0;
    Object.keys(book).forEach(function (id) {
      var f = G.FISH_ID && G.FISH_ID[id];
      if (!f || f.rar !== topRar()) return;
      var e = book[id];
      if (!e || typeof e !== 'object' || Array.isArray(e)) return;
      var cols = e.colors;
      if (!cols || typeof cols !== 'object' || Array.isArray(cols)) return;
      var tot = 0;
      Object.keys(cols).forEach(function (ck) {
        var v = Math.max(0, num(cols[ck], 0));
        tot += v;
        if (ck === topMorph().key) k += v;
      });
      bkSum += tot;
    });
    if (bkSum > n) n = bkSum;
    var minK = Math.max(2, Math.round(num(cfg().minOddsK, 4)));
    if (k < minK || n <= 0) return [];
    var ub = unionBound(n * num(Loot.colorProb(topMorph(), topRar()), 0), k);
    if (!(ub < num(cfg().oddsFloor, 1e-9))) return [];
    return [{ code: 'ODDS', n: 1, at: 0,
      detail: '传说档 ' + n + ' 条里 ' + k + ' 条闪光（概率上界 ' + ub.toExponential(2)
        + ' < ' + cfg().oddsFloor + '）' }];
  }

  /* ---------------- 对外：纯函数审计 ----------------
     `dump` = { book, stats }；`ev` = [{ t(ms), rar, fid, ck }]。
     不碰模块状态、不读时钟 / 随机数 ⇒ test.js 能构造数据定点复现，
     也让「门禁里验的」与「运行时跑的」是同一段代码。 */
  function audit(dump, ev) {
    dump = dump || {}; ev = Array.isArray(ev) ? ev : [];
    var margin = Math.min(1, Math.max(0.01, num(cfg().gapMargin, 0.98)));
    return jGap(ev, margin).concat(jSave(dump), jOdds(dump));
  }

  /* ---------------- 运行时：现场审计 + 落盘 ---------------- */
  /* 现场重算、**幂等**（同一份证据 + 同一份存档 ⇒ 同一份标记），
     所以 GAP 那种「违规对还留在缓冲里」的情况不会把计数越滚越大。 */
  function run() {
    var it = bag(S);
    if (!it) return [];
    var found = audit({ book: S.book, stats: S.stats }, EV);
    it.flags = found;
    it.runs++;
    return found;
  }

  function init(s) {
    S = s || S;
    var it = bag(S);
    if (!it) return [];
    return run();                 // 读档即审一遍：改档的人不用等钓到鱼才被记上
  }

  /* 记一条真·钓获（由 `Fishing.resolve()` 在成功路径调用）。
     只记**真玩出来的**：离线补算 / devtools 不走这条路，它们的渔获不是「玩家动作」。 */
  function note(fish, colorKey, at) {
    if (!S || !fish) return [];
    EV.push({ t: isFinite(at) ? at : Date.now(), rar: num(fish.rar, 0), fid: fish.field, ck: colorKey || '' });
    while (EV.length > lim()) EV.shift();
    return run();
  }

  function flags() { var it = bag(S); return it ? it.flags.slice() : []; }
  function count() { var it = bag(S); return it ? it.flags.length : 0; }

  /* 给开发者面板看的一句话（也是本模块导出面的消费方 —— 项目删过没有消费方的导出） */
  function stats() {
    var it = bag(S);
    if (!it) return '未接入存档';
    if (!it.flags.length) return 'L1 标记 0 条｜已审计 ' + it.runs + ' 次｜无异常';
    return 'L1 标记 ' + it.flags.length + ' 条（' + it.flags.map(function (f) {
      return f.code + '×' + f.n;
    }).join('、') + '）｜已审计 ' + it.runs + ' 次';
  }

  function clear() {
    var it = bag(S);
    if (!it) return 0;
    var had = it.flags.length;
    it.flags = [];
    EV = [];
    return had;
  }

  return {
    init: init, note: note, audit: audit,
    flags: flags, count: count, stats: stats, clear: clear,
  };
})();
