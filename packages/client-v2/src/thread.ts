/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- protocol option fields must be omitted, not sent as undefined. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- the WebSocket adapter narrows an EventTarget proxy to the DOM socket surface. */
/* oxlint-disable max-lines -- the client keeps its selection, projection, and transport lifecycle in one public value. */
/* oxlint-disable anti-slop/no-object-parameters -- external Generalist errors are decoded at this boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- queue conflict decoding establishes the invariant. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- mapped conflict reasons are validated before state publication. */
/* oxlint-disable typescript/no-base-to-string -- Error values are rendered only for a user-facing fallback. */
/* oxlint-disable typescript/no-unsafe-assignment -- Generalist page codecs provide the typed queue/history payload. */
/* oxlint-disable effecttsgo/lazy-effect -- client methods intentionally remain callable operations for UI events. */
/* oxlint-disable effecttsgo/schema-struct-with-tag -- this schema mirrors Generalist's encoded error tag. */
/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this package is the Generalist client adapter boundary. */
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import type { ConnectionEvent, HostSessionSnapshot } from "generalist/server"
import { makeExecutionClient, type ExecutionClient } from "./generalist"
import { applyConnectionEvent, applyConnectionStatus, projectSnapshot, type ProjectionResult, type ProjectionState, type ProjectionThread } from "./projection"
import type { ProductClient, ThreadMetadata } from "./product"
import { ProductClientError } from "./product"

const QueueConflict = Schema.Struct({
  _tag: Schema.Literal("generalist/session/SessionQueueConflict"),
  reason: Schema.Literals(["capacity", "closed", "revision", "selection"]),
  hint: Schema.String,
})

export type QueueConflictReason = typeof QueueConflict.Type["reason"]

export class ThreadClientError extends Schema.TaggedError<ThreadClientError>()("RikaClientV2ThreadError", {
  kind: Schema.Literals(["network", "protocol", "unauthorized", "forbidden", "conflict", "selection", "closed"]),
  operation: Schema.String,
  message: Schema.String,
  reason: Schema.optionalKey(Schema.String),
}) {}

export interface CommandReceipt {
  readonly commandId: string
  readonly id?: string
  readonly revision?: number
  readonly status?: "active" | "queued" | "accepted"
}

export interface ThreadClientState {
  readonly selectionEpoch: number
  readonly selectedThreadId: string | undefined
  readonly selectedSessionId: string | undefined
  readonly threads: readonly ProjectionThread[]
  readonly projection: ProjectionState | undefined
  readonly connection: "connecting" | "connected" | "reconnecting" | "disconnected"
  readonly notice: string
  readonly lastReceipt: CommandReceipt | undefined
  readonly lastConflict: { readonly commandId: string; readonly reason: QueueConflictReason; readonly message: string } | undefined
}

