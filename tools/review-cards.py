# -*- coding: utf-8 -*-
"""卡片评审台：把**已出图**的鱼连同中文名并排摆出来，人工逐条判「合格 / 重出」。

为什么需要它：
  出图是无人值守跑的，**没有人在看图**。而 `check-cards.py` 只能查几何（占比 / 宽高比 /
  重心 / 背腹 / 主色），**拦不住「画的不是这个物种」** —— 实测就这么漏掉过
  D08 小龙虾（画成乌贼）、A24 章鱼（画成鱿鱼）、A29 牙鲆（比目鱼画成普通鱼）。
  几何断言永远替代不了眼睛，所以给人一个**顺手到愿意用**的评审界面。

用法：
  python tools/review-cards.py                 # 写 docs/卡片评审.html
  python tools/review-cards.py --only-pending  # 只列「没审过」的（依赖上次导出的清单）

产物：`docs/卡片评审.html`（单文件、零依赖，**双击即可打开**；也可起 http 服务看）
  · 每张卡：母版大图 + **5 个可评审单元**（母版含原色档 / 彩虹 / 白化 / 黄金 / 闪光），
    外加 id + 中文名 +（有的话）拉丁名 + 形态描述
  · **每个单元各自判**「合格 / 重出」—— 出问题的是单张图，不是整条鱼（用户口径 2026-10-08）
  · **点任意一张图放大到原图**（`#lb` 层；点任意处或 Esc 关闭）。缩略图再大也不够用：
    卡面 1152×768 而鱼只占中间一块，判「头身是不是一个色」这种细节必须能放到接近 1:1
  · 状态存在浏览器 localStorage（键 `fishcard-review-v2`），**刷新不丢**
  · 顶部进度条 + 筛选；「导出重出清单」**按档分组**给出可直接执行的命令
  · 「对照百科」按钮：新窗口搜该物种，方便和真动物比对

⚠️ 五档自 2026-10-07 起是**独立文生图**（同种子、同提示词、只差颜色句；
   曾走图生图，已弃用）⇒ **单档可以独立重出**，不必须连母版一起。
   母版重出会顺带刷新它的 `<id>-normal.png`（原色档就是母版抠图）。
"""
import argparse
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CARDS = os.path.join(ROOT, "assets", "cards")
RAR_CN = ["普通", "稀有", "史诗", "传说"]
MORPH_CN = [("normal", "原色"), ("bright", "彩虹色"), ("albino", "白化"),
            ("golden", "黄金"), ("shiny", "闪光")]


def load_fish():
    src = io.open(os.path.join(ROOT, "src", "data", "fish.js"), encoding="utf-8").read()
    out = []
    for i, n, r, sh in re.findall(r"F\('([A-Z0-9]+)', '([^']*)', (\d), '([a-z]+)'", src):
        out.append({"id": i, "name": n, "rar": int(r), "shape": sh})
    return out


def load_traits():
    try:
        return json.load(io.open(os.path.join(ROOT, "tools", "fish-traits.json"), encoding="utf-8"))
    except Exception:
        return {}


def generated_ids():
    """有母版的鱼（`<id>.png`，排除 `<id>-<档>.png`）。"""
    ids = []
    for p in glob.glob(os.path.join(CARDS, "*.png")):
        b = os.path.basename(p)[:-4]
        if "-" in b:
            continue
        ids.append(b)
    return set(ids)


def build_rows(only_ids=None):
    traits = load_traits()
    gen = generated_ids()
    rows = []
    for f in load_fish():
        if f["id"] not in gen:
            continue
        if only_ids and f["id"] not in only_ids:
            continue
        t = traits.get(f["id"]) or {}
        morphs = [k for k, _ in MORPH_CN
                  if os.path.exists(os.path.join(CARDS, "%s-%s.png" % (f["id"], k)))]
        # 可评审单元 = **每一档单独一个**（不再「一条鱼一个结论」）。
        # ⚠️ `normal` 不是独立出图，它是母版的抠图 —— 所以并进 `master` 这个单元，
        #    不单独列（列了会逼人给同一个东西判两次，而且两次判反了也不知道听谁的）。
        #    但缩略图用的是**抠图**（`<id>-normal.png`）：那才是游戏里真正会显示的图。
        slots = []
        if os.path.exists(os.path.join(CARDS, f["id"] + ".png")):
            normal = f["id"] + "-normal.png"
            slots.append({"k": "master", "label": "母版（含原色档）",
                          "file": normal if os.path.exists(os.path.join(CARDS, normal))
                                  else f["id"] + ".png"})
        for m in morphs:
            if m == "normal":
                continue
            slots.append({"k": m, "label": dict(MORPH_CN)[m],
                          "file": "%s-%s.png" % (f["id"], m)})
        rows.append({
            "id": f["id"], "name": f["name"], "lat": (t.get("species") or "").strip(),
            "rar": f["rar"], "shape": f["shape"],
            "form": (t.get("form") or "").strip(), "fins": (t.get("fins") or "").strip(),
            "slots": slots,
        })
    rows.sort(key=lambda r: r["id"])
    return rows


