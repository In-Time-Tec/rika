import { Context, Effect } from "effect"
import { HostBindings } from "generalist/repl"
import { NestedOperation, ToolContext } from "generalist"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"

export const toolContext: ToolContext.Service = ToolContext.ToolContext.of({
  signal: new AbortController().signal,
  emit: () => Effect.succeed(true),
  sessionId: "session",
  runId: "run",
  toolCallId: "call",
  operationKey: "operation",
})

export interface Journal {
  readonly kinds: Array<string>
  readonly approvals: Array<string | undefined>
  readonly policies: Array<string>
  readonly nested: NestedOperation.Service
}

export const journal = (): Journal => {
  const kinds: Array<string> = []
  const approvals: Array<string | undefined> = []
  const policies: Array<string> = []
  return {
    kinds,
    approvals,
    policies,
    nested: {
      run: (request, effect) => {
        kinds.push(request.kind)
        approvals.push(request.approval?.capability)
        policies.push(request.replayPolicy)
        return effect
      },
    },
  }
}

export const codingToolRuntime = (run: CodingToolRuntime.Interface["run"]) =>
  Context.make(CodingToolRuntime.Service, CodingToolRuntime.Service.of({ run }))

export const mountModules = <R>(input: {
  readonly modules: ReadonlyArray<HostBindings.Module<R | ToolContext.ToolContext | NestedOperation.Operations>>
  readonly services: Context.Context<R>
  readonly nested?: NestedOperation.Service | undefined
  readonly sessionId?: string
}): Effect.Effect<HostBindings.Service, HostBindings.HostModuleConflict> => {
  const { modules, services } = input
  const nested = input.nested ?? { run: (_request, effect) => effect }
  const context =
    input.sessionId === undefined
      ? toolContext
      : ToolContext.ToolContext.of({ ...toolContext, sessionId: input.sessionId })
  return Effect.provideContext(
    HostBindings.make(modules),
    services.pipe(
      Context.add(ToolContext.ToolContext, context),
      Context.add(NestedOperation.Operations, NestedOperation.Operations.of(nested)),
    ),
  )
}
