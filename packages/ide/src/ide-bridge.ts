import { Event, Ide } from "@rika/schema"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

export class IdeBridgeError extends Schema.TaggedErrorClass<IdeBridgeError>()("IdeBridgeError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
}) {}

export interface Interface {
  readonly connect: (input: Ide.ConnectRequest) => Effect.Effect<Ide.ConnectResponse, IdeBridgeError>
  readonly disconnect: (input: Ide.DisconnectRequest) => Effect.Effect<Ide.Status, IdeBridgeError>
  readonly updateContext: (input: Ide.UpdateContextRequest) => Effect.Effect<Ide.Status, IdeBridgeError>
  readonly status: () => Effect.Effect<Ide.Status>
  readonly currentContext: () => Effect.Effect<Option.Option<Ide.ContextSnapshot>>
  readonly openFile: (input: Ide.OpenFileRequest) => Effect.Effect<Ide.OpenFileResult>
  readonly navigationRequests: () => Effect.Effect<ReadonlyArray<Ide.OpenFileRequest>>
}

export class Service extends Context.Service<Service, Interface>()("@rika/ide/IdeBridge") {}

interface State {
  readonly connection?: Ide.ConnectRequest
  readonly context?: Ide.ContextSnapshot
  readonly navigation_requests: ReadonlyArray<Ide.OpenFileRequest>
}

const emptyState: State = { navigation_requests: [] }

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState)
    return makeService(state)
  }),
)

export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    connect: Effect.fn("IdeBridge.empty.connect")(function* (input: Ide.ConnectRequest) {
      return { client_id: input.client_id, connected: false, capabilities: [] }
    }),
    disconnect: Effect.fn("IdeBridge.empty.disconnect")(function* () {
      return disconnectedStatus
    }),
    updateContext: Effect.fn("IdeBridge.empty.updateContext")(function* () {
      return disconnectedStatus
    }),
    status: Effect.fn("IdeBridge.empty.status")(function* () {
      return disconnectedStatus
    }),
    currentContext: Effect.fn("IdeBridge.empty.currentContext")(function* () {
      return Option.none<Ide.ContextSnapshot>()
    }),
    openFile: Effect.fn("IdeBridge.empty.openFile")(function* () {
      return { accepted: false, message: "No IDE client is connected" }
    }),
    navigationRequests: Effect.fn("IdeBridge.empty.navigationRequests")(function* () {
      return []
    }),
  }),
)

export const connect = Effect.fn("IdeBridge.connect.call")(function* (input: Ide.ConnectRequest) {
  const service = yield* Service
  return yield* service.connect(input)
})

export const disconnect = Effect.fn("IdeBridge.disconnect.call")(function* (input: Ide.DisconnectRequest) {
  const service = yield* Service
  return yield* service.disconnect(input)
})

export const updateContext = Effect.fn("IdeBridge.updateContext.call")(function* (input: Ide.UpdateContextRequest) {
  const service = yield* Service
  return yield* service.updateContext(input)
})

export const status = Effect.fn("IdeBridge.status.call")(function* () {
  const service = yield* Service
  return yield* service.status()
})

export const currentContext = Effect.fn("IdeBridge.currentContext.call")(function* () {
  const service = yield* Service
  return yield* service.currentContext()
})

export const openFile = Effect.fn("IdeBridge.openFile.call")(function* (input: Ide.OpenFileRequest) {
  const service = yield* Service
  return yield* service.openFile(input)
})

export const navigationRequests = Effect.fn("IdeBridge.navigationRequests.call")(function* () {
  const service = yield* Service
  return yield* service.navigationRequests()
})

export const contextEntries = (context: Ide.ContextSnapshot): ReadonlyArray<Event.ContextEntry> => {
  const entries: Array<Event.ContextEntry> = []
  if (context.active_file !== undefined) entries.push(activeFileEntry(context))
  const diagnostics = context.diagnostics ?? []
  if (diagnostics.length > 0) entries.push(diagnosticsEntry(context.workspace_roots, diagnostics))
  return entries
}

