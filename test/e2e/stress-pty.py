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
import re

binary, cwd, env_json, options_json = sys.argv[1:]
environment = json.loads(env_json)
options = json.loads(options_json)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", options.get("rows", 40), options.get("columns", 120), 0, 0))
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
    arguments = options.get("arguments", [])
    os.execve(binary, [binary, *arguments], environment)

os.close(slave)
print(json.dumps({"type": "ready", "pid": pid}), flush=True)
output = bytearray()
started = time.monotonic()
deadline = started + (
    options.get("readyTimeoutMs", 10000)
    if options.get("readyTarget") is not None
    else options.get("durationMs", 30000)
) / 1000
requested_stop = False
requested_stop_at = None
quit_sent = False
status = None
observed_target = False
screen_ready = options.get("readyTarget") is None
action_started = started if screen_ready else None
cycle_options = options.get("cycle")
cycle_index = 0
confirmed_cycles = 0
cycle_stage = "startup"
cycle_at = started
selection_offset = 0
rows = options.get("rows", 40)
columns = options.get("columns", 120)
actions = sorted(enumerate(options.get("actions", [])), key=lambda item: item[1]["atMilliseconds"])
action_index = 0
pending_probes = []
snapshots = []
probe_latencies = []
key_sequences = {
    "enter": b"\r", "escape": b"\x1b", "tab": b"\t", "backspace": b"\x7f",
    "up": b"\x1b[A", "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D",
    "ctrl-c": b"\x03", "ctrl-t": b"\x14",
}

def semantic_screen():
    text = output.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[@-_]", "", text)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line[-columns:] for line in lines[-rows:])[-32768:]

def capture_action(index, action_type, now):
    snapshots.append({
        "actionIndex": index,
        "actionType": action_type,
        "timestampMilliseconds": round((now - started) * 1000),
        "rows": rows,
        "columns": columns,
        "screen": semantic_screen(),
    })

def perform_action(index, action, now):
    global rows, columns
    action_type = action["type"]
    if action_type == "write":
        if "text" in action:
            data = action["text"].encode()
        elif "bytes" in action:
            data = bytes(action["bytes"])
        else:
            data = key_sequences[action["key"]]
        os.write(master, data)
    elif action_type == "resize":
        rows = action["rows"]
        columns = action["columns"]
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(pid, signal.SIGWINCH)
    elif action_type == "signal":
        os.killpg(pid, signal.SIGSTOP if action["signal"] == "stop" else signal.SIGCONT)
    marker = action.get("expectedMarker")
    if marker is None:
        capture_action(index, action_type, now)
    else:
        pending_probes.append({
            "index": index,
            "type": action_type,
            "marker": marker,
            "offset": len(output),
            "started": now,
            "deadline": now + action.get("markerTimeoutMilliseconds", 3000) / 1000,
        })

def request_stop():
    global requested_stop, requested_stop_at
    if requested_stop:
        return
    requested_stop = True
    requested_stop_at = time.monotonic()
    try:
        os.write(master, b"\x0f")
    except OSError:
        pass

def continue_stop(now):
    global quit_sent
    if requested_stop_at is not None and not quit_sent and now >= requested_stop_at + 0.25:
        try:
            os.write(master, b"quit\r")
        except OSError:
            pass
        quit_sent = True

