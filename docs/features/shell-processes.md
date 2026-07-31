# Shell processes

Agents use `bash` to run one shell command string in the Workspace and `shell_command_status` to wait for new output from a still-running process. Direct shell input and tool calls run immediately with the authority of the OS user who invoked Rika. Rika does not confine them to the Workspace. `bash` accepts an optional working directory and initial wait in milliseconds. Calls that outlive that wait return a process identifier, and later polls return only newly retained output.

Working directories may be anywhere that OS user can reach. A hardcoded, non-configurable circuit breaker refuses recursive deletion of the filesystem root or home directory and shell fork bombs. These catastrophic-command guards are not user controls or a sandbox and cannot be overridden. Output is continuously drained but bounded in memory and responses; unknown or completed process identifiers fail, and processes still running when their owning scope closes are terminated.
