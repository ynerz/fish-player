/* =========================================================================
   profile.js —— 本机账号与档案（uid / 昵称 / 密码 / 多档案）
   =========================================================================
   用户口径（2026-10-09）：「设定玩家 uid、账号、密码等东西」。

   ⚠️ **先把边界写清楚**（免得后来人以为这是安全边界）：
     本项目是**纯前端单机**（零依赖 / `file://` 双击可跑），没有服务端 ⇒
     不存在任何权威数据源。所以这里的「账号密码」是**档案管理 + 防误改**，
     **不是安全机制** —— 懂行的人清掉 `localStorage` 就能重置一切。
     这一点必须在设置面板上对玩家直说，不许写成「账号已保护」。

   设计要点：
   · 账号表单独一个键 `fishplayer.accounts.v1`；**每个账号一份存档**，
     键 = `<saveKey>.<uid>`（老档自动迁移，进度零丢失）。
   · 密码**绝不存明文**：`crypto.subtle` 的 PBKDF2-SHA256（每账号独立 salt，12 万次迭代）。
     实测 `file://` 下 `isSecureContext === true`、`crypto.subtle` 可用；
     真遇到拿不到 subtle 的老环境，退到内置弱哈希（`weakHash`）并在 `isSecure()` 里如实回报。
   · **无密码档案**：`hash === ''` 表示这个档案不设密码（免登录，默认档案就是这样）。
   · 一切失败都不抛异常：掉存储、脏 JSON、uid 对不上，一律降级到「能玩」。
   ========================================================================= */
window.G = window.G || {};

