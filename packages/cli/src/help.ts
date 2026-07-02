import { homedir } from "node:os"
import { Effect } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export const terminalResetText = "\u001b[=0u\u001b[<u\u001b[?25h"

export const versionHelpStdoutText = `Usage: amp version [options]

Print the version number and exit

Options:
  -h, --help  display help for command
`

export const logoutHelpStdoutText = (homeDir = homedir()) => `Usage: amp logout [options]

Log out by removing stored API key

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const loginHelpStdoutText = (homeDir = homedir()) => `Usage: amp login [options]

Log in to Amp

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

If AMP_URL is set during login, it will be persisted to global settings for future CLI invocations, though AMP_URL will continue to take precedence.
`

export const cloneHelpStdoutText = (homeDir = homedir()) => `Usage: amp clone [options] <repository> [target-dir]

Clone a workspace repository

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const topHelpStdoutText = (homeDir = homedir()) => `Usage: amp top [options]

Show a live list of active threads across all repositories.

Options:

  --stream-jsonl
      Stream a JSON line whenever the thread list changes (output schema is EXPERIMENTAL)

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const lastHelpStdoutText = (homeDir = homedir()) => `Usage: amp last [options]

Continue the last thread directly.

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads [options] [command]

Thread management commands. When no subcommand is provided, defaults to listing threads.

Commands:

  new         [alias: n] Create a new thread
  continue    [alias: c] Continue an existing thread
  list        [alias: l, ls] List all threads
  usage       Show usage information for a thread
  visibility  [alias: v] Show or set default visibility for this repository
  search      [alias: find] Search threads
  label       Add labels to a thread
  share       [alias: s] Share a thread
  report      Generate and send a diagnostic report for a thread to provide to Amp support
  rename      [alias: r] Rename a thread
  archive     Archive a thread
  delete      Delete a thread
  markdown    [alias: md] Render thread as markdown
  export      Export a thread as JSON
  raw         [alias: raw-thread] Export raw actor thread data as JSON

Options:

  --include-archived
      Include archived threads in the list
  --limit <number>
      Maximum number of threads to return
  --offset <number>
      Number of threads to skip

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsNewHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads new [options]

Create a new thread and print its ID. The thread will be empty. You can set the visibility using the --visibility option.

Options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)

Global options:

  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsContinueHelpStdoutText = (
  homeDir = homedir(),
) => `Usage: amp threads continue [options] [threadIDOrURLs...]

Continue an existing thread by resuming the conversation. By default, interactive mode shows a picker. Use --last to continue the last thread for the current mode directly. When multiple thread are given, all are resumed and the first is shown in the foreground.

Options:

  --last
      Continue the last thread for the current mode directly
  --pick
      Pick a thread interactively from a list (DEPRECATED: picker is now the default)

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsListHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads list [options]

List all your threads with their IDs, names, and last modified times.

Options:

  --include-archived
      Include archived threads in the list
  --installation-id <installationID>
      Only list threads for a specific installation ID
  --limit <number>
      Maximum number of threads to return
  --offset <number>
      Number of threads to skip
  --json
      Output as JSON

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsUsageHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads usage [options] <threadIDOrURL>

Show display cost information for a thread. Accepts either a thread ID or thread URL.

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsVisibilityHelpStdoutText = (
  homeDir = homedir(),
) => `Usage: amp threads visibility [options] [visibility]

Print the explicit repo visibility override or "inherited", or set a new default (private, workspace, group).

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsSearchHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads search [options] <query>

Search for threads using a query DSL.

Query syntax:
- Keywords: Bare words or quoted phrases for text search: auth or "race condition"
- File filter: file:path to find threads that touched a file: file:src/auth/login.ts
- Repo filter: repo:url to scope to a repository: repo:github.com/owner/repo
- Ref filter: ref:name to scope to a git ref: ref:main
- Combine filters: Use implicit AND: auth file:src/foo.ts repo:amp ref:main

All matching is case-insensitive. File paths use partial matching.