TEMPLATE = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>卡片评审台 · 钓鱼人生</title>
<style>
  :root { --bg:#16171a; --card:#22242a; --line:#33363e; --fg:#e8e9ec; --dim:#9a9ea8;
          --ok:#3f9e6a; --bad:#c0503f; --accent:#5b8fd6; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:9; background:rgba(22,23,26,.96);
           border-bottom:1px solid var(--line); padding:10px 16px; }
  h1 { font-size:15px; font-weight:500; margin:0 0 6px; }
  .bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .prog { flex:1; min-width:180px; height:6px; background:#2a2d34; border-radius:3px; overflow:hidden; }
  .prog i { display:block; height:100%; background:var(--accent); width:0; }
  button { background:#2a2d34; color:var(--fg); border:1px solid var(--line);
           border-radius:6px; padding:5px 12px; font:inherit; cursor:pointer; }
  button:hover { border-color:#5a5f6b; }
  button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .stat { color:var(--dim); }
  .stat b { color:var(--fg); font-weight:500; }
  /* 存储不可用时的横幅（沙箱 iframe / 隐私模式）。默认不显示 ——
     但它必须存在且醒目：**不告诉用户，他刷新一下结果全没了还不知道**。 */
  #warn { display:none; margin-top:6px; padding:6px 10px; border-radius:6px; font-size:12px;
          background:rgba(192,80,63,.18); border:1px solid var(--bad); color:#f2dcd7; }
  #warn.on { display:block; }
  .grid { display:grid; gap:14px; padding:16px;
          grid-template-columns:repeat(auto-fill,minmax(430px,1fr)); }
  .c { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .c.ok  { border-color:var(--ok); }
  .c.bad { border-color:var(--bad); }
  .c > img { width:100%; display:block; background:#2b2b2e; aspect-ratio:3/2; object-fit:contain;
             cursor:zoom-in; }
  /* 可评审单元：**每张都要能看清**。
     原来缩略图写死 76px（用户口径 2026-10-08「其他版本的图太小了，不清晰」）——
     卡面原图是 1152×768、鱼只占中间一部分，76px 下连鳍都数不清。
     现在改成网格：一格里一张，缩略图占满格子宽（≈200px，是原来的 2.6 倍）；
     **点任意一张还能放大到原图**（见 #lb）。 */
  .slots { display:grid; grid-template-columns:repeat(auto-fit,minmax(185px,1fr));
           gap:8px; padding:8px; border-top:1px solid var(--line); }
  .slot { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#1d1f24; }
  .slot.ok  { border-color:var(--ok);  background:rgba(63,158,106,.14); }
  .slot.bad { border-color:var(--bad); background:rgba(192,80,63,.16); }
  .slot img { width:100%; display:block; background:#2b2b2e; aspect-ratio:3/2; object-fit:contain;
              cursor:zoom-in; }
  .sl-label { font-size:12px; padding:5px 8px 0; }
  .sl-acts { display:flex; gap:6px; padding:6px 8px 8px; }
  .sl-acts button { flex:1; min-width:0; padding:4px 0; }

  /* 放大层：评审要靠它看清细节，所以放到「能到 1:1」为止（1152×768 在 1440 屏上基本是原尺寸） */
  #lb { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.9); display:none;
        align-items:center; justify-content:center; cursor:zoom-out; }
  #lb.on { display:flex; }
  #lb img { max-width:97vw; max-height:90vh; object-fit:contain; background:#2b2b2e; }
  #lb .lb-tip { position:absolute; left:0; right:0; bottom:14px; text-align:center;
                color:#c9cdd5; font-size:12px; }
  .m { padding:8px 10px 10px; }
  .nm { font-size:15px; font-weight:500; }
  .nm span { color:var(--dim); font-weight:400; font-size:12px; margin-left:6px; }
  .lat { color:var(--dim); font-size:12px; font-style:italic; min-height:18px; }
  details { margin:6px 0 0; }
  summary { color:var(--dim); font-size:12px; cursor:pointer; }
  details p { color:var(--dim); font-size:12px; margin:4px 0 0; }
  .acts { display:flex; gap:8px; margin-top:10px; }
  .acts button { flex:1; }
  .acts .b-ok.on  { background:var(--ok);  border-color:var(--ok);  color:#fff; }
  .acts .b-bad.on { background:var(--bad); border-color:var(--bad); color:#fff; }
  .acts .b-go { flex:0 0 auto; }
  .empty { padding:40px 16px; color:var(--dim); }
  dialog { background:var(--card); color:var(--fg); border:1px solid var(--line);
           border-radius:10px; max-width:640px; width:92%; }
  dialog textarea { width:100%; height:190px; background:#16171a; color:var(--fg);
                    border:1px solid var(--line); border-radius:6px; padding:8px;
                    font:12px/1.5 Consolas,monospace; }
  dialog h2 { font-size:14px; font-weight:500; margin:0 0 8px; }
  dialog p { color:var(--dim); font-size:12px; margin:8px 0; }
  code { background:#16171a; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>卡片评审台 —— 逐条看「画的到底是不是这个物种」</h1>
  <div class="bar">
    <span class="stat">进度 <b id="s-done">0</b>/<b id="s-all">0</b></span>
    <span class="prog"><i id="s-bar"></i></span>
    <span class="stat">合格 <b id="s-ok">0</b> · 重出 <b id="s-bad">0</b></span>
    <button id="f-all" class="on">全部</button>
    <button id="f-pend">未审</button>
    <button id="f-bad">重出</button>
    <button id="exp">导出重出清单</button>
    <button id="rst">清空</button>
    <span class="stat">快捷键：1=合格　2=重出　·　点图放大　·　<span id="runState">检查本地运行器…</span></span>
  </div>
  <div id="warn"></div>
  <div class="stat" style="margin-top:4px">图片若显示不出来：请用「项目根目录起 http 服务」的方式打开本页（<code>python -m http.server 8765</code> → <code>127.0.0.1:8765/docs/卡片评审.html</code>）。</div>
</header>
<div class="grid" id="grid"></div>

<div id="lb"><img alt=""><div class="lb-tip">点任意处关闭（Esc 也可以）</div></div>

<dialog id="dlg">
  <h2 id="dlgTitle">重出清单（**按单档**给）</h2>
  <p id="dlgTip">五档**是独立文生图**（2026-10-07 起，曾走图生图已弃用），所以**可以只重出其中一张**；
     母版重出会顺带刷新它的 <code>-normal</code>（原色档就是母版抠图）。</p>
  <textarea id="out" readonly></textarea>
  <p id="cmds"></p>
  <div class="acts">
    <button id="cp">复制</button>
    <button id="run" disabled>开始重出</button>
    <button id="close">关闭</button>
  </div>
</dialog>

<script>
var DATA = __DATA__;
/* `--serve` 打开本页时这里会被换成真 token；静态打开时是空串（运行器也不在）。 */
var TOKEN = '__TOKEN__';
/* 重出之后设成 `?t=…` —— 否则浏览器会把旧图从缓存里拿出来，看着像「没重出」 */
var CACHE_BUST = '';
/* 档位中文名的**唯一来源是 Python 侧的 slot.label**，这里只做索引，不另抄一份 */
var SLOT_LABEL = {};
DATA.forEach(function (d) { d.slots.forEach(function (s) { SLOT_LABEL[s.k] = s.label; }); });
/* v2：状态从「一条鱼一个结论」改成「一条鱼 × **每一档**一个结论」。
   换 key 是为了不把新旧两种结构混在同一个键里。 */
var KEY = 'fishcard-review-v2';
var OLD_KEY = 'fishcard-review-v1';
var state = {};
var memOnly = false;    // localStorage 用不了时退回「只在本页存」（见 save 的注释）

function readStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
try { state = JSON.parse(readStore(KEY) || '{}'); } catch (e) { state = {}; }
/* 迁移：老状态是 `{id:'ok'|'bad'}`（整条鱼一个结论）→ 展开到它的每一档，
   以前审过的结论不白丢。 */
try {
  var older = JSON.parse(readStore(OLD_KEY) || '{}');
  var byId = {};
  DATA.forEach(function (d) { byId[d.id] = d; });
  Object.keys(older).forEach(function (id) {
    if (!older[id] || !byId[id]) return;
    state[id] = state[id] || {};
    byId[id].slots.forEach(function (s) { if (!state[id][s.k]) state[id][s.k] = older[id]; });
  });
} catch (e) { /* 老状态坏了不影响使用 */ }
var filter = 'all';

/* 🔴 `save()` **绝不许抛**。
   踩过（2026-10-08 用户报「我点了重出后咋没用」）：预览面板把本页放在**沙箱 iframe** 里，
   那里 `localStorage.setItem` 会抛 SecurityError；而 save() 原来排在
   `paintCard()/updateStats()` **之前** —— 异常把整个点击处理中断，
   于是「点了完全没反应」，连按钮高亮都没有，控制台只有一条 SecurityError。
   现在两条防线：
     ① 存不进去就退回「只在本页有效」，**并且显式告诉用户**（否则刷新一下全没了还不知道）；
     ② 调用点一律**先把结果画出来、最后才落盘**（见点击处理）。 */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    if (!memOnly) { memOnly = true; showMemWarning(); }
    return false;
  }
}

function showMemWarning() {
  var w = document.getElementById('warn');
  if (!w) return;
  w.className = 'on';
  w.innerHTML = '⚠️ <b>本页的存储不可用</b>（浏览器沙箱 / 隐私模式 / 无痕）：'
    + '你判的结果<b>只在本页有效，刷新就没了</b>。'
    + '请随时点「导出重出清单」把结果复制走（那个功能不依赖存储）。';
}
function verdict(d, k) { return ((state[d.id] || {})[k]) || ''; }
function verdicts(d) { return d.slots.map(function (s) { return verdict(d, s.k); }); }
function isDone(d) { return verdicts(d).every(function (v) { return !!v; }); }
function isBad(d) { return verdicts(d).indexOf('bad') >= 0; }

function render() {
  var g = document.getElementById('grid');
  g.innerHTML = '';
  var shown = 0;
  DATA.forEach(function (d) {
    if (filter === 'pending' && isDone(d)) return;
    if (filter === 'bad' && !isBad(d)) return;
    shown++;
    var el = document.createElement('div');
    el.className = 'c' + (isDone(d) ? ' ok' : '') + (isBad(d) ? ' bad' : '');
    el.setAttribute('data-id', d.id);
    var h = '<img src="../assets/cards/' + d.id + '.png' + CACHE_BUST + '" loading="lazy">';
    h += '<div class="slots">';
    d.slots.forEach(function (s) {
      var v = verdict(d, s.k);
      h += '<div class="slot' + (v ? ' ' + v : '') + '">' +
           '<img src="../assets/cards/' + s.file + CACHE_BUST + '" loading="lazy">' +
           '<div class="sl-label">' + s.label + '</div>' +
           '<div class="sl-acts">' +
             '<button class="b-ok' + (v === 'ok' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="ok" title="记下这张没问题">合格</button>' +
             '<button class="b-bad' + (v === 'bad' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="bad" title="记下这张要重出（**不会立刻重出** —— 之后点「导出重出清单」拿命令去跑）">重出</button>' +
           '</div></div>';
    });
    h += '</div>';
    h += '<div class="m"><div class="nm">' + d.name +
         '<span>' + d.id + ' · ' + d.rarCn + ' · ' + d.shape + '</span></div>' +
         '<div class="lat">' + (d.lat || '') + '</div>';
    if (d.form || d.fins) {
      h += '<details><summary>形态描述（提示词里用的）</summary><p>' +
           (d.form || '') + (d.fins ? '<br>' + d.fins : '') + '</p></details>';
    }
    h += '<div class="acts">' +
         '<button class="b-go" data-go="' + d.name + '">对照百科</button>' +
         '</div></div>';
    el.innerHTML = h;
    g.appendChild(el);
  });
  if (!shown) {
    var e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '这个筛选下没有卡片。';
    g.appendChild(e);
  }
  updateStats();
}

function updateStats() {
  var done = 0, ok = 0, bad = 0, all = 0;
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      all++;
      var v = verdict(d, s.k);
      if (!v) return;
      done++;
      if (v === 'ok') ok++; else bad++;
    });
  });
  document.getElementById('s-done').textContent = done;
  document.getElementById('s-all').textContent = all;
  document.getElementById('s-ok').textContent = ok;
  document.getElementById('s-bad').textContent = bad;
  document.getElementById('s-bar').style.width = (all ? done * 100 / all : 0) + '%';
}

/* 只改这一张卡 —— **不要整页重绘**：122 张图重新建元素会全部重新解码、屏幕闪一下，
   而且滚动位置也会跳。筛选/清空才走 render()。 */
function paintCard(id) {
  var el = document.querySelector('.c[data-id="' + id + '"]');
  if (!el) return;
  var d = null;
  DATA.forEach(function (x) { if (x.id === id) d = x; });
  if (!d) return;
  el.className = 'c' + (isDone(d) ? ' ok' : '') + (isBad(d) ? ' bad' : '');
  var boxes = el.querySelectorAll('.slot');
  d.slots.forEach(function (s, i) {
    var v = verdict(d, s.k);
    if (!boxes[i]) return;
    boxes[i].className = 'slot' + (v ? ' ' + v : '');
    boxes[i].querySelector('.b-ok').classList.toggle('on', v === 'ok');
    boxes[i].querySelector('.b-bad').classList.toggle('on', v === 'bad');
  });
}

/* 点任意一张图 → 放大到原图。
   缩略图再大也不够用（用户口径 2026-10-08「其他版本的图太小了，不清晰」）：
   卡面是 1152×768、鱼只占中间一块，评审要判断「头身是不是一个色」这种细节，
   必须能放到接近 1:1。放大层铺满视口，点任意处或 Esc 关闭。 */
var lb = document.getElementById('lb'), lbImg = lb.querySelector('img');
function zoom(src) { lbImg.src = src; lb.classList.add('on'); }
function unzoom() { lb.classList.remove('on'); lbImg.removeAttribute('src'); }
lb.addEventListener('click', unzoom);

document.getElementById('grid').addEventListener('click', function (ev) {
  var b = ev.target.closest('button');
  if (!b) {
    var im = ev.target.closest('img');
    if (im) zoom(im.src);
    return;
  }
  if (b.dataset.go) {
    window.open('https://www.bing.com/search?q=' + encodeURIComponent(b.dataset.go + ' 鱼 形态特征'), '_blank');
    return;
  }
  var id = b.dataset.id, k = b.dataset.k, v = b.dataset.v;
  if (!id || !k) return;
  state[id] = state[id] || {};
  state[id][k] = (state[id][k] === v) ? '' : v;
  if (!state[id][k]) delete state[id][k];
  /* 顺序很重要：**先把结果画出来，最后才落盘** —— 落盘失败也不能让「点了像没反应」。 */
  paintCard(id); updateStats(); save();
});

['all', 'pend', 'bad'].forEach(function (k) {
  var idmap = { all: 'f-all', pend: 'f-pend', bad: 'f-bad' };
  document.getElementById(idmap[k]).onclick = function () {
    filter = k === 'all' ? 'all' : (k === 'pend' ? 'pending' : 'bad');
    ['f-all', 'f-pend', 'f-bad'].forEach(function (x) {
      document.getElementById(x).classList.toggle('on', x === idmap[k]);
    });
    render();
  };
});

document.getElementById('rst').onclick = function () {
  if (confirm('清空全部评审记录？')) { state = {}; save(); render(); }
};

document.getElementById('exp').onclick = function () {
  var bySlot = {}, okN = 0, pendN = 0, allN = 0, order = [];
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      if (order.indexOf(s.k) < 0) order.push(s.k);
      allN++;
      var v = verdict(d, s.k);
      if (v === 'ok') okN++;
      if (!v) pendN++;
      if (v === 'bad') { (bySlot[s.k] = bySlot[s.k] || []).push(d.id); }
    });
  });
  var keys = order.filter(function (k) { return bySlot[k] && bySlot[k].length; });
  var total = keys.reduce(function (a, k) { return a + bySlot[k].length; }, 0);
  var L = ['# 重出清单：' + total + ' 张（**按单档给**，可以直接执行）',
           '# 五档是独立文生图（2026-10-07 起；曾走图生图，已弃用）⇒ 可以只重出其中一张。',
           '# 母版那一行会顺带刷新 <id>-normal.png（原色档就是母版抠图）；',
           '# 五档单张重出**不动**别的档。'];
  L.push('');
  keys.forEach(function (k) {
    var ids = bySlot[k].slice().sort();
    var label = k === 'master' ? '母版（含原色档）'
              : ({ bright: '彩虹色', albino: '白化', golden: '黄金', shiny: '闪光' }[k] || k);
    L.push('# ' + label + '（' + ids.length + ' 张）');
    L.push('python tools/gen-art.py --list ' + ids.join(',') +
           (k === 'master' ? '' : ' --only-morph ' + k));
    L.push('');
  });
  L.push('# 未判 ' + pendN + ' / 已合格 ' + okN + '（共 ' + allN + ' 个可评审单元）');
  L.push('#');
  L.push('# 另一种更省事的做法：若你只想「把口径改过的卡全部重出」，不用逐条审 ——');
  L.push('#   python tools/gen-art.py --stale');
  L.push('# 它拿当前生成器**现算**提示词去和 manifest 比，直接列出过期的那些（判据不会过期）。');
  document.getElementById('out').value = total ? L.join('\\n') : '（还没有标记为「重出」的）';
  document.getElementById('cmds').innerHTML = total
    ? '把上面 <code>python tools/gen-art.py ⋯</code> 那些行原样跑一遍即可。'
    : '';
  document.getElementById('dlg').showModal();
};

