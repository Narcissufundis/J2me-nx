#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-softrestart-jars.py — 造两个仅"分辨率标记"不同的测试 jar。

复用 data/midlet.jar 的内容（可真实运行），各注入一组目录命名条目，
让 main.js detectGameResolution 的"条目名"线索命中指定分辨率：
  A.jar -> 176x220   B.jar -> 240x320
"""
import sys, zipfile, shutil, os

SRC = r"F:\Deepseek\j2me-nx-port\data\midlet.jar"
OUT = r"F:\Deepseek\j2me-nx-port\tools\tmp-softrestart"

def make(dst, res, n=20):
    os.makedirs(OUT, exist_ok=True)
    if os.path.exists(dst):
        os.remove(dst)
    with zipfile.ZipFile(SRC, 'r') as zin, \
         zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        # 注入 20 个 "<res>/marker_i.txt" 条目 → 条目名线索 count>=40，稳压原生内容
        for i in range(n):
            zout.writestr("%s/marker_%d.txt" % (res, i), b"x")
    print("wrote", dst)

make(os.path.join(OUT, "A_176x220.jar"), "176x220")
make(os.path.join(OUT, "B_240x320.jar"), "240x320")
