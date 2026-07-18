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

executable, cwd, environment_json, actions_json = sys.argv[1:]
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
    os.execve(executable, [executable, "src/client-main.ts"], environment)

os.close(slave)
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
        os.write(master, action["write"].encode())
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
