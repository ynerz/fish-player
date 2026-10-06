/* =========================================================
   tools/build.js  —  单文件打包（可选，开发期完全用不到）
   =========================================================
   把 index.html + assets/css/style.css + src/ 下的全部脚本
   内联成「一个 HTML 文件」，双击就能玩（file:// 直接跑）。

   它**不是开发流程的一环**（改完源码刷新浏览器即可，项目依然是零构建）。
   只在两种时候用：
     · 发布前自查 —— 「零依赖 / 零素材」这个卖点是不是还成立：
       产物里不应该再有任何指向本地文件的 src= / href=
     · 打小体积分发包 —— 上 Steam / 上小程序时，移植单位就是一个文件

   用法：
     node tools/build.js                        # → dist/fish-player.html
     node tools/build.js --release              # → dist/fish-player.release.html（剔除调试面板）
     node tools/build.js --out some/where.html  # 指定输出路径
     node tools/build.js --check                # 只跑断言，不写文件

   断言不通过时退出码为 1。
   collectScripts / collectStyles / assemble / auditBundle / auditHtml / build
   都是纯函数，导出给 tools/test.js 与 tools/verify.js 复用。

   ⚠️ 内联的正确性依赖两件事，改 index.html 时别破坏：
     1. 所有 <script src> 必须**连续挨在一块**（否则「整块替换」会漏）
     2. config.js 必须第一（它建 window.G）、main.js 必须最后（它 boot）
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const STYLE_RE  = /<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g;
const SCRIPT_RE = /<script\s+src="([^"]+)"[^>]*>\s*<\/script>/g;
/* 连续的一整块 <script src>：内联时整块替换成一个 <script> */
const SCRIPT_RUN_RE = /(?:<script\s+src="[^"]+"[^>]*>\s*<\/script>\s*)+/;

/* 开发期专用、不上发布包的模块 */
const DEV_ONLY = ['src/ui/devtools.js'];

/* 加载顺序的硬约束 */
const MUST_BE_FIRST = 'src/data/config.js';
const MUST_BE_LAST  = 'src/main.js';

/* 单文件产物体积上限（当前约 0.4 MB；超过说明内联进了不该进的东西，
   比如 base64 素材 —— 那会毁掉「零素材」这个卖点） */
const MAX_BYTES = 1.5 * 1024 * 1024;

/* ---------------- 工具 ---------------- */
const stripBom = s => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const bytes = s => Buffer.byteLength(s, 'utf8');

