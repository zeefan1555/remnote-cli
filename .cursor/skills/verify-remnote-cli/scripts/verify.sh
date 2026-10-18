#!/usr/bin/env bash
# verify-remnote-cli：构建并驱动本仓库的 remnote-cli，离线、隔离配置，不连真实 RemNote。
# 用法: verify.sh [all|build|unit|cli|pair|status] [证据目录]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CLI="$ROOT"
MODE="${1:-all}"
ER="${VERIFY_EVIDENCE_ROOT:-/workspace/verify-evidence}"; [ -w "$(dirname "$ER")" ] || ER="$HOME/verify-evidence"
EV="${2:-$ER/remnote-cli/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EV"; chmod 700 "$EV"
# 需要 node >= 22.13：优先 REMNOTE_NODE_BIN 目录，其次 box 上的便携 node24，最后 PATH 里的 node
for d in "${REMNOTE_NODE_BIN:-}" "$HOME/.local/opt/node-v24.21.0-linux-x64/bin"; do [ -n "$d" ] && [ -x "$d/node" ] && { export PATH="$d:$PATH"; break; }; done
CFG="$(mktemp -d -t remnote-verify.XXXX)"; export REMNOTE_CLI_CONFIG="$CFG/connection.json"   # 绝不读写真实 ~/.config/remnote-cli
trap 'rm -rf "$CFG"' EXIT
PORT="${VERIFY_PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')}"
rc(){ node "$CLI/dist/remnote-cli/index.js" "$@"; }
# GNU coreutils 优先，不支持时回退 BSD（macOS）。探测只决定用哪条命令；Linux 上仍是 stat -c %a 与 date -Iseconds。
if stat -c %a /dev/null >/dev/null 2>&1; then file_mode(){ stat -c %a "$1"; }; else file_mode(){ stat -f %Lp "$1"; }; fi
if date -Iseconds >/dev/null 2>&1; then iso_now(){ date -Iseconds; }; else iso_now(){ date +%Y-%m-%dT%H:%M:%S%z; }; fi
fails=()
step(){ local n="$1"; shift; echo "== $n"; if "$@" >"$EV/$n.log" 2>&1; then echo "PASS $n"; else echo "FAIL $n (见 $EV/$n.log)"; fails+=("$n"); fi; }
# expect <期望退出码> <正则> <参数...>
expect(){ local want="$1" re="$2"; shift 2; local out code; out="$(rc "$@" 2>&1)"; code=$?
  printf '$ remnote-cli %s\n%s\n[exit %s]\n' "$*" "$(sed -E 's/("token"[[:space:]]*:[[:space:]]*")[^"]*/\1<redacted>/' <<<"$out")" "$code"
  [ "$code" = "$want" ] || { echo "退出码 $code != $want"; return 1; }
  grep -qE -- "$re" <<<"$out" || { echo "未匹配: $re"; return 1; }; }

build(){ node --version; cd "$CLI" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build; }
unit(){ cd "$CLI" && npm test; }
cli(){ expect 0 "^[0-9]+\.[0-9]+\.[0-9]+" --version && expect 0 "Direct RemNote SDK automation" --help && expect 0 "Preview a flashcards plan" flashcards --help; }
pair(){
  expect 0 '"paired": ?false' --kb-id verify-kb --port "$PORT" pair || return 1
  local mode; mode="$(file_mode "$REMNOTE_CLI_CONFIG")"
  echo "pairing 文件权限 $mode"; [ "$mode" = 600 ] || return 1
  python3 -c "import json,sys;c=json.load(open(sys.argv[1]));assert c['knowledgeBaseId']=='verify-kb' and c['port']==int(sys.argv[2]) and len(c['token'])>=16;print('keys',sorted(c))" "$REMNOTE_CLI_CONFIG" "$PORT"
}
status(){ [ -f "$REMNOTE_CLI_CONFIG" ] || rc --kb-id verify-kb --port "$PORT" pair >/dev/null; expect 1 "Plugin connection timed out" --port "$PORT" status; }

case "$MODE" in
  all) step build build; step unit unit; step cli cli; step pair pair; step status status ;;
  build|unit|cli|pair|status) [ -f "$CLI/dist/remnote-cli/index.js" ] || [ "$MODE" = build ] || [ "$MODE" = unit ] || step build build; step "$MODE" "$MODE" ;;
  *) echo "未知模式 $MODE"; exit 2 ;;
esac
outcome=passed; [ ${#fails[@]} = 0 ] || outcome=failed
printf '{"repo":"remnote-cli","head":"%s","mode":"%s","outcome":"%s","failed":"%s","node":"%s","time":"%s"}\n' \
  "$(git -C "$ROOT" rev-parse HEAD)" "$MODE" "$outcome" "${fails[*]:-}" "$(node --version)" "$(iso_now)" >"$EV/manifest.json"
echo "outcome=$outcome evidence=$EV"
[ "$outcome" = passed ]