Options:

  -n, --limit <number>
      Maximum number of threads to return
  --offset <number>
      Number of results to skip (for pagination)
  --json
      Output as JSON

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsLabelHelpStdoutText = (
  homeDir = homedir(),
) => `Usage: amp threads label [options] <threadIDOrURL> <labels...>

Add one or more labels to an existing thread without removing the labels it already has.

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const threadsShareHelpStdoutText = (homeDir = homedir()) => `Usage: amp threads share [options] <threadIDOrURL>

Change thread visibility (private, unlisted, workspace, group) or share with Amp support for debugging. Use --visibility to change who can access the thread, or --support to share with the Amp team for troubleshooting.

Options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  --support [message]
      Share thread with Amp support for debugging

Global options:

  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const configHelpStdoutText = (homeDir = homedir()) => `Usage: amp config [options] [command]

Manage Amp configuration

Commands:

  edit    Open the Amp settings file in $EDITOR
  keymap  List command keymap entries

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const configEditHelpStdoutText = (homeDir = homedir()) => `Usage: amp config edit [options]

Open the Amp settings file in $EDITOR. By default, this opens user settings. Use --workspace to edit the workspace-specific .amp/settings.json file.

Options:

  --global
      Edit user settings (default)
  --workspace
      Edit workspace settings

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const configKeymapHelpStdoutText = (homeDir = homedir()) => `Usage: amp config keymap [options]

List all command IDs, descriptions, and effective keymap entries

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp [options] [command]

Add and manage MCP server configuration under amp.mcpServers

Commands:

  add       Add an MCP server configuration
  list      List all MCP server configurations
  remove    Remove an MCP server configuration
  oauth     Manage OAuth authentication for MCP servers
    login   Register OAuth client credentials for an MCP server
    logout  Remove OAuth credentials for an MCP server
    status  Show OAuth status for an MCP server
  doctor    Check MCP server status
  approve   Approve a workspace MCP server

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpAddHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp add [options] <name> [args...]

Add an MCP server to amp.mcpServers in the Amp CLI settings file.

By default, this modifies global settings (~/.config/amp/settings.json). Use --workspace to target workspace settings instead.

Usage:
  amp mcp add <name> -- <command> [args...]                   (local MCP server, started with command)
  amp mcp add <name> --env KEY=VAL -- <command> [args...]     (local MCP server, with env vars)
  amp mcp add <name> <url>                                    (remote MCP server with auto-detected transport)
  amp mcp add <name> --header KEY=VAL <url>                   (remote MCP server with HTTP headers)
  amp mcp add <name> --workspace -- <command> [args...]       (add to workspace settings)

Examples:
  amp mcp add context7 -- npx -y @upstash/context7-mcp
  amp mcp add postgres --env PGUSER=orb -- npx -y @modelcontextprotocol/server-postgres postgresql://localhost/orbing
  amp mcp add sourcegraph --header "Authorization=token <sg-instance-token>" https://sourcegraph.example.com/.api/mcp/v1
  amp mcp add hugging-face https://huggingface.co/mcp
  amp mcp add monday --header "Authorization=Bearer <token>" https://mcp.monday.com/sse
  amp mcp add project-specific --workspace -- npx -y @some/server

Options:

  --env <kv>
      Environment variables as KEY=VALUE pairs (repeatable)
  --header <kv>
      HTTP headers as KEY=VALUE pairs for URL-based MCP servers (repeatable)
  --workspace
      Target workspace settings instead of global settings

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpRemoveHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp remove [options] <name>

Remove an MCP server from amp.mcpServers in the settings file.

This command checks workspace settings first, then falls back to global settings (~/.config/amp/settings.json).
This command does not modify VS Code or other editor settings.

Usage:
  amp mcp remove <name>

Examples:
  amp mcp remove context7
  amp mcp remove postgres

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpDoctorHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp doctor [options] [name]

Wait for MCP service initialization and display the status of configured servers.

If [name] is provided, only show status for that specific server.

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpOauthHelpStdoutText = `Usage: amp mcp oauth [options] [command]

