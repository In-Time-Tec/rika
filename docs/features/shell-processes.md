# Shell processes

Agents use `bash` to run one shell command string in the Workspace and `shell_command_status` to wait for new output from a still-running process. `bash` accepts an optional working directory and initial wait in milliseconds. Calls that outlive that wait return a process identifier, and later polls return only newly retained output.

Working directories stay inside the Workspace. Output is continuously drained but bounded in memory and responses; unknown or completed process identifiers fail, and processes still running when their owning scope closes are terminated.
