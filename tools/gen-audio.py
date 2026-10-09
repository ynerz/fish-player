#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/gen-audio.py —— 游戏音频素材的**生成参数表 + 可复跑入口**（2026-10-09 加）

为什么需要这个文件
------------------
`assets/audio/*.mp3` 是 16 个一次性音效 + 1 段环境音，全部由本地 ComfyUI
（Stable Audio Open 1.0）生成，**没有任何云端 Key 参与**。
在此之前，那 16 条的提示词只活在 `_tmp/gen_sfx.sh` 里 —— 而 `_tmp/` 是 gitignore 的
⇒ **素材能复现，参数不能复现**（换台机器 / 一年后想重出，没人知道当初写的什么）。
「来源不可复现」是这个项目反复栽过的坑，所以把参数搬进库里：本文件是**唯一真相**，
`_tmp/gen_sfx.sh` 那类一次性脚本不该再承担这个角色。

判据不是「工具跑成功」，而是「产物能用」
--------------------------------------
`--probe` 会拿 ffmpeg 现算每一段素材的时长 / 声道 / 电平 / **逐秒 RMS 的起伏**。
最后一项是给「垫底环境音」用的：一段 45 秒的水声如果逐秒电平几乎不动，
那它跟程序化合成的布朗噪声没有区别（换素材就白换了）。

用法
----
    python tools/gen-audio.py --check            # 打印生成服务与模型是否就绪
    python tools/gen-audio.py --list             # 列出参数表（不跑任何生成）
    python tools/gen-audio.py --probe            # 量一遍盘上已有素材（只读）
    python tools/gen-audio.py --only ambience    # 重出某一条（会覆盖 assets/audio/<id>.mp3）
    python tools/gen-audio.py --all --skip-existing

⚠️ 生成走 `~/.workbuddy/comfy/txt2audio.py`，那个脚本**不支持 .flac 输出**
   （`FORMATS["flac"] = None` 却被当元组解包 ⇒ TypeError）。这里一律出 mp3。