/* ---------------- 解析 index.html ---------------- */
function collectScripts(html) {
  const out = [], re = new RegExp(SCRIPT_RE.source, 'g');
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function collectStyles(html) {
  const out = [], re = new RegExp(STYLE_RE.source, 'g');
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/* ---------------- 拼接 ---------------- */
/* 每个模块前加一行分隔注释（产物里可以直接搜文件名定位），
   模块之间插一行 `;`：上一段末尾可能没有分号，直接接下一段的
   `(function(){...})()` 会被解析成「函数调用」，静默改语义。 */
function assemble(mods) {
  const parts = [];
  mods.forEach(m => {
    parts.push('/* ===== ' + m.rel + ' ===== */');
    parts.push(stripBom(m.body).trim());
    parts.push(';');
  });
  return parts.join('\n') + '\n';
}

/* ---------------- 产物断言（纯文本层面） ---------------- */
function auditBundle(bundle, opts) {
  opts = opts || {};
  const bad = [];
  /* ES Module 语法在 file:// 下会被浏览器以 CORS 拦掉；内联之后更是毫无意义 */
  if (/^[ \t]*(import|export)[ \t]+[\w{*'"]/m.test(bundle)) {
    bad.push('内联内容里出现 import / export（ES Module 在 file:// 下会被浏览器拦掉）');
  }
  /* 字符串里出现 </script 会提前闭合脚本标签，后面全部变成页面文字 */
  if (/<\/script/i.test(bundle)) {
    bad.push('内联内容里出现 </script（浏览器会提前闭合脚本标签，后面的代码会变成页面文字）');
  }
  if (opts.release && /G\.Cheat/.test(bundle)) {
    bad.push('release 版里还带着调试面板（G.Cheat）—— devtools.js 不该进发布包');
  }
  return bad;
}

/* ---------------- 产物断言（HTML 层面） ---------------- */
function auditHtml(html, meta) {
  const bad = [];
  const re = /(?:^|\s)(?:src|href)="([^"]*)"/gm;
  let m;
  while ((m = re.exec(html))) {
    const r = m[1];
    if (/^(data:|#|javascript:)/i.test(r)) continue;   // 内联图标 / 锚点，允许
    bad.push('产物里还有指向外部文件的引用：' + r);
  }
  if (/<script\s+src=/i.test(html)) bad.push('产物里还有 <script src= —— 没内联干净');
  if (/<link\s+rel="stylesheet"/i.test(html)) bad.push('产物里还有外链样式表 —— 没内联干净');
  if (meta && meta.bytes > MAX_BYTES) {
    bad.push('产物体积 ' + kb(meta.bytes) + ' 超过上限 ' + kb(MAX_BYTES) + '（内联进素材了？）');
  }
  return bad;
}

/* ---------------- 主流程 ---------------- */
function build(opts) {
  opts = opts || {};
  const errors = [], warns = [], sizes = [];

  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = collectScripts(raw);
  const styles  = collectStyles(raw);

  if (!scripts.length) errors.push('index.html 里没找到任何 <script src>（写法变了？更新 SCRIPT_RE）');
  else {
    if (scripts[0] !== MUST_BE_FIRST) {
      errors.push('第一个脚本应是 ' + MUST_BE_FIRST + '，实际是 ' + scripts[0]);
    }
    if (scripts[scripts.length - 1] !== MUST_BE_LAST) {
      errors.push('最后一个脚本应是 ' + MUST_BE_LAST + '，实际是 ' + scripts[scripts.length - 1]);
    }
    const run = raw.match(SCRIPT_RUN_RE);
    if (!run || collectScripts(run[0]).length !== scripts.length) {
      errors.push('index.html 里的 <script src> 不是连续的一整块，无法安全内联');
    }
    const seen = {}, dup = [];
    scripts.forEach(s => { if (seen[s]) dup.push(s); seen[s] = 1; });
    if (dup.length) errors.push('重复引用的脚本：' + dup.join('、'));
  }

  let keep = scripts.slice();
  if (opts.release) {
    const before = keep.length;
    keep = keep.filter(r => DEV_ONLY.indexOf(r) < 0);
    if (keep.length === before) warns.push('release 模式下没剔除任何模块（DEV_ONLY 是不是过期了？）');
  }

  const mods = [];
  keep.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { errors.push('引用的脚本不存在：' + rel); return; }
    const body = fs.readFileSync(p, 'utf8');
    sizes.push({ rel, n: bytes(body) });
    mods.push({ rel, body });
  });

  let css = '';
  styles.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { errors.push('引用的样式表不存在：' + rel); return; }
    sizes.push({ rel, n: bytes(fs.readFileSync(p, 'utf8')), css: true });
    css += (css ? '\n' : '') + stripBom(fs.readFileSync(p, 'utf8')).trim();
  });
  if (!styles.length) warns.push('index.html 没有外链样式表，产物会没有皮肤');

  /* 版本号从 config.js 里取（唯一来源就是那里，别在 build.js 里再写一份） */
  let version = 'unknown';
  const cfg = mods.filter(m => m.rel === 'src/data/config.js')[0];
  if (cfg) { const vm = cfg.body.match(/version\s*:\s*'([^']+)'/); if (vm) version = vm[1]; }
  else warns.push('没读 src/data/config.js，产物横幅里的版本号会是 unknown');

  /* 1) 内联样式表 */
  const styleTag = '<style>\n' + css + '\n</style>';
  let usedCss = false;
  let html = raw.replace(new RegExp(STYLE_RE.source, 'g'), () => {
    if (usedCss) return '';            // 多余的 <link> 直接吃掉
    usedCss = true; return styleTag;
  });

  /* 2) 内联脚本块（用函数式 replace：JS 里的 $& / $' 不会被当替换模式解释） */
  const bundle = assemble(mods);
  const scriptTag = '<script>\n' + bundle + '</script>';
  /* 正则末尾的 \s* 会把脚本块后面的换行一起吃掉，这里补回来 */
  html = html.replace(new RegExp(SCRIPT_RUN_RE.source), () => scriptTag + '\n');

  /* 3) 顶部横幅 */
  const banner =
    '<!--\n' +
    '  钓鱼人生 · Fish Player  v' + version + '\n' +
    '  单文件构建产物 —— 由 tools/build.js 生成，请勿手改；改代码请改 src/ 下的对应文件。\n' +
    '  模块 ' + mods.length + ' 个全部内联 · 样式表内联 · 零依赖 · 零素材 · 可直接双击（file://）打开\n' +
    (opts.release ? '  发布版：已剔除开发者面板 src/ui/devtools.js\n' : '') +
    '-->\n';
  html = html.replace(/^(<!DOCTYPE html>\s*)/i, m0 => m0 + banner);

  const meta = {
    version: version,
    release: !!opts.release,
    scripts: mods.map(m => m.rel),
    moduleCount: mods.length,
    cssBytes: bytes(css),
    bundleBytes: bytes(bundle),
    bytes: bytes(html),
    /* 原始形态要发多少个请求：1 个 html + 1 个 css + N 个脚本 */
    requests: 2 + mods.length,
  };

  auditBundle(bundle, { release: !!opts.release }).forEach(e => errors.push(e));
  auditHtml(html, meta).forEach(e => errors.push(e));

  return { html, meta, errors, warns, sizes };
}