def handle_signal(_signum, _frame):
    request_stop()

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.025)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > 8388608:
            del output[:len(output) - 8388608]
    target = options.get("target")
    if target is not None and target.encode() in output:
        observed_target = True
    ready_target = options.get("readyTarget")
    if not screen_ready and ready_target is not None and ready_target.encode() in output:
        screen_ready = True
        action_started = time.monotonic()
        deadline = action_started + options.get("durationMs", 30000) / 1000
        print(json.dumps({"type": "screen-ready", "pid": pid}), flush=True)
    if cycle_options is not None and not requested_stop:
        targets = cycle_options["targets"]
        now = time.monotonic()
        if cycle_stage == "startup" and (b"Welcome to Rika" in output or any(target["marker"].encode() in output for target in targets)):
            cycle_stage = "waiting"
            cycle_at = now + 0.3
        elif cycle_index >= cycle_options["count"]:
            request_stop()
        elif cycle_stage == "waiting" and now >= cycle_at:
            os.write(master, b"\x14")
            cycle_stage = "query"
            cycle_at = now + cycle_options.get("stepDelayMs", 175) / 1000
        elif cycle_stage == "query" and now >= cycle_at:
            target_option = targets[cycle_index % len(targets)]
            os.write(master, target_option["query"].encode())
            cycle_stage = "select"
            cycle_at = now + cycle_options.get("stepDelayMs", 175) / 1000
        elif cycle_stage == "select" and now >= cycle_at:
            os.write(master, b"\r")
            selection_offset = len(output)
            cycle_stage = "confirm"
            cycle_at = now + 3
        elif cycle_stage == "confirm":
            marker = targets[cycle_index % len(targets)]["marker"].encode()
            if marker in output[selection_offset:]:
                confirmed_cycles += 1
                cycle_index += 1
                cycle_stage = "waiting"
                cycle_at = now + cycle_options.get("stepDelayMs", 175) / 1000
            elif now >= cycle_at:
                request_stop()
    now = time.monotonic()
    continue_stop(now)
    while action_started is not None and action_index < len(actions) and now >= action_started + actions[action_index][1]["atMilliseconds"] / 1000:
        original_index, action = actions[action_index]
        try:
            perform_action(original_index, action, now)
        except (OSError, KeyError, ValueError) as error:
            print(json.dumps({"type": "action-error", "actionIndex": original_index, "error": str(error)})[:4096], file=sys.stderr, flush=True)
        action_index += 1
    remaining_probes = []
    for probe in pending_probes:
        marker_found = probe["marker"].encode() in output[probe["offset"]:]
        if marker_found or now >= probe["deadline"]:
            latency = round((now - probe["started"]) * 1000)
            probe_latencies.append({
                "actionIndex": probe["index"], "marker": probe["marker"],
                "latencyMilliseconds": latency, "observed": marker_found,
            })
            capture_action(probe["index"], probe["type"], now)
        else:
            remaining_probes.append(probe)
    pending_probes = remaining_probes
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        break

if status is None:
    request_stop()
    graceful_stop_seconds = options.get("gracefulStopMs", 2000) / 1000
    exit_deadline = time.monotonic() + max(5, graceful_stop_seconds + 3)
    next_interrupt = time.monotonic() + graceful_stop_seconds
    while time.monotonic() < exit_deadline:
        now = time.monotonic()
        continue_stop(now)
        if now >= next_interrupt:
            try:
                os.killpg(pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            next_interrupt = now + 1
        ready, _, _ = select.select([master], [], [], 0.025)
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
    os.killpg(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)

now = time.monotonic()
for probe in pending_probes:
    marker_found = probe["marker"].encode() in output[probe["offset"]:]
    probe_latencies.append({
        "actionIndex": probe["index"], "marker": probe["marker"],
        "latencyMilliseconds": round((now - probe["started"]) * 1000), "observed": marker_found,
    })
    capture_action(probe["index"], probe["type"], now)

os.close(master)
print(json.dumps({
    "type": "result",
    "pid": pid,
    "capture": base64.b64encode(output).decode(),
    "exitCode": os.waitstatus_to_exitcode(status),
    "observedTarget": observed_target,
    "confirmedCycles": confirmed_cycles,
    "requestedCycles": 0 if cycle_options is None else cycle_options["count"],
    "durationMilliseconds": round((time.monotonic() - started) * 1000),
    "snapshots": snapshots[-256:],
    "probeLatencies": probe_latencies[-256:],
    "finalRows": rows,
    "finalColumns": columns,
}), flush=True)
