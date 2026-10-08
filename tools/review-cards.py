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
    <span class="stat">快捷键：1=合格　2=重出　点图放大</span>
  </div>
  <div class="stat" style="margin-top:4px">图片若显示不出来：请用「项目根目录起 http 服务」的方式打开本页（<code>python -m http.server 8765</code> → <code>127.0.0.1:8765/docs/卡片评审.html</code>）。</div>
</header>
<div class="grid" id="grid"></div>

<div id="lb"><img alt=""><div class="lb-tip">点任意处关闭（Esc 也可以）</div></div>

<dialog id="dlg">
  <h2>重出清单（**按单档**给）</h2>
  <p>下面每条命令都是可以直接跑的。五档**是独立文生图**（2026-10-07 起，曾走图生图已弃用），
     所以**可以只重出其中一张**；母版重出会顺带刷新它的 <code>-normal</code>（原色档就是母版抠图）。</p>
  <textarea id="out" readonly></textarea>
  <p id="cmds"></p>
  <div class="acts"><button id="cp">复制</button><button id="close">关闭</button></div>
</dialog>

<script>
var DATA = __DATA__;
/* v2：状态从「一条鱼一个结论」改成「一条鱼 × **每一档**一个结论」。
   换 key 是为了不把新旧两种结构混在同一个键里。 */
var KEY = 'fishcard-review-v2';
var OLD_KEY = 'fishcard-review-v1';
var state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
/* 迁移：老状态是 `{id:'ok'|'bad'}`（整条鱼一个结论）→ 展开到它的每一档，
   以前审过的结论不白丢。 */
try {
  var older = JSON.parse(localStorage.getItem(OLD_KEY) || '{}');
  var byId = {};
  DATA.forEach(function (d) { byId[d.id] = d; });
  Object.keys(older).forEach(function (id) {
    if (!older[id] || !byId[id]) return;
    state[id] = state[id] || {};
    byId[id].slots.forEach(function (s) { if (!state[id][s.k]) state[id][s.k] = older[id]; });
  });
} catch (e) { /* 老状态坏了不影响使用 */ }
var filter = 'all';

function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
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
    var h = '<img src="../assets/cards/' + d.id + '.png" loading="lazy">';
    h += '<div class="slots">';
    d.slots.forEach(function (s) {
      var v = verdict(d, s.k);
      h += '<div class="slot' + (v ? ' ' + v : '') + '">' +
           '<img src="../assets/cards/' + s.file + '" loading="lazy">' +
           '<div class="sl-label">' + s.label + '</div>' +
           '<div class="sl-acts">' +
             '<button class="b-ok' + (v === 'ok' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="ok">合格</button>' +
             '<button class="b-bad' + (v === 'bad' ? ' on' : '') + '" data-id="' + d.id +
               '" data-k="' + s.k + '" data-v="bad">重出</button>' +
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
  save(); paintCard(id); updateStats();
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

document.getElementById('close').onclick = function () { document.getElementById('dlg').close(); };
document.getElementById('cp').onclick = function () {
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "卡片评审.html"))
    ap.add_argument("--only", default="", help="只列这些 id（逗号分隔）")
    args = ap.parse_args()

    only = set(x.strip() for x in args.only.split(",") if x.strip()) if args.only else None
    rows = build_rows(only)
    for r in rows:
        r["rarCn"] = RAR_CN[min(3, r["rar"])]
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    html = TEMPLATE.replace("__DATA__", data)
    io.open(args.out, "w", encoding="utf-8", newline="\n").write(html)
    print("评审台已写出：%s" % args.out)
    print("  卡片 %d 张（已出图的鱼）；形态描述与拉丁名一并嵌入" % len(rows))


if __name__ == "__main__":
    main()