Manage OAuth authentication for MCP servers

Options:
  -h, --help                     display help for command

Commands:
  login [options] <server-name>  Register OAuth client credentials for an MCP
                                 server
  logout <server-name>           Remove OAuth credentials for an MCP server
  status <server-name>           Show OAuth status for an MCP server
  help [command]                 display help for command
`

export const mcpOauthLoginHelpStdoutText = `Usage: amp mcp oauth login [options] <server-name>

Register OAuth client credentials for an MCP server

Arguments:
  server-name               Name of the MCP server to authenticate with

Options:
  --server-url <url>        MCP server URL
  --client-id <id>          OAuth client ID
  --client-secret <secret>  OAuth client secret; only necessary for clients
                            that don't support PKCE
  --scopes <scopes>         OAuth scopes (comma-separated)
  --auth-url <url>          OAuth authorization URL (discovered if not
                            provided)
  --token-url <url>         OAuth token URL (discovered if not provided)
  -h, --help                display help for command
`

export const mcpOauthLogoutHelpStdoutText = `Usage: amp mcp oauth logout [options] <server-name>

Remove OAuth credentials for an MCP server

Arguments:
  server-name  Name of the MCP server

Options:
  -h, --help   display help for command
`

export const mcpOauthStatusHelpStdoutText = `Usage: amp mcp oauth status [options] <server-name>

Show OAuth status for an MCP server

Arguments:
  server-name  Name of the MCP server

Options:
  -h, --help   display help for command
`

export const mcpListHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp list [options]

List all configured MCP servers from both global and workspace settings.

Shows the server name, type (command or URL), and source (global or workspace).

Options:

  --json
      Output as JSON

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const mcpApproveHelpStdoutText = (homeDir = homedir()) => `Usage: amp mcp approve [options] <name>

Approve a workspace MCP server for execution.

MCP servers added to workspace settings (.amp/settings.json) require explicit approval before they can run. This is a security measure to prevent untrusted code execution.

Usage:
  amp mcp approve <name>

Examples:
  amp mcp approve my-server
  amp mcp approve project-mcp

Global options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

`

export const rootHelpStdoutText = (homeDir = homedir()) => `Amp CLI

Usage: amp [options] [command]

Commands:

  version       Print the version number and exit
  logout        Log out by removing stored API key
  login         Log in to Amp
  clone         Clone a workspace repository
  top           Show live active threads
  last          [alias: l] Continue the last thread
  threads       [alias: t, thread] Manage threads
    new         [alias: n] Create a new thread
    continue    [alias: c] Continue an existing thread
    list        [alias: l, ls] List all threads
    usage       Show usage information for a thread
    visibility  [alias: v] Show or set default visibility for this repository
    search      [alias: find] Search threads
    label       Add labels to a thread
    share       [alias: s] Share a thread
    report      Generate and send a diagnostic report for a thread to provide to Amp support
    rename      [alias: r] Rename a thread
    archive     Archive a thread
    delete      Delete a thread
    markdown    [alias: md] Render thread as markdown
    export      Export a thread as JSON
    raw         [alias: raw-thread] Export raw actor thread data as JSON
  tools         [alias: tool] Tool management commands
    list        [alias: ls] List all active tools (including MCP tools)
    show        Show details about an active tool
  review        Run code review through the review agent mode
  skill         [alias: skills] Manage skills from GitHub or local sources
    add         Install skills from a source
    list        [alias: ls] List all available skills
    remove      [alias: rm] Remove an installed skill
    info        Show information about a skill
  permissions   [alias: permission] Manage permissions
    list        [alias: ls] List permissions
    test        Test permissions
    edit        Edit permissions
    add         Add permission rule
  mcp           Manage MCP servers
    add         Add an MCP server configuration
    list        List all MCP server configurations
    remove      Remove an MCP server configuration
    oauth       Manage OAuth authentication for MCP servers
      login     Register OAuth client credentials for an MCP server
      logout    Remove OAuth credentials for an MCP server
      status    Show OAuth status for an MCP server
    doctor      Check MCP server status
    approve     Approve a workspace MCP server
  config        Manage Amp configuration
    edit        Open the Amp settings file in $EDITOR
    keymap      List command keymap entries
  project       Project management commands
    create      Create a project for a repository
    list        List projects
    show        Show project details
    set-env     Set a project environment variable
    set-secret  Set a project secret from stdin
  usage         Show your current Amp usage and credit balance
  update        [alias: up] Update Amp CLI