/* =========================================================
   本地运行器：让「重出」真的能跑（用户口径 2026-10-08）
   =========================================================
   页面是静态 HTML，浏览器里**跑不了 python**。要直接跑，得用
   `python tools/review-cards.py --serve` 打开本页 —— 那个小服务提供 `/api/regen`。
   静态打开（file:// 或普通 http.server）时探不到运行器 ⇒ 按钮置灰，只能用「复制」。 */
var RUNNER = false;

function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'X-Token': TOKEN }, opt.headers || {});
  return fetch(path, opt);
}

function runnerNote(txt) { document.getElementById('runState').textContent = txt; }

api('/api/ping').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
  RUNNER = !!(j && j.ok);
  var b = document.getElementById('run');
  b.disabled = !RUNNER;
  b.textContent = RUNNER ? '开始重出' : '开始重出（未连接运行器）';
  runnerNote(RUNNER
    ? '本地运行器：已连接 —— 可以直接「开始重出」'
    : '本地运行器：未连接 —— 只能用「复制」把命令拿去别处跑');
}).catch(function () {
  document.getElementById('run').textContent = '开始重出（未连接运行器）';
  runnerNote('本地运行器：未连接（静态打开时就是这样）');
});

/* 把当前标成「重出」的收成 [{morph, ids}] 交给运行器 */
function collectGroups() {
  var by = {}, order = [];
  DATA.forEach(function (d) {
    d.slots.forEach(function (s) {
      if (order.indexOf(s.k) < 0) order.push(s.k);
      if (verdict(d, s.k) === 'bad') { (by[s.k] = by[s.k] || []).push(d.id); }
    });
  });
  return order.filter(function (k) { return by[k] && by[k].length; })
              .map(function (k) { return { morph: k, ids: by[k].slice().sort() }; });
}

