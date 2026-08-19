#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
APP_ROOT="$SCRIPT_DIR/接口现场助手.app/Contents/Resources"
NODE="$APP_ROOT/runtime/node"
STOPPER="$APP_ROOT/companion/src/diagnostics/stop-companion.js"

if [[ ! -x "$NODE" || ! -f "$STOPPER" ]]; then
  echo "[错误] 发行包不完整，请重新解压整个 ZIP。"
  read -k 1 "?按任意键关闭……"
  exit 1
fi

"$NODE" "$STOPPER"
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  read -k 1 "?停止失败，按任意键关闭……"
fi
exit $STATUS
