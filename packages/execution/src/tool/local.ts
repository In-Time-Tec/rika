import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as Read from "@rika/product/read-file-tool"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import * as ShellStatus from "@rika/product/shell-command-status-tool"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { Capability } from "@rika/extensions/mcp-capability-contract"
import { ToolExecutor } from "generalist"
import * as ProcessRegistry from "./process-registry"
import { toolkit } from "./registry"
import { layerWithProcessRegistry } from "./runtime"
import * as Mcp from "./mcp"

/** The exact four model-facing handlers. Recorded Shell stays on ToolRuntime.Service only. */
export const handlerLayer = toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* ToolRuntime.Service
    return {
      bash: ({ command, workdir, timeout_ms }) => {
        let request = Bash.Request.make({ _tag: "Bash", command })
        if (workdir !== undefined) request = Bash.Request.make({ ...request, workdir })
        if (timeout_ms !== undefined) request = Bash.Request.make({ ...request, timeoutMillis: timeout_ms })
        return runtime.run(request)
      },
      shell_command_status: ({ processId, waitMillis }) => {
        const request =
          waitMillis == null
            ? ShellStatus.Request.make({ _tag: "ShellCommandStatus", processId })
            : ShellStatus.Request.make({ _tag: "ShellCommandStatus", processId, waitMillis })
        return runtime.run(request)
      },
      read: ({ path, read_range }) => {
        const request =
          read_range === undefined
            ? Read.Request.make({ _tag: "Read", path })
            : Read.Request.make({ _tag: "Read", path, readRange: read_range })
        return runtime.run(request)
      },
      edit: ({ path, old_str, new_str, replace_all }) => {
        const base = Edit.Request.make({ _tag: "Edit", path, oldStr: old_str, newStr: new_str })
        const request = replace_all === undefined ? base : Edit.Request.make({ ...base, replaceAll: replace_all })
        return runtime.run(request)
      },
    }
  }),
)

/**
 * One local Run layer. The ToolExecutor and recorded-shell runtime share one scoped ProcessRegistry,
 * so a background bash id remains pollable for the lifetime of that Run and is cleaned up with it.
 */
export const layer = (options: string | { readonly workspace: string; readonly mcp: ReadonlyArray<Capability> }) => {
  const workspace = Schema.is(Schema.String)(options) ? options : options.workspace
  const mcp = Schema.is(Schema.String)(options) ? [] : options.mcp
  const processes = ProcessRegistry.layer
  const runtime = layerWithProcessRegistry(workspace).pipe(Layer.provide(processes))
  const mcpToolkit = Toolkit.make(...mcp.map(Mcp.tool))
  const mcpHandlers = mcpToolkit.toLayer(
    Effect.gen(function* () {
      const service = yield* ToolRuntime.Service
      return Object.fromEntries(
        mcp.map((capability) => [
          capability.name,
          (input: Tool.Parameters<ReturnType<typeof Mcp.tool>>) =>
            Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
              Effect.mapError(() =>
                ToolRuntime.ToolError.make({
                  tool: capability.name,
                  kind: "operation",
                  category: "invalid_input",
                  outcome: "known",
                  recovery: "after_change",
                  message: "MCP input must be JSON",
                  nextAction: "Provide JSON input",
                }),
              ),
              Effect.flatMap((value) => service.run({ _tag: "McpCall", capability, input: value })),
            ),
        ]),
      )
    }),
  )
  const combined = Toolkit.make(...Object.values(toolkit.tools), ...mcp.map(Mcp.tool))
  const executor = ToolExecutor.layerToolkit(combined).pipe(
    Layer.provide(Layer.merge(handlerLayer, mcpHandlers)),
    Layer.provide(runtime),
  )
  return Layer.merge(runtime, executor)
}