function pollJob() {
  api('/api/job').then(function (r) { return r.json(); }).then(function (j) {
    var out = document.getElementById('out');
    out.value = (j.log || []).join('\\n');
    out.scrollTop = out.scrollHeight;
    document.getElementById('cmds').innerHTML = (j.running ? '⏳ 正在重出　' : '✅ 跑完　')
      + j.done + ' / ' + j.total + ' 张　（成功 ' + j.ok + ' · 失败 ' + j.fail + '）'
      + (j.cur ? '　当前：' + j.cur : '');
    if (j.running) setTimeout(pollJob, 1200); else onJobDone(j);
  }).catch(function () { setTimeout(pollJob, 2000); });
}

/* 跑完：把图刷成新的（绕开缓存）+ 清掉这些档的结论（新图要重新审） */
function onJobDone(j) {
  if (!j.ok) return;
  CACHE_BUST = '?t=' + Date.now();
  DATA.forEach(function (d) {
    if (!state[d.id]) return;
    d.slots.forEach(function (s) { if (state[d.id][s.k] === 'bad') delete state[d.id][s.k]; });
    if (!Object.keys(state[d.id]).length) delete state[d.id];
  });
  render(); save();
  document.getElementById('dlgTitle').textContent = '重出完成';
  document.getElementById('dlgTip').innerHTML = '跑完了 ' + j.ok + ' 张（失败 ' + j.fail + '）。'
    + '页面的图已刷新、结论已清空 —— **请重新审这几张**。'
    + '旧图在 <code>assets/cards/_superseded/</code> 下按本轮时间戳归档。';
}