export interface ThreadClient {
  readonly state: ThreadClientState
  readonly subscribe: (listener: (state: ThreadClientState) => void) => () => void
  readonly refreshThreads: () => Effect.Effect<void, ThreadClientError>
  readonly selectThread: (threadId: string) => Effect.Effect<void, ThreadClientError>
  readonly submit: (prompt: string, commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly editQueued: (id: string, prompt: string, commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly removeQueued: (id: string, commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly steer: (prompt: string, commandId?: string, targetRunId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly followUp: (
    prompt: string,
    childSessionId?: string,
    commandId?: string,
  ) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly cancel: (commandId?: string, reason?: string, targetRunId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly stop: (commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly closeSession: (commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly resumeSession: (commandId?: string) => Effect.Effect<CommandReceipt, ThreadClientError>
  readonly loadOlder: (limit?: number) => Effect.Effect<void, ThreadClientError>
  readonly dispose: Effect.Effect<void>
}

export interface MakeThreadClientOptions {
  readonly product: ProductClient
  readonly execution: ExecutionClient
  readonly executionForThread?: (thread: ThreadMetadata) => Effect.Effect<ExecutionClient, ThreadClientError>
  readonly targetForThread?: (thread: ThreadMetadata) => "runner" | "orb"
  readonly eventCapacity?: number
  readonly historyPageSize?: number
  readonly initialThreadId?: string
  /**
   * Construct the runtime socket. Bun's WebSocket implementation accepts request headers in its options object;
   * browser implementations can ignore the third argument and use a cookie/subprotocol transport instead.
   */
  readonly webSocketConstructor?: (
    url: string,
    protocols?: string | string[],
    headers?: Readonly<Record<string, string>>,
  ) => globalThis.WebSocket
  /** Headers for the upgrade request, evaluated for each reconnect URL. */
  readonly webSocketHeaders?: (
    input: { readonly url: string; readonly method: "GET" },
  ) => Effect.Effect<Readonly<Record<string, string>>, never>
}

const initialState: ThreadClientState = {
  selectionEpoch: 0,
  selectedThreadId: undefined,
  selectedSessionId: undefined,
  threads: [],
  projection: undefined,
  connection: "disconnected",
  notice: "",
  lastReceipt: undefined,
  lastConflict: undefined,
}

const errorKind = (error: ProductClientError | object): ThreadClientError["kind"] => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }))(error)
  if (decoded._tag === "Some") {
    if (decoded.value.kind === "unauthorized") return "unauthorized"
    if (decoded.value.kind === "forbidden") return "forbidden"
    if (decoded.value.kind === "network") return "network"
  }
  return "protocol"
}

const mapError = (operation: string, error: ProductClientError | object): ThreadClientError => {
  const conflict = Schema.decodeUnknownOption(QueueConflict)(error)
  if (conflict._tag === "Some")
    return ThreadClientError.make({
      kind: "conflict",
      operation,
      message: conflict.value.hint,
      reason: conflict.value.reason,
    })
  const message = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(error)
  return ThreadClientError.make({
    kind: errorKind(error),
    operation,
    message: message._tag === "Some" ? message.value.message : String(error),
  })
}

const commandId = (serial: number, operation: string): string => `tui-v2:${operation}:${serial}`

const unavailableWebSocket: MakeThreadClientOptions["webSocketConstructor"] = () => {
  throw new Error("A WebSocket constructor is required for hosted Thread reconnect")
}

const authenticatedWebSocket = (input: {
  readonly url: string
  readonly protocols: string | string[] | undefined
  readonly headers: Effect.Effect<Readonly<Record<string, string>>, never>
  readonly constructor: NonNullable<MakeThreadClientOptions["webSocketConstructor"]>
}): globalThis.WebSocket => {
  const events = new EventTarget()
  let socket: globalThis.WebSocket | undefined
  let readyState = 0
  let binaryType: globalThis.WebSocket["binaryType"] = "arraybuffer"
  let closed = false
  const handlers = new Map<string, EventListener | null>()
  const eventNames = ["open", "message", "error", "close"] as const
  // ast-grep-ignore: effect-prefer-runtime-boundary -- the WebSocket proxy must start authentication before its synchronous host constructor returns.
  const fiber = Effect.runFork(
    input.headers.pipe(
      Effect.flatMap((headers) =>
        Effect.sync(() => {
          if (closed) return
          socket = input.constructor(input.url, input.protocols, headers)
          socket.binaryType = binaryType
          readyState = socket.readyState
          for (const eventName of eventNames)
            socket.addEventListener(eventName, (event) => {
              if (eventName === "open") readyState = 1
              if (eventName === "close") readyState = 3
              events.dispatchEvent(event)
            })
          if (closed) socket.close(1_000)
        }),
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          if (closed) return
          readyState = 3
          events.dispatchEvent(new Event("error"))
          events.dispatchEvent(new CloseEvent("close", { code: 1_006, reason: "WebSocket authentication failed" }))
        }),
      ),
    ),
  )
  const setHandler = (eventName: (typeof eventNames)[number], handler: EventListener | null) => {
    const previous = handlers.get(eventName)
    if (previous !== null && previous !== undefined) events.removeEventListener(eventName, previous)
    handlers.set(eventName, handler)
    if (handler !== null) events.addEventListener(eventName, handler)
  }
  const proxy = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    get binaryType() {
      return binaryType
    },
    set binaryType(value: globalThis.WebSocket["binaryType"]) {
      binaryType = value
      if (socket !== undefined) socket.binaryType = value
    },
    get bufferedAmount() {
      return socket?.bufferedAmount ?? 0
    },
    get extensions() {
      return socket?.extensions ?? ""
    },
    get protocol() {
      return socket?.protocol ?? ""
    },
    get readyState() {
      return readyState
    },
    get url() {
      return input.url
    },
    send: (data: Parameters<globalThis.WebSocket["send"]>[0]) => {
      if (socket === undefined) throw new Error("WebSocket is not open")
      socket.send(data)
    },
    close: (code?: number, reason?: string) => {
      closed = true
      fiber.interruptUnsafe()
      if (socket === undefined) {
        readyState = 3
        const init = reason === undefined ? { code: code ?? 1_000 } : { code: code ?? 1_000, reason }
        events.dispatchEvent(new CloseEvent("close", init))
      } else socket.close(code, reason)
    },
  } as unknown as globalThis.WebSocket
  for (const eventName of eventNames)
    Object.defineProperty(proxy, `on${eventName}`, {
      configurable: true,
      get: () => handlers.get(eventName) ?? null,
      set: (handler: EventListener | null) => setHandler(eventName, handler),
    })
  return proxy
}

