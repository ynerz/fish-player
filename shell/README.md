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
| **绝不用 `file://` 加载** | 实测：`file://` 下 `fetch` 被拦、画布贴上本地图后被标记「被污染」（`getImageData` 抛 `SecurityError`）⇒ 本壳自起**只回环**的静态服务走 `http://` |
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
  ⇒ 在这台机器上验证用：`env -u ELECTRON_RUN_AS_NODE npx electron . --selfcheck`。
- 存档位置（Windows）：`%APPDATA%\FishPlayer`（= `app.getPath('userData')`；
  `localStorage` 就落在这儿 ⇒ 重启之后进度还在）。自检会把实际路径打出来。
- 自检截图默认写 `../_tmp/shell-check.png`（`_tmp/` 是 gitignore 的）；可用 `--shot=<路径>` 改。

## 自检的四条判据（＝本轮验收，全部**机器可判**）

| # | 判据 | 怎么算通过 |
|---|---|---|
| 1 | **能启动、内容完整** | 15 秒内等到 `window.G && G.State && document.readyState === 'complete'` |
| 2 | **画面正常** | `#scene` 画布上**读得到像素**（`canvasPx > 0`）且 `tainted === false` —— 这一条同时证明「不是 `file://`」 |
| 3 | **音效能起来** | 带 `userGesture` 执行时 `AudioContext.state === 'running'`（**听**是人工项，见下） |
| 4 | **存档落用户目录** | 打出 `userData` 路径；重启一次自检，`lsKeys > 0` 且存档还在 |

**人工项（机器判不了，必须自己看一眼）**：① 窗口里画面是不是真的对（看 `../_tmp/shell-check.png`）；
② 点一下画面能不能听到声音；③ 全屏 / 缩放正常。

## 这一壳**不做**什么（下一步才做）

- ❌ 不装 Steamworks SDK、不出 `.exe`（打包用 `electron-builder` 一类，属上架准备）
- ❌ 不接云存档（云存档 = **自建 BaaS 一套**，见 `docs/N8-多端与后端设计.md` §5；**Steam Cloud 暂不接**）
- ❌ 不做自动更新 / 成就 / 覆盖层
