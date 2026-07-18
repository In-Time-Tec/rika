import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

executable, cwd, environment_json, actions_json, *arguments = sys.argv[1:]
entrypoint = arguments[0] if arguments else "src/client-main.ts"
environment = {key: value for key, value in json.loads(environment_json).items() if value is not None}
actions = json.loads(actions_json)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
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
    os.execve(executable, [executable, entrypoint], environment)

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
    matches = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as stat:
                fields = stat.read().split()
            if int(fields[3]) == parent:
                matches.append(int(entry))
        except (FileNotFoundError, ProcessLookupError, ValueError):
            pass
    return matches

output = bytearray()
action_index = 0
action_offset = 0
running_checks = []
status = None
timed_out = False
deadline = time.monotonic() + 30

while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.025)
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
        if action["after"].encode() not in output[action_offset:]:
            break
        waited, current_status = os.waitpid(pid, os.WNOHANG)
        running = waited == 0
        if action.get("checkRunning", False):
            running_checks.append(running)
        if not running:
            status = current_status
            break
        delay_ms = action.get("delayMs", 0)
        if delay_ms > 0:
            time.sleep(delay_ms / 1000)
        restart_arguments = action.get("restartArguments")
        if restart_arguments is None:
            os.write(master, action["write"].encode())
        else:
            for child in children(pid):
                os.kill(child, signal.SIGKILL)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(master)
            pid, master = restart(restart_arguments)
        action_index += 1
        action_offset = len(output)
    if status is not None:
        break
    waited, current_status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = current_status
        break

if status is None:
    timed_out = True
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
        time.sleep(0.025)
if status is None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)

while True:
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

os.close(master)
print(json.dumps({
    "output": base64.b64encode(output).decode(),
    "exitCode": os.waitstatus_to_exitcode(status),
    "actionsCompleted": action_index,
    "runningChecks": running_checks,
    "timedOut": timed_out,
}))
