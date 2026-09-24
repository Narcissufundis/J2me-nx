import zipfile, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
z = zipfile.ZipFile(r'D:\新建文件夹\游戏相关\修改版游戏\J2ME整理\能玩\Ferrari GT 3_ World Track.jar')
il = z.infolist()
total = sum(i.file_size for i in il)
out = ['entries: %d, uncompressed: %d KB' % (len(il), total // 1024)]
for i in il:
    n = i.filename.lower()
    if any(n.endswith(e) for e in ('.wav', '.mid', '.midi', '.mp3', '.amr', '.ogg', '.png')):
        out.append('%10d  %s' % (i.file_size, i.filename))
open(r'F:\Deepseek\j2me-nx-port\jar_audio.txt', 'w', encoding='utf-8').write('\n'.join(out))
