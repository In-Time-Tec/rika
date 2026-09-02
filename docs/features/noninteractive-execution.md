# Noninteractive execution

Automation can run one prompt with `rika run` or `rika --execute` (`-x`). Both accept the interactive selection flags and can emit newline-delimited execution events with `--stream-json`; normal output prints the final model response. The JSON stream projects turns, native tool calls, subagents, and outcomes. It does not emit the system prompt or other model instructions.

`rika run --thread <thread-id> "<prompt>"` submits one prompt to an existing hosted Thread over the Thread WebSocket, stays attached until the Turn it admitted settles, and prints that Turn's final assistant text. If another Turn is active the prompt is durably queued and the command waits for its own Turn. A rejected submission, a failed or cancelled Turn, or an execution failure for that Turn exits with the failure message. The hosted path prints plain text only; `--stream-json` does not change its output.

`--stream-json-input` reads newline-delimited JSON from standard input when no prompt argument is supplied. Each nonblank line must be a JSON string or an object with a string `prompt`; malformed input names the failing line, and JSON input requires `--stream-json`.