document.getElementById('run').onclick = function () {
  var groups = collectGroups();
  var total = groups.reduce(function (a, g) { return a + g.ids.length; }, 0);
  if (!total) { alert('还没有把任何一张标成「重出」——先在卡片上点「重出」再来。'); return; }
  var tip = groups.map(function (g) {
    return '· ' + (SLOT_LABEL[g.morph] || g.morph) + '：' + g.ids.join(' ');
  }).join('\\n');
  if (!confirm('要重出这 ' + total + ' 张吗？\\n\\n' + tip
      + '\\n\\n每张约 50 秒；旧图**不会**被覆盖，会移进 assets/cards/_superseded/<本轮时间戳>/。\\n'
      + '跑完这些档的结论会被清掉，等你重新审。')) return;
  document.getElementById('dlgTitle').textContent = '正在重出…';
  document.getElementById('dlgTip').innerHTML = '每张约 50 秒，可以放着不管；跑完会自动刷新图片。';
  document.getElementById('out').value = '正在启动…';
  api('/api/regen', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: groups }),
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res.ok) { alert('没能开跑：' + (res.msg || '未知原因')); return; }
    pollJob();
  }).catch(function (e) { alert('连不上运行器：' + e); });
};

document.getElementById('close').onclick = function () { document.getElementById('dlg').close(); };document.getElementById('cp').onclick = function () {
  var t = document.getElementById('out');
  t.select(); document.execCommand('copy');
};

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && lb.classList.contains('on')) { unzoom(); return; }
  if (e.key === '1' || e.key === 'y') { var b = document.querySelector('.b-ok:not(.on)'); if (b) b.click(); }
  if (e.key === '2' || e.key === 'n') { var c = document.querySelector('.b-bad:not(.on)'); if (c) c.click(); }
});

