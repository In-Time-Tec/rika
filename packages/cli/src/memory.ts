import { ThreadMemoryIndexer, WorkspaceIdentity } from "@rika/agent"
import { Context, Effect, Layer } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export type RunError = ThreadMemoryIndexer.RunError

export interface Interface {
  readonly executeCommand: (command: Args.MemoryCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Memory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const indexer = yield* ThreadMemoryIndexer.Service
    return Service.of(makeService(output, indexer))
  }),
)

export const executeCommand = Effect.fn("Cli.Memory.executeCommand.call")(function* (command: Args.MemoryCommand) {
  const existing = yield* Effect.serviceOption(Service)
  if (existing._tag === "Some") return yield* existing.value.executeCommand(command)
  const output = yield* Output.Service
  const indexer = yield* ThreadMemoryIndexer.Service
  return yield* makeService(output, indexer).executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const makeService = (output: Output.Interface, indexer: ThreadMemoryIndexer.Interface): Interface => ({
  executeCommand: Effect.fn("Cli.Memory.executeCommand")(function* (command: Args.MemoryCommand) {
    switch (command.action) {
      case "status": {
        const status = yield* indexer.status()
        yield* output.stdout(JSON.stringify(status))
        return 0
      }
      case "index": {
        const workspaceId =
          command.workspace_root === undefined
            ? undefined
            : WorkspaceIdentity.resolveWorkspaceId({ workspace_root: command.workspace_root })
        const result = yield* indexer.backfill(workspaceId === undefined ? {} : { workspace_id: workspaceId })
        yield* output.stdout(JSON.stringify(result))
        return 0
      }
    }
    return 0
  }),
})