Options:

  --visibility <visibility>
      Set thread visibility (private, unlisted, workspace, group)
  -V, --version
      Print the version number and exit
  -v
      Alias for --version
  --notifications
      Enable notification alerts (audio locally, terminal bell over SSH or with AMP_FORCE_BEL; enabled by default when
      not in execute mode)
  --no-notifications
      Disable notification alerts (audio locally, terminal bell over SSH or with AMP_FORCE_BEL; enabled by default when
      not in execute mode)
  --color
      Enable color output (enabled by default if stdout and stderr are sent to a TTY)
  --no-color
      Disable color output (enabled by default if stdout and stderr are sent to a TTY)
  --settings-file <value>
      Custom settings file path (overrides the default location ${homeDir}/.config/amp/settings.json)
  --log-level <value>
      Set log level (parent, children, category, sinks, parentSinks, filters, lowestLevel, contextLocalStorage)
  --log-file <value>
      Set log file location (overrides the default location ${homeDir}/.cache/amp/logs/cli.log)
  --ide
      Enable IDE connection (default). When enabled, Amp automatically includes your open IDE's file and text selection
      with every message.
  --no-ide
      Disable IDE connection
  --mcp-config <value>
      JSON configuration or file path for MCP servers to merge with existing settings
  -m, --mode <value>
      Set the agent mode (rush, smart, deep1, deep2, deep3) — controls the model, system prompt, and tool selection
  --effort <value>
      Set reasoning effort for the new thread, when supported by the selected mode
  -x, --execute [message]
      Use execute mode, optionally with user message. In execute mode, agent will execute provided prompt (either as
      argument, or via stdin). Execute mode is only enabled when explicitly requested.
  --stream-json
      When used with --execute, output Rika Event schema JSON lines.
  --stream-json-thinking
      Include thinking blocks in stream JSON output (non-Claude Code extension). Implies --stream-json.
  --stream-json-input
      Read JSON Lines user messages from stdin. Requires both --execute and --stream-json.
  --no-archive-after-execute
      When used with --execute on a new thread or with the review command, leave the thread unarchived after the command
      finishes.
  -l, --label <label>
      Add a label to the thread created or continued by this command. Repeat the flag for multiple labels.

