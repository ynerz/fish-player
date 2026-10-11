# shell/ — 钓鱼人生 · Steam 版外壳（Electron 最小验证壳）

> **这一步只验证「能不能把游戏装进一个原生窗口」**，不做上架、不接 Steamworks、不碰云存档。
> 口径与验收写在这里，别处不复制：设计正文 = `docs/N8-多端与后端设计.md` §7。

## 为什么必须要有它

Steam **不接受网页 / 浏览器游戏**，必须有原生桌面可执行文件（Windows `.exe` 是底线）。
游戏本体仍然是 `../index.html`（双击能跑），外壳只是**把它装进 `BrowserWindow`**。

## 硬边界（改这个目录之前先读）

| 规矩 | 为什么 |
|---|---|
| **`../src/` 一个字节都不许改** | 外壳是外壳、游戏是游戏；`src/` 仍然**零构建 / 零依赖**（`verify ㊱` 守） |
| **依赖只许出现在本目录**（`package.json` 在这里） | 与 `tools/` 用 Python 是同一个道理：**工具链可以有依赖，游戏不能有** |
| **绝不用 `file://` 加载** | 实测：`file://` 下 `fetch` 被拦、画布贴上本地图后被标记「被污染」（`getImageData` 抛 `SecurityError`）⇒ 本壳用**自定义协议 `app://fishplayer/`**（`protocol.handle` 从仓库根取文件） |
| 🔴 **页面 origin 必须固定** | `localStorage` 按 **origin** 分桶，而原来自起**随机端口**的 http 服务 ⇒ 每次启动都是新 origin = **空档**（见下） |
| 页面拿不到 node（`contextIsolation: true` / `nodeIntegration: false`） | 「一套核心 + 一层 `G.Platform`」不许被外壳悄悄打穿；将来 Steamworks 也要**经 IPC 暴露**成 `Platform` 的一组能力 |

## 跑法

```bash
cd shell
npm install          # 只有这一步会下载 Electron（≈100MB+），其余零依赖
npm start            # 正常玩：全屏窗口
npm run check        # 自检：隐藏窗口真跑一遍 + 探针 + 截图 + 一行 JSON + 退出码
```

- ⚠️ **本仓库的自动化环境里 `ELECTRON_RUN_AS_NODE=1` 是被预设的**（见 `TRAPS.md`）——
  带着它跑 `electron`，`electron.exe` 会**当普通 node 执行**（`require('electron')` 只给出一个路径字符串、
  `app` 是 undefined），表现成「壳一启动就崩」，很容易误判成代码写错。
  ⇒ 在这台机器上验证用：`unset ELECTRON_RUN_AS_NODE && ./node_modules/.bin/electron . --selfcheck`
  （`npx electron` 也行，但先 `unset`）。
  🔴 **别用 `env -u ELECTRON_RUN_AS_NODE …` 那种写法**（2026-10-11 实测）：在本机的 Git Bash /
  自动化 shell 里它会**把子进程输出整段吞掉、退出码仍是 0，并且自检根本没真跑**
  （判据：`../_tmp/shell-check.png` 的 mtime 一动不动）—— 「跑成功、没输出」看起来一模一样，
  属于本项目天天在抓的「不报错但静默失效」。`unset` 之后同一台机器上一切正常。
- 存档位置（Windows）：`%APPDATA%\FishPlayer`（= `app.getPath('userData')`；
  `localStorage` 就落在这儿）。页面走 `app://fishplayer/index.html` ⇒ origin 固定，
  **重启之后进度还在**。自检会把实际路径打出来。
- 🔴 **口径 ②（2026-10-11 修的真 bug）**：原来是「自起一个随机端口的本地 http 服务」——
  听着很稳（不占端口、不弹防火墙），但 `http://127.0.0.1:<随机端口>` **每次启动都是一个新 origin**，
  而 `localStorage` 是按 origin 分桶的 ⇒ **每次开窗都是空档**，而且**不报错**。
  实据：用户机器上 `%APPDATA%\FishPlayer\Local Storage\leveldb` 里躺着 **5 个不同端口的 origin、
  5 份互不相干的账号存档**（开一次壳多一份）。现在固定成 `app://fishplayer`，与端口彻底无关。
  ⚠️ 这类坏法**只能靠「连跑两趟比对」发现**，单趟怎么跑都是绿的（见下面的验收）。
