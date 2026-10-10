/* =========================================================
   main.js — 钓鱼人生 · Steam 版外壳（**Electron 最小验证壳**）
   =========================================================
   它只做一件事：**把游戏装进一个原生窗口**。游戏逻辑、存档结构、渲染全在 `../src/`
   —— 本目录**一个字节都不许改游戏**（`src/` 仍然零依赖，见 `docs/N8-多端与后端设计.md` §7）。

   🔴 四条口径（改之前先读，理由都在这儿）：

     ① **绝不用 `file://` 加载**。本项目实测过：`file://` 下 `fetch` 被拦
        （`G.Assets` 的图片全失败），而且**画布一旦贴上本地图片就被标记「被污染」**
        （`getImageData` 抛 `SecurityError`，`tools/` 里那些像素探针全废）。
        ⇒ 本壳自己起一个**只监听 127.0.0.1** 的静态服务（随机端口），走 `http://` 加载。
        这与「网页版 / 小游戏版」跑的是同一套代码路径，端差异一点都没有。

     ② **只监听回环**：`listen(0, '127.0.0.1')` ⇒ 不对外暴露、不弹防火墙。
        端口随机（`listen(0)` 让系统给）⇒ 不占用户端口、不会与本地别的服务撞车。

     ③ **静态服务不许逃出仓库根**：请求路径要 `decodeURIComponent` → `normalize` →
        前缀检查。虽然只回环，但「一个能读任意文件的本地服务」是白送的攻击面。

     ④ **存档落在用户目录**：Electron 默认把 `localStorage`（= `G.Platform.storage` 的载体）
        与缓存放在 `app.getPath('userData')`（Windows = `%APPDATA%\<应用名>`）
        ⇒ **重启之后进度还在**，不需要写任何额外代码（本壳只是显式固定了应用名）。

   🧪 **自检模式**（`npm run check`，本轮的验收手段）：
      隐藏窗口真跑一遍 → 探针（模块挂上没 / 画布真画了没 / 画布被污染没 / 是不是 http 源 /
      存档版本号 / AudioContext 能不能起来）→ 截图 → 打印一行 JSON → 用**退出码**表态。
      ⚠️ `executeJavaScript(code, true)` 的第二个参数是 **userGesture** —— 不给它，
         浏览器策略不许凭空建 `AudioContext`（探针会把「策略拦住了」误判成「音频坏了」）。
   ========================================================= */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');            /* 仓库根 = index.html 所在处 */
const SELFCHECK = process.argv.indexOf('--selfcheck') >= 0;
const shotArg = process.argv.filter(a => a.indexOf('--shot=') === 0)[0];
const SHOT = shotArg ? shotArg.slice(7) : path.join(ROOT, '_tmp', 'shell-check.png');

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

/* ---------------- 只回环的静态服务（零依赖：node 自带的 http + fs） ---------------- */
function startServer() {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      let p;
      try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
      catch (e) { res.writeHead(400); res.end('bad path'); return; }
      if (p === '/' || p === '') p = '/index.html';
      /* ③ 逃不出仓库根：normalize 之后必须仍以 ROOT 开头（`..` / 绝对路径都挡住） */
      const abs = path.normalize(path.join(ROOT, p));
      if (abs.indexOf(ROOT + path.sep) !== 0 && abs !== ROOT) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      fs.readFile(abs, function (err, buf) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); });
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

function judge(p) {
  const bad = [];
  if (!p.hasG) bad.push('游戏模块没挂上（window.G 不存在）');
  if (p.ready !== 'complete') bad.push('文档还没加载完（' + p.ready + '）');
  if (p.isFile !== false) bad.push('不是 http 源（isFile=' + p.isFile + '，origin=' + p.origin + '）');
  if (p.tainted !== false) bad.push('画布被标记为「被污染」（' + (p.pixelErr || 'unknown') + '）');
  if (!(p.canvasPx > 0)) bad.push('画布上一个像素都没画（canvasPx=' + p.canvasPx + '）');
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
  const started = await startServer();
  console.log('[shell] 静态服务已起：' + 'http://127.0.0.1:' + started.port + '/（只监听回环）');

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
    await win.loadURL('http://127.0.0.1:' + started.port + '/index.html');
  } catch (e) {
    console.error('[shell] 加载失败：' + ((e && e.message) || e));
    started.server.close();
    app.exit(1);
    return;
  }

  if (!SELFCHECK) {
    win.on('closed', function () { started.server.close(); });
    return;                                  /* 正常模式：窗口留着，人自己玩 */
  }

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
  started.server.close();
  win.destroy();
  app.exit(bad.length === 0 ? 0 : 1);
}

/* setName 要在 `app.whenReady()` 之前：它决定 `userData` 路径（= 存档落哪） */
app.setName('FishPlayer');
app.whenReady().then(run);
app.on('window-all-closed', function () { app.quit(); });