Environment variables:

  AMP_API_KEY        Access token for Amp (see https://ampcode.com/settings)
  AMP_URL            URL for the Amp service (default is https://ampcode.com/)
  AMP_LOG_LEVEL      Set log level (can also use --log-level)
  AMP_LOG_FILE       Set log file location (can also use --log-file)
  AMP_SETTINGS_FILE  Set settings file path (can also use --settings-file, default:
                     ${homeDir}/.config/amp/settings.json)

Examples:

Start an interactive session:

  $ amp

Start an interactive session with a user message:

  $ echo "commit all my unstaged changes" | amp

Use execute mode (--execute or -x) to send a command to an agent, stream Rika Event JSON lines, and then exit:

  $ amp -x "what file in this folder is in markdown format?" --stream-json | jq -r 'select(.type=="message.added" and .data.message.role=="assistant") | .data.message.content[] | select(.type=="text") | .text'

Stream the first protocol event as JSON:

  $ amp -x "2+2?" --stream-json | head -1 | jq .

Feed JSON Lines user messages through stdin:

  $ printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}' | amp -x --stream-json --stream-json-input

Pipe data to the agent and send along a prompt in execute mode:

  $ cat ~/.zshrc | amp -x "what does the 'beautiful' function do?"
  The \`beautiful\` function creates an infinite loop that prints the letter "o" in cycling colors every 0.2 seconds.

Execute a prompt from a file with explicit execute mode:

  $ amp -x < prompt.txt

Add an MCP server with a local command:

  $ amp mcp add context7 -- npx -y @upstash/context7-mcp

Add an MCP server with environment variables:

  $ amp mcp add postgres --env PGUSER=orb -- npx -y @modelcontextprotocol/server-postgres postgresql://localhost/orbing

Add a remote MCP server:

  $ amp mcp add hugging-face https://huggingface.co/mcp

Configuration:

Amp can be configured using a JSON settings file located at ${homeDir}/.config/amp/settings.json. All settings use the "amp." prefix.

Settings reference:

  amp.dangerouslyAllowAll
      Disable all command confirmation prompts (agent will execute all commands without asking)
  amp.defaultVisibility
      Define default thread visibility per repository origin using mappings like "github.com/org/repo": "workspace".
      Values: private, workspace, group.
  amp.experimental.modes
      Enable experimental agent modes by name. Available modes: deep1, deep2, deep3
  amp.fuzzy.alwaysIncludePaths
      Glob patterns for paths that should always be included in fuzzy file search, even if gitignored
  amp.git.commit.ampThread.enabled
      Enable adding Amp-Thread trailer in git commits
  amp.git.commit.coauthor.enabled
      Enable adding Amp as co-author in git commits
  amp.guardedFiles.allowlist
      Array of file glob patterns that are allowed to be accessed without confirmation. Takes precedence over the
      built-in denylist.
  amp.keymap
      Command shortcuts keyed by command ID. Values can be a shortcut string, an array of shortcuts, or null. User
      keymap entries override workspace entries. Run "amp config keymap" to list all command IDs, descriptions, and
      effective keys, with null for unbound commands.
  amp.mcpServers
      Model Context Protocol servers to connect to for additional tools
  amp.network.timeout
      How many seconds to wait for network requests to the Amp server before timing out
  amp.notifications.enabled
      Enable notification alerts when the agent completes tasks. Over SSH, or when AMP_FORCE_BEL is set, this sends a
      terminal bell.
  amp.notifications.system.enabled
      Enable system notifications when terminal is not focused
  amp.permissions
      Permission rules for tool calls. See amp permissions --help
  amp.proxy
      Proxy URL used for both HTTP and HTTPS requests to the Amp server
  amp.showCosts
      Set to false to hide costs while working on a thread
  amp.skills.disableClaudeCodeSkills
      Disable loading skills from Claude Code directories (.claude/skills/, ~/.claude/skills/,
      ~/.claude/plugins/cache/). Amp-native skill directories are not affected.
  amp.skills.path
      Path to additional directories containing skills. Supports colon-separated paths (semicolon on Windows). Use ~ for
      home directory.
  amp.terminal.animation
      Set to false to disable terminal animations (or use the equivalent NO_ANIMATION=1 env var)
  amp.terminal.copyOnSelect
      Automatically copy selection to clipboard.
  amp.terminal.detailsExpandedByDefault
      Expand thinking and tool call details by default in the CLI transcript.
  amp.tools.disable
      Array of tool names to disable. Use 'builtin:toolname' to disable only the builtin tool with that name (allowing
      an MCP server to provide a tool by that name).
  amp.tools.enable
      Array of tool name patterns to enable. Supports glob patterns (e.g., 'mcp__metabase__*'). If not set, all tools
      are enabled. If set, only matching tools are enabled.
  amp.updates.mode
      Control update checking behavior: "warn" shows update notifications, "disabled" turns off checking, "auto"
      automatically runs update.

Example configuration:

{
  "amp.dangerouslyAllowAll": false,
  "amp.defaultVisibility": {
    "github.com/ampcode/amp": "workspace"
  },
  "amp.experimental.modes": [],
  "amp.fuzzy.alwaysIncludePaths": [],
  "amp.git.commit.ampThread.enabled": true,
  "amp.git.commit.coauthor.enabled": true,
  "amp.guardedFiles.allowlist": [],
  "amp.keymap": {},
  "amp.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-filesystem",
        "/path/to/allowed/dir"
      ]
    }
  },
  "amp.network.timeout": 30,
  "amp.notifications.enabled": true,
  "amp.notifications.system.enabled": true,
  "amp.permissions": [
    {
      "tool": "Bash",
      "action": "ask",
      "matches": {
        "cmd": [
          "git push*",
          "git commit*",
          "git branch -D*",
          "git checkout HEAD*"
        ]
      }
    }
  ],
  "amp.showCosts": true,
  "amp.skills.disableClaudeCodeSkills": false,
  "amp.terminal.animation": true,
  "amp.terminal.copyOnSelect": true,
  "amp.terminal.detailsExpandedByDefault": false,
  "amp.tools.disable": [
    "browser_navigate",
    "builtin:edit_file"
  ],
  "amp.updates.mode": "auto"
}


`

export const executeCommand = Effect.fn("Cli.Help.executeCommand")(function* (command: Args.HelpCommand) {
  if (command.type === "help") {
    yield* Output.stdoutRaw(
      command.topic === "version"
        ? versionHelpStdoutText
        : command.topic === "top"
          ? topHelpStdoutText()
          : command.topic === "last"
            ? lastHelpStdoutText()
            : command.topic === "threads"
              ? threadsHelpStdoutText()
              : command.topic === "threads-new"
                ? threadsNewHelpStdoutText()
                : command.topic === "threads-continue"
                  ? threadsContinueHelpStdoutText()
                  : command.topic === "threads-list"
                    ? threadsListHelpStdoutText()
                    : command.topic === "threads-usage"
                      ? threadsUsageHelpStdoutText()
                      : command.topic === "threads-visibility"
                        ? threadsVisibilityHelpStdoutText()
                        : command.topic === "threads-search"
                          ? threadsSearchHelpStdoutText()
                          : command.topic === "threads-label"
                            ? threadsLabelHelpStdoutText()
                            : command.topic === "threads-share"
                              ? threadsShareHelpStdoutText()
                              : command.topic === "clone"
                                ? cloneHelpStdoutText()
                                : command.topic === "login"
                                  ? loginHelpStdoutText()
                                  : command.topic === "logout"
                                    ? logoutHelpStdoutText()
                                    : command.topic === "config-edit"
                                      ? configEditHelpStdoutText()
                                      : command.topic === "config-keymap"
                                        ? configKeymapHelpStdoutText()
                                        : command.topic === "mcp-approve"
                                          ? mcpApproveHelpStdoutText()
                                          : command.topic === "mcp-add"
                                            ? mcpAddHelpStdoutText()
                                            : command.topic === "mcp-doctor"
                                              ? mcpDoctorHelpStdoutText()
                                              : command.topic === "mcp-list"
                                                ? mcpListHelpStdoutText()
                                                : command.topic === "mcp-oauth"
                                                  ? mcpOauthHelpStdoutText
                                                  : command.topic === "mcp-oauth-login"
                                                    ? mcpOauthLoginHelpStdoutText
                                                    : command.topic === "mcp-oauth-logout"
                                                      ? mcpOauthLogoutHelpStdoutText
                                                      : command.topic === "mcp-oauth-status"
                                                        ? mcpOauthStatusHelpStdoutText
                                                        : command.topic === "mcp-remove"
                                                          ? mcpRemoveHelpStdoutText()
                                                          : command.topic === "mcp"
                                                            ? mcpHelpStdoutText()
                                                            : command.topic === "config"
                                                              ? configHelpStdoutText()
                                                              : rootHelpStdoutText(),
    )
    if (
      command.topic !== "mcp-oauth" &&
      command.topic !== "mcp-oauth-login" &&
      command.topic !== "mcp-oauth-logout" &&
      command.topic !== "mcp-oauth-status"
    ) {
      yield* Output.stderrRaw(terminalResetText)
    }
  }
  return 0
})
