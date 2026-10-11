/* =========================================================
   main.js — 钓鱼人生 · Steam 版外壳（**Electron 最小验证壳**）
   =========================================================
   它只做一件事：**把游戏装进一个原生窗口**。游戏逻辑、存档结构、渲染全在 `../src/`
   —— 本目录**一个字节都不许改游戏**（`src/` 仍然零依赖，见 `docs/N8-多端与后端设计.md` §7）。

   🔴 五条口径（改之前先读，理由都在这儿）：

     ① **绝不用 `file://` 加载**。本项目实测过：`file://` 下 `fetch` 被拦
        （`G.Assets` 的图片全失败），而且**画布一旦贴上本地图片就被标记「被污染」**
        （`getImageData` 抛 `SecurityError`，`tools/` 里那些像素探针全废）。
        ⇒ 本壳用**自定义协议 `app://fishplayer/`** 加载（`protocol.handle` 从仓库根取文件）。
        这与「网页版 / 小游戏版」跑的是同一套代码路径，端差异一点都没有
        （`G.Platform.sys.isFile()` 仍是 false，`fetch` / `<img>` / `AudioContext` 照常）。

     ② 🔴 **origin 必须**稳定**（2026-10-11 改，这是本壳曾经最大的坑）**：
        `G.Platform.storage` 的载体是 `localStorage`，而 **Chromium 按 origin 分桶** ——
        原来那版用 `listen(0)` 起随机端口的 http 服务，`http://127.0.0.1:<随机端口>` 每次启动
        **都是一个新 origin** ⇒ 每次开窗都是**空档**，「重启之后进度还在」根本不成立，
        而且**不报错**。实据：用户机器上的 `%APPDATA%\FishPlayer\Local Storage\leveldb`
        里躺着 **5 个不同端口的 origin、5 份互不相干的账号存档**（每开一次壳就多一份）。
        ⇒ 现在固定成 `app://fishplayer/`：origin 恒定 = `app://fishplayer`，与端口彻底无关。
        ⚠️ 这条**不是**「顺手优化」：判据要能亲手验（`--selfcheck` **同一 `--user-data-dir`
        连跑两趟，第二趟的 `saveKey` 必须与第一趟相同、`playTime` 必须更大** —— 换新 origin
        就会变成新账号，两个数一起变）。

     ③ **协议处理器不许逃出仓库根**：请求路径要 `decodeURIComponent` → `normalize` →
        前缀检查（自定义协议这版同样要挡 —— 「一个能读任意文件的处理器」是白送的攻击面）。

     ④ **存档落在用户目录**：Electron 默认把 `localStorage`（= `G.Platform.storage` 的载体）
        与缓存放在 `app.getPath('userData')`（Windows = `%APPDATA%\<应用名>`）
        ⇒ 配合口径 ② 的固定 origin，**重启之后进度真的还在**（本壳显式固定了应用名）。

   🧪 **自检模式**（`npm run check`，本轮的验收手段）：
      隐藏窗口真跑一遍 → 探针（模块挂上没 / 画布真画了没 / 画布被污染没 / 不是 `file://` /
      存档载体是不是 localStorage / localStorage 里至少写过一个键 / 照存档键能不能读出非空 JSON /
      AudioContext 能不能起来）→ 截图 → 打印一行 JSON → 用**退出码**表态。
      ⚠️ `executeJavaScript(code, true)` 的第二个参数是 **userGesture** —— 不给它，
         浏览器策略不许凭空建 `AudioContext`（探针会把「策略拦住了」误判成「音频坏了」）。
      ⚠️ **探针采的每个字段要么在 `judge()` 里被判、要么在 `DIAG_ONLY` 里带理由豁免**
         （`verify §32-n` 守）：只采集不判 = 面板在说谎，「看着有这一项」其实没人看。
      2026-10-11（第 46 轮）补的三条存档判据：此前只判「拿得到版本号」，而那条**不可能失败**
      （`state.js` 的 `load()` 无条件 `d.v = SAVE_V`）⇒ 存档落到内存（重启即丢）照样全绿，
      而 README 第 4 条判据写着「存档落在用户目录、重启之后进度还在」—— 广告与实现不一致。
      补上判据的当场就逮到口径 ② 那个真 bug（上面那 5 个 origin）。
   ========================================================= */
