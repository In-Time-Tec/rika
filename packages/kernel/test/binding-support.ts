import { Context, Effect } from "effect"
import { HostBindingRegistry } from "@batonfx/repl"
import { NestedOperation, ToolContext } from "@batonfx/core"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"

export const toolContext: ToolContext.Interface = ToolContext.ToolContext.of({
  signal: new AbortController().signal,
  emit: () => Effect.void,
  sessionId: "session",
  runId: "run",
  toolCallId: "call",
  operationKey: "operation",
})

export interface Journal {
  readonly kinds: Array<string>
  readonly approvals: Array<string | undefined>
  readonly policies: Array<string>
  readonly nested: NestedOperation.Interface
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
  readonly modules: ReadonlyArray<HostBindingRegistry.Module<R>>
  readonly services: Context.Context<never>
  readonly nested?: NestedOperation.Interface | undefined
  readonly sessionId?: string
}): Effect.Effect<HostBindingRegistry.Interface, HostBindingRegistry.HostBindingConflict> => {
  const { modules, services } = input
  const nested = input.nested ?? { run: (_request, effect) => effect }
  const context =
    input.sessionId === undefined
      ? toolContext
      : ToolContext.ToolContext.of({ ...toolContext, sessionId: input.sessionId })
  return Effect.provideContext(
    HostBindingRegistry.make(modules),
    services.pipe(
      Context.add(ToolContext.ToolContext, context),
      Context.add(NestedOperation.NestedOperations, NestedOperation.NestedOperations.of(nested)),
    ) as Context.Context<R>,
  )
}
