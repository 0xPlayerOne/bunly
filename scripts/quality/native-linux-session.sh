#!/usr/bin/env bash
# Run inside a dedicated Xvfb and DBus session. Never target a user's desktop.
set -euo pipefail

if (( $# < 3 )); then
  echo 'usage: native-linux-session.sh NEW_OUTPUT_DIR MODE COMMAND [ARGS...]' >&2
  exit 1
fi
evidence_dir=$1
mode=$2
shift 2
case "$mode" in
  development|aot|aot-input-race|javascript|aot-javascript|core-lifecycle|aot-core-lifecycle|--)
    ;;
  *)
    echo 'Choose development, aot, aot-input-race, javascript, aot-javascript, core-lifecycle, aot-core-lifecycle, or -- followed by an explicit command' >&2
    exit 1
    ;;
esac
mkdir "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd)
export XDG_RUNTIME_DIR="$evidence_dir/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
export GPUI_X11_SCALE_FACTOR=1
export LIBGL_ALWAYS_SOFTWARE=1
unset WAYLAND_DISPLAY WAYLAND_SOCKET ZED_HEADLESS

# Mesa's JSON filename differs between distribution versions. Require one
# software Vulkan ICD and keep its exact path in every evidence report.
shopt -s nullglob
software_icds=(/usr/share/vulkan/icd.d/lvp_icd*.json)
if (( ${#software_icds[@]} != 1 )); then
  echo 'Expected exactly one installed Mesa lavapipe ICD' >&2
  exit 1
fi
export VK_DRIVER_FILES="${software_icds[0]}"

openbox >"$evidence_dir/window-manager.log" 2>&1 &
window_manager=$!
cleanup_session() {
  kill "$window_manager" 2>/dev/null || true
  wait "$window_manager" 2>/dev/null || true
}
trap cleanup_session EXIT

for attempt in {1..50}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
    break
  fi
  if ! kill -0 "$window_manager" 2>/dev/null; then
    echo 'The test window manager exited before becoming ready' >&2
    exit 1
  fi
  sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'

if [[ "$mode" == -- ]]; then
  "$@"
  exit
fi

if [[ "$mode" == development ]]; then
  # This test reopens five real windows in one host and checks invalid states.
  timeout 45s bun tests/native/lifecycle.ts 2>&1 | tee "$evidence_dir/lifecycle.log"
fi

# Share the independent full-tree expectations with the repeated baseline.
snapshot() {
  python3 - "$mode" "$@" <<'PY'
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("native_input_linux", "scripts/quality/native-input-linux.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
if sys.argv[1] in ("javascript", "aot-javascript"):
    state = driver.javascript_fixture_paint(int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5]))
elif sys.argv[1] in ("core-lifecycle", "aot-core-lifecycle"):
    state = driver.lifecycle_fixture_paint(int(sys.argv[2]), sys.argv[3])
else:
    state = driver.fixture_paint(int(sys.argv[2]), sys.argv[3], sys.argv[4])
print(json.dumps(state))
PY
}

execution_mode=development
if [[ "$mode" == aot || "$mode" == aot-* ]]; then
  execution_mode=aot
fi

if [[ "$mode" == core-lifecycle || "$mode" == aot-core-lifecycle ]]; then
  python3 scripts/quality/native-input-linux.py \
    --output "$evidence_dir/lifecycle" --mode "$execution_mode" --timeout 60 \
    --title 'Bun Native public lifecycle' --expect-software-renderer \
    --expect-initial-render "$(snapshot 1 Ready)" --click 100 130 \
    --expect-event '{"type":"click","stage":"bun-application","sequence":1,"target":"public-lifecycle"}' \
    --expect-render "$(snapshot 3002 'Completed 1000 cycles')" -- "$@"
  exit
fi

if [[ "$mode" == javascript || "$mode" == aot-javascript ]]; then
  initial=$(snapshot 2 'Updates: 0' 'JavaScript is ready' 1)
  driver=(python3 scripts/quality/native-input-linux.py --mode "$execution_mode" --timeout 30
    --title 'Bun Native JavaScript' --expect-software-renderer --expect-initial-render "$initial")
  "${driver[@]}" --output "$evidence_dir/click" --click 100 130 \
    --expect-event '{"type":"click","stage":"bun-application","sequence":1,"target":"javascript-update"}' \
    --expect-render "$(snapshot 3 'Updates: 1' 'JavaScript is ready' 1)" -- "$@"
  "${driver[@]}" --output "$evidence_dir/input" --key ctrl+a --text 'Bun Native {nonce}' \
    --expect-event '{"type":"input","stage":"bun-application","sequence":43,"input_revision":44,"value":"Bun Native {nonce}"}' \
    --expect-render "$(snapshot 2 'Updates: 0' 'Bun Native {nonce}' 44)" -- "$@"
  exit
fi

initial=$(snapshot 1 'Clicks: 0' '')
driver=(python3 scripts/quality/native-input-linux.py --mode "$execution_mode" --timeout 30
  --title 'Bun Native BN1' --expect-software-renderer --expect-initial-render "$initial")

input_race() {
  "${driver[@]}" --output "$evidence_dir/input-race" --key ctrl+a --text 'Bun Native {nonce}' \
    --expect-event '{"type":"input","stage":"bun-application","sequence":43,"input_revision":43,"value":"Bun Native {nonce}"}' \
    --expect-render "$(snapshot 2 'Input preserved after stale rejection' 'Bun Native {nonce}')" \
    -- "$@"
}

if [[ "$mode" == aot-input-race ]]; then
  input_race "$@"
  exit
fi

"${driver[@]}" --output "$evidence_dir/click" --click 100 130 \
  --expect-event '{"type":"click","stage":"bun-application","sequence":1,"target":"increment"}' \
  --expect-render "$(snapshot 2 'Clicks: 1' '')" -- "$@"

# A fresh launch after a verified OS close must regain input focus and work.
"${driver[@]}" --output "$evidence_dir/input" --key ctrl+a --text 'Bun Native {nonce}' \
  --expect-event '{"type":"input","stage":"bun-application","sequence":43,"input_revision":43,"value":"Bun Native {nonce}"}' \
  --expect-render "$(snapshot 1 'Clicks: 0' 'Bun Native {nonce}')" -- "$@"

# Clicking focuses the actual button. Enter must produce a distinct second
# application event and a second committed tree update, not reuse click evidence.
"${driver[@]}" --output "$evidence_dir/keyboard" --click 100 130 --key Return \
  --expect-event '{"type":"click","stage":"bun-application","sequence":1,"target":"increment"}' \
  --expect-event '{"type":"click","stage":"bun-application","sequence":2,"target":"increment"}' \
  --expect-render "$(snapshot 3 'Clicks: 2' '')" \
  -- "$@"

if [[ "$mode" == development ]]; then
  # The raw runtime fixture rejects an old input revision, then commits an
  # unrelated label update. Native input must survive both operations unchanged.
  input_race bun tests/native/input-race.ts
fi
