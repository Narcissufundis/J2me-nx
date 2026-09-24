#!/bin/bash
# build-classes.sh — 构建 PluotSorbet 的 phoneME 类库 classes.jar
# 复刻上游 java/Makefile 的流程（Soot 优化已被上游注释掉，无需 Soot）。
# 用法: bash tools/build-classes.sh   （在项目根目录执行）
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAVA_DIR="$ROOT/java"
PY="/c/Users/Admin/.workbuddy/binaries/python/versions/3.13.12/python.exe"
cd "$ROOT"

echo "[0/5] 生成 l10n 资源与 ResourceConstants ..."
rm -rf java/l10n
mkdir -p java/l10n java/custom/com/sun/midp/i18n java/custom/com/sun/midp/l10n
for f in l10n/*.xml; do
  "$PY" tools/xml_to_json.py "$f" "java/${f%.xml}.json"
done
"$PY" tools/xml_to_java_classes.py l10n/en-US.xml

cd "$JAVA_DIR"

# 上游 Makefile 默认开关（顶层 Makefile: JSR_256/082/179 均 =1）
SRC_DIRS="cldc1.1.1 vm midp custom jsr-256 jsr-179 jsr-082"
JPP_DEFS="-DENABLE_JSR_205 -DENABLE_SSL -DENABLE_PUBLICKEYSTORE -DENABLE_JSR_211 \
-DENABLE_MULTIPLE_ISOLATES -DRECORD -DUSE_FILE_CONNECTION -DENABLE_JSR_234 \
-DENABLE_JSR_256 -DENABLE_JSR_179"

echo "[1/5] 编译 Jpp 预处理器..."
javac -d tools tools/Jpp.java 2>&1 | grep -v "已过时\|bootstrap\|引导" || true

echo "[2/5] 预处理 .jpp -> .java ..."
for f in $(find $SRC_DIRS -name "*.jpp"); do
  java -classpath tools Jpp "$f" $JPP_DEFS -o "${f%.jpp}.java"
done
echo "      处理了 $(find $SRC_DIRS -name '*.jpp' | wc -l) 个 .jpp"

echo "[3/5] 汇集源码..."
rm -rf build build-src
mkdir build build-src
for dir in $SRC_DIRS; do
  cp -a "$dir"/. build-src/
done
find ./build-src -name "*.java" > build-srcs.txt
echo "      $(wc -l < build-srcs.txt) 个源文件"

echo "[4/5] javac 编译（-source 1.3 -target 1.3，JDK8 仍支持，仅警告）..."
javac -nowarn -Xlint:none \
  -cp build-src -g:none -source 1.3 -target 1.3 \
  -bootclasspath "" -extdirs "" \
  -d ./build @build-srcs.txt
rm -rf build-src

echo "[5/5] 打包 classes.jar..."
cd build && jar cf0 ../classes.jar * && cd ..
# 附加资源（png/bin/l10n json），上游 EXTRA
EXTRA=$(find . -path ./build -prune -o \( -name "*.png" -o -name "*.bin" \) -print; find ./l10n -name "*.json" 2>/dev/null || true)
if [ -n "$EXTRA" ]; then
  jar uf0 classes.jar $EXTRA
fi

ls -la classes.jar
echo "DONE: $JAVA_DIR/classes.jar"
