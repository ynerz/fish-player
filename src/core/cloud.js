/* =========================================================
   cloud.js  —  云存档通道（N8 ③ 的第一刀 · 2026-10-11）
   =========================================================
   用户口径（2026-10-10）：**数据本地优先**；后端形态 = 自建 BaaS 一套；
   离线必须照常可玩。N8 设计文档写明：「有没有云端存档」由**平台层**回答，
   业务侧**不判断端**。

   所以这里只做三件事，一件都不多做：
     ① `status()`  —— 界面拿它显示一行「云存档：…」（**唯一判据**在平台层）；
     ② `push()`    —— 把本机存档**尽力**往云端推一次（本地优先）；
     ③ 离线**静默降级** —— 没有云端能力时立刻 resolve（**不 reject**），
        不弹窗、不报错、**不改动本机存档**（离线可玩是硬口径）。

   🔴 为什么 `push()` 离线时要 resolve 而不是 reject：
     本项目 `main.js` 订阅了 `Platform.sys.onRejection()`（未处理的 Promise 拒绝会 toast +
     记进 G.Track）。如果这里 reject，玩家每次点「同步」都会看到一条「出错了」——
     而那是**预期内的离线**，不是错误。
   ⚠️ 本轮**没有**真后端：`G.Platform.net.base()` 返回 null ⇒ `available()` 恒 false
     ⇒ 界面显示「本机存档」、`push()` 静默跳过。协议部分（上传 / 下载 / 二选一合并、
     乐观锁 `rev`）**等 BaaS 就绪再写**，别在这里先写一套猜的（写了也没人能验）。
*/
window.G = window.G || {};

(function () {
  /* 最近一次推送的结果（**只在内存里**，不落存档）——
     「云端状态」不该污染本机档：存档结构变更会连带 32-h / GDD 三处同步，
     而它的生命周期本来就只该是「这一次会话」。 */
  var last = null;

  function api() { return (G.Platform && G.Platform.net) || null; }
  function nowMs() { return Date.now(); }

  /* 界面唯一入口：这一台机器 + 这个端到底有没有云端可用。
     平台层拿不到能力组也走「离线」——**兜底不抛**（规范 §9.3）。 */
  function status() {
    var n = api();
    if (!n) {
      return { mode: 'offline', label: '本机存档', detail: '平台层没有网络能力组', base: null, last: last };
    }
    if (!n.available()) {
      return {
        mode: 'offline',
        label: '本机存档',
        detail: n.base() ? '云端不可达' : '未配置云端地址',
        base: n.base(),
        last: last,
      };
    }
    return { mode: 'online', label: '云端已连接', detail: n.base(), base: n.base(), last: last };
  }

  /* 本机存档原文。⚠️ 键走 `St.saveKey()`（每个账号一份档），不自己拼 `CFG.saveKey` —— 
     拼了就变成「同一件事写两遍」，加账号之后这里会静默推错档。 */
  function localText() {
    try {
      if (!G.State || !G.State.saveKey) return null;
      return G.Platform.storage.get(G.State.saveKey());
    } catch (e) { return null; }
  }

  /* 推一次本机存档。**永远 resolve**（见文件头）。 */
  function push() {
    var n = api();
    if (!n || !n.available()) {
      last = { ok: false, off: true, ts: nowMs(), err: '离线（本机存档不受影响）' };
      return Promise.resolve({ ok: false, off: true });
    }
    var text = localText();
    if (!text) {
      last = { ok: false, off: false, ts: nowMs(), err: '本机还没有存档可推' };
      return Promise.resolve({ ok: false, off: false, err: 'empty' });
    }
    return n.request('/save', { method: 'POST', body: { v: G.State.SAVE_V, text: text } })
      .then(function (r) {
        last = { ok: true, off: false, ts: nowMs(), err: '', status: r.status };
        return { ok: true, off: false, status: r.status };
      }, function (e) {
        var off = !!(e && e.off);
        last = { ok: false, off: off, ts: nowMs(), err: (e && e.message) || String(e) };
        return { ok: false, off: off, err: last.err };
      });
  }

  G.Cloud = { status: status, push: push };
})();
