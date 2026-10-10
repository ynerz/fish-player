/* =========================================================
   tools/browser-probe.js  —  真浏览器复核（零依赖）
   =========================================================
   为什么需要它（2026-10-08 栽过）：
     「工具跑成功」与「产物能用」是两件事。`tools/review-cards.py` 拼出来的
     `docs/卡片评审.html` 因为 Python 三引号把页内 JS 的 `\n` 提前解释掉，
     整段 `<script>` 语法失效 —— **浏览器打开是一片空白，而生成工具退出码 0、
     一句错都不报**。`verify.js` 第 ㊴ 节现在能拦「语法」，但拦不住「语法对了、
     运行时抛错 / 图全裂 / 按钮点了没反应」这一类。这类只能**真打开一次**才知道。
   实现：直接用 node 22 内置的 `WebSocket` 连无头 Chromium 的 DevTools 协议，
     **不装 playwright / puppeteer**（本项目零依赖；本机也没有落地这两个包）。
   用法：
     node tools/browser-probe.js <url> [截图.png] [探针.js] [--exe <浏览器路径>] [--wait 2500]
       · 探针.js：一段**页面内求值的表达式**（可以是 `(async function(){…})()`），
         返回值会挂在结果的 `interact` 里 —— 用来点按钮 / 读 DOM / 走一遍交互。
         🔴 工具会先往页面里注入 **`__raf1()`**（等一帧的助手）：凡是「刚触发了面板渲染 /
            refresh 就立刻读 DOM」的地方，一律 `await __raf1()` 再读 ——
            同步读会**漏掉刚画上去的那一行**，而且每次漏的行还不一样（见下面那条实测）。
   例：
     node tools/browser-probe.js "file:///D:/fish%20player/docs/%E5%8D%A1%E7%89%87%E8%AF%84%E5%AE%A1.html" _tmp/a.png
     node tools/browser-probe.js http://127.0.0.1:8770/ _tmp/b.png _tmp/probe-review.js
   输出：JSON（标题 / 正文长度 / 容器与图片数量 / 破图数 / 关键元素状态 / 页面报错）
         + 一张截图；**有页面报错就以退出码 1 结束**（方便将来接进自动化）。
   ========================================================= */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--exe') opt.exe = argv[++i];
  else if (argv[i] === '--wait') opt.wait = Number(argv[++i]);
  else if (argv[i] === '--port') opt.port = Number(argv[++i]);
  else pos.push(argv[i]);
}
const url = pos[0];
const shot = pos[1] || path.join(os.tmpdir(), 'probe.png');
const probeFile = pos[2];
const waitMs = opt.wait || 2500;
const port = opt.port || 9333;

