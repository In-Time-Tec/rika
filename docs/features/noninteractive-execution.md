# Noninteractive execution

Automation can run one prompt with `rika run` or `rika --execute` (`-x`). Both accept the interactive selection flags and can emit newline-delimited execution events with `--stream-json`; normal output prints the final model response. The JSON stream projects turns, native tool calls, subagents, and outcomes. It does not emit the system prompt or other model instructions.

`--stream-json-input` reads newline-delimited JSON from standard input when no prompt argument is supplied. Each nonblank line must be a JSON string or an object with a string `prompt`; malformed input names the failing line, and JSON input requires `--stream-json`.