/* ---------------- CLI ---------------- */
function main(argv) {
  const release = argv.indexOf('--release') >= 0;
  const dry     = argv.indexOf('--check') >= 0;
  const oi      = argv.indexOf('--out');
  const outPath = (oi >= 0 && argv[oi + 1])
    ? path.resolve(process.cwd(), argv[oi + 1])
    : path.join(ROOT, 'dist', release ? 'fish-player.release.html' : 'fish-player.html');

  console.log('\n钓鱼人生 · 单文件构建');
  const r = build({ release });

  console.log('  版本        v' + r.meta.version + '（读自 src/data/config.js）');
  console.log('  模式        ' + (release ? '发布版（剔除调试面板）' : '开发版（含 ?dev 调试面板）'));
  console.log('  内联模块    ' + r.meta.moduleCount + ' 个');
  r.sizes.forEach(s => {
    console.log('    ' + (s.css ? '· ' : '  ') + s.rel.padEnd(26) + kb(s.n).padStart(9));
  });
  console.log('  ' + '-'.repeat(46));
  console.log('  内联脚本    ' + kb(r.meta.bundleBytes).padStart(9));
  console.log('  内联样式    ' + kb(r.meta.cssBytes).padStart(9));
  console.log('  产物        ' + kb(r.meta.bytes).padStart(9) + '   （原本 ' + r.meta.requests + ' 个请求 → 1 个文件）');

  r.warns.forEach(w => console.log('  \u26a0 ' + w));
  if (r.errors.length) {
    r.errors.forEach(e => console.log('  \u2716 ' + e));
    console.log('\n\u2716 构建未通过：' + r.errors.length + ' 个错误、' + r.warns.length + ' 个警告\n');
    process.exit(1);
  }

  if (dry) {
    console.log('\n\u2714 断言通过（--check：未写文件）\n');
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, r.html, 'utf8');
  console.log('\n\u2714 构建通过（0 个错误、' + r.warns.length + ' 个警告）');
  console.log('  → ' + path.relative(ROOT, outPath).replace(/\\/g, '/') + '\n');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  build, assemble, auditBundle, auditHtml, collectScripts, collectStyles,
  ROOT, DEV_ONLY, MUST_BE_FIRST, MUST_BE_LAST, MAX_BYTES,
};