/* 找浏览器：显式 --exe > 环境变量 > 常见安装位置 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const EXE = opt.exe || CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

if (!url) {
  console.error('用法：node tools/browser-probe.js <url> [截图.png] [探针.js] [--exe 浏览器] [--wait ms]');
  process.exit(2);
}
if (!EXE) {
  console.error('没找到浏览器 —— 用 --exe 指定，或设 CHROME_PATH 环境变量。已找过：\n  ' + CANDIDATES.join('\n  '));
  process.exit(2);
}
if (probeFile && !fs.existsSync(probeFile)) {
  console.error('探针文件不存在：' + probeFile);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  /* profile 改成一次性目录（时间戳 + 随机后缀），跑完在 finally 里删掉：
     ① 同一端口连跑时不再共用 user-data-dir —— 上一次运行留下的登录态 /
        IndexedDB / Service Worker 之类的残留不会串到下一次；
     ② 临时目录不会越堆越多（以前 `wb-probe-profile-<port>` 是常驻的）。
     ⚠️ **但这不是为了绕 HTTP 缓存** —— 2026-10-09 实测（同端口连跑、
        中间改 JS、探针读全局标记）证明：`--headless=new` 下页面拿到的**就是新文件**，
        「profile 复用 ⇒ 吃到缓存里的旧 JS」这个说法**不成立**。
        那次性能数据异常的真因是 `git stash` 在**已提交**的工作区上无效
        （无改动可 stash，命令静默什么也没做），代码压根没被回退，
        于是「before」跑的也是新版本。教训：A/B 对拍前先**断言**两份代码确实不同。
     🔴 **一次性 profile 的代价（2026-10-09 补记，别踩）**：既然每次都是全新 user-data-dir，
        **`localStorage` 不可能跨次保留** —— 所以「先 `goto` 一个同源页灌存档、再 `goto` 游戏页
        读存档」那条路线（`MEMORY.md` 里推荐过的手法）**在探针上永远行不通**，
        第二次读到的必然是空白档（`coin` = 初值，不是注入值）。
        正确姿势：**在同一次页面求值里**先 `localStorage.setItem(...)` 再调 `G.State.load()`。
        别去修「`child.kill()` 没给浏览器落盘机会」—— 换了新 profile，落了盘也读不到。） */
  const profile = path.join(os.tmpdir(),
    'wb-probe-profile-' + port + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const child = spawn(EXE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disk-cache-size=1', '--media-cache-size=1',   // 无害的保险，与上面那条结论无关
    '--user-data-dir=' + profile, '--remote-debugging-port=' + port, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let list = null;
    for (let i = 0; i < 40 && !list; i++) {
      await sleep(400);
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/list');
        list = (await r.json()).filter(t => t.type === 'page');
      } catch (e) { /* 还没起来，继续等 */ }
    }
    if (!list || !list.length) throw new Error('浏览器没起来（端口 ' + port + '）—— 换个端口或先关掉占用的进程');

    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    const pend = new Map();
    let id = 0;
    const send = (method, params = {}) => new Promise((res, rej) => {
      const n = ++id;
      pend.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const events = { error: [], console: [] };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        events.error.push((d.exception || {}).description || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        events.console.push(m.params.args.map(a => a.value || a.description).join(' '));
      }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    await sleep(waitMs);

    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面内求值抛错：' + (r.exceptionDetails.text || ''));
      return r.result && r.result.value;
    };

    const out = await evalJs(`(function () {
      var body = document.body;
      var imgs = document.images || [];
      var broken = [];
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        var src = im.getAttribute('src') || '';
        /* ⚠️ 只判「已经给了 src、也确实加载完了、但 naturalWidth 还是 0」的 ——
           懒加载 / 还没赋值的占位图（比如放大层那个空 img）不算破图，
           否则每次跑都会有一条假警报，报几次就没人看了。 */
        if (src && im.complete && im.naturalWidth === 0) {
          broken.push((im.id ? '#' + im.id : 'img') + ' ← ' + src.slice(-60));
        }
      }
      return {
        url: location.href,
        title: document.title,
        bodyChars: (body.innerText || '').trim().length,
        nodeCount: body.querySelectorAll('*').length,
        scriptCount: document.scripts.length,
        imgCount: imgs.length,
        brokenImg: broken.length,
        brokenList: broken.slice(0, 5),
      };
    })()`);

    /* 🔴 探针求值**之前**先往页面里塞一个「等一帧」的助手（2026-10-11，队列：待办 2252）：
       探针最常见的坑是「刚触发渲染就同步读 DOM ⇒ 漏掉刚画上去的那一行」
       （实测：`G.Panels.open('shop')` 之后立刻 `querySelectorAll('.shop-item')`
       只拿到 12 行、唯独少了刚渲染的那一行，连跑三次还不一样；同一段逻辑 await 一帧就正常）。
       ⇒ 与其在每个探针文件里各写一遍 `new Promise(r => requestAnimationFrame(...))`，
         不如由工具注入一个：探针里 `await __raf1()` 即可（**它总是存在**，不必判空）。
       ⚠️ 名字特意起得不像业务代码（`__raf1`），免得和页面自己的全局撞名。
       ⚠️ 它只等**一帧**：渲染如果是「等数据回来再画」那种异步链，还得再等（多 await 几次）。 */
    await evalJs('window.__raf1 = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(true); }); }); }; "ok"');

    if (probeFile) out.interact = await evalJs(fs.readFileSync(probeFile, 'utf8'));

    /* 🔴 全页截图要能**失败退回**（2026-10-10）：`docs/卡片评审.html` 装上 362 张卡之后
       页面高达十几万像素，Chromium 直接回 `-32000 Page is too large.` ——
       而这一步在探针**之后**，于是「探针跑得好好的」却整条命令报错、`interact` 也拿不到。
       页会长大（鱼越多越长），工具不能跟着报废 ⇒ 全页失败就退回**视口截图**，
       并在 `shotFallback` 里写明原因（别让人以为截图本来就是这样的）。 */
    let png, shotFallback = null;
    try {
      png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    } catch (e) {
      shotFallback = String((e && e.message) || e).slice(0, 120);
      png = await send('Page.captureScreenshot', { format: 'png' });
    }
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    out.screenshot = shot;
    if (shotFallback) out.shotFallback = shotFallback;
    out.pageErrors = events.error;
    out.consoleErrors = events.console;
    ws.close();
    return out;
  } finally {
    /* ⚠️ 收尾**保持 `kill()`**（2026-10-11 重新核实过，报障 ⑨ 的陈述不成立）：
       曾经想把它改成「先 `Browser.close` 优雅退出、等进程自己结束、再兜底 kill」——
       理由写在报障 ⑨ 里（「硬杀让浏览器来不及把 localStorage 落盘」）。**实测证不出收益**：
         · 「落盘也读不到」这件事本文件的 `main()` 注释（2026-10-09）早就写明了 ——
           profile 每次都是**新建的一次性目录**，跨次保留存档根本不可能；
         · 本机对照实测（同一台机器、同一份页面，A/B 各跑两次）：
           旧写法 `kill()` ⇒ 临时 profile 目录数 34 → 34 → 34、探针进程 0 残留；
           新写法优雅关闭 ⇒ 同样 34 → 34、0 残留 ⇒ **两种收尾没有可观察差异**。
       ⇒ 不为一个证不出的收益改代码（§9.1 第 3 条「留证据」）。真要跨次保留存档，
          正确姿势是**同一次页面求值里先 `setItem` 再 `G.State.load()`**（见 `main()` 注释）。
       ⚠️ 这条**不是**「留着不管」：报障 ⑨ 已按「陈述不成立」结案（队列 §1 报障板）。 */
    child.kill();
    /* 一次性 profile 用完整删掉，别在临时目录里越堆越多。
       删不掉也无所谓（下一轮本来就用新目录），所以整段吞掉异常。 */
    try {
      await sleep(300);
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) { /* 忽略 */ }
  }
}

main().then(o => {
  console.log(JSON.stringify(o, null, 2));
  const bad = o.pageErrors.length + o.consoleErrors.length;
  console.log(bad ? `✘ 有 ${bad} 条页面报错` : '✔ 无页面报错');
  process.exit(bad ? 1 : 0);
}).catch(e => {
  console.error('探针失败：' + e.message);
  process.exit(2);
});