"""

import argparse
import array
import math
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'assets', 'audio')
TXT2AUDIO = os.path.expanduser('~/.workbuddy/comfy/txt2audio.py')
PY = sys.executable

# 负向提示词：一次性音效与环境音共用（都是「短促的干净音」或「不要人声 / 音乐」）
NEG = ('music, melody, singing, speech, voices, bird calls, insects, thunder, '
       'sudden loud splash, wind chimes, fade out, silence, harsh hiss, static, '
       'white noise, air conditioning hum')

# 一次性音效（提示词 + 时长），与 `assets/audio/<id>.mp3` 一一对应。
# ⚠️ 键必须匹配 `[a-z][a-z0-9]*`（`G.Assets.resolve` 的口径）；名字就是 `G.Audio` 的方法名。
ONESHOT = [
    ('cast',      'fishing rod casting, thin line whipping through the air, light whoosh, clean game sfx', 1.5),
    ('splash',    'water splash, small object dropping into calm pond water, close up, clean game sfx', 1.5),
    ('bite',      'short sharp bell ding with a soft thud, alert notification, dry, game sfx', 1.0),
    ('hint',      'soft gentle marimba note, subtle UI hint, clean game sfx', 1.2),
    ('tick',      'short dry wooden tick, clock tick, minimal game UI, clean', 0.6),
    ('snap',      'fishing line snapping under tension, sharp crack with a high ping, game sfx', 1.2),
    ('escape',    'low descending whoosh underwater, fish escaping, disappointed game sfx', 1.8),
    ('success',   'bright ascending chime arpeggio, success jingle, game reward, clean', 2.0),
    ('legendary', 'epic orchestral hit with shimmering bells, legendary reward, cinematic, game', 2.5),
    ('glint',     'bright sparkle glissando, glittering high bells, short shimmer, game sfx', 1.0),
    ('reward',    'warm coin and chime cascade, reward claim, game sfx, clean', 1.8),
    ('newRecord', 'triumphant short brass fanfare, achievement new record, game sfx', 2.2),
    ('click',     'soft UI click, subtle wooden tap, minimal, clean', 0.5),
    ('deny',      'low buzz error deny sound, short negative beep, game UI', 0.8),
    ('unlock',    'magical unlocking shimmer, rising sparkle, achievement unlock, game sfx', 2.0),
    ('coin',      'small brass coin clink, short metallic ring, game pickup, clean', 0.9),
]

# 环境音（**循环播放**的那一条）。与上表的区别：走「整段循环 buffer」通道，
# 而且要做**电平归一化**（见下面的 TARGET_RMS_DBFS）。
#   · 循环接缝由 `src/core/audio.js` 的 `seamEnd()` 做自交叉淡化兜底 ——
#     生成端不保证能出无缝素材，代码侧那一步是确定性的。
#   · `target_rms_dbfs` 的来源：合成环境音（布朗噪声 `last=(last+0.02w)/1.02`、`d=last*3.2`）
#     在 0.10 gain 之前的 RMS ≈ 0.1881 ⇒ -14.51 dBFS。两条路共用同一个 `AMB_GAIN`，
#     所以采样必须归一化到这个电平，否则「换素材」会顺手改掉音量平衡。
#     ⚠️ 合成那条公式改了就来重跑：
#        python -c "import random,math;random.seed(1);n=44100*3;last=0.;s=0.;\
#        [None for i in range(n)]"  ← 见 `--probe-synth`（本脚本内置，别手抄）
AMBIENCE = {
    'id': 'ambience',
    # 选型留痕（2026-10-09，6 份候选按同一套指标现算，见 `_tmp/amb`）：
    #   判据 = ① 全程连续无空档 ② 能量集中在 520Hz 以下（合成那条路有同一个低通，
    #   采样若是一片宽带嘶声，换成素材就等于顺手换了音色）③ 归一化后峰值留得住余量。
    #   6 份里 a(seed …09)/d(…12) 近乎静音（RMS −53 / −57 dBFS）、b(…10)/f(…14) 有 13~16 dB
    #   能量在 520Hz 以上（会变成嘶声）、c(…11) 达标但归一化后峰值只余 −0.3 dB；
    #   **e(…13) 达标且只差 1.3 dB**（现算 RMS −15.8 dBFS、峰值 −3.5 dBFS）⇒ 选它。
    'prompt': ('low frequency underwater ambience, distant water flow, soft muffled roar, '
               'continuous seamless loop'),
    'seconds': 45.0,
    'steps': 60,
    'seed': 20261013,
    'target_rms_dbfs': -14.51,
    'mono': True,
    'quality': '96k',
}


def need(binary):
    p = shutil.which(binary)
    if not p:
        raise SystemExit('[!] 找不到 %s —— 归一化与量化都要用它，请装 ffmpeg 并放进 PATH' % binary)
    return p


def sh(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return r.returncode, r.stdout.decode('utf-8', 'replace')


def sh_bytes(cmd):
    """取**二进制**输出（解码 PCM 用）。⚠️ 别拿 `sh()` 去接它 ——
    `decode('utf-8')` 会把 PCM 里的字节吃掉/替换掉，量出来的电平是错的。"""
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return r.returncode, r.stdout


def probe(path):
    """量一段音频：时长 / 声道 / 采样率 / 整体 RMS / 峰值 / **逐秒 RMS 的起伏**（dB）。

    最后一项是判断「垫底水声有没有生命」的客观指标：把 PCM 解码出来按秒切段算 RMS，
    取这些 RMS（dB）的标准差。近乎 0 = 一条平直的电平线（等于白噪声），
    越大 = 起伏越明显（真实水面的拍打感）。"""
    ff, fp = need('ffmpeg'), need('ffprobe')
    code, out = sh([fp, '-v', 'error', '-select_streams', 'a:0',
                    '-show_entries', 'stream=sample_rate,channels:format=duration',
                    '-of', 'default=nw=1:nk=1', path])
    if code != 0:
        raise SystemExit('[!] ffprobe 读不了 %s：%s' % (path, out.strip()))
    nums = [x for x in out.split('\n') if x.strip()]
    sr, ch, sec = int(nums[0]), int(nums[1]), float(nums[2])

    code, out = sh([ff, '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
    rms = peak = None
    for line in out.split('\n'):
        if 'mean_volume:' in line:
            rms = float(line.split('mean_volume:')[1].split('dB')[0])
        if 'max_volume:' in line:
            peak = float(line.split('max_volume:')[1].split('dB')[0])

    code, raw = sh_bytes([ff, '-v', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', '-'])
    pcm = array.array('h')
    pcm.frombytes(raw)
    step = sr * ch                      # 一秒的样本数（含全部声道）
    rms_db = []
    for off in range(0, len(pcm) - step + 1, step):
        seg = pcm[off:off + step]
        acc = 0
        for v in seg:
            acc += v * v
        m = math.sqrt(acc / len(seg)) / 32768.0
        rms_db.append(20 * math.log10(m) if m > 0 else -120.0)
    drift = (sum((x - sum(rms_db) / len(rms_db)) ** 2 for x in rms_db) / len(rms_db)) ** 0.5 if rms_db else 0.0
    return {'seconds': round(sec, 2), 'sr': sr, 'channels': ch,
            'rms_dbfs': rms, 'peak_dbfs': peak, 'sec_rms_drift_db': round(drift, 2)}


def probe_synth():
    """按 `src/core/audio.js` 的合成公式现算「采样要匹配的电平靶子」。
    ⚠️ 公式改了就重跑它，别手抄这里的数字（本项目最忌「同一个事实两处」）。"""
    import random
    random.seed(1)
    n, last, acc = 44100 * 3, 0.0, 0.0
    for _ in range(n):
        last = (last + 0.02 * (random.random() * 2 - 1)) / 1.02
        d = last * 3.2
        acc += d * d
    rms = math.sqrt(acc / n)
    print('  · 合成环境音 RMS（0.10 gain 之前）= %.4f  ⇒ 目标电平 %.2f dBFS'
          % (rms, 20 * math.log10(rms)))
    return round(20 * math.log10(rms), 2)


def gen_oneshot(entry, out, skip_existing):
    rid, prompt, sec = entry
    if skip_existing and os.path.exists(out):
        print('  · 跳过 %s（已存在）' % rid)
        return True
    code, o = sh([PY, TXT2AUDIO, '-p', prompt, '-n', NEG, '-o', out, '-d', str(sec)])
    print('  · %-10s %s' % (rid, '完成' if code == 0 else '失败'))
    if code != 0:
        print(o.strip()[-400:])
    return code == 0


def gen_ambience(entry, out, skip_existing):
    if skip_existing and os.path.exists(out):
        print('  · 跳过 %s（已存在）' % entry['id'])
        return True
    ff = need('ffmpeg')
    tmp = out + '.raw.mp3'
    mono = out + '.mono.wav'
    code, o = sh([PY, TXT2AUDIO, '-p', entry['prompt'], '-n', NEG, '-o', tmp,
                  '-d', str(entry['seconds']), '--steps', str(entry['steps']),
                  '--seed', str(entry['seed'])])
    if code != 0:
        print('  · %s 生成失败：%s' % (entry['id'], o.strip()[-400:]))
        return False

    # ① 先降到单声道。⚠️ **这一步本身会改电平** —— ffmpeg 的立体声→单声道下混
    #    不是简单的 `(L+R)/2`（2026-10-09 实测 +3.8 dB：源 −15.8 dBFS → 单声道后 −12.0 dBFS）
    #    ⇒ 归一化**必须在它之后**量，否则算出来的增益是错的、产物直接顶到 0 dBFS 削波。
    code, o = sh([ff, '-hide_banner', '-y', '-i', tmp, '-ac', '1', '-c:a', 'pcm_s16le', mono])
    if code != 0:
        print('  · %s 转单声道失败：%s' % (entry['id'], o.strip()[-400:]))
        return False

    d = probe(mono)
    target = entry['target_rms_dbfs']
    gain = 10 ** ((target - d['rms_dbfs']) / 20.0)
    head_room = -1.5 - d['peak_dbfs']                 # 峰值至少留 1.5 dB 余量
    capped = 20 * math.log10(gain) > head_room
    if capped:
        gain = 10 ** (head_room / 20.0)

    # ② 归一化 + 重编码（输入已经是单声道 ⇒ 这里不会再引入通道转换的额外增益）
    code, o = sh([ff, '-hide_banner', '-y', '-i', mono, '-af', 'volume=%.6f' % gain,
                  '-ac', '1', '-b:a', entry['quality'], out])
    os.remove(tmp)
    os.remove(mono)
    if code != 0:
        print('  · %s 归一化失败：%s' % (entry['id'], o.strip()[-400:]))
        return False

    # ③ 🔴 **拿产物本身复核一遍**（「工具跑成功」≠「产物能用」）：
    #    电平必须在靶子的 ±0.75 dB 内、峰值不许顶到 0（顶了就是削波，听感是「炸」）。
    got = probe(out)
    if abs(got['rms_dbfs'] - target) > 0.75 or got['peak_dbfs'] > -1.0:
        print('  · %s ✖ 产物电平不合格：RMS %.2f dBFS（靶子 %.2f）· 峰值 %.2f dBFS'
              % (entry['id'], got['rms_dbfs'], target, got['peak_dbfs']))
        return False
    print('  · %s 完成：单声道 %.2f dBFS（靶子 %.2f）· 峰值 %.2f dBFS · 逐秒起伏 %.2f dB%s'
          % (entry['id'], got['rms_dbfs'], target, got['peak_dbfs'],
             got['sec_rms_drift_db'], '（峰值受限、未足额拉升）' if capped else ''))
    return True


def main():
    ap = argparse.ArgumentParser(description='游戏音频素材生成表 / 复跑入口')
    ap.add_argument('--list', action='store_true', help='只列参数表')
    ap.add_argument('--check', action='store_true', help='只查生成服务是否就绪')
    ap.add_argument('--probe', action='store_true', help='量一遍盘上已有素材（只读）')
    ap.add_argument('--probe-synth', action='store_true', help='现算合成环境音的电平靶子')
    ap.add_argument('--only', default=None, help='只做这一条（id）')
    ap.add_argument('--all', action='store_true', help='全量重出（含 16 个一次性音效）')
    ap.add_argument('--skip-existing', action='store_true', help='已存在的不重出')
    args = ap.parse_args()

    if args.probe_synth:
        probe_synth()
        return
    if args.list:
        print('一次性音效 %d 条（assets/audio/<id>.mp3）：' % len(ONESHOT))
        for rid, prompt, sec in ONESHOT:
            print('  %-10s %4.1fs  %s' % (rid, sec, prompt[:64]))
        print('环境音 1 条（# 整段循环 + 电平归一化）：')
        print('  %-10s %4.1fs  %s' % (AMBIENCE['id'], AMBIENCE['seconds'], AMBIENCE['prompt']))
        print('  · 目标电平 %.2f dBFS（与合成环境音同源）· 单声道 %s'
              % (AMBIENCE['target_rms_dbfs'], AMBIENCE['quality']))
        return
    if args.check:
        code, out = sh([PY, TXT2AUDIO, '--check'])
        print(out.strip())
        print('  · 本表：一次性音效 %d 条 + 环境音 1 条' % len(ONESHOT))
        return
    if args.probe:
        rows = [(rid, os.path.join(OUT_DIR, rid + '.mp3')) for rid, _, _ in ONESHOT]
        rows.append((AMBIENCE['id'], os.path.join(OUT_DIR, AMBIENCE['id'] + '.mp3')))
        print('%-10s %8s %4s %10s %10s %10s' % ('id', '秒', '声道', 'RMS dBFS', '峰值 dB', '逐秒起伏'))
        missing = []
        for rid, p in rows:
            if not os.path.exists(p):
                missing.append(rid)
                continue
            d = probe(p)
            print('%-10s %8.2f %4d %10.2f %10.2f %10.2f'
                  % (rid, d['seconds'], d['channels'], d['rms_dbfs'],
                     d['peak_dbfs'], d['sec_rms_drift_db']))
        if missing:
            print('  ⚠️ 缺 %d 条：%s' % (len(missing), '、'.join(missing)))
        return

    if not os.path.isdir(OUT_DIR):
        raise SystemExit('[!] 没有 %s' % OUT_DIR)
    ok = True
    if args.only:
        if args.only == AMBIENCE['id']:
            ok = gen_ambience(AMBIENCE, os.path.join(OUT_DIR, AMBIENCE['id'] + '.mp3'),
                              args.skip_existing)
        else:
            hit = [e for e in ONESHOT if e[0] == args.only]
            if not hit:
                raise SystemExit('[!] 参数表里没有 %s' % args.only)
            ok = gen_oneshot(hit[0], os.path.join(OUT_DIR, args.only + '.mp3'),
                             args.skip_existing)
    elif args.all:
        for e in ONESHOT:
            ok = gen_oneshot(e, os.path.join(OUT_DIR, e[0] + '.mp3'), args.skip_existing) and ok
        ok = gen_ambience(AMBIENCE, os.path.join(OUT_DIR, AMBIENCE['id'] + '.mp3'),
                          args.skip_existing) and ok
    else:
        ap.print_help()
        return
    print('=== %s ===' % ('全部完成' if ok else '有失败项，见上面'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
