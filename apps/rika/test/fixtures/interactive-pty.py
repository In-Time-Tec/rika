import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import time

executable, cwd, environment_json, actions_json, *arguments = sys.argv[1:]
entrypoint, *entrypoint_arguments = arguments if arguments else ["src/client-main.ts"]
# A packaged binary carries its own entrypoint, so "" means "pass no script argument".
child_argv = [value for value in [entrypoint, *entrypoint_arguments] if value != ""]
environment = {key: value for key, value in json.loads(environment_json).items() if value is not None}
actions = json.loads(actions_json)
master, slave = pty.openpty()
rows = int(environment.pop("RIKA_TEST_TERMINAL_ROWS", 30))
columns = int(environment.pop("RIKA_TEST_TERMINAL_COLUMNS", 100))
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
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
    os.execve(executable, [executable, *child_argv], environment)

os.close(slave)

def restart(arguments):
    next_master, next_slave = pty.openpty()
    fcntl.ioctl(next_slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    child = os.fork()
    if child == 0:
        os.setsid()
        os.close(next_master)
        os.dup2(next_slave, 0)
        os.dup2(next_slave, 1)
        os.dup2(next_slave, 2)
        if next_slave > 2:
            os.close(next_slave)
        os.chdir(cwd)
        os.execve(executable, [executable, entrypoint, *arguments], environment)
    os.close(next_slave)
    return child, next_master

def children(parent):
    process_table = subprocess.run(
        ["ps", "-axo", "pid=,ppid="],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    children_by_parent = {}
    for row in process_table:
        fields = row.split()
        if len(fields) != 2:
            continue
        try:
            child, direct_parent = map(int, fields)
        except ValueError:
            continue
        children_by_parent.setdefault(direct_parent, []).append(child)
    descendants = []
    pending = list(children_by_parent.get(parent, []))
    while pending:
        child = pending.pop()
        descendants.append(child)
        pending.extend(children_by_parent.get(child, []))
    return descendants

output = bytearray()
action_index = 0
action_offset = 0
running_checks = []
replaced_descendants = []
status = None
timed_out = False
deadline = time.monotonic() + max(30, sum(action.get("timeoutMs", 10_000) for action in actions) / 1000 + 8)
action_started = time.monotonic()
blocked_action = None
terminal_control = re.compile(rb"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])")

def queued_count():
    try:
        with sqlite3.connect(f"file:{environment['RIKA_DATABASE']}?mode=ro", uri=True, timeout=0) as database:
            row = database.execute("SELECT COALESCE(SUM(queued_count), 0) FROM rika_thread_queue_state").fetchone()
            return row[0] if row else 0
    except (KeyError, sqlite3.Error):
        return 0

def queue_revision(prompt):
    try:
        with sqlite3.connect(f"file:{environment['RIKA_DATABASE']}?mode=ro", uri=True, timeout=0) as database:
            row = database.execute(
                "SELECT queue.revision FROM rika_thread_queue_state queue JOIN rika_turns turn ON turn.thread_id = queue.thread_id WHERE turn.status = 'queued' AND turn.prompt = ?",
                (prompt,),
            ).fetchone()
            return row[0] if row else None
    except (KeyError, sqlite3.Error):
        return None

def turn_status(prompt):
    try:
        with sqlite3.connect(f"file:{environment['RIKA_DATABASE']}?mode=ro", uri=True, timeout=0) as database:
            row = database.execute(
                "SELECT status FROM rika_turns WHERE prompt = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (prompt,),
            ).fetchone()
            return row[0] if row else None
    except (KeyError, sqlite3.Error):
        return None

master_closed = False
while time.monotonic() < deadline:
    if master_closed:
        time.sleep(0.005)
    else:
        ready, _, _ = select.select([master], [], [], 0.005)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                _, status = os.waitpid(pid, 0)
                break
            if not chunk:
                _, status = os.waitpid(pid, 0)
                break
            output.extend(chunk)
    while action_index < len(actions):
        action = actions[action_index]
        after = action.get("after")
        action_output = output[action_offset:]
        if action.get("visible", False):
            action_output = terminal_control.sub(b"", action_output)
        if after is not None and after.encode() not in action_output:
            break
        if "queueCount" in action and queued_count() != action["queueCount"]:
            break
        if "queueRevision" in action and queue_revision(action["queuePrompt"]) != action["queueRevision"]:
            break
        if "turnStatus" in action and turn_status(action["turnPrompt"]) != action["turnStatus"]:
            break
        waited, current_status = os.waitpid(pid, os.WNOHANG)
        running = waited == 0
        if action.get("checkRunning", False):
            running_checks.append(running)
        if not running:
            status = current_status
            break
        for size in action.get("resizes", []):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", size["height"], size["width"], 0, 0))
            os.killpg(pid, signal.SIGWINCH)
        delay_ms = action.get("delayMs", 0)
        if delay_ms > 0:
            time.sleep(delay_ms / 1000)
        for path, contents in action.get("files", {}).items():
            target = os.path.join(cwd, path)
            if contents is None:
                try:
                    os.remove(target)
                except FileNotFoundError:
                    pass
            else:
                os.makedirs(os.path.dirname(target) or cwd, exist_ok=True)
                with open(target, "w") as file:
                    file.write(contents)
        resize = action.get("resize")
        if resize is not None:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", resize["height"], resize["width"], 0, 0))
            os.kill(pid, signal.SIGWINCH)
        signal_name = action.get("signal")
        if signal_name is not None:
            os.killpg(pid, getattr(signal, signal_name))
        if action.get("closePty", False) and not master_closed:
            master_closed = True
            os.close(master)
        restart_arguments = action.get("restartArguments")
        if restart_arguments is None:
            write = action.get("write")
            if write is not None and not master_closed:
                if resize is not None:
                    time.sleep(0.5)
                for fragment in write.split("\0"):
                    os.write(master, fragment.encode())
                    time.sleep(0.001)
        else:
            replaced_descendants.extend(children(pid))
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(master)
            pid, master = restart(restart_arguments)
        action_index += 1
        action_started = time.monotonic()
        action_offset = len(output)
    if status is not None:
        break
    if action_index < len(actions) and time.monotonic() - action_started >= actions[action_index].get("timeoutMs", 10_000) / 1000:
        timed_out = True
        blocked_action = actions[action_index]
        break
    waited, current_status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = current_status
        break

if status is None:
    timed_out = timed_out or time.monotonic() >= deadline
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    stop_deadline = time.monotonic() + 2
    while time.monotonic() < stop_deadline:
        waited, current_status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            status = current_status
            break
        time.sleep(0.005)
if status is None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)

for child in replaced_descendants:
    try:
        os.kill(child, signal.SIGTERM)
    except ProcessLookupError:
        pass

while not master_closed:
    ready, _, _ = select.select([master], [], [], 0)
    if not ready:
        break
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    output.extend(chunk)

if master_closed:
    final_height, final_width = 0, 0
else:
    final_height, final_width, _, _ = struct.unpack("HHHH", fcntl.ioctl(master, termios.TIOCGWINSZ, b"\0" * 8))
    os.close(master)
print(json.dumps({
    "output": base64.b64encode(output).decode(),
    "exitCode": os.waitstatus_to_exitcode(status),
    "actionsCompleted": action_index,
    "runningChecks": running_checks,
    "timedOut": timed_out,
    "blockedAction": blocked_action,
    "finalWidth": final_width,
    "finalHeight": final_height,
}))
