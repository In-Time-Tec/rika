# Tool presentation

The transcript names tools by what the user sees, never by transport method or internal tool name. Calls stay in source order. A call appears once while running and is updated in place when it completes.

Unselected summaries show the action or agent identity as primary text and mute statuses, targets, counts, and context at every nesting depth.

| Calls                       | Running                          | Complete                        | Expanded detail        |
| --------------------------- | -------------------------------- | ------------------------------- | ---------------------- |
| `read`                      | `Exploring`                      | `Explored`                      | `Read <path>`          |
| `view_media`                | `Exploring`                      | `Explored`                      | `Viewed <path>`        |
| `grep`                      | `Exploring`                      | `Explored`                      | `Grep <query>`         |
| `search_threads`            | `Exploring`                      | `Explored`                      | `Searched <query>`     |
| `skill`                     | `Exploring`                      | `Explored`                      | the skill name         |
| `write`                     | `Creating <path>`                | `Created <path>`                | the live or final diff |
| `edit`                      | `Editing <path>`                 | `Edited <path>`                 | the live or final diff |
| `bash`                      | `$ <command>`                    | `$ <command>`                   | bounded command output |
| `run_child` selection       | `<Agent> working`                | `<Agent> finished`              | delegated task         |
| `start_child_group` members | child cards by selection         | child cards by selection        | delegated tasks        |
| `finder`, codebase search   | `Searching codebase`             | `Searched codebase`             | delegated task         |
| `web_search`                | `Web Search <query>`             | `Web Search <query>`            | none                   |
| `read_web_page`             | `Read <url>`                     | `Read <url>`                    | none                   |
| `read_thread_transcript`    | `Reading Thread <thread>`        | `Read Thread <thread>`          | bounded result         |
| `list_agent_modes`          | `Checking available agent modes` | `Checked available agent modes` | bounded result         |
| `load_plugin`               | `Loading plugin`                 | `Loaded plugin`                 | bounded result         |
| `archive_current_thread`    | `Archiving this thread`          | `Archived this thread`          | bounded result         |
| `send_message_to_thread`    | `Sending message to thread`      | `Sent message to thread`        | bounded result         |
| `send_message_to_puck`      | `Sending message to Puck`        | `Sent message to Puck`          | bounded result         |
| `slack_read`, `slack_write` | `Slack <detail>`                 | `Slack <detail>`                | bounded result         |
| unknown or MCP tool         | `Running tool <detail>`          | `Ran tool <detail>`             | bounded result         |

Continuation calls do not create transcript rows while running or completing. `shell_command_status` updates the originating shell row's liveness and bounded newest output, while `await_child_group` leaves delegated child cards and outcomes visible without showing the wait itself. A continuation failure appears only when no originating row owns that failure; process exits remain on the shell row.

Adjacent reads and searches collapse into `Explored <counts>`. Adjacent edits collapse into `Edited <count> files +<added> -<removed>`. Adjacent shell calls collapse into `Ran <count> commands[, <failed> failed]`. A failed single command appends `(exit code: <code>)`. Shell commands render syntax-highlighted: command words bold, flags amber, quoted strings green, and operators, line continuations, comments, and heredoc bodies dim or muted.

Groups expand and collapse when they have displayable detail. Web search and web-page reads keep their own results in the transcript but show only the inline call status; attached child-tool detail remains expandable. Multi-file edits and multi-command shell groups add independently expandable child rows. Read and search children keep clickable file targets. Running edits open automatically and turn argument deltas into per-file diffs; the final tool result replaces that preview on the same row.
