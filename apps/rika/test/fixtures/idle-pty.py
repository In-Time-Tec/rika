"""Runs the Rika launcher on a real PTY and forwards this process's stdin into it.

The forwarding loop blocks in select so the fixture itself contributes no idle CPU
to the measurement it exists to take.
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

executable, entrypoint = sys.argv[1], sys.argv[2]
rows = int(os.environ.get("RIKA_IDLE_GATE_ROWS", "36"))
columns = int(os.environ.get("RIKA_IDLE_GATE_COLUMNS", "120"))

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

child = os.fork()
if child == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.execve(executable, [executable, entrypoint], os.environ.copy())

os.close(slave)
stdin = sys.stdin.buffer.fileno()
sources = [master, stdin]

while sources:
    readable, _, errored = select.select(sources, [], sources)
    for source in readable + errored:
        try:
            data = os.read(source, 65536)
        except OSError:
            data = b""
        if not data:
            sources.remove(source)
            if source is master:
                sources = []
            continue
        if source is stdin:
            os.write(master, data)

try:
    os.kill(child, 15)
except OSError:
    pass
os.waitpid(child, 0)
