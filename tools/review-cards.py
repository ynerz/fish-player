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
  · 每张卡：母版大图 + 五档小图 + id + 中文名 +（有的话）拉丁名 + 形态描述
  · 「合格 / 重出」两个按钮，状态存在浏览器 localStorage，**刷新不丢**
  · 顶部进度条 + 筛选；底部「导出重出清单」给出可直接执行的命令
  · 「对照百科」按钮：新窗口搜该物种，方便和真动物比对

⚠️ 重新生成时**必须连五档一起重出**（`<id>.png` + `<id>-<档>.png` 共 6 个文件）——
   只重出母版会让五档还停在旧形态上，五档是母版抠图+调色来的，形态改不了。
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
MORPH_CN = [("normal", "原色"), ("bright", "亮色"), ("albino", "白化"),
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
        rows.append({
            "id": f["id"], "name": f["name"], "lat": (t.get("species") or "").strip(),
            "rar": f["rar"], "shape": f["shape"],
            "form": (t.get("form") or "").strip(), "fins": (t.get("fins") or "").strip(),
            "morphs": morphs,
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
          grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); }
  .c { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .c.ok  { border-color:var(--ok); }
  .c.bad { border-color:var(--bad); }
  .c > img { width:100%; display:block; background:#2b2b2e; aspect-ratio:3/2; object-fit:contain; }
  .morphs { display:flex; gap:3px; padding:3px 3px 0; }
  .morphs img { width:20%; aspect-ratio:3/2; object-fit:contain; background:#2b2b2e; border-radius:3px; }
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
    <span class="stat">快捷键：1=合格　2=重出</span>
  </div>
  <div class="stat" style="margin-top:4px">图片若显示不出来：请用「项目根目录起 http 服务」的方式打开本页（<code>python -m http.server 8765</code> → <code>127.0.0.1:8765/docs/卡片评审.html</code>）。</div>
</header>
<div class="grid" id="grid"></div>

<dialog id="dlg">
  <h2>重出清单</h2>
  <p>这些 id 需要重出。<b>必须连五档一起重出</b>（共 6 个文件），只重母版的话五档还停在旧形态。</p>
  <textarea id="out" readonly></textarea>
  <p id="cmds"></p>
  <div class="acts"><button id="cp">复制</button><button id="close">关闭</button></div>
</dialog>

<script>
var DATA = __DATA__;
var KEY = 'fishcard-review-v1';
var state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
var filter = 'all';

function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

function render() {
  var g = document.getElementById('grid');
  g.innerHTML = '';
  var shown = 0;
  DATA.forEach(function (d) {
    var st = state[d.id] || '';
    if (filter === 'pending' && st) return;
    if (filter === 'bad' && st !== 'bad') return;
    shown++;
    var el = document.createElement('div');
    el.className = 'c' + (st ? ' ' + st : '');
    el.setAttribute('data-id', d.id);
    var h = '<img src="../assets/cards/' + d.id + '.png" loading="lazy">';
    if (d.morphs.length) {
      h += '<div class="morphs">';
      d.morphs.forEach(function (m) {
        h += '<img src="../assets/cards/' + d.id + '-' + m + '.png" loading="lazy" title="' + m + '">';
      });
      h += '</div>';
    }
    h += '<div class="m"><div class="nm">' + d.name +
         '<span>' + d.id + ' · ' + d.rarCn + ' · ' + d.shape + '</span></div>' +
         '<div class="lat">' + (d.lat || '') + '</div>';
    if (d.form || d.fins) {
      h += '<details><summary>形态描述（提示词里用的）</summary><p>' +
           (d.form || '') + (d.fins ? '<br>' + d.fins : '') + '</p></details>';
    }
    h += '<div class="acts">' +
         '<button class="b-ok' + (st === 'ok' ? ' on' : '') + '" data-id="' + d.id + '" data-v="ok">合格</button>' +
         '<button class="b-bad' + (st === 'bad' ? ' on' : '') + '" data-id="' + d.id + '" data-v="bad">重出</button>' +
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
  var done = 0, ok = 0, bad = 0;
  DATA.forEach(function (d) {
    if (state[d.id]) { done++; if (state[d.id] === 'ok') ok++; else bad++; }
  });
  document.getElementById('s-done').textContent = done;
  document.getElementById('s-all').textContent = DATA.length;
  document.getElementById('s-ok').textContent = ok;
  document.getElementById('s-bad').textContent = bad;
  document.getElementById('s-bar').style.width = (DATA.length ? done * 100 / DATA.length : 0) + '%';
}

/* 只改这一张卡 —— **不要整页重绘**：122 张图重新建元素会全部重新解码、屏幕闪一下，
   而且滚动位置也会跳。筛选/清空才走 render()。 */
function paintCard(id) {
  var el = document.querySelector('.c[data-id="' + id + '"]');
  if (!el) return;
  var st = state[id] || '';
  el.className = 'c' + (st ? ' ' + st : '');
  el.querySelector('.b-ok').classList.toggle('on', st === 'ok');
  el.querySelector('.b-bad').classList.toggle('on', st === 'bad');
}

document.getElementById('grid').addEventListener('click', function (ev) {
  var b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.go) {
    window.open('https://www.bing.com/search?q=' + encodeURIComponent(b.dataset.go + ' 鱼 形态特征'), '_blank');
    return;
  }
  var id = b.dataset.id, v = b.dataset.v;
  if (!id) return;
  state[id] = (state[id] === v) ? '' : v;
  if (!state[id]) delete state[id];
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
  var bad = [], ok = [], pend = [];
  DATA.forEach(function (d) {
    if (state[d.id] === 'bad') bad.push(d.id);
    else if (state[d.id] === 'ok') ok.push(d.id);
    else pend.push(d.id);
  });
  var L = [];
  L.push('# 重出清单（' + bad.length + ' 条）');
  L.push('# 每条必须重出 6 个文件：<id>.png + <id>-normal/bright/albino/golden/shiny.png');
  L.push('# 步骤：① 先备份并移走这 6 个文件  ② 跑下面这条命令');
  L.push('');
  L.push('IDS=' + bad.join(','));
  L.push('');
  L.push('python tools/gen-art.py --list ' + bad.join(','));
  L.push('');
  L.push('# 未审 ' + pend.length + ' 条 / 已合格 ' + ok.length + ' 条');
  document.getElementById('out').value = bad.length ? L.join('\\n') : '（还没有标记为「重出」的）';
  document.getElementById('cmds').innerHTML = bad.length
    ? '把上面 <code>--list</code> 那行发给助手即可。'
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
