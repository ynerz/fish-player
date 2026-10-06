import io

def patch(p, pairs):
    s = io.open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, p + ' :: NOT FOUND >> ' + a[:90]
        s = s.replace(a, b, 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('ok', p)

# ---------- scene.js：新增 floatNudge（咬钩前的浮漂异动） ----------
patch('src/render/scene.js', [
("""    floatState: 'none',   // none | flying | wait | bite | fight
    floatT: 0,
    biteDip: 0,""",
"""    floatState: 'none',   // none | flying | wait | bite | fight
    floatT: 0,
    biteDip: 0,
    nudge: 0,             // 0~1，咬钩前的「浮漂异动」强度，指数衰减"""),

("""  function cast() {
    S.floatState = 'flying';
    S.floatT = 0;
    S.lineOut = 0;
    S.fishShadow = null;
    G.Audio.cast();
  }""",
"""  function cast() {
    S.floatState = 'flying';
    S.floatT = 0;
    S.nudge = 0;
    S.lineOut = 0;
    S.fishShadow = null;
    G.Audio.cast();
  }

  /* 咬钩前的浮漂异动 —— 让「提前收杆」这件事有可观察的信号。
     只是很轻微的连续抖动 + 一圈细小涟漪，不暴露鱼的稀有度。 */
  function floatNudge() { S.nudge = 1; }"""),

("""  function floatX() {
    if (S.floatState === 'flying') {
      return U.lerp(W * 0.30, floatHomeX(), U.easeOut(S.floatT / 0.85));
    }
    return floatHomeX();
  }""",
"""  function floatX() {
    if (S.floatState === 'flying') {
      return U.lerp(W * 0.30, floatHomeX(), U.easeOut(S.floatT / G.CONFIG.misc.flyTime));
    }
    /* 异动时浮漂轻微横向游移，看起来像有东西在水下试探 */
    if (S.nudge > 0) return floatHomeX() + Math.sin(time * 7.5) * S.nudge * 3.4;
    return floatHomeX();
  }"""),

("""      if (S.floatT > 0.85) { S.floatT = 0.85; }""",
"""      if (S.floatT > G.CONFIG.misc.flyTime) { S.floatT = G.CONFIG.misc.flyTime; }"""),

("""    if (S.biteDip > 0) S.biteDip = Math.max(0, S.biteDip - dt * 1.6);""",
"""    if (S.biteDip > 0) S.biteDip = Math.max(0, S.biteDip - dt * 1.6);
    if (S.nudge > 0) S.nudge = Math.max(0, S.nudge - dt * 0.42);"""),

("""    } else if (S.floatState === 'fight') {
      dip = 5 + Math.sin(time * 9) * 3;
    }
    var fy = base + bob + dip;""",
"""    } else if (S.floatState === 'fight') {
      dip = 5 + Math.sin(time * 9) * 3;
    }
    if (S.nudge > 0) dip += (Math.sin(time * 11) * 0.5 + 0.5) * S.nudge * 2.6;
    var fy = base + bob + dip;"""),

("""    var rr = ((time * 22 + i * 16) % 34);""",
"""    var rr = ((time * 22 + i * 16) % 34);
      if (S.nudge > 0) { rr = (rr + S.nudge * 8) % 34; }"""),

("""    var t = S.floatT / 0.85;""",
"""    var t = S.floatT / G.CONFIG.misc.flyTime;"""),

("""    cast: cast, beginWait: beginWait, bite: bite,""",
"""    cast: cast, beginWait: beginWait, bite: bite, floatNudge: floatNudge,"""),
])

# ---------- audio.js：新增 hint（异动提示音） ----------
patch('src/core/audio.js', [
("""    /* 收线咔哒 */""",
"""    /* 咬钩前的浮漂异动：刻意做得很轻，只是「有东西在试探」的感觉 */
    hint: function () {
      tone(1180, 0.09, 'sine', 0.035, 0);
      noise(0.10, 0.030, 1600, 0, 0.9);
    },
    /* 收线咔哒 */"""),
])
