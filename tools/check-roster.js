/* 打印各钓场鱼种/档位分布 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

/* 命令行契约（2026-10-13 第 61 轮，Q100）：本工具**不接受任何开关**。
   为什么这句必须有：此前这个文件里连 `process.argv` 都不出现 ⇒ `verify §32-s` 的
   扫描面（那时按「文件里提没提 process.argv」现算）**根本看不到它**，于是
   `node tools/check-roster.js --help` / `--zzz` 全都**静默忽略**、照跑真活、退出码 0
   —— 与 py 侧 `--help` 会真重写 fish.js（第 57 轮 Q90）是同一族坏法。
   空 `KNOWN` 是合法的（见 `tools/argv.js` 的注释）：它表示「给任何开关都算用法错」。 */
const { checkKnown } = require('./argv');
const KNOWN = [];
checkKnown(process.argv.slice(2), KNOWN, 'check-roster.js');

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G;
let tot = 0;
console.log('钓场  鱼种  档位(普/稀/史/传)');
G.FIELDS.forEach(f => {
  const l = G.FISH_BY_FIELD[f.id];
  const t = [0, 0, 0, 0];
  l.forEach(x => t[x.rar]++);
  tot += l.length;
  console.log(`${f.id.padEnd(5)} ${String(l.length).padStart(3)}   ${t.join(' / ')}`);
});
console.log('合计 ' + tot + ' 种');