'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');            /* 仓库根 = index.html 所在处 */
const SELFCHECK = process.argv.indexOf('--selfcheck') >= 0;
const shotArg = process.argv.filter(a => a.indexOf('--shot=') === 0)[0];
const SHOT = shotArg ? shotArg.slice(7) : path.join(ROOT, '_tmp', 'shell-check.png');

/* 🔴 口径 ② 的落地：**固定 origin**。`app://fishplayer` 与端口无关 ⇒ localStorage 的分桶
   每次启动都是同一个 ⇒ 进度才留得住。`standard: true` 给它一个真 origin（`localStorage`
   的前提），`secure: true` 让它算安全上下文，`supportFetchAPI` 给 `G.Platform` 的
   `fetch`（音频 / 联网能力）用。
   ⚠️ `registerSchemesAsPrivileged` **必须在 app ready 之前**调用 —— 挪到 `run()` 里会静默失效。 */
const SCHEME = 'app';
const APP_ORIGIN = SCHEME + '://fishplayer';
const START_URL = APP_ORIGIN + '/index.html';
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------- 从仓库根取文件的协议处理器（零依赖：node 自带的 fs） ----------------
   与原来那版 http 静态服务**同一条口径 ③**：路径要 decodeURIComponent → normalize →
   前缀检查，逃不出 ROOT。返回一个 `Response`（Electron 44 的 protocol.handle 形态）。 */
function installHandler() {
  protocol.handle(SCHEME, function (req) {
    let p;
    try { p = decodeURIComponent(new URL(req.url).pathname); }
    catch (e) { return new Response('bad path', { status: 400 }); }
    if (p === '/' || p === '') p = '/index.html';
    /* ③ 逃不出仓库根：normalize 之后必须仍以 ROOT 开头（`..` / 绝对路径都挡住） */
    const abs = path.normalize(path.join(ROOT, p));
    if (abs.indexOf(ROOT + path.sep) !== 0 && abs !== ROOT) {
      return new Response('forbidden', { status: 403 });
    }
    return fs.promises.readFile(abs).then(function (buf) {
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' },
      });
    }).catch(function () { return new Response('not found', { status: 404 }); });
  });
}