DATA.forEach(function (d) { d.rarCn = d.rarCn || ''; });
render();
</script>
</body>
</html>
"""


def check_inline_js(html):
    """生成物自带语法门禁：把页内 <script> 抠出来，交给 node --check 真跑一遍。

    为什么必须有（回归 2026-10-08，用户报「咋现在卡片评审台打不开了？」）：
      `TEMPLATE` 是 Python 三引号**非 raw** 字符串，所以页内 JS 里写的 `'\\n'`
      会被 Python **提前**解释成真换行 —— 字符串字面量被截断成跨行，
      整段 `<script>` 语法失效，浏览器打开就是一片空白（且不报任何服务端错误）。
      这个坑在**写完文件、打开浏览器之前完全看不出来**，只能真 check 一遍才拦得住。
      教训：拼装 HTML 的工具，落盘前必须验一遍产物的脚本语法。
    """
    node = shutil.which("node")
    if not node:
        return          # 没有 node 就别把工具链卡死（本项目门禁本来就依赖 node）
    blocks = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    tmpdir = os.path.join(ROOT, "_tmp")
    if not os.path.isdir(tmpdir):
        os.makedirs(tmpdir)
    for i, code in enumerate(blocks):
        tmp = os.path.join(tmpdir, "inline-js-%d.js" % i)
        io.open(tmp, "w", encoding="utf-8", newline="\n").write(code)
        p = subprocess.run([node, "--check", tmp], capture_output=True, text=True)
        if p.returncode:
            lines = code.split("\n")
            m = re.search(r"inline-js-\d+\.js:(\d+)", p.stderr or "")
            ln = int(m.group(1)) if m else 0
            raise SystemExit(
                "✘ 页内脚本第 %d 段有语法错误 —— **拒绝写出**（写成空白页更糟）。\n"
                "  大概位置：第 %d 行\n     %s\n%s"
                % (i + 1, ln, (lines[ln - 1].strip() if 0 < ln <= len(lines) else "?"),
                   (p.stderr or "").strip()[:600]))
        os.remove(tmp)


def build_page(only):
    """把评审页拼出来 —— 写文件与 `--serve` 共用同一份口径。"""
    rows = build_rows(only)
    for r in rows:
        r["rarCn"] = RAR_CN[min(3, r["rar"])]
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    html = TEMPLATE.replace("__DATA__", data)
    check_inline_js(html)
    return html, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "卡片评审.html"))
    ap.add_argument("--only", default="", help="只列这些 id（逗号分隔）")
    ap.add_argument("--serve", action="store_true",
                    help="起**本地运行器**：页面上能直接「开始重出」（真的跑 gen-art.py）")
    ap.add_argument("--port", type=int, default=8770, help="--serve 的端口（只绑 127.0.0.1）")
    args = ap.parse_args()

    only = set(x.strip() for x in args.only.split(",") if x.strip()) if args.only else None

    if args.serve:
        serve(args.port, only)
        return

    html, n = build_page(only)
    io.open(args.out, "w", encoding="utf-8", newline="\n").write(html)
    print("评审台已写出：%s" % args.out)
    print("  卡片 %d 张（已出图的鱼）；形态描述与拉丁名一并嵌入" % n)
    print("  ⚠️ 静态打开**不能**在页里直接重出（浏览器跑不了 python）。")
    print("     要能直接跑：python tools/review-cards.py --serve → 开 http://127.0.0.1:8770/")


def serve(port, only):
    """本地运行器：把评审页发出去，并开一个**能真的跑重出**的口子。

    为什么需要它（用户口径 2026-10-08：「导出重出清单时，它自己能直接跑起来」）：
      评审页是静态 HTML，浏览器里**跑不了 python**。所以给一个只绑本机回环的小服务：
        GET  /            → 评审页（内存里现拼，把 token 嵌进去）
        GET  /assets/...  → 直接喂卡的图（不用再另开一个 http.server）
        GET  /api/ping    → 运行器在不在（页面据此启用「开始重出」）
        GET  /api/job     → 当前任务状态 + 日志尾部（页面轮询）
        POST /api/regen   → 真的开跑（后台线程，逐档跑 gen-art.py 子进程）

    ⚠️ 安全：**只绑 127.0.0.1**，且 `/api/regen` 要带页面内嵌的一次性 token ——
       否则本机任意网页都能往这里 POST、触发跑命令。
    ⚠️ 出图是**逐个跑子进程**（不 import 进来）：失败只是一个子进程非 0 退出，不会把服务带崩。
    """
    import http.server, socketserver, threading, uuid
    from urllib.parse import urlparse, unquote

    token = uuid.uuid4().hex[:16]
    job = {"running": False, "log": [], "cur": "", "done": 0, "total": 0, "ok": 0, "fail": 0}
    lock = threading.Lock()

    def worker(groups):
        try:
            for g in groups:
                morph = g.get("morph") or "master"
                ids = [str(x) for x in (g.get("ids") or [])]
                if not ids:
                    continue
                cmd = [sys.executable, os.path.join("tools", "gen-art.py"), "--list", ",".join(ids)]
                if morph != "master":
                    cmd += ["--only-morph", morph]
                job["cur"] = "%s ×%d" % (morph, len(ids))
                job["log"].append("$ " + " ".join(cmd))
                try:
                    p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True,
                                         errors="replace", bufsize=1)
                    for line in p.stdout:
                        job["log"].append(line.rstrip())
                        del job["log"][:-500]      # 只留尾部，别把内存吃光
                    rc = p.wait()
                except Exception as e:
                    job["log"].append("!! 起不来：%s" % e)
                    rc = -1
                (job.__setitem__("ok", job["ok"] + len(ids)) if rc == 0
                 else job.__setitem__("fail", job["fail"] + len(ids)))
                job["done"] += len(ids)
        finally:
            job["running"] = False
            job["cur"] = ""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):      # 别把每个请求都刷到控制台
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            b = body if isinstance(body, bytes) else str(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/index.html"):
                html, _n = build_page(only)
                return self._send(200, html.replace("__TOKEN__", token),
                                  "text/html; charset=utf-8")
            if path == "/api/ping":
                return self._send(200, json.dumps({"ok": True}))
            if path == "/api/job":
                return self._send(200, json.dumps(job, ensure_ascii=False))
            if path.startswith("/assets/"):
                root = os.path.abspath(os.path.join(ROOT, "assets"))
                fp = os.path.abspath(os.path.join(ROOT, path.lstrip("/")))
                if fp.startswith(root) and os.path.isfile(fp):
                    ct = "image/png" if fp.endswith(".png") else "application/octet-stream"
                    return self._send(200, open(fp, "rb").read(), ct)
            return self._send(404, "not found", "text/plain; charset=utf-8")

        def do_POST(self):
            if urlparse(self.path).path != "/api/regen":
                return self._send(404, json.dumps({"ok": False, "msg": "没有这个接口"}))
            if self.headers.get("X-Token") != token:
                return self._send(403, json.dumps({"ok": False, "msg": "token 不对"}))
            if job["running"]:
                return self._send(409, json.dumps({"ok": False, "msg": "已经有一轮在跑了"}))
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                groups = [g for g in (body.get("groups") or []) if g.get("ids")]
            except Exception as e:
                return self._send(400, json.dumps({"ok": False, "msg": "body 读不出来：%s" % e}))
            if not groups:
                return self._send(400, json.dumps({"ok": False, "msg": "没有要重出的"}))
            with lock:
                job.update({"running": True, "cur": "排队中", "log": [], "done": 0,
                            "ok": 0, "fail": 0,
                            "total": sum(len(g["ids"]) for g in groups)})
            threading.Thread(target=worker, args=(groups,), daemon=True).start()
            return self._send(200, json.dumps({"ok": True, "total": job["total"]}))

    # 开机自检：拿 `--stale` 试跑一次 gen-art.py（**不联网、不出图**），
    # 把「解释器不对 / 管线坏了」在第一次重出**之前**就告诉人。
    try:
        chk = subprocess.run([sys.executable, os.path.join("tools", "gen-art.py"), "--stale"],
                             cwd=ROOT, capture_output=True, text=True,
                             errors="replace", timeout=180)
        if chk.returncode != 0:
            print("⚠️ 自检跑不动 gen-art.py（退出码 %d）：\n%s"
                  % (chk.returncode, (chk.stderr or "")[-400:]))
            print("   重出会失败 —— 换个解释器再启动（见 docs/开发者文档.md 的工具表）。")
    except Exception as e:
        print("⚠️ 自检异常：%s" % e)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        print("评审台运行器已启动：http://127.0.0.1:%d/" % port)
        print("   · 标记「重出」后点「开始重出」就会真的跑（逐张约 50 秒）")
        print("   · 旧图不会被覆盖：移进 assets/cards/_superseded/<本轮时间戳>/")
        print("   · 只绑本机回环；Ctrl-C 退出")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已退出。")


if __name__ == "__main__":
    main()