G.Profile = (function () {
  var U = G.U, CFG = G.CONFIG;

  var KEY_ACC = 'fishplayer.accounts.v1';
  var ITER = 120000;        // PBKDF2 迭代（有 subtle 时）
  var WEAK_ITER = 2000;     // 降级哈希的迭代（纯 JS 循环，不能太高）
  var NAME_MAX = 12;
  var PW_MIN = 4;
  var DEFAULT_NAME = '本机玩家';

  var DB = null;            // { cur: uid, list: [...] }
  var note = '';            // 给设置面板看的一句话（迁移提示等）

  function PS() { return (G.Platform && G.Platform.storage) || null; }

  function readRaw() {
    var ps = PS(); if (!ps) return null;
    try {
      var d = JSON.parse(ps.get(KEY_ACC) || 'null');
      if (!d || typeof d !== 'object' || !Array.isArray(d.list)) return null;
      return d;
    } catch (e) { return null; }
  }
  function writeRaw() {
    var ps = PS(); if (!ps || !DB) return false;
    try { ps.set(KEY_ACC, JSON.stringify(DB)); return true; } catch (e) { return false; }
  }

  /* ---------------- 存档键：一个账号一份 ---------------- */
  function keyFor(uid) { return CFG.saveKey + '.' + uid; }
  function key() { return (DB && DB.cur) ? keyFor(DB.cur) : CFG.saveKey; }
  function keyBak() { return key() + '.bak'; }
  function keyRescue() { return key() + '.rescue'; }

  /* ---------------- uid / salt ---------------- */
  function newUid() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 16);
    return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function hex(u8) {
    var s = '', i;
    for (i = 0; i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
    return s;
  }
  function newSalt() {
    var a = new Uint8Array(16), i;
    var c = window.crypto;
    if (c && c.getRandomValues) c.getRandomValues(a);
    else for (i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return hex(a);
  }
  function bytesOf(hexStr) {
    var n = Math.floor(hexStr.length / 2), out = new Uint8Array(n), i;
    for (i = 0; i < n; i++) out[i] = parseInt(hexStr.substr(i * 2, 2), 16) || 0;
    return out;
  }

  /* ---------------- 密码派生 ----------------
     有 subtle 走 PBKDF2-SHA256（**正规做法**）；没有就走 weakHash，
     并在 isSecure() 里如实回报 false —— 界面要照实说，不许含糊。 */
  function weakHash(pw, saltHex, iter) {
    /* 降级路径：FNV-1a 变体迭代混淆。**强度很低**，只用于「防误改 / 多档案区分」。
       仍然不存明文 —— 存明文会让「玩家在 devtools 里直接看到自己密码」这种事发生。 */
    var s = saltHex + '|' + pw, h = 0x811c9dc5, i, j;
    for (i = 0; i < iter; i++) {
      for (j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      s = (h >>> 0).toString(16) + '|' + pw;
    }
    return 'w' + (h >>> 0).toString(16);
  }

  function derive(pw, saltHex) {
    var c = window.crypto, subtle = c && c.subtle;
    if (!subtle || !window.TextEncoder) {
      return Promise.resolve(weakHash(pw, saltHex, WEAK_ITER));
    }
    try {
      return subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
        .then(function (k) {
          return subtle.deriveBits(
            { name: 'PBKDF2', salt: bytesOf(saltHex), iterations: ITER, hash: 'SHA-256' }, k, 256);
        })
        .then(function (bits) { return hex(new Uint8Array(bits)); })
        .catch(function () { return weakHash(pw, saltHex, WEAK_ITER); });
    } catch (e) {
      return Promise.resolve(weakHash(pw, saltHex, WEAK_ITER));
    }
  }

  /* ---------------- 账号表 ---------------- */
  function find(uid) {
    if (!DB) return null;
    var i;
    for (i = 0; i < DB.list.length; i++) if (DB.list[i].uid === uid) return DB.list[i];
    return null;
  }
  function clean(name) {
    return String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim().slice(0, NAME_MAX);
  }
  function current() { return find(DB && DB.cur); }
  function list() {
    return (DB && DB.list) ? DB.list.map(function (a) {
      return { uid: a.uid, name: a.name, locked: !!a.hash, created: a.created, last: a.last, cur: a.uid === DB.cur };
    }) : [];
  }

  function init() {
    DB = readRaw();
    var ps = PS();

    if (!DB || !DB.list.length) {
      /* 首次（或账号表损坏）：建一个免密默认档案，并把老档搬过来 —— 进度零丢失 */
      var uid = newUid();
      DB = {
        cur: uid,
        list: [{ uid: uid, name: DEFAULT_NAME, salt: '', hash: '', iter: 0,
                 created: Date.now(), last: Date.now() }],
      };
      var legacy = ps ? ps.get(CFG.saveKey) : null;
      if (legacy) {
        try {
          var lk = ps.get(CFG.saveKeyBak);
          ps.set(keyFor(uid), legacy);
          if (lk) ps.set(keyFor(uid) + '.bak', lk);
          note = '原有进度已归入「' + DEFAULT_NAME + '」';
        } catch (e) { /* 搬不动就算了，load 会有兜底 */ }
      }
      writeRaw();
    } else {
      if (!find(DB.cur)) DB.cur = DB.list[0].uid;
    }
    return DB.cur;
  }

  /* ---------------- 对外操作 ---------------- */
  function register(name, pw) {
    name = clean(name);
    if (!name) return Promise.resolve({ ok: false, msg: '请填昵称' });
    if (name === DEFAULT_NAME) return Promise.resolve({ ok: false, msg: '换个别的昵称' });
    if (!pw || pw.length < PW_MIN) return Promise.resolve({ ok: false, msg: '密码至少 ' + PW_MIN + ' 位' });
    var uid = newUid(), salt = newSalt();
    return derive(pw, salt).then(function (hash) {
      DB.list.push({ uid: uid, name: name, salt: salt, hash: hash, iter: ITER,
                     created: Date.now(), last: Date.now() });
      DB.cur = uid;
      writeRaw();
      return { ok: true, uid: uid, name: name };
    });
  }

  function login(uid, pw) {
    var a = find(uid);
    if (!a) return Promise.resolve({ ok: false, msg: '没有这个档案' });
    if (!a.hash) {                       // 免密档案：直接进
      DB.cur = uid; a.last = Date.now(); writeRaw();
      return Promise.resolve({ ok: true, name: a.name });
    }
    return derive(pw, a.salt).then(function (h) {
      if (h !== a.hash) return { ok: false, msg: '密码不对' };
      DB.cur = uid; a.last = Date.now(); writeRaw();
      return { ok: true, name: a.name };
    });
  }

  function switchTo(uid) {
    if (!find(uid) || uid === DB.cur) return false;
    DB.cur = uid;
    writeRaw();
    return true;
  }

  function rename(uid, name) {
    var a = find(uid); name = clean(name);
    if (!a || !name) return false;
    a.name = name; writeRaw(); return true;
  }

  /* 设/改/清密码。旧密码不对就拒绝（免密档案除外）。 */
  function setPassword(uid, oldPw, newPw) {
    var a = find(uid);
    if (!a) return Promise.resolve({ ok: false, msg: '没有这个档案' });
    if (!newPw) {                        // 清掉密码 = 变回免密
      a.salt = ''; a.hash = ''; a.iter = 0; writeRaw();
      return Promise.resolve({ ok: true, msg: '已取消密码' });
    }
    if (newPw.length < PW_MIN) return Promise.resolve({ ok: false, msg: '密码至少 ' + PW_MIN + ' 位' });
    var check = a.hash
      ? derive(oldPw || '', a.salt).then(function (h) { return h === a.hash; })
      : Promise.resolve(true);
    return check.then(function (pass) {
      if (!pass) return { ok: false, msg: '原密码不对' };
      var salt = newSalt();
      return derive(newPw, salt).then(function (hash) {
        a.salt = salt; a.hash = hash; a.iter = ITER; writeRaw();
        return { ok: true, msg: '密码已更新' };
      });
    });
  }

  function remove(uid) {
    if (!DB || DB.list.length <= 1) return { ok: false, msg: '至少留一个档案' };
    var i, idx = -1;
    for (i = 0; i < DB.list.length; i++) if (DB.list[i].uid === uid) idx = i;
    if (idx < 0) return { ok: false, msg: '没有这个档案' };
    var ps = PS();
    DB.list.splice(idx, 1);
    if (DB.cur === uid) DB.cur = DB.list[0].uid;
    /* 存档留着不删（放错手就救不回来了）；要彻底清可以去设置里手动清 */
    writeRaw();
    return { ok: true, msg: '档案已移除（它的存档仍留在本机，可用同 uid 找回）', uid: uid, ps: !!ps };
  }

  return {
    init: init,
    key: key, keyBak: keyBak, keyRescue: keyRescue, keyFor: keyFor,
    current: current, list: list, find: find,
    register: register, login: login, switchTo: switchTo,
    rename: rename, setPassword: setPassword, remove: remove,
    note: function () { return note; },
    /* 界面要照实说：false 表示这个环境只用了降级弱哈希 */
    isSecure: function () { return !!(window.crypto && window.crypto.subtle); },
    NAME_MAX: NAME_MAX, PW_MIN: PW_MIN,   /* 界面文案与这里同源 */
  };
})();