/* ---------------- 页面内探针（返回**纯数据**，判据在 node 侧） ---------------- */
const PROBE = `(function () {
  var out = {};
  var cv = document.querySelector('#scene');
  out.ready = document.readyState;
  out.title = document.title;
  out.hasG = !!window.G;
  out.version = (window.G && G.CONFIG) ? G.CONFIG.version : null;
  out.origin = location.origin;
  out.isFile = (window.G && G.Platform && G.Platform.sys && G.Platform.sys.isFile)
    ? !!G.Platform.sys.isFile() : null;
  out.storageKind = (window.G && G.Platform && G.Platform.storage && G.Platform.storage.kind)
    ? G.Platform.storage.kind() : null;
  out.lsKeys = Object.keys(window.localStorage).length;
  out.saveV = (window.G && G.State) ? G.State.get().v : null;
  /* 存档**真的落进 localStorage**了吗（不是只活在内存里）：直接照存档键读一次原始文本。
     ⚠️ 必须读**原始串**而不是 G.State.get() —— 后者在内存里永远是好的，
        写盘静默失败（配额满 / 载体退化成 memory）时它一点异样都没有。
     ⚠️ 这段在 PROBE 模板串里：注释里**不许出现反引号**，否则模板串当场被截断。 */
  out.saveKey = (window.G && G.State && G.State.saveKey) ? G.State.saveKey() : null;
  /* 跨重启的**证据字段**：同一个 origin 连跑两趟，第二趟读到的 playTime 必须比第一趟大
     （新 origin ⇒ 新账号 ⇒ 又回到 0.0x）。「单趟判不了」，所以它只进 DIAG_ONLY。 */
  out.playTime = (window.G && G.State) ? G.State.get().playTime : null;
  out.saveRawLen = -1; out.saveRawParses = false;
  try {
    var raw = window.localStorage.getItem(out.saveKey);
    if (typeof raw === 'string') {
      out.saveRawLen = raw.length;
      out.saveRawParses = (raw.charAt(0) === '{' && raw.charAt(raw.length - 1) === '}');
    }
  } catch (e) { out.saveRawLen = -2; out.saveRawParses = false; }
  out.ua = navigator.userAgent.indexOf('Electron') >= 0 ? 'electron' : navigator.userAgent.slice(0, 40);
  out.canvas = cv ? (cv.width + 'x' + cv.height) : null;
  out.canvasPx = -1; out.tainted = null; out.pixelErr = '';
  if (cv) {
    try {
      /* 读像素 = 证明画布**没被标记为「被污染」**（file:// 下这一步会抛 SecurityError） */
      var d = cv.getContext('2d').getImageData(Math.floor(cv.width * 0.15), Math.floor(cv.height * 0.35), 48, 48).data;
      var n = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      out.canvasPx = n; out.tainted = false;
    } catch (e) { out.tainted = true; out.pixelErr = String((e && e.message) || e); }
  }
  /* 音效：这里**带 userGesture** 执行（见文件头 🧪），所以「起来了」是真的起来了 */
  out.audioCtor = !!(window.AudioContext || window.webkitAudioContext);
  out.audioState = null; out.audioErr = '';
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { var c = new AC(); out.audioState = c.state; try { c.close(); } catch (e2) {} }
  } catch (e) { out.audioErr = String((e && e.message) || e); }
  return out;
})()`;

/* 探针字段的分工（`verify §32-m(b)` 按这张表双向判）：
     · 判据字段 —— 必须出现在 `judge()` 里（以 `p.<字段>` 的形式被读）；
     · 下面这张表 = **纯诊断字段**（只打印进那行 JSON，给人看，不参与退出码），
       每一条都得写清「为什么不需要判」；**表里多一个不存在的字段也会报红**（清了就得删）。 */
const DIAG_ONLY = {
  title:   '只用来确认加载的是本游戏（标题漂了不影响能不能玩）',
  version: '游戏版本号，跟外壳无关（漂了由主仓自己的门禁管）',
  origin:  '只打进错误文案里帮人定位（判据看的是 isFile）',
  ua:      '确认跑在 Electron 里，属环境信息',
  canvas:  '画布尺寸随窗口变（判据看的是有没有画上像素）',
  playTime:'累计游玩秒数 —— 跨重启的证据靠**两趟比对**（第二趟必须更大），单趟判不了',
  pixelErr:'只在 tainted 为真时进错误文案',
  audioErr:'只在 AudioContext 起不来时进错误文案',
};
function judge(p) {
  const bad = [];
  if (!p.hasG) bad.push('游戏模块没挂上（window.G 不存在）');
  if (p.ready !== 'complete') bad.push('文档还没加载完（' + p.ready + '）');
  if (p.isFile !== false) bad.push('不是 http 源（isFile=' + p.isFile + '，origin=' + p.origin + '）');
  if (p.tainted !== false) bad.push('画布被标记为「被污染」（' + (p.pixelErr || 'unknown') + '）');
  if (!(p.canvasPx > 0)) bad.push('画布上一个像素都没画（canvasPx=' + p.canvasPx + '）');
  /* ⑤ 存档三条（2026-10-11 第 46 轮补）：README 的第 4 条判据写着「存档落在用户目录、
     重启之后进度还在」，而此前**只**判了「拿得到版本号」—— 保存档版本号那句
     **不可能失败**（`state.js` 在 `load()` 里无条件 `d.v = SAVE_V`）⇒ 三条空判据。
     补的三条各管一件真能坏的事：载体退化 / 一个键都没写 / 存档串没真落进 localStorage。 */
  if (p.storageKind !== 'localStorage') bad.push('存档载体不是 localStorage（storageKind='
    + p.storageKind + '）：进度只活在这一进程里，关掉窗口就没了');
  if (!(p.lsKeys > 0)) bad.push('localStorage 里一个键都没有（lsKeys=' + p.lsKeys + '）');
  if (!(p.saveRawLen > 0)) bad.push('存档键 `' + p.saveKey + '` 在 localStorage 里读不出内容（saveRawLen='
    + p.saveRawLen + '）：这一次开窗没真写盘 ⇒ 重启之后进度会丢');
  else if (!p.saveRawParses) bad.push('存档键 `' + p.saveKey + '` 的内容不像一份 JSON 存档'
    + '（saveRawLen=' + p.saveRawLen + '，首尾不是 `{` / `}`）');
  if (!p.saveV) bad.push('拿不到存档版本号（G.State.get().v）');
  if (p.audioCtor && p.audioState !== 'running') bad.push('AudioContext 起不来（state=' + p.audioState + ' ' + p.audioErr + '）');
  return bad;
}