- 自检截图默认写 `../_tmp/shell-check.png`（`_tmp/` 是 gitignore 的）；可用 `--shot=<路径>` 改。

## 自检的判据（＝验收口径）

**机器项**（`judge()` 逐条判，任何一条不过 ⇒ **退出码 1**；⚠️ 探针采的每个字段要么在这儿被判、
要么在 `main.js` 的 `DIAG_ONLY` 里带理由豁免 —— `verify §32-n` 守这条，防「采了却没人看」）：

| # | 判据 | 怎么算通过 |
|---|---|---|
| 1 | **能启动、内容完整** | 15 秒内等到 `window.G && G.State && document.readyState === 'complete'`，且 `judge()` 看到 `hasG === true`、`ready === 'complete'` |
| 2 | **画面正常** | `#scene` 画布上**读得到像素**（`canvasPx > 0`）且 `tainted === false` —— 这一条同时证明「素材真加载上了（`app://` 处理器通）且画布没被污染」（`isFile === false` 单独判一次） |
| 3 | **音效能起来** | 带 `userGesture` 执行时 `AudioContext.state === 'running'`（**听**是人工项，见下） |
| 4 | **存档真落在 localStorage** | 三条：`storageKind === 'localStorage'`（载体没退化成内存）＋ `lsKeys > 0` ＋ 照**存档键**能读出非空 JSON —— ⚠️ 存档键取 `G.State.saveKey()`（N1 之后是**按账号分档**的键），**不是** `CFG.saveKey`；⚠️ 必须读**原始串**，`G.State.get()` 在内存里永远是好的 |

⚠️ **判据 4 的边界（2026-10-11 第 46 轮补）**：机器只能证「**这一次**开窗真写进了 localStorage」。
「**重启之后进度还在**」单进程判不了 ⇒ 是人工项（下面 ④），做法**不许碰真实存档**：换一个
一次性目录跑两趟（Chromium 的 `--user-data-dir` 会传给 `app.getPath('userData')`，实测有效）：

```bash
cd shell
unset ELECTRON_RUN_AS_NODE   # 本机预设了它（见上），带着它会当普通 node 跑
./node_modules/.bin/electron . --selfcheck --user-data-dir=../_tmp/fp-check   # 第一趟：新建档
./node_modules/.bin/electron . --selfcheck --user-data-dir=../_tmp/fp-check   # 第二趟：读上一趟写的
```

两趟都必须 `"ok":true`，且 **两趟 `saveKey` 相同**、**第二趟的 `playTime` 比第一趟大**
（`playTime` 就在那行 JSON 里 —— 它是跨重启的**证据字段**：换新 origin 会变成新账号，
两个数会一起变）。实测（2026-10-11）：第一趟 `saveKey=fishplayer.save.v1.07da5f368b034c5f` /
`playTime=0.095`，第二趟同一个 `saveKey` / `playTime=0.1361` ⇒ 第二趟真的读到了第一趟的档。
⚠️ 反过来说：**这套「两趟比对」就是 origin 漂移的探测器** —— 把 origin 改回随机（反向验证 F1 组
实测过），第二趟立刻变成另一个 `saveKey`、`playTime` 掉回 0.0x。

**人工项（机器判不了，必须自己看一眼）**：① 窗口里画面是不是真的对（看 `../_tmp/shell-check.png`；
自检窗口是隐藏的、截图就是真实首帧，2026-10-11 人工看过：HUD / 场景 / 邻居 / 底栏都在）；
② 点一下画面能不能听到声音；③ 全屏 / 缩放正常；④ **跨重启的进度**（按上面那三行命令跑两趟）。

## 这一壳**不做**什么（下一步才做）

- ❌ 不装 Steamworks SDK、不出 `.exe`（打包用 `electron-builder` 一类，属上架准备）
- ❌ 不接云存档（云存档 = **自建 BaaS 一套**，见 `docs/N8-多端与后端设计.md` §5；**Steam Cloud 暂不接**）
- ❌ 不做自动更新 / 成就 / 覆盖层
