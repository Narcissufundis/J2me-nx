#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze-wav.py — 纯 stdlib WAV 谱分析：定位"持续蜂鸣"
对整个文件分窗做 Goertzel 扫频，报告每窗 top-N 峰、随时间不变的稳态音、
DC 分量与削波情况。
用法: python analyze-wav.py <file.wav>
"""
import sys, wave, math, struct, json

OUT = None
def out(*args):
    s = ' '.join(str(a) for a in args)
    if OUT:
        OUT.write(s + '\n')
    else:
        sys.stdout.write(s + '\n')

def read_wav(path):
    w = wave.open(path, 'rb')
    nch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    raw = w.readframes(nf)
    w.close()
    assert sw == 2, f"只支持 16bit，实际 {sw*8}bit"
    data = struct.unpack('<%dh' % (len(raw)//2), raw)
    # 混到单声道
    mono = [0.0]*nf
    for i in range(nf):
        s = 0
        for c in range(nch):
            s += data[i*nch+c]
        mono[i] = s/nch/32768.0
    return sr, mono

def goertzel(buf, sr, freq):
    w = 2.0*math.pi*freq/sr
    cw = 2.0*math.cos(w)
    s1 = s2 = 0.0
    for x in buf:
        s0 = x + cw*s1 - s2
        s2 = s1; s1 = s0
    return math.sqrt(abs(s1*s1 + s2*s2 - cw*s1*s2)) / len(buf)

def main(path):
    sr, mono = read_wav(path)
    n = len(mono)
    dur = n/sr
    peak = max(abs(v) for v in mono)
    clipped = sum(1 for v in mono if abs(v) > 0.985)
    out(f"文件: {path}")
    out(f"sr={sr} 时长={dur:.2f}s 峰值={peak:.3f} 削波样本={clipped}")

    # 全局 RMS 曲线（0.5s 粒度）
    out("\n--- RMS 时间线 (0.5s/格) ---")
    win = sr//2
    rms_line = []
    for st in range(0, n, win):
        seg = mono[st:st+win]
        r = math.sqrt(sum(v*v for v in seg)/len(seg))
        rms_line.append(r)
    out(' '.join(f"{r:.2f}" for r in rms_line))

    # 分窗扫频 40..5000Hz 步长 2Hz，每窗取 top5
    out("\n--- 分窗谱峰 (1.0s 窗, 步进 2s) ---")
    f_lo, f_hi, step = 40, 5000, 2
    freqs = list(range(f_lo, f_hi+1, step))
    window = sr  # 1s
    all_peaks = {}
    t = 0.0
    while t + 1.0 <= dur:
        seg = mono[int(t*sr):int((t+1)*window*0+ (t+1)*sr)]
        seg = mono[int(t*sr):int((t+1)*sr)]
        # 去直流
        mean = sum(seg)/len(seg)
        seg = [v-mean for v in seg]
        scored = []
        for f in freqs:
            e = goertzel(seg, sr, f)
            scored.append((e, f))
        scored.sort(reverse=True)
        # 局部极大筛选（±6Hz 内取最大）
        tops = []
        for e, f in scored:
            if all(abs(f-f2) > 6 for _, f2 in tops):
                tops.append((e, f))
            if len(tops) >= 5:
                break
        out(f"t={t:5.1f}s  " + "  ".join(f"{f:5d}Hz({e:.3f})" for e, f in tops))
        for e, f in tops:
            key = f//8*8
            all_peaks.setdefault(key, []).append((t, e))
        t += 2.0

    # 稳态音：在 ≥60% 的窗里都进 top5 的频率
    nwin = len(range(0, int(dur-1), 2))
    out("\n--- 稳态蜂鸣候选（出现率 ≥ 50% 的窗）---")
    steady = []
    for f, lst in sorted(all_peaks.items()):
        if len(lst) >= nwin*0.5:
            avg = sum(e for _, e in lst)/len(lst)
            steady.append((avg, f, len(lst), nwin))
    if steady:
        steady.sort(reverse=True)
        for avg, f, c, tot in steady[:12]:
            out(f"  ~{f}Hz  平均幅 {avg:.3f}  出现 {c}/{tot} 窗")
    else:
        out("  （无）")

if __name__ == '__main__':
    if len(sys.argv) > 2:
        OUT = open(sys.argv[2], 'w', encoding='utf-8')
    try:
        main(sys.argv[1])
    except BaseException:
        import traceback
        out('ERROR:\n' + traceback.format_exc())
    if OUT: OUT.close()
