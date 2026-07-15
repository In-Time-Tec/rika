import base64
import json
import os
import pty
import select
import signal
import sys
import termios
import time

binary, cwd, env_json, *arguments = sys.argv[1:]
idle = arguments == ["idle"]
palette_quit = arguments == ["palette-quit"]
environment = json.loads(env_json)
master, slave = pty.openpty()
baseline = termios.tcgetattr(slave)
pid = os.fork()
if pid == 0:
    os.setsid()
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.chdir(cwd)
    os.execve(binary, [binary], environment)

os.close(slave)
output = bytearray()
deadline = time.monotonic() + 10
submitted = False
paste_collapsed = False
shortcuts_opened = False
mode_opened = False
mention_opened = False
mention_sent_at = 0.0
sent_at = 0.0
shortcuts_sent_at = 0.0
escape_sent_at = 0.0
mode_sent_at = 0.0
mode_escape_sent_at = 0.0
palette_opened = False
quit_sent = False
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
    if idle and b"Welcome to Rika" in output and time.monotonic() + 0.5 < deadline:
        deadline = time.monotonic() + 0.5
    if palette_quit and not palette_opened and b"Welcome to Rika" in output:
        os.write(master, b"\x0f")
        palette_opened = True
    if palette_quit and palette_opened and not quit_sent and b"Command Palette" in output:
        os.write(master, b"quit\r")
        quit_sent = True
    if palette_quit and quit_sent:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            break
    if not idle and not palette_quit and not shortcuts_opened and b"Welcome to Rika" in output:
        os.write(master, b"?")
        shortcuts_opened = True
        shortcuts_sent_at = time.monotonic()
    if shortcuts_opened and not mode_opened and time.monotonic() - shortcuts_sent_at > 0.15:
        os.write(master, b"\x1b")
        escape_sent_at = time.monotonic()
        mode_opened = True
    if mode_opened and mode_sent_at == 0.0 and time.monotonic() - escape_sent_at > 0.15:
        os.write(master, b"\x13")
        mode_sent_at = time.monotonic()
    if mode_sent_at > 0.0 and mode_escape_sent_at == 0.0 and time.monotonic() - mode_sent_at > 0.15:
        os.write(master, b"\x1b")
        mode_escape_sent_at = time.monotonic()
    if mode_escape_sent_at > 0.0 and not mention_opened and time.monotonic() - mode_escape_sent_at > 0.15:
        os.write(master, b"@")
        mention_opened = True
        mention_sent_at = time.monotonic()
    if mention_opened and not submitted and not paste_collapsed and time.monotonic() - mention_sent_at > 0.15:
        os.write(master, b"\x1b")
        paste_collapsed = True
        sent_at = time.monotonic()
    if paste_collapsed and not submitted and sent_at > 0.0 and time.monotonic() - sent_at > 0.15:
        os.write(master, b"before \x1b[200~first line\nsecond line\x1b[201~")
        sent_at = 0.0
    if paste_collapsed and not submitted and b"[Pasted text #1 +2 lines]" in output:
        os.write(master, b" after\r")
        submitted = True
        sent_at = time.monotonic()
    if not idle and not palette_quit and submitted and (b"deterministic response" in output or b"ExecutionBackendError" in output or b"Execution failed" in output):
        break

fallback_signal_used = False
if status is None:
    fallback_signal_used = True
    os.kill(pid, signal.SIGKILL if palette_quit else signal.SIGINT)
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(master, 65536)
            if chunk:
                output.extend(chunk)
        except OSError:
            pass
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        break
if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)

deadline = time.monotonic() + 1
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if not ready:
        continue
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    output.extend(chunk)

restored = termios.tcgetattr(master)
os.close(master)
print(json.dumps({
    "capture": base64.b64encode(output).decode(),
    "pasteCollapsed": paste_collapsed and b"[Pasted text #1 +2 lines]" in output,
    "submitted": submitted,
    "exited": status is not None,
    "exitCode": None if status is None else os.waitstatus_to_exitcode(status),
    "paletteVisible": b"Command Palette" in output,
    "quitSelected": quit_sent,
    "fallbackSignalUsed": fallback_signal_used,
    "termiosRestored": baseline == restored,
}))