const placeholderThread = (thread: ThreadMetadata): ProjectionThread => ({
  id: thread.id,
  title: thread.title,
  target: thread.target,
  activity: "idle",
  items: [],
  pending: [],
  approval: null,
})

const activeRun = (projection: ProjectionState | undefined, targetRunId: string | undefined): string | undefined =>
  targetRunId ?? projection?.snapshot.session.activeRunId

const applyProjectionResult = (result: ProjectionResult): ProjectionState => result.state

interface SelectionContext {
  readonly epoch: number
  readonly sessionId: string
  readonly execution: ExecutionClient
  readonly projection: ProjectionState
}

export const makeThreadClient = (options: MakeThreadClientOptions): ThreadClient => {
  const execution = options.execution
  let current: ThreadClientState = initialState
  let serial = 0
  let disposed = false
  let connectionFiber: Fiber.Fiber<void, never> | undefined
  const connectionScope = Scope.makeUnsafe()
  let selectedExecution = execution
  const listeners = new Set<(state: ThreadClientState) => void>()
  const nextCommandId = (operation: string, provided: string | undefined): string => {
    if (provided !== undefined && provided.length > 0) return provided
    serial += 1
    return commandId(serial, operation)
  }
  const publish = (next: ThreadClientState): void => {
    if (disposed) return
    current = next
    for (const listener of listeners) listener(current)
  }
  const updateProjection = (projection: ProjectionState): void => {
    const selected = current.selectedThreadId
    const thread = projection.thread
    publish({
      ...current,
      projection,
      selectedSessionId: projection.sessionId,
      threads: current.threads.some((candidate) => candidate.id === thread.id)
        ? current.threads.map((candidate) => (candidate.id === thread.id ? thread : candidate))
        : [...current.threads, thread],
      ...(selected === undefined ? { selectedThreadId: thread.id } : {}),
    })
  }
  const observeEvent = (event: ConnectionEvent, epoch: number): Effect.Effect<void> =>
    Effect.sync(() => {
      if (disposed || epoch !== current.selectionEpoch) return
      const projection = current.projection
      if (projection === undefined) return
      const result = applyConnectionEvent(projection, event)
      if (result._tag === "Rejected") publish({ ...current, projection: result.state, notice: result.reason })
      else updateProjection(applyProjectionResult(result))
    })
  const observeStatus = (status: Parameters<typeof applyConnectionStatus>[1], epoch: number): Effect.Effect<void> =>
    Effect.sync(() => {
      if (disposed || epoch !== current.selectionEpoch || current.projection === undefined) return
      const next = applyConnectionStatus(current.projection, status)
      let connectionState: ThreadClientState["connection"] = "connecting"
      if (status._tag === "Connected") connectionState = "connected"
      else if (status._tag === "Retrying") connectionState = "reconnecting"
      else if (status._tag === "Disconnected") connectionState = "disconnected"
      publish({
        ...current,
        projection: next,
        connection: connectionState,
        threads: current.threads.map((thread) => (thread.id === next.thread.id ? next.thread : thread)),
      })
    })
  const stopConnection = (): Effect.Effect<void> => {
    if (connectionFiber === undefined) return Effect.void
    const fiber = connectionFiber
    connectionFiber = undefined
    return Fiber.interrupt(fiber).pipe(Effect.asVoid)
  }
  const runConnection = (selected: ExecutionClient, sessionId: string, epoch: number): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const connected = yield* selected.connect({ sessionId, eventCapacity: options.eventCapacity ?? 256 }).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            (url, protocols) => {
              const constructor = options.webSocketConstructor ?? unavailableWebSocket
              if (options.webSocketHeaders === undefined) return constructor(url, protocols)
              return authenticatedWebSocket({
                url,
                protocols,
                constructor,
                headers: options.webSocketHeaders({ url, method: "GET" }),
              })
            },
          ),
        )
        yield* Effect.all(
          [
            connected.events.pipe(Stream.runForEach((event) => observeEvent(event, epoch))),
            connected.status.pipe(Stream.runForEach((status) => observeStatus(status, epoch))),
          ],
          { concurrency: "unbounded" },
        )
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (disposed || epoch !== current.selectionEpoch) return
          publish({ ...current, connection: "disconnected", notice: mapError("events.connect", error).message })
        }),
      ),
      Effect.asVoid,
    )
  const connectForSelection = (selected: ExecutionClient, sessionId: string, epoch: number): Effect.Effect<void> =>
    runConnection(selected, sessionId, epoch).pipe(
      Effect.forkIn(connectionScope),
      Effect.flatMap((fiber) =>
        Effect.sync(() => {
          if (!disposed && epoch === current.selectionEpoch) {
            connectionFiber = fiber
            return true
          }
          return false
        }).pipe(
          Effect.flatMap((owned) => (owned ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid))),
        ),
      ),
      Effect.asVoid,
    )
  const selection = (): SelectionContext | undefined => {
    const sessionId = current.selectedSessionId
    const projection = current.projection
    if (sessionId === undefined || projection === undefined) return undefined
    return { epoch: current.selectionEpoch, sessionId, execution: selectedExecution, projection }
  }
  const staleSelection = (operation: string): Effect.Effect<never, ThreadClientError> =>
    ThreadClientError.make({
      kind: "selection",
      operation,
      message: "The selected Thread changed before this command committed",
    })
  const ensureSelection = (selected: SelectionContext, operation: string): Effect.Effect<void, ThreadClientError> =>
    current.selectionEpoch === selected.epoch && current.selectedSessionId === selected.sessionId
      ? Effect.void
      : staleSelection(operation)
  const withReceipt = (receipt: CommandReceipt): void => publish({ ...current, lastReceipt: receipt, lastConflict: undefined })
  const failCommand = (operation: string, id: string, error: ProductClientError | object): ThreadClientError => {
    const mapped = mapError(operation, error)
    if (mapped.kind === "conflict" && mapped.reason !== undefined) {
      publish({
        ...current,
        lastConflict: { commandId: id, reason: mapped.reason as QueueConflictReason, message: mapped.message },
        notice: mapped.message,
      })
    } else publish({ ...current, notice: mapped.message })
    return mapped
  }
  const refreshThreads = Effect.fn("RikaClientV2.refreshThreads")(function* () {
    const page = yield* options.product.listThreads().pipe(Effect.mapError((error) => mapError("threads.list", error)))
    publish({ ...current, threads: page.threads.map(placeholderThread), notice: "" })
  })
  const selectThread = Effect.fn("RikaClientV2.selectThread")(function* (threadId: string) {
    if (disposed) return yield* ThreadClientError.make({ kind: "closed", operation: "thread.select", message: "Client is closed" })
    serial += 1
    const epoch = current.selectionEpoch + 1
    yield* stopConnection()
    publish({
      ...current,
      selectionEpoch: epoch,
      selectedThreadId: threadId,
      selectedSessionId: undefined,
      projection: undefined,
      connection: "connecting",
      notice: "Loading Thread…",
    })
    const metadata = yield* options.product.thread(threadId).pipe(Effect.mapError((error) => mapError("thread.read", error)))
    if (epoch !== current.selectionEpoch) return
    const executionForSelection =
      options.executionForThread === undefined ? execution : yield* options.executionForThread(metadata)
    const session = yield* options.product.ensureSession(threadId, nextCommandId("session", undefined)).pipe(Effect.mapError((error) => mapError("session.ensure", error)))
    const snapshot = yield* executionForSelection.snapshot({ sessionId: session.sessionId }).pipe(Effect.mapError((error) => mapError("session.snapshot", error)))
    if (epoch !== current.selectionEpoch) return
    selectedExecution = executionForSelection
    const projection = projectSnapshot({
      sessionId: session.sessionId,
      threadId,
      snapshot,
      target: options.targetForThread?.(metadata) ?? metadata.target,
    })
    updateProjection(projection)
    publish({ ...current, connection: "connecting", notice: "" })
    yield* connectForSelection(executionForSelection, session.sessionId, epoch)
  })
  const submit = Effect.fn("RikaClientV2.submit")(function* (prompt: string, provided?: string) {
    const selected = selection()
    if (selected === undefined) return yield* ThreadClientError.make({ kind: "selection", operation: "submit", message: "Select a Thread first" })
    const id = nextCommandId("submit", provided)
    const active = selected.projection.snapshot.session.activeRunId
    const receipt = yield* selected.execution.submit({ sessionId: selected.sessionId, commandId: id, input: prompt }).pipe(
      Effect.mapError((error) => failCommand("queue.submit", id, error)),
    )
    yield* ensureSelection(selected, "queue.submit")
    const status: "active" | "queued" = active === undefined ? "active" : "queued"
    const value: CommandReceipt = { commandId: id, id: receipt.id, revision: receipt.revision, status }
    withReceipt(value)
    return value
  })
  const editQueued = Effect.fn("RikaClientV2.editQueued")(function* (id: string, prompt: string, provided?: string) {
    const selected = selection()
    const pending = selected?.projection.snapshot.session.queue.find((item) => item.id === id)
    if (selected === undefined || pending === undefined)
      return yield* ThreadClientError.make({ kind: "selection", operation: "queue.edit", message: "Pending instruction is no longer loaded" })
    const command = nextCommandId("queue-edit", provided)
    const receipt = yield* selected.execution.updateInput({ sessionId: selected.sessionId, id, commandId: command, expectedRevision: pending.revision, input: prompt }).pipe(
      Effect.mapError((error) => failCommand("queue.edit", command, error)),
    )
    yield* ensureSelection(selected, "queue.edit")
    const value = { commandId: command, id: receipt.id, revision: receipt.revision, status: "accepted" as const }
    withReceipt(value)
    return value
  })
  const removeQueued = Effect.fn("RikaClientV2.removeQueued")(function* (id: string, provided?: string) {
    const selected = selection()
    const pending = selected?.projection.snapshot.session.queue.find((item) => item.id === id)
    if (selected === undefined || pending === undefined)
      return yield* ThreadClientError.make({ kind: "selection", operation: "queue.remove", message: "Pending instruction is no longer loaded" })
    const command = nextCommandId("queue-remove", provided)
    const receipt = yield* selected.execution.removeInput({ sessionId: selected.sessionId, id, commandId: command, expectedRevision: pending.revision }).pipe(
      Effect.mapError((error) => failCommand("queue.remove", command, error)),
    )
    yield* ensureSelection(selected, "queue.remove")
    const value = { commandId: command, id: receipt.id, revision: receipt.revision, status: "accepted" as const }
    withReceipt(value)
    return value
  })
  const steer = Effect.fn("RikaClientV2.steer")(function* (prompt: string, provided?: string, targetRunId?: string) {
    const selected = selection()
    if (selected === undefined)
      return yield* ThreadClientError.make({ kind: "selection", operation: "run.steer", message: "Select a Thread first" })
    const runId = activeRun(selected?.projection, targetRunId)
    if (runId === undefined) return yield* ThreadClientError.make({ kind: "selection", operation: "run.steer", message: "No active Run is available" })
    const command = nextCommandId("steer", provided)
    yield* selected.execution.steer({ runId, commandId: command, input: prompt }).pipe(Effect.mapError((error) => failCommand("run.steer", command, error)))
    yield* ensureSelection(selected, "run.steer")
    const value = { commandId: command, status: "accepted" as const }
    withReceipt(value)
    return value
  })
  const followUp = Effect.fn("RikaClientV2.followUp")(function* (prompt: string, childSessionId?: string, provided?: string) {
    const selected = selection()
    const sessionId = childSessionId ?? selected?.sessionId
    if (sessionId === undefined || selected === undefined) return yield* ThreadClientError.make({ kind: "selection", operation: "follow-up", message: "No retained Session is selected" })
    const command = nextCommandId("follow-up", provided)
    const receipt = yield* selected.execution.submit({ sessionId, commandId: command, input: prompt }).pipe(Effect.mapError((error) => failCommand("follow-up", command, error)))
    yield* ensureSelection(selected, "follow-up")
    const value = { commandId: command, id: receipt.id, revision: receipt.revision, status: "accepted" as const }
    withReceipt(value)
    return value
  })
  const cancel = Effect.fn("RikaClientV2.cancel")(function* (provided?: string, reason?: string, targetRunId?: string) {
    const selected = selection()
    if (selected === undefined)
      return yield* ThreadClientError.make({ kind: "selection", operation: "run.cancel", message: "Select a Thread first" })
    const runId = activeRun(selected?.projection, targetRunId)
    if (runId === undefined) return yield* ThreadClientError.make({ kind: "selection", operation: "run.cancel", message: "No active Run is available" })
    const command = nextCommandId("cancel", provided)
    yield* selected.execution.cancel({ runId, commandId: command, ...(reason === undefined ? {} : { reason }) }).pipe(Effect.mapError((error) => failCommand("run.cancel", command, error)))
    yield* ensureSelection(selected, "run.cancel")
    const value = { commandId: command, status: "accepted" as const }
    withReceipt(value)
    return value
  })
  const control = (action: "stop" | "close" | "resume", operation: string, provided?: string) =>
    Effect.fn(`RikaClientV2.${operation}`)(function* () {
      const selected = selection()
      if (selected === undefined) return yield* ThreadClientError.make({ kind: "selection", operation, message: "Select a Thread first" })
      const command = nextCommandId(operation, provided)
      yield* selected.execution.control({ sessionId: selected.sessionId, commandId: command, action }).pipe(Effect.mapError((error) => failCommand(operation, command, error)))
      yield* ensureSelection(selected, operation)
      const value = { commandId: command, status: "accepted" as const }
      withReceipt(value)
      return value
    })
  const loadOlder = Effect.fn("RikaClientV2.loadOlder")(function* (limit = options.historyPageSize ?? 250) {
    const selected = selection()
    if (selected === undefined || selected.projection.snapshot.conversation.leafId === null) return
    const projection = selected.projection
    const page = yield* selected.execution.history({
      sessionId: selected.sessionId,
      leafId: projection.snapshot.conversation.nextLeafId ?? projection.snapshot.conversation.leafId,
      limit,
    }).pipe(
      Effect.mapError((error) => mapError("session.history", error)),
    )
    yield* ensureSelection(selected, "session.history")
    if (page.entries.length === 0) return
    const known = new Set(projection.snapshot.conversation.entries.map((entry) => entry.id))
    const entries = [
      ...page.entries.filter((entry) => !known.has(entry.id)),
      ...projection.snapshot.conversation.entries,
    ]
    const conversation =
      page.nextLeafId === null
        ? { leafId: page.leafId, entries }
        : { ...projection.snapshot.conversation, entries, leafId: page.leafId, nextLeafId: page.nextLeafId }
    const snapshot: HostSessionSnapshot = {
      ...projection.snapshot,
      conversation,
    }
    updateProjection(
      projectSnapshot({
        sessionId: projection.sessionId,
        threadId: projection.thread.id,
        snapshot,
        target: projection.thread.target,
        previousPreviews: projection.previews,
        previousPreviewFences: projection.previewFences,
      }),
    )
  })
  const dispose = Effect.sync(() => {
    if (disposed) return
    disposed = true
    listeners.clear()
  }).pipe(Effect.andThen(Effect.suspend(stopConnection)), Effect.andThen(Scope.close(connectionScope, Exit.void)))
  return {
    get state() {
      return current
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshThreads,
    selectThread,
    submit,
    editQueued,
    removeQueued,
    steer,
    followUp,
    cancel,
    stop: control("stop", "session.stop"),
    closeSession: control("close", "session.close"),
    resumeSession: control("resume", "session.resume"),
    loadOlder,
    dispose,
  }
}

export const makeThreadClientFromGeneralist = (options: Omit<MakeThreadClientOptions, "execution"> & { readonly generalist: Parameters<typeof makeExecutionClient>[0] }) =>
  makeThreadClient({ ...options, execution: makeExecutionClient(options.generalist) })
