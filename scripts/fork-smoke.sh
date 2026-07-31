#!/bin/zsh
# Smoke-test a herdr fork binary's floating-pane feature against a scratch
# session — never the live server.
#
# Usage: scripts/fork-smoke.sh /path/to/herdr-binary
set -euo pipefail

BIN="${1:?usage: fork-smoke.sh <herdr-binary>}"
SESSION="f7smoke"
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

req() { printf '%s\n' "$2" | nc -U "$1" -w 3 }

cleanup() {
  req "$SOCK" '{"id":"x","method":"server.stop","params":{}}' >/dev/null 2>&1 || true
  pkill -f "sandbox.py $SESSION" 2>/dev/null || true
}
trap cleanup EXIT

echo "== boot scratch session with $BIN"
"$BIN" session stop "$SESSION" >/dev/null 2>&1 || true
"$BIN" session delete "$SESSION" >/dev/null 2>&1 || true
HERDR_VOICE_BIN="$BIN" python3 - "$SESSION" <<'EOF' &
import os, pty, fcntl, termios, struct, sys, time
session = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ); env.pop("HERDR_ENV", None); env["TERM"] = "xterm-256color"
    os.execvpe(env["HERDR_VOICE_BIN"], [env["HERDR_VOICE_BIN"], "--session", session], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
while True:
    try:
        if not os.read(fd, 65536): break
    except OSError: break
EOF
for _ in {1..30}; do [[ -S "$SOCK" ]] && break; sleep 0.5; done
[[ -S "$SOCK" ]] || { echo "FAIL: scratch session never came up"; exit 1 }

echo "== ping"
PONG=$(req "$SOCK" '{"id":"1","method":"ping","params":{}}')
print -r -- "$PONG" | grep -q pong || { echo "FAIL: no pong"; exit 1 }
echo "protocol: $(print -r -- "$PONG" | grep -oE '"protocol":[0-9]+')"

echo "== floating open-time override accepted?"
R=$(req "$SOCK" "{\"id\":\"2\",\"method\":\"plugin.pane.open\",\"params\":{\"plugin_id\":\"herdr-voice\",\"entrypoint\":\"hud\",\"placement\":\"floating\",\"anchor\":\"top_right\",\"width\":\"42%\",\"height\":14}}")
print -r -- "$R"
print -r -- "$R" | grep -q '"result"' || { echo "FAIL: floating open rejected"; exit 1 }

sleep 2
echo "== pane.list shows floating flag without workspace_id?"
L=$(req "$SOCK" '{"id":"3","method":"pane.list","params":{}}')
print -r -- "$L" | python3 -c "
import json,sys
d=json.load(sys.stdin)
fl=[p for p in d['result']['panes'] if p.get('floating')]
assert fl, 'no floating pane in pane.list'
assert not fl[0].get('workspace_id'), 'floating pane has workspace_id'
print('floating pane:', fl[0]['pane_id'])
"

echo "== plugin.pane.close on floating"
C=$(req "$SOCK" '{"id":"4","method":"plugin.pane.close","params":{"plugin_id":"herdr-voice","entrypoint":"hud"}}')
print -r -- "$C" | grep -q '"result"' || { echo "WARN: close returned: $C" }

echo "== ALL SMOKE CHECKS PASSED"
