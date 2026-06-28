# IDE Integration Boundaries

Rika's editor integration starts with a small remote-control seam rather than editor-specific plugins. VS Code, JetBrains, Neovim, Zed, and future adapters should all map to the same IDE client protocol.

## Stable responsibilities

- **IDE client**: connects with a client id, display name, workspace roots, and optional capabilities.
- **IDE context**: reports user-visible editor state: active file, selection, diagnostics, and workspace roots.
- **Navigation request**: lets Rika ask a capable IDE client to reveal a file/range for the user.

IDE context is resolved as ordinary untrusted turn context. It can help the model understand what the user sees, but it cannot override system/developer policy and it is not a durable source of truth separate from the thread event log.

## Remote-control mapping

Adapters should use the TypeScript SDK rather than duplicating HTTP details:

| Adapter need                                     | SDK method              |
| ------------------------------------------------ | ----------------------- |
| Connect editor                                   | `connectIde`            |
| Report changed active file/selection/diagnostics | `updateIdeContext`      |
| Inspect connection                               | `ideStatus`             |
| Poll requested file navigation                   | `ideNavigationRequests` |
| Disconnect editor                                | `disconnectIde`         |

Rika itself can request navigation through `openIdeFile`; editor adapters consume those requests and decide how to reveal them in their own UI.

## Future editor adapters

- VS Code should map `window.activeTextEditor`, selections, diagnostics, and workspace folders into IDE context.
- JetBrains should map project roots, current editor caret/selection, inspections, and open-file actions into the same SDK calls.
- Neovim should map the current buffer, visual selection, LSP diagnostics, and `:edit`/quickfix navigation.
- Zed should map workspace roots, active pane selections, diagnostics, and reveal-file commands.

Adapters must remain thin. They should not call Drizzle, Rivet internals, model providers, or local workspace mutation APIs directly.
