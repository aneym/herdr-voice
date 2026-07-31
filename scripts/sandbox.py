#!/usr/bin/env python3
"""Launch a headless herdr session on a properly-sized pty.

herdr fails pane spawns with `ghostty error -2` when the controlling pty reports
rows=0/cols=0 (which `script -q /dev/null` does). We allocate a real pty, set an
explicit winsize, and keep it drained so the sandbox behaves like a real client.
"""
import os
import pty
import fcntl
import termios
import struct
import sys
import signal
import time

SESSION = sys.argv[1] if len(sys.argv) > 1 else "voicelab"
ROWS, COLS = 45, 160

pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ)
    env.pop("HERDR_ENV", None)  # allow nested herdr
    env["TERM"] = "xterm-256color"
    os.execvpe("herdr", ["herdr", "--session", SESSION], env)

# parent: set the window size the child sees
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
print(f"sandbox session '{SESSION}' pty pid={pid} size={ROWS}x{COLS}", flush=True)

# drain output forever so the client never blocks on a full pty buffer
def cleanup(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

while True:
    try:
        data = os.read(fd, 65536)
        if not data:
            break
    except OSError:
        break
    except KeyboardInterrupt:
        cleanup()
time.sleep(0.2)