function waitForGame(win, ms) {
  const t0 = Date.now();
  return new Promise(function (resolve) {
    (function tick() {
      win.webContents.executeJavaScript("!!(window.G && window.G.State && document.readyState === 'complete')")
        .then(function (ok) {
          if (ok) return resolve(true);
          if (Date.now() - t0 > ms) return resolve(false);
          setTimeout(tick, 200);
        })
        .catch(function () { if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 200); });
    })();
  });
}

async function run() {
  installHandler();
  console.log('[shell] 已注册 ' + APP_ORIGIN + '/（自定义协议：origin 固定，存档分桶不随端口变）');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !SELFCHECK,                       /* 自检时不弹窗，免得抢用户的焦点 */
    backgroundColor: '#0b1c2c',
    autoHideMenuBar: true,
    title: '钓鱼人生',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (!SELFCHECK) win.maximize();

  try {
    await win.loadURL(START_URL);
  } catch (e) {
    console.error('[shell] 加载失败：' + ((e && e.message) || e));
    app.exit(1);
    return;
  }

  if (!SELFCHECK) return;                    /* 正常模式：窗口留着，人自己玩 */

  const okLoad = await waitForGame(win, 15000);
  await new Promise(function (r) { setTimeout(r, 1500); });   /* 给首帧与素材一点时间 */

  let p = null, bad = [];
  try {
    p = await win.webContents.executeJavaScript(PROBE, true);  /* true = userGesture */
    bad = judge(p);
  } catch (e) { bad = ['探针本身抛了：' + ((e && e.message) || e)]; }
  if (!okLoad) bad.push('15 秒内没等到游戏就绪');

  if (p) {
    await new Promise(function (r) { setTimeout(r, 400); });
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      fs.writeFileSync(SHOT, img.toPNG());
      console.log('[shell] 截图：' + SHOT);
    } catch (e) { bad.push('截图失败：' + ((e && e.message) || e)); }
  }

  console.log('[shell] 用户数据目录（存档就在这里）：' + app.getPath('userData'));
  console.log('SELFCHECK ' + JSON.stringify({ ok: bad.length === 0, bad: bad, probe: p }));
  win.destroy();
  app.exit(bad.length === 0 ? 0 : 1);
}

/* setName 要在 `app.whenReady()` 之前：它决定 `userData` 路径（= 存档落哪） */
app.setName('FishPlayer');
app.whenReady().then(run);
app.on('window-all-closed', function () { app.quit(); });
