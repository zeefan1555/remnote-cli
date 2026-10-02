#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"
source "${SCRIPT_DIR}/node-check.sh"

confirmed=0
preflight_only=0
modes=0
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) confirmed=1; shift ;;
    --preflight-only) preflight_only=1; shift ;;
    --command) modes=$((modes + 1)); args=("$@"); break ;;
    --transactions-only) modes=$((modes + 1)); args+=("$1"); shift ;;
    --flashcards-only)
      modes=$((modes + 1))
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        printf '%s\n' '--flashcards-only requires an existing HOME concept title.' >&2; exit 1
      fi
      args+=("$1" "$2"); shift 2 ;;
    --help|-h)
      printf '%s\n' 'Usage: ./run-agent-integration-test.sh --preflight-only' \
        '       ./run-agent-integration-test.sh --yes [--flashcards-only <HOME concept>]' \
        '       ./run-agent-integration-test.sh --yes --transactions-only' \
        '       ./run-agent-integration-test.sh --yes --command <CLI arguments...>' \
        'Uses the private pairing file. Refuses occupied ports; never starts or stops a daemon.'
      exit 0 ;;
    --suite|--suite=*) printf '%s\n' 'Only direct CLI tests exist; remove --suite.' >&2; exit 1 ;;
    *) printf 'Unknown wrapper argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
if (( modes > 1 )); then
  printf '%s\n' 'Choose exactly one live test mode.' >&2; exit 1
fi

node --import tsx test/integration/preflight.ts
if (( preflight_only == 1 )); then exit 0; fi
if (( confirmed != 1 )); then
  printf '%s\n' 'Live tests create real [CLI-TEST] notes. Explicit --yes is required.' >&2
  exit 1
fi
npm run build
if (( ${#args[@]} > 0 )); then
  exec npm run test:integration:cli -- --yes "${args[@]}"
fi
exec npm run test:integration:cli -- --yes
