#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
APP_ROOT="$SCRIPT_DIR/接口现场助手.app/Contents/Resources"
NODE="$APP_ROOT/runtime/node"
LAUNCHER="$APP_ROOT/companion/src/native-harness/launcher.js"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "[错误] 第一版仅支持 Apple Silicon（M1/M2/M3/M4）。"
  read -k 1 "?按任意键关闭……"
  exit 1
fi

if [[ ! -x "$NODE" || ! -f "$LAUNCHER" ]]; then
  echo "[错误] 发行包不完整，请重新解压整个 ZIP。"
  read -k 1 "?按任意键关闭……"
  exit 1
fi

echo "正在启动接口现场助手，诊断日志会保留在用户 Library/Logs 目录。"
"$NODE" "$LAUNCHER"
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "启动失败，退出码：$STATUS"
  read -k 1 "?按任意键关闭……"
fi
exit $STATUS