const makeService = (state: Ref.Ref<State>): Interface =>
  Service.of({
    connect: Effect.fn("IdeBridge.connect")(function* (input: Ide.ConnectRequest) {
      const nextContext = input.initial_context ?? { workspace_roots: input.workspace_roots }
      yield* Ref.set(state, { connection: input, context: nextContext, navigation_requests: [] })
      return { client_id: input.client_id, connected: true, capabilities: input.capabilities }
    }),
    disconnect: Effect.fn("IdeBridge.disconnect")(function* (input: Ide.DisconnectRequest) {
      const result = yield* Ref.modify(
        state,
        (current): readonly [Effect.Effect<Ide.Status, IdeBridgeError>, State] => {
          const error = clientError(current, input.client_id, "disconnect")
          if (error !== undefined) return [Effect.fail(error), current]
          return [Effect.succeed(disconnectedStatus), emptyState]
        },
      )
      return yield* result
    }),
    updateContext: Effect.fn("IdeBridge.updateContext")(function* (input: Ide.UpdateContextRequest) {
      const result = yield* Ref.modify(
        state,
        (current): readonly [Effect.Effect<Ide.Status, IdeBridgeError>, State] => {
          const error = clientError(current, input.client_id, "updateContext")
          if (error !== undefined) return [Effect.fail(error), current]
          const next = { ...current, context: input.context }
          return [Effect.succeed(toStatus(next)), next]
        },
      )
      return yield* result
    }),
    status: Effect.fn("IdeBridge.status")(function* () {
      return toStatus(yield* Ref.get(state))
    }),
    currentContext: Effect.fn("IdeBridge.currentContext")(function* () {
      const current = yield* Ref.get(state)
      return current.context === undefined ? Option.none<Ide.ContextSnapshot>() : Option.some(current.context)
    }),
    openFile: Effect.fn("IdeBridge.openFile")(function* (input: Ide.OpenFileRequest) {
      return yield* Ref.modify(state, (current): readonly [Ide.OpenFileResult, State] => {
        const connection = current.connection
        if (connection === undefined) {
          return [{ accepted: false, message: "No IDE client is connected" }, current]
        }
        if (!connection.capabilities.includes("navigation")) {
          return [
            { accepted: false, message: `IDE client ${connection.client_id} does not support navigation` },
            current,
          ]
        }
        return [
          { accepted: true },
          {
            ...current,
            navigation_requests: [...current.navigation_requests, input],
          },
        ]
      })
    }),
    navigationRequests: Effect.fn("IdeBridge.navigationRequests")(function* () {
      const current = yield* Ref.get(state)
      return current.navigation_requests
    }),
  })

const clientError = (state: State, clientId: Ide.ConnectRequest["client_id"], operation: string) => {
  if (state.connection === undefined) {
    return new IdeBridgeError({ message: "No IDE client is connected", operation, status: 409 })
  }
  if (state.connection.client_id !== clientId) {
    return new IdeBridgeError({ message: `IDE client ${clientId} is not connected`, operation, status: 409 })
  }
  return undefined
}

const disconnectedStatus: Ide.Status = {
  connected: false,
  capabilities: [],
  workspace_roots: [],
}

const toStatus = (state: State): Ide.Status => {
  const connection = state.connection
  if (connection === undefined) return disconnectedStatus
  return {
    connected: true,
    client_id: connection.client_id,
    ...(connection.name === undefined ? {} : { name: connection.name }),
    capabilities: connection.capabilities,
    workspace_roots: connection.workspace_roots,
    ...(state.context === undefined ? {} : { context: state.context }),
  }
}

const activeFileEntry = (context: Ide.ContextSnapshot): Event.ContextEntry => {
  const activeFile = context.active_file
  if (activeFile === undefined) {
    return {
      kind: "file",
      source: "ide:active-file",
      reason: "IDE active file context",
      trusted: false,
      metadata: { workspace_roots: context.workspace_roots },
    }
  }
  return {
    kind: "file",
    source: "ide:active-file",
    reason: "IDE active file and selection",
    trusted: false,
    path: activeFile.path,
    content: activeFileContent(activeFile),
    metadata: activeFileMetadata(context),
  }
}

const activeFileContent = (activeFile: Ide.ActiveFile) => {
  const lines: Array<string> = [`Active file: ${activeFile.path}`]
  if (activeFile.language_id !== undefined) lines.push(`Language: ${activeFile.language_id}`)
  if (activeFile.selection !== undefined) {
    lines.push(`Selection: lines ${activeFile.selection.range.start_line}-${activeFile.selection.range.end_line}`)
    if (activeFile.selection.selected_text !== undefined) lines.push("", activeFile.selection.selected_text)
  }
  return lines.join("\n")
}

const activeFileMetadata = (context: Ide.ContextSnapshot) => {
  const activeFile = context.active_file
  return {
    workspace_roots: context.workspace_roots,
    ...(activeFile?.language_id === undefined ? {} : { language_id: activeFile.language_id }),
    ...(activeFile?.selection === undefined
      ? {}
      : {
          selection: {
            start_line: activeFile.selection.range.start_line,
            end_line: activeFile.selection.range.end_line,
          },
        }),
    diagnostics: (context.diagnostics ?? []).length,
  }
}

const diagnosticsEntry = (
  workspaceRoots: ReadonlyArray<string>,
  diagnostics: ReadonlyArray<Ide.Diagnostic>,
): Event.ContextEntry => ({
  kind: "file",
  source: "ide:diagnostics",
  reason: "IDE diagnostics for open workspace",
  trusted: false,
  content: diagnostics.map(formatDiagnostic).join("\n"),
  metadata: { workspace_roots: workspaceRoots, diagnostics: diagnostics.length },
})

const formatDiagnostic = (diagnostic: Ide.Diagnostic) => {
  const range = diagnostic.range === undefined ? "" : `:${diagnostic.range.start_line}-${diagnostic.range.end_line}`
  const source = diagnostic.source === undefined ? "" : ` [${diagnostic.source}]`
  return `${diagnostic.path}${range} ${diagnostic.severity}${source}: ${diagnostic.message}`
}
