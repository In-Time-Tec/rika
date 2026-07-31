import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError, StaleQueuedTurns } from "../../thread/queue/pending-turn-policy"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { AgentDepth } from "@rika/product/execution-service"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { clampThreadTitle, threadTitleLimit } from "../../thread/query/thread-title-policy"
import * as ProductAgent from "../../agent/product-agent-service"
import * as ExtensionOperations from "./extension-operation-dispatch"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as OpenAiAuth from "../../authentication/openai-auth-service"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import { ExecutionId } from "../../execution/contract/execution-identifier"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import {
  Cause,
  Clock,
  Console,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Function,
  Layer,
  PubSub,
  Queue,
  Ref,
  Result,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import * as FileMentions from "../../context/file-mention-parser"
import * as ContextMentions from "../../context/context-mention-parser"
import * as ConfigOperations from "./configuration-operation-dispatch"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ThreadActivity from "../../thread/query/thread-activity"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as InteractiveFeedOverflow from "../interactive/interactive-feed-overflow"
import * as UsageCost from "../../usage/usage-projection"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as ThreadToolService from "../../thread/tool/thread-tool-service"
import { ModeId } from "@rika/configuration/behavior-mode"
import { InvalidInput, OperationUnavailable, Service, unavailableLayer } from "../contract/product-operation-service"
import { Input } from "../contract/operation-input-schema"
import { InteractiveCommand } from "../interactive/interactive-command"
import { InteractiveEventSchema } from "../interactive/interactive-event"
import type { InteractiveEvent, QueueChange, QueueItem } from "../interactive/interactive-event"
import type { InteractiveSession } from "../interactive/interactive-session"

export { Input } from "../contract/operation-input-schema"
export { InteractiveEventSchema, InvalidInput, OperationUnavailable, Service, unavailableLayer } from "../contract/product-operation-service"
export type { Interface, InteractiveCommand, InteractiveEvent, InteractiveSession, QueueChange, QueueItem } from "../contract/product-operation-service"

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const executionStartFailureMessage =
  "Rika could not start this message. Run rika diagnostics status if it keeps happening."
const operationFailureMessage =
  "Rika could not complete that action. Run rika diagnostics status if it keeps happening."
const ingestFailureMessage =
  "Rika lost its place in this thread's event history and stopped recording it. Reopen the thread to rebuild it."
const recordedShellOutputLimit = 64 * 1024

const isTerminalStatus = ExecutionStatus.isTerminalStatus

interface RecordedShellOutput {
  readonly text: string
  readonly truncated: boolean
}

const boundedTextPrefix = (text: string, limit: number): string => {
  const prefix = text.slice(0, Math.max(0, limit))
  const final = prefix.charCodeAt(prefix.length - 1)
  return final >= 0xd800 && final <= 0xdbff ? prefix.slice(0, -1) : prefix
}

const appendRecordedShellOutput = (output: RecordedShellOutput, text: string): RecordedShellOutput => {
  const accepted = boundedTextPrefix(text, recordedShellOutputLimit - output.text.length)
  return {
    text: output.text + accepted,
    truncated: output.truncated || accepted.length < text.length,
  }
}

const projectionVisibleState = (
  projection: Pick<TranscriptRepository.Projection, "revision" | "modelPhase" | "usableCompletionSequence">,
): ExecutionIngest.ProjectionSnapshot["state"] => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: projection.usableCompletionSequence }),
})

const recordedShellStreamId = (turnId: Turn.TurnId): string => `recorded-shell:${turnId}`

const recordedShellStartedEvent = (
  turn: Turn.RunningRecordedShellTurn,
  projection: TranscriptRepository.Projection,
): InteractiveEvent => ({
  _tag: "TranscriptProjectionStarted",
  selectionEpoch: 0,
  threadId: turn.threadId,
  rootTurnId: turn.id,
  turn,
  streamId: recordedShellStreamId(turn.id),
  patchRevision: 0,
  state: projectionVisibleState(projection),
  units: projection.units,
})

const recordedShellSettledEvents = (
  turn: Turn.TerminalRecordedShellTurn,
  projection: TranscriptRepository.Projection,
): readonly [InteractiveEvent, InteractiveEvent] => {
  const streamId = recordedShellStreamId(turn.id)
  return [
    {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 0,
      threadId: turn.threadId,
      rootTurnId: turn.id,
      turn,
      streamId,
      baseRevision: 0,
      patchRevision: 1,
      origin: { _tag: "RecordedShell", phase: "settled" },
      state: projectionVisibleState(projection),
      delta: { upsert: projection.units, remove: [] },
      rootStatus: turn.status,
    },
    {
      _tag: "TranscriptProjectionStopped",
      selectionEpoch: 0,
      threadId: turn.threadId,
      rootTurnId: turn.id,
      streamId,
      patchRevision: 1,
      status: turn.status,
    },
  ]
}

const isAgentResponseEvent = (event: ExecutionBackend.Event): boolean =>
  event.type.includes("reasoning") ||
  event.type === "model.output.delta" ||
  event.type === "model.cycle.completed" ||
  event.type === "model.output.completed" ||
  event.type === "model.toolcall.delta" ||
  event.type === "tool.call.requested" ||
  event.type === "child_run.spawned"

const agentResponseArrived = (events: ReadonlyArray<ExecutionBackend.Event>): boolean => {
  for (const event of events) {
    if (event.type === "execution.cancelled") return false
    if (isAgentResponseEvent(event)) return true
  }
  return false
}

const interactiveEventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

const temporaryThreadTitle = (prompt: string) => clampThreadTitle(prompt) || "New thread"

const titleExecutionId = (turnId: Turn.TurnId) => AgentDepth.childExecutionId(String(turnId), "title")

const sanitizeThreadTitle = (text: string) =>
  [
    ...(text.split(/\r?\n/, 1)[0] ?? "")
      .replace(/\p{C}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'#\s]+/, "")
      .replace(/["'\s]+$/, ""),
  ]
    .slice(0, threadTitleLimit)
    .join("")
    .trimEnd()
const withSelectionEpoch = (event: InteractiveEvent, selectionEpoch: number): InteractiveEvent => {
  switch (event._tag) {
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPageAppended":
    case "TranscriptProjectionStarted":
    case "TranscriptProjectionPatched":
    case "TranscriptProjectionStopped":
    case "TranscriptProjectionFailed":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "QueueFull":
    case "TurnStarted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "ExecutionControlFailed":
    case "ExecutionControlled":
    case "ThreadUsageUpdated":
      return { ...event, selectionEpoch }
    default:
      return event
  }
}

class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  message: Schema.String,
}) {}
const operationError = (message: string) => OperationError.make({ message })
const executeShellCommand = Effect.fn("ProductOperation.executeShellCommand")(function* (
  tools: ToolRuntime.Interface,
  command: string,
) {
  let output: RecordedShellOutput = { text: "", truncated: false }
  let result = yield* tools.run({
    _tag: "Shell",
    command: "sh",
    args: ["-lc", command],
    waitMillis: 10_000,
  })
  while (true) {
    output = appendRecordedShellOutput({ ...output, truncated: output.truncated || result.truncated }, result.text)
    if (result.running !== true) {
      if (result.exitCode === undefined || !Number.isSafeInteger(result.exitCode))
        return yield* operationError("Shell command ended without an integer exit code")
      return {
        ...output,
        exitCode: result.exitCode,
      }
    }
    if (result.processId === undefined)
      return yield* operationError("Shell command is running without a process identifier")
    result = yield* tools.run({
      _tag: "ShellCommandStatus",
      processId: result.processId,
      waitMillis: 9_000,
    })
  }
})
const operationFailureDetail = (error: unknown) => {
  if (
    Schema.is(OperationError)(error) ||
    Schema.is(OperationUnavailable)(error) ||
    Schema.is(TurnRepository.QueuedTurnUnavailable)(error) ||
    Schema.is(StaleQueuedTurns)(error)
  )
    return error.message
  if (Schema.is(ExecutionBackend.BackendError)(error) && error.message.includes("cursor did not advance"))
    return error.message
  return operationFailureMessage
}
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const untrustedData = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")
const transcriptPageEncoder = new TextEncoder()
const maximumTranscriptPageBytes = 8 * 1024 * 1024
const maximumTranscriptPayloadBytes = maximumTranscriptPageBytes - 64 * 1024
const sameTranscriptCursor = (
  left: TranscriptRepository.PageCursor | undefined,
  right: TranscriptRepository.PageCursor | undefined,
) => left !== undefined && right !== undefined && encodeJson(left) === encodeJson(right)
const transcriptCursorFor = (
  entry: TranscriptRepository.Entry | undefined,
): TranscriptRepository.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }
const boundTurnEntries = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  detail: number,
): { readonly entries: ReadonlyArray<TranscriptRepository.Entry>; readonly contiguousFrom: number } => {
  const semantic = new Set(entries.flatMap((entry, index) => (isSemanticTranscriptEntry(entry) ? [index] : [])))
  const contiguousFrom = Math.max(0, entries.length - Math.max(0, detail - semantic.size))
  return {
    entries: entries.filter((_, index) => semantic.has(index) || index >= contiguousFrom),
    contiguousFrom,
  }
}
const isSemanticTranscriptEntry = (entry: TranscriptRepository.Entry): boolean =>
  entry.unit.parentId === undefined &&
  (entry.unit.content._tag === "Entry" ||
    entry.unit.content.block._tag === "Compaction" ||
    entry.unit.executionOutcome !== undefined)
const boundTranscriptEntries = (
  sourceEntries: ReadonlyArray<TranscriptRepository.Entry>,
): {
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly partialCursor?: TranscriptRepository.PageCursor
  readonly truncated: boolean
  readonly oversizedEntry: boolean
} => {
  let entries = sourceEntries
  let boundedStart = entries.length
  let boundedBytes = 0
  while (boundedStart > 0) {
    const entryBytes = transcriptPageEncoder.encode(encodeJson(entries[boundedStart - 1])).byteLength
    if (boundedBytes + entryBytes > maximumTranscriptPayloadBytes) {
      if (boundedStart === entries.length) return { entries: [], truncated: false, oversizedEntry: true }
      const bounded = boundPartialTranscriptEntries(entries, boundedStart, boundedBytes)
      return transcriptPageEncoder.encode(encodeJson(bounded.entries)).byteLength > maximumTranscriptPayloadBytes
        ? { entries: [], truncated: false, oversizedEntry: true }
        : bounded
    }
    boundedStart -= 1
    boundedBytes += entryBytes
  }
  return { entries, truncated: false, oversizedEntry: false }
}
const boundPartialTranscriptEntries = (
  sourceEntries: ReadonlyArray<TranscriptRepository.Entry>,
  initialStart: number,
  initialBytes: number,
): {
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly partialCursor?: TranscriptRepository.PageCursor
  readonly truncated: true
  readonly oversizedEntry: false
} => {
  let entries = sourceEntries
  let boundedStart = initialStart
  let boundedBytes = initialBytes
  let partialCursor: TranscriptRepository.PageCursor | undefined
  const turnBoundary = entries.findIndex(
    (entry, index) => index >= boundedStart && entry.unit.key === `turn:${entry.turn.id}:user`,
  )
  if (turnBoundary < 0) {
    const newest = entries.at(-1)
    const userBoundary =
      newest === undefined ? -1 : entries.findIndex((entry) => entry.unit.key === `turn:${newest.turn.id}:user`)
    if (userBoundary >= 0) {
      const userEntry = entries[userBoundary]!
      const semanticIndexes = new Set([userBoundary])
      let semanticBytes = transcriptPageEncoder.encode(encodeJson(userEntry)).byteLength
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (index === userBoundary) continue
        const entry = entries[index]!
        if (!isSemanticTranscriptEntry(entry)) continue
        const entryBytes = transcriptPageEncoder.encode(encodeJson(entry)).byteLength
        if (semanticBytes + entryBytes > maximumTranscriptPayloadBytes) continue
        semanticIndexes.add(index)
        semanticBytes += entryBytes
      }
      boundedStart = entries.length
      boundedBytes = semanticBytes
      while (boundedStart > userBoundary + 1) {
        const index = boundedStart - 1
        const entryBytes = semanticIndexes.has(index)
          ? 0
          : transcriptPageEncoder.encode(encodeJson(entries[index])).byteLength
        if (boundedBytes + entryBytes > maximumTranscriptPayloadBytes && boundedStart < entries.length) break
        boundedStart -= 1
        boundedBytes += entryBytes
      }
      partialCursor = transcriptCursorFor(entries[boundedStart])
      entries = entries.filter((_, index) => semanticIndexes.has(index) || index >= boundedStart)
    } else entries = entries.slice(boundedStart)
  } else entries = entries.slice(turnBoundary)
  return { entries, ...(partialCursor === undefined ? {} : { partialCursor }), truncated: true, oversizedEntry: false }
}
const selectionInitialTurnWindow = 12
const selectionInitialEntryWindow = 400
export interface ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
  ThreadInteractionError = never,
  UsageError = never,
> {
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadError>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnError>
  readonly threadSummaryRepositoryLayer?: Layer.Layer<ThreadSummaryRepository.Service, ThreadSummaryError>
  readonly transcriptRepositoryLayer?: Layer.Layer<TranscriptRepository.Service, TranscriptError>
  readonly threadInteractionRepositoryLayer?: Layer.Layer<ThreadInteractionRepository.Service, ThreadInteractionError>
  readonly usageRepositoryLayer?: Layer.Layer<UsageRepository.Service, UsageError>
  readonly threadToolGateway?: ThreadToolService.Gateway
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly resolveExecutionRoute?: (
    mode: ModeId,
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<Turn.ExecutionRoutePin, OperationError, ExecutionBackend.Service>
  readonly productAgentLayer?: Layer.Layer<ProductAgent.Service, OperationError, ExecutionBackend.Service>
  readonly toolRuntimeLayer?: (workspace: string) => Layer.Layer<ToolRuntime.Service, OperationError, never>
  readonly resolvedContextLayer?: Layer.Layer<ResolvedContext.Service, OperationError>
  readonly executionExtensions?: {
    readonly layer: Layer.Layer<ExecutionExtensions.ExecutionExtensionService, OperationError>
    readonly mcpFingerprint: Effect.Effect<string>
  }
  readonly defaultWorkspace: string
  readonly recoveredWorkGrace?: Duration.Input
  readonly pendingTurnCapacity?: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly configOperations?: {
    readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigurationService.ConfigurationService, OperationError>
    readonly options: ConfigOperations.Options
    readonly forWorkspace?: (workspace: string) => Effect.Effect<
      {
        readonly layer: Layer.Layer<
          ConfigOperations.Adapter | ConfigurationService.ConfigurationService,
          OperationError
        >
        readonly options: ConfigOperations.Options
      },
      OperationError
    >
  }
  readonly extensionOperations?: {
    readonly layer: Layer.Layer<
      | ExtensionOperations.Service
      | import("@rika/extensions/mcp-oauth-service").McpOAuthService
      | import("effect").FileSystem.FileSystem
      | import("effect").Path.Path
      | import("effect").Crypto.Crypto,
      OperationError
    >
  }
  readonly authOperations?: AuthOperationOptions
  readonly interactive?: (
    input: Extract<Input, { readonly _tag: "Interactive" }>,
    session: InteractiveSession,
  ) => Effect.Effect<void, OperationUnavailable>
}
export interface AuthOperationOptions {
  readonly layer: Layer.Layer<OpenAiAuth.Service, OperationError>
  readonly assertOpenAiDirect: (workspace: string) => Effect.Effect<void, OperationError>
}
export const runAuth = Effect.fn("ProductOperation.runAuth")(function* (
  input: Extract<Input, { readonly _tag: "Auth" }>,
  options: AuthOperationOptions,
  defaultWorkspace: string,
) {
  if (input.action === "login") {
    yield* options
      .assertOpenAiDirect(input.clientWorkspace ?? defaultWorkspace)
      .pipe(Effect.mapError((error) => unavailable(input, error.message)))
  }
  const context = yield* Layer.build(options.layer).pipe(Effect.mapError((error) => unavailable(input, String(error))))
  const auth = Context.get(context, OpenAiAuth.Service)
  if (input.action === "login") {
    yield* (input.deviceCode === true ? auth.loginDevice : auth.loginBrowser()).pipe(
      Effect.flatMap(() => Console.log("OpenAI account login complete.")),
      Effect.mapError((error) => unavailable(input, error.message)),
    )
    return
  }
  if (input.action === "logout") {
    const result = yield* auth.logout.pipe(Effect.mapError((error) => unavailable(input, error.message)))
    yield* Console.log(
      result.removed
        ? "OpenAI account credentials removed. Server revocation is not supported."
        : "No OpenAI account credentials were stored. Server revocation is not supported.",
    )
    return
  }
  const status = yield* auth.status.pipe(Effect.mapError((error) => unavailable(input, error.message)))
  let message: string
  if (status._tag === "Unauthenticated") {
    message = "OpenAI account: unauthenticated"
  } else if (status._tag === "Present") {
    message = "OpenAI account: credentials present (remote validity not checked)"
  } else if (status._tag === "RefreshRequired") {
    message = "OpenAI account: refresh required (remote validity not checked)"
  } else {
    message = "OpenAI account: credential store is corrupt; log in again after removing it"
  }
  yield* Console.log(message)
})
const reconcileInternal = Effect.fn("ProductOperation.reconcile")(function* (
  extensions?: ExecutionExtensions.ExecutionExtensionInterface,
  prepare?: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    | TurnRepository.Service
    | ThreadRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >,
  watchReviewOwner?: (
    turn: Turn.AgentExecutionTurn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
  ownership?: {
    readonly claim: (
      turn: Pick<Turn.AgentExecutionTurn, "id" | "status">,
    ) => Effect.Effect<boolean, TurnRepository.RepositoryError, TurnRepository.Service>
    readonly release: (turnId: Turn.TurnId) => Effect.Effect<boolean>
    readonly claimQueued: (
      threadId: Thread.ThreadId,
      now: number,
    ) => Effect.Effect<TurnRepository.QueueClaim | undefined, TurnRepository.RepositoryError, TurnRepository.Service>
  },
  repairQueues: boolean = true,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const active = yield* turns.listNonterminal
  const skipRepair = (turn: Turn.AgentExecutionTurn) =>
    Effect.logInfo("execution.repair.skipped").pipe(
      Effect.annotateLogs({
        "rika.turn.id": String(turn.id),
        "rika.turn.expected_status": turn.status,
        "rika.failure.kind": "turn-status-changed-or-observed",
      }),
    )
  yield* Effect.forEach(
    active.filter((turn) => turn.status !== "queued"),
    (turn) => {
      const repair =
        turn.reviewFanOutId !== undefined
          ? backend.inspectFanOut(turn.reviewFanOutId).pipe(
              Effect.flatMap((inspection) =>
                Effect.gen(function* () {
                  let status: Turn.Status = "failed"
                  if (inspection !== undefined) {
                    status = fanOutTurnStatus(inspection.state)
                  }
                  yield* turns.setStatus(turn.id, status, turn.lastCursor, yield* Clock.currentTimeMillis)
                  if (inspection?.state === "joining" && watchReviewOwner !== undefined)
                    yield* watchReviewOwner(turn, inspection)
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                  return yield* error
                }),
              ),
            )
          : backend.inspect(turn.id).pipe(
              Effect.flatMap((inspection) =>
                inspection === undefined
                  ? Effect.gen(function* () {
                      const now = yield* Clock.currentTimeMillis
                      if ((yield* awaitSessionQuiescence(backend, turn.threadId)) !== undefined) return
                      if (prepare === undefined && extensions !== undefined && turn.extensionPin === undefined)
                        return yield* operationError(`Turn ${turn.id} has no durable extension pin`)
                      if (prepare === undefined && extensions !== undefined && turn.extensionPin !== undefined)
                        yield* extensions.resume(turn.extensionPin)
                      const prepared =
                        prepare === undefined
                          ? { prompt: turn.prompt, promptParts: turn.promptParts, extensionPin: turn.extensionPin }
                          : yield* (yield* ThreadRepository.Service)
                              .get(turn.threadId)
                              .pipe(
                                Effect.flatMap((thread) =>
                                  thread === undefined
                                    ? operationError(`Thread ${turn.threadId} does not exist`)
                                    : prepare(turn, thread.workspace),
                                ),
                              )
                      if (turn.status === "accepted") {
                        if (!(yield* turns.startAccepted(turn.id, now))) return
                      } else {
                        const current = yield* turns.get(turn.id)
                        if (current === undefined || !Turn.isAgentExecution(current) || current.status !== turn.status)
                          return
                      }
                      const result = yield* backend.start({
                        threadId: turn.threadId,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                        executionRoute: turn.executionRoute,
                        ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                      })
                      yield* turns.setStatus(
                        turn.id,
                        result.status,
                        result.checkpoint?.cursor ??
                          ThreadActivity.latestCursor(turn.id, result.events) ??
                          turn.lastCursor,
                        now,
                      )
                    }).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                          return yield* error
                        }),
                      ),
                    )
                  : Effect.gen(function* () {
                      if (isTerminalStatus(inspection.status) && !(yield* executionTreeQuiescent(backend, turn.id)))
                        return
                      yield* turns.setStatus(
                        turn.id,
                        inspection.status,
                        inspection.lastCursor ?? turn.lastCursor,
                        yield* Clock.currentTimeMillis,
                      )
                    }),
              ),
            )
      if (ownership === undefined)
        return turns
          .get(turn.id)
          .pipe(Effect.flatMap((current) => (current?.status === turn.status ? repair : skipRepair(turn))))
      return Effect.uninterruptibleMask((restore) =>
        ownership
          .claim(turn)
          .pipe(
            Effect.flatMap((claimed) =>
              claimed ? restore(repair).pipe(Effect.ensuring(ownership.release(turn.id))) : skipRepair(turn),
            ),
          ),
      )
    },
    { discard: true },
  )
  const threadIds = [...new Set(active.map((turn) => turn.threadId))]
  if (backend.wakeThreadHost !== undefined) {
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const wake = yield* turns.requestQueueWake(threadId)
          if (wake === undefined) return
          const now = yield* Clock.currentTimeMillis
          yield* backend.wakeThreadHost!({ ...wake, now })
        }),
      { discard: true },
    )
    return
  }
  if (!repairQueues) return
  const promotionNow = yield* Clock.currentTimeMillis
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
        const queue = yield* turns.readQueue(threadId)
        const staleError = staleQueuedTurnsError(threadId, queue.turns, promotionNow, queuedTurnPromoteMaxAgeMs)
        if (staleError !== undefined) {
          yield* Effect.logWarning("execution.queue.stale_refused").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(threadId),
              "rika.turn.count": staleError.turnIds.length,
            }),
          )
          return
        }
        const thread = prepare === undefined ? undefined : yield* (yield* ThreadRepository.Service).get(threadId)
        if (prepare !== undefined && thread === undefined) return
        const executePromoted = (claim: TurnRepository.QueueClaim) =>
          Effect.gen(function* () {
            const promotedTurn = claim.turn
            const prepared = yield* prepare === undefined
              ? Effect.succeed({
                  prompt: promotedTurn.prompt,
                  promptParts: promotedTurn.promptParts,
                  extensionPin: promotedTurn.extensionPin,
                })
              : prepare(promotedTurn, thread!.workspace)
            const transition = yield* turns.finishQueuedClaim(
              claim,
              "running",
              promotedTurn.lastCursor,
              prepared.extensionPin,
              yield* Clock.currentTimeMillis,
            )
            if (transition._tag === "Unavailable") return undefined
            return yield* backend
              .start({
                threadId,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                executionRoute: promotedTurn.executionRoute,
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* turns.setStatus(
                      promotedTurn.id,
                      "failed",
                      promotedTurn.lastCursor,
                      yield* Clock.currentTimeMillis,
                    )
                    return yield* error
                  }),
                ),
              )
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const current = yield* turns.get(claim.turn.id)
                if (current?.status === "queued")
                  yield* turns.finishQueuedClaim(
                    claim,
                    "failed",
                    claim.turn.lastCursor,
                    claim.turn.extensionPin,
                    yield* Clock.currentTimeMillis,
                  )
                return yield* error
              }),
            ),
            Effect.onInterrupt(() => turns.releaseQueuedClaim(claim)),
          )
        while (true) {
          if ((yield* turns.readQueue(threadId)).queuedCount === 0) return
          if ((yield* awaitSessionQuiescence(backend, threadId)) !== undefined) return
          let promotedTurn: TurnRepository.QueueClaim
          let result: ExecutionBackend.Result
          if (ownership === undefined) {
            const promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
            if (promoted === undefined) return
            promotedTurn = promoted
            const executionResult = yield* executePromoted(promoted)
            if (executionResult === undefined) continue
            result = executionResult
          } else {
            const repaired = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const promoted = yield* ownership.claimQueued(threadId, yield* Clock.currentTimeMillis)
                if (promoted === undefined) return undefined
                const executionResult = yield* restore(executePromoted(promoted)).pipe(
                  Effect.ensuring(ownership.release(promoted.turn.id)),
                )
                return { promoted, result: executionResult }
              }),
            )
            if (repaired === undefined) return
            if (repaired.result === undefined) continue
            promotedTurn = repaired.promoted
            result = repaired.result
          }
          yield* turns.setStatus(
            promotedTurn.turn.id,
            result.status,
            result.checkpoint?.cursor ??
              ThreadActivity.latestCursor(promotedTurn.turn.id, result.events) ??
              promotedTurn.turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          if (!isTerminalStatus(result.status) || result.status === "failed") return
        }
      }),
    { discard: true },
  )
})
export const reconcile = Effect.fn("ProductOperation.reconcilePublic")(function* (
  extensions?: ExecutionExtensions.ExecutionExtensionInterface,
  prepare?: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    | TurnRepository.Service
    | ThreadRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >,
  watchReviewOwner?: (
    turn: Turn.AgentExecutionTurn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
): Effect.fn.Return<
  void,
  OperationError,
  | ExecutionBackend.Service
  | TurnRepository.Service
  | ThreadRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.ExecutionExtensionService
> {
  return yield* reconcileInternal(extensions, prepare, watchReviewOwner).pipe(
    Effect.mapError((error) => operationError(String(error))),
  )
})
const fanOutTurnStatus = (state: "joining" | "satisfied" | "failed" | "cancelled"): Turn.Status => {
  if (state === "joining") return "running"
  return state === "satisfied" ? "completed" : state
}
const normalizeChildExecutionId = TranscriptCorrelation.executionKey
type ThreadUsageEvent = Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>
const initializeSelectedUsage = (threadId: Thread.ThreadId, request: number): ThreadUsageEvent => ({
  _tag: "ThreadUsageUpdated",
  selectionEpoch: request,
  threadId,
  revision: 0,
  cost: { _tag: "Unavailable" },
  tokens: { _tag: "Unavailable" },
  time: { _tag: "Unavailable" },
})
const persistedThreadUsage = (
  value: UsageRepository.Aggregate,
): Pick<ThreadUsageEvent, "cost" | "tokens" | "time"> => ({
  cost:
    value.costNanoUsd === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", usd: value.costNanoUsd / 1_000_000_000, unpricedAttempts: value.unpricedAttempts },
  tokens:
    value.tokens === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", total: value.tokens, uncountedAttempts: value.uncountedAttempts },
  time:
    value.activeMillis === undefined
      ? { _tag: "Unavailable" }
      : {
          _tag: "Available",
          accumulatedMillis: value.activeMillis,
          ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince }),
        },
})
const transcriptProjectionEvent = (change: ExecutionIngest.ProjectionChange): InteractiveEvent => {
  switch (change._tag) {
    case "ProjectionStarted": {
      const { rootStatus: startedRootStatus, ...snapshot } = change.snapshot
      return {
        _tag: "TranscriptProjectionStarted",
        selectionEpoch: 0,
        ...snapshot,
        ...(startedRootStatus === undefined ? {} : { rootStatus: startedRootStatus }),
      }
    }
    case "ProjectionPatched": {
      const { rootStatus: patchedRootStatus, ...patch } = change.patch
      return {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: 0,
        ...patch,
        ...(patchedRootStatus === undefined ? {} : { rootStatus: patchedRootStatus }),
      }
    }
    case "ProjectionStopped":
      return {
        _tag: "TranscriptProjectionStopped",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        status: change.status,
      }
    case "ProjectionFailed":
      return {
        _tag: "TranscriptProjectionFailed",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        executionId: change.failure.executionId ?? String(change.rootTurnId),
        reason: change.failure.reason,
        message: change.failure.message,
      }
    default:
      return Function.absurd(change)
  }
}
export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event>
  (events: ReadonlyArray<ExecutionBackend.Event>): (turnId: string) => ReadonlyArray<ExecutionBackend.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
    events.filter((event) => ExecutionId.ownsExecution(turnId, event.executionId)),
)
const undeliveredEvents = (
  events: ReadonlyArray<ExecutionBackend.Event>,
  delivered: ReadonlySet<string>,
): ReadonlyArray<ExecutionBackend.Event> =>
  events.filter((event) => !delivered.has(event.cursor)).toSorted((left, right) => left.sequence - right.sequence)
type SelectionEpochState = {
  readonly epoch: number
  readonly thread: Thread.Thread
  readonly loadedKeys: Set<string>
  transcriptCursor: TranscriptRepository.PageCursor | undefined
  newestTranscriptCursor: TranscriptRepository.PageCursor | undefined
  hasOlder: boolean
  projectionFeed?: {
    readonly watch: ExecutionIngest.ProjectionWatch
    readonly scope: Scope.Closeable
    promoted: boolean
  }
}
const makeSelectionState = (thread: Thread.Thread, epoch: number): SelectionEpochState => ({
  epoch,
  thread,
  loadedKeys: new Set(),
  transcriptCursor: undefined,
  newestTranscriptCursor: undefined,
  hasOlder: false,
})
const projectedOutcomeStatus = (status: "completed" | "failed" | "cancelled"): "complete" | "failed" | "cancelled" => {
  if (status === "completed") return "complete"
  return status
}
const sessionQuiescencePollAttempts = 40
const sessionQuiescenceCandidateLimit = 8
const executionTreeQuiescent = Effect.fn("ProductOperation.executionTreeQuiescent")(function* (
  backend: ExecutionBackend.Interface,
  turnId: string,
  reference: boolean = false,
) {
  const root = yield* backend.inspect(turnId, reference ? ExecutionBackend.executionReference : undefined)
  if (root === undefined) return true
  if (!isTerminalStatus(root.status)) return false
  const pending: Array<string> = []
  const seen = new Set<string>()
  for (const child of root.children) {
    if (!isTerminalStatus(child.status)) return false
    seen.add(normalizeChildExecutionId(child.executionId))
    pending.push(child.executionId)
  }
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(current, ExecutionBackend.executionReference)
    if (inspection === undefined) continue
    if (!isTerminalStatus(inspection.status)) return false
    for (const child of inspection.children) {
      const normalized = normalizeChildExecutionId(child.executionId)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      if (!isTerminalStatus(child.status)) return false
      pending.push(child.executionId)
    }
  }
  return true
})
const workflowReplacementKey = (runId: string, ownerTurnId?: string, workspace?: string) =>
  JSON.stringify([runId, ownerTurnId, workspace])
export const hasActiveExecutionWork = Effect.fn("ProductOperation.hasActiveExecutionWork")(function* () {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const persisted =
    backend.listOpenRootExecutions === undefined
      ? (yield* Effect.forEach(yield* (yield* ThreadRepository.Service).listAll, (thread) => turns.list(thread.id), {
          concurrency: 1,
        }))
          .flat()
          .filter(Turn.isAgentExecution)
          .filter((turn) => turn.status !== "queued")
      : (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
  for (const turn of persisted) {
    const terminal = isTerminalStatus(turn.status)
    if (turn.reviewFanOutId !== undefined) {
      const fanOut = yield* backend.inspectFanOut(turn.reviewFanOutId)
      if (fanOut === undefined) {
        if (!terminal) yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
        continue
      }
      if (fanOut.state === "joining" || fanOut.members.some((member) => !isTerminalStatus(member.state))) return true
      for (const member of fanOut.members) {
        const executionId = AgentDepth.childExecutionId(turn.id, member.childId)
        if (!(yield* executionTreeQuiescent(backend, executionId, true))) return true
      }
      if (!terminal) {
        const status = fanOutTurnStatus(fanOut.state)
        yield* turns.setStatus(turn.id, status, turn.lastCursor, yield* Clock.currentTimeMillis)
      }
      continue
    }
    const inspection = yield* backend.inspect(turn.id)
    if (inspection === undefined) {
      if (!terminal) yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
      continue
    }
    if (!(yield* executionTreeQuiescent(backend, turn.id))) return true
    if (!terminal)
      yield* turns.setStatus(
        turn.id,
        inspection.status,
        inspection.lastCursor ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
  }
  return backend.listOpenRootExecutions === undefined ? false : (yield* backend.listOpenRootExecutions).length > 0
})
const blockedSessionWriter = Effect.fn("ProductOperation.blockedSessionWriter")(function* (
  backend: ExecutionBackend.Interface,
  threadId: Thread.ThreadId,
) {
  const turns = yield* TurnRepository.Service
  const history = yield* turns.list(threadId)
  const candidates = history
    .filter(Turn.isAgentExecution)
    .filter((turn) => turn.status === "cancelled" || turn.status === "failed")
    .slice(-sessionQuiescenceCandidateLimit)
    .toReversed()
  for (const candidate of candidates) {
    const quiescent = yield* executionTreeQuiescent(backend, candidate.id).pipe(Effect.orElseSucceed(() => false))
    if (!quiescent) return candidate
  }
  return undefined
})
const settleStopRequestedTurns = Effect.fn("ProductOperation.settleStopRequestedTurns")(function* <E, R>(
  backend: ExecutionBackend.Interface,
  settle: (
    turnId: Turn.TurnId,
    status: Turn.Status,
    cursor: string | undefined,
    settledAt: number,
  ) => Effect.Effect<void, E, R>,
) {
  const turns = yield* TurnRepository.Service
  for (const turn of yield* turns.listStopRequested) {
    const outcome = yield* Effect.result(backend.cancel(turn.id))
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("execution.stop.settle_cancel_failed").pipe(
        Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.failure.kind": String(outcome.failure) }),
      )
      continue
    }
    const result = outcome.success
    yield* settle(
      turn.id,
      result.status,
      result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
      yield* Clock.currentTimeMillis,
    )
    yield* Effect.logInfo("execution.stop.settled").pipe(Effect.annotateLogs({ "rika.turn.id": String(turn.id) }))
  }
})
export const stopActiveExecutionWork = Effect.fn("ProductOperation.stopActiveExecutionWork")(function* () {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const running = (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of running) yield* turns.requestStop(turn.id, requestedAt)
  if (running.length > 0)
    yield* Effect.logInfo("execution.stop.requested_for_all").pipe(
      Effect.annotateLogs({ "rika.turn.count": running.length }),
    )
  yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
    turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
  )
})
export const settleAbandonedRecoveredWork = Effect.fn("ProductOperation.settleAbandonedRecoveredWork")(function* (
  grace: Duration.Duration,
  watchedThreads: () => ReadonlySet<string>,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const bootAt = yield* Clock.currentTimeMillis
  yield* Effect.sleep(grace)
  const watched = watchedThreads()
  const abandoned = (yield* turns.listNonterminal).filter(
    (turn) => turn.status !== "queued" && turn.createdAt < bootAt && !watched.has(String(turn.threadId)),
  )
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of abandoned) {
    yield* turns.requestStop(turn.id, requestedAt)
    yield* Effect.logInfo("execution.recovery.abandoned_stop_requested").pipe(
      Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.thread.id": String(turn.threadId) }),
    )
  }
  if (abandoned.length > 0)
    yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
      turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
    )
  if (backend.listOpenRootExecutions === undefined) return
  const openRoots = yield* backend.listOpenRootExecutions.pipe(Effect.orElseSucceed(() => []))
  for (const root of openRoots) {
    if (root.createdAt >= bootAt) continue
    const turn = root.turnId === undefined ? undefined : yield* turns.get(Turn.TurnId.make(root.turnId))
    if (turn !== undefined && Turn.isAgentExecution(turn) && !isTerminalStatus(turn.status)) continue
    yield* backend
      .cancel(root.executionId, ExecutionBackend.executionReference)
      .pipe(
        Effect.catch((failure) =>
          Effect.logWarning("execution.recovery.orphan_cancel_failed").pipe(
            Effect.annotateLogs({ "rika.execution.id": root.executionId, "rika.failure.kind": String(failure) }),
          ),
        ),
      )
    yield* Effect.logInfo("execution.recovery.orphan_cancelled").pipe(
      Effect.annotateLogs({ "rika.execution.id": root.executionId }),
    )
  }
})
const awaitSessionQuiescence = Effect.fn("ProductOperation.awaitSessionQuiescence")(function* (
  backend: ExecutionBackend.Interface,
  threadId: Thread.ThreadId,
) {
  let blocked = yield* blockedSessionWriter(backend, threadId)
  if (blocked === undefined) return undefined
  yield* Effect.logInfo("execution.admission.blocked").pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(threadId),
      "rika.predecessor.turn.id": String(blocked.id),
      "rika.predecessor.turn.status": blocked.status,
    }),
  )
  for (let attempt = 1; attempt < sessionQuiescencePollAttempts; attempt += 1) {
    yield* Effect.sleep("250 millis")
    blocked = yield* blockedSessionWriter(backend, threadId)
    if (blocked === undefined) return undefined
  }
  yield* Effect.logWarning("execution.admission.deferred").pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(threadId),
      "rika.predecessor.turn.id": String(blocked.id),
      "rika.predecessor.turn.status": blocked.status,
    }),
  )
  return blocked
})
const queueItem = (turn: Turn.AgentExecutionTurn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  return attachments === undefined || attachments.length === 0
    ? { id: turn.id, prompt: turn.prompt }
    : { id: turn.id, prompt: turn.prompt, attachments }
}
const queueMutationEvent = (queue: TurnRepository.QueueItemChange): InteractiveEvent => {
  const change =
    queue.change._tag === "Removed"
      ? ({ _tag: "Removed", turnId: queue.change.turnId } as const)
      : ({ _tag: queue.change._tag, item: queueItem(queue.change.turn) } as const)
  return {
    _tag: "QueueUpdated",
    selectionEpoch: 0,
    threadId: queue.threadId,
    revision: queue.revision,
    queuedCount: queue.queuedCount,
    change,
  }
}
const unavailable = (input: Input, message = `${input._tag} is specified but not implemented yet`) =>
  OperationUnavailable.make({ operation: input._tag, message })
const writeThread = (thread: Thread.Thread) => Console.log(encodeJson(thread))
const requireThread = Effect.fn("ProductOperation.requireThread")(function* (
  repository: ThreadRepository.Interface,
  id: string,
) {
  const thread = yield* repository.get(Thread.ThreadId.make(id))
  if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
  return thread
})
const markdownExport = (thread: Thread.Thread, turns: ReadonlyArray<Turn.Turn>) =>
  [
    `# ${thread.title}`,
    "",
    `- Thread: ${thread.id}`,
    `- Workspace: ${thread.workspace}`,
    `- Labels: ${thread.labels.join(", ") || "None"}`,
    "",
    ...turns.flatMap((turn, index) => [`## Turn ${index + 1}`, "", `Status: ${turn.status}`, "", turn.prompt, ""]),
  ].join("\n")
export const productLayer = <
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
  ThreadInteractionError = never,
  UsageError = never,
>(
  options: ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ownerScope = yield* Effect.scope
      const pendingTurnCapacity = Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64))
      const reviewSettlementAdmission = yield* Semaphore.make(1)
      const turnMutationAdmission = yield* Semaphore.make(1)
      const createForSubmission = (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) =>
        turnMutationAdmission.withPermits(1)(turns.createForSubmission(input))
      const turnChanges = yield* PubSub.sliding<void>(1)
      const dirtyTurnObservers = new Set<Turn.TurnId>()
      let interactiveSessionSequence = 0
      let activitySequence = 0
      const interactiveSinks = new Map<number, (origin: number, event: InteractiveEvent) => void>()
      const sessionThreadViews = new Map<number, () => string | undefined>()
      const watchedThreadIds = () => {
        const watched = new Set<string>()
        for (const view of sessionThreadViews.values()) {
          const threadId = view()
          if (threadId !== undefined) watched.add(threadId)
        }
        return watched
      }
      let rootTurnOwner: RootTurnOwner.Interface
      const claimTurnObserver = (turnId: Turn.TurnId, expectedStatus?: Turn.Status) =>
        rootTurnOwner.claim(turnId, expectedStatus)
      const releaseTurnObserver = (turnId: Turn.TurnId, notify: boolean = true) =>
        Effect.uninterruptible(
          rootTurnOwner
            .release(turnId)
            .pipe(
              Effect.tap(() =>
                notify
                  ? Effect.sync(() => dirtyTurnObservers.add(turnId)).pipe(
                      Effect.andThen(PubSub.publish(turnChanges, undefined)),
                    )
                  : Effect.void,
              ),
            ),
        )
      const createObservedSubmission = (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) =>
        Effect.gen(function* () {
          const turn = yield* turns.createForSubmission(input)
          if (turn.status === "queued") return { turn, claimed: false }
          return { turn, claimed: yield* rootTurnOwner.claim(turn.id, turn.status) }
        }).pipe(turnMutationAdmission.withPermits(1))
      const claimQueuedTurn = (threadId: Thread.ThreadId, now: number) => rootTurnOwner.claimQueued(threadId, now)
      const publishInteractiveActivity = (origin: number, event: InteractiveEvent) => {
        activitySequence += 1
        for (const [sessionId, sink] of interactiveSinks) if (sessionId !== origin) sink(origin, event)
      }
      const reviewSettlements = new Map<string, Fiber.Fiber<ExecutionBackend.FanOutInspection, OperationError>>()
      const resolvedContextLayer =
        options.resolvedContextLayer ??
        ResolvedContext.testLayer({
          resolve: () => Effect.succeed({ sources: [], diagnostics: [], digest: "" }),
        })
      const repositories = Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)
      const threadSummaryRepositoryLayer =
        options.threadSummaryRepositoryLayer ?? ThreadSummaryRepository.memoryLayer.pipe(Layer.provide(repositories))
      const transcriptRepositoryLayer =
        options.transcriptRepositoryLayer ?? TranscriptRepository.memoryLayerWithTurns.pipe(Layer.provide(repositories))
      const usageRepositoryLayer = options.usageRepositoryLayer ?? UsageRepository.memoryLayer
      const threadInteractionRepositoryLayer = options.threadInteractionRepositoryLayer ?? Layer.empty
      const executionExtensionsLayer = options.executionExtensions?.layer ?? Layer.empty
      const dependencies = Layer.mergeAll(
        repositories,
        threadSummaryRepositoryLayer,
        transcriptRepositoryLayer,
        usageRepositoryLayer,
        threadInteractionRepositoryLayer,
        resolvedContextLayer,
        executionExtensionsLayer,
      )
      const dependencyContext = yield* Layer.buildWithScope(dependencies, ownerScope)
      const acquiredDependencies = Layer.succeedContext(dependencyContext)
      const rawBackend = Context.get(
        yield* Layer.buildWithScope(options.backendLayer, ownerScope),
        ExecutionBackend.Service,
      )
      const usageRepository = Context.get(dependencyContext, UsageRepository.Service)
      const publishThreadUsage = Effect.fn("ProductOperation.publishThreadUsage")(function* (
        value: UsageRepository.TurnUsage | undefined,
      ) {
        if (value === undefined) return
        const thread = yield* usageRepository.readThread(value.threadId)
        const global = yield* usageRepository.readGlobal
        if (thread.costNanoUsd === undefined && thread.tokens === undefined && thread.activeMillis === undefined) return
        publishInteractiveActivity(0, {
          _tag: "ThreadUsageUpdated",
          selectionEpoch: 0,
          threadId: Thread.ThreadId.make(value.threadId),
          revision: thread.revision,
          ...persistedThreadUsage(thread),
        })
        if (value.costNanoUsd !== undefined && thread.costNanoUsd !== undefined && global.costNanoUsd !== undefined)
          publishInteractiveActivity(0, {
            _tag: "TitleCostUpdated",
            threadId: Thread.ThreadId.make(value.threadId),
            turnId: Turn.TurnId.make(value.turnId),
            turnCostUsd: value.costNanoUsd / 1_000_000_000,
            threadCostUsd: thread.costNanoUsd / 1_000_000_000,
            globalCostUsd: global.costNanoUsd / 1_000_000_000,
          })
      })
      const replacementAdmission = yield* Semaphore.make(1)
      const replacementState = yield* Ref.make({ closed: false, active: 0 })
      const activeWorkflows = new Map<
        string,
        { readonly runId: string; readonly ownerTurnId?: string; readonly workspace?: string }
      >()
      const withExecutionAdmission = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | ExecutionBackend.BackendError, R> =>
        Effect.acquireUseRelease(
          replacementAdmission.withPermits(1)(
            Ref.modify(replacementState, (state) =>
              state.closed ? [false, state] : [true, { ...state, active: state.active + 1 }],
            ),
          ),
          (admitted): Effect.Effect<A, E | ExecutionBackend.BackendError, R> =>
            admitted
              ? effect
              : Effect.fail(
                  ExecutionBackend.BackendError.make({
                    message: "Resident replacement has closed execution admission",
                  }),
                ),
          (admitted) =>
            admitted
              ? Ref.update(replacementState, (state) => ({ ...state, active: Math.max(0, state.active - 1) }))
              : Effect.void,
        )
      const acquiredBackend = ExecutionBackend.Service.of({
        ...rawBackend,
        start: (input) => withExecutionAdmission(rawBackend.start(input)),
        ...(rawBackend.follow === undefined
          ? {}
          : {
              follow: (turnId, afterCursor, onEvent, reference, eventScope) =>
                rawBackend.follow!(turnId, afterCursor, onEvent, reference, eventScope),
            }),
        cancel: (turnId, reference) => withExecutionAdmission(rawBackend.cancel(turnId, reference)),
        invokeChild: (input) => withExecutionAdmission(rawBackend.invokeChild(input)),
        createFanOut: (input) => withExecutionAdmission(rawBackend.createFanOut(input)),
        startWorkflow: (name, runId, revision, ownerTurnId, workspace) =>
          withExecutionAdmission(
            rawBackend.startWorkflow(name, runId, revision, ownerTurnId, workspace).pipe(
              Effect.tap((inspection) =>
                Effect.sync(() => {
                  const key = workflowReplacementKey(runId, ownerTurnId, workspace)
                  if (inspection.status === "running")
                    activeWorkflows.set(key, {
                      runId,
                      ...(ownerTurnId === undefined ? {} : { ownerTurnId }),
                      ...(workspace === undefined ? {} : { workspace }),
                    })
                  else activeWorkflows.delete(key)
                }),
              ),
            ),
          ),
      })
      rootTurnOwner = yield* RootTurnOwner.make(
        Context.get(dependencyContext, TurnRepository.Service),
        acquiredBackend,
        ownerScope,
      )
      const backendLayer = Layer.succeed(ExecutionBackend.Service, acquiredBackend)
      if (options.threadToolGateway !== undefined) {
        const threadToolService = yield* ThreadToolService.make({ scheduler: rootTurnOwner }).pipe(
          Effect.provide(Context.merge(dependencyContext, Context.make(ExecutionBackend.Service, acquiredBackend))),
        )
        yield* options.threadToolGateway.install(threadToolService)
      }
      const extensionService =
        options.executionExtensions === undefined
          ? undefined
          : Context.get(dependencyContext, ExecutionExtensions.ExecutionExtensionService)
      const executionDependencies = Context.merge(
        dependencyContext,
        Context.make(ExecutionBackend.Service, acquiredBackend),
      )
      const commitUsageSource = Effect.fn("ProductOperation.commitUsageSource")(function* (
        sourceId: string,
        threadId: string,
        turnId: string,
        events: ReadonlyArray<ExecutionBackend.Event>,
        terminal: boolean,
      ) {
        yield* usageRepository.admitSource(sourceId, turnId, threadId)
        while (true) {
          const stored = yield* usageRepository.loadSourceFold(sourceId, turnId)
          if (stored === undefined)
            return yield* UsageRepository.RepositoryError.make({ message: `Usage source ${sourceId} was not admitted` })
          const decoded =
            stored.foldJson === undefined ? Result.succeed(UsageCost.empty) : UsageCost.deserialize(stored.foldJson)
          if (Result.isFailure(decoded)) return yield* decoded.failure
          const folded = UsageCost.foldBatch(
            decoded.success,
            events.map((event) => ({ threadId, turnId, event })),
            terminal ? new Set([sourceId]) : new Set(),
          )
          if (Result.isFailure(folded)) return yield* folded.failure
          const foldJson = UsageCost.serialize(folded.success)
          const totals = { ...UsageCost.materialize(folded.success, turnId, threadId), sourceComplete: terminal }
          if (foldJson === stored.foldJson) {
            const source = yield* usageRepository.readSource(sourceId, turnId)
            if (source?.sourceComplete === terminal) return source
          }
          const committed = yield* usageRepository.commitSource(sourceId, turnId, stored.revision, foldJson, totals)
          if (committed._tag === "Applied") return committed.value
        }
      })
      const usageCommits = yield* Queue.unbounded<ExecutionIngest.Commit>()
      const refoldingRoots = new Map<string, number>()
      const publishRefold = (refold: ExecutionIngest.Refold) => {
        const key = String(refold.threadId)
        const current = refoldingRoots.get(key) ?? 0
        const next = refold.phase === "started" ? current + 1 : Math.max(0, current - 1)
        if (next === 0) refoldingRoots.delete(key)
        else refoldingRoots.set(key, next)
        const refolding = next > 0
        if (refolding === current > 0) return
        publishInteractiveActivity(0, {
          _tag: "ThreadRefolding",
          selectionEpoch: 0,
          threadId: refold.threadId,
          refolding,
        })
      }
      const executionIngest = yield* ExecutionIngest.make({
        backend: acquiredBackend,
        transcripts: Context.get(dependencyContext, TranscriptRepository.Service),
        turns: Context.get(dependencyContext, TurnRepository.Service),
        usage: usageRepository,
        onCommitted: (commit) => Queue.offerUnsafe(usageCommits, commit),
        onRefold: publishRefold,
        onFailure: (failure) =>
          publishInteractiveActivity(0, {
            _tag: "ExecutionFailed",
            selectionEpoch: 0,
            threadId: Thread.ThreadId.make(failure.threadId ?? ""),
            turnId: Turn.TurnId.make(failure.turnId ?? ""),
            message: ingestFailureMessage,
          }),
      })
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            const commit = yield* Queue.take(usageCommits)
            if (commit.refolded) {
              const sourceId = titleExecutionId(commit.rootTurnId)
              const inspection = yield* acquiredBackend.inspect(sourceId, ExecutionBackend.executionReference)
              if (inspection !== undefined) {
                if (!isTerminalStatus(inspection.status))
                  return yield* operationError(`Title usage source ${sourceId} is nonterminal after root refold`)
                const replay = yield* acquiredBackend.replay(sourceId, undefined, ExecutionBackend.executionReference)
                if (replay.status !== inspection.status)
                  return yield* operationError(`Title usage source ${sourceId} has contradictory terminal status`)
                yield* commitUsageSource(
                  sourceId,
                  String(commit.threadId),
                  String(commit.rootTurnId),
                  replay.events,
                  true,
                )
              }
            }
            if (commit.usageChanged || commit.refolded)
              yield* usageRepository.readTurn(String(commit.rootTurnId)).pipe(Effect.flatMap(publishThreadUsage))
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("usage-projection.publish.failed").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": failureKind(cause),
                    "rika.failure.cause": Cause.pretty(cause),
                  }),
                ),
          ),
        ),
        ownerScope,
      )
      const ensureIngest = (threadId: Thread.ThreadId, turnId: Turn.TurnId) =>
        executionIngest.ensure({ threadId, turnId }).pipe(Effect.mapError((failure) => operationError(failure.message)))
      const awaitIngestSettled = (turnId: Turn.TurnId) =>
        executionIngest.settled(turnId).pipe(Effect.mapError((failure) => operationError(failure.message)))
      const flushIngest = (turnId: Turn.TurnId) =>
        executionIngest.flush(turnId).pipe(Effect.mapError((failure) => operationError(failure.message)))
      const deliverResultEvents = (
        turnId: Turn.TurnId,
        events: ReadonlyArray<ExecutionBackend.Event>,
        delivered: ReadonlySet<string> = new Set(),
      ) => {
        for (const event of undeliveredEvents(events, delivered)) executionIngest.deliver(turnId, event)
      }
      const stopActiveExecutionWorkWithProjection = Effect.fn("ProductOperation.stopActiveExecutionWorkWithProjection")(
        function* () {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          const running = (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
          for (const turn of running) {
            yield* ensureIngest(turn.threadId, turn.id)
            yield* flushIngest(turn.id)
          }
          const requestedAt = yield* Clock.currentTimeMillis
          for (const turn of running) yield* turns.requestStop(turn.id, requestedAt)
          if (running.length > 0)
            yield* Effect.logInfo("execution.stop.requested_for_all").pipe(
              Effect.annotateLogs({ "rika.turn.count": running.length }),
            )
          for (const turn of yield* turns.listStopRequested) {
            const outcome = yield* Effect.result(backend.cancel(turn.id))
            if (outcome._tag === "Failure") {
              yield* Effect.logWarning("execution.stop.settle_cancel_failed").pipe(
                Effect.annotateLogs({
                  "rika.turn.id": String(turn.id),
                  "rika.failure.kind": String(outcome.failure),
                }),
              )
              continue
            }
            const result = outcome.success
            deliverResultEvents(turn.id, result.events)
            yield* turns.setStatus(
              turn.id,
              result.status,
              result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
              yield* Clock.currentTimeMillis,
            )
            yield* Effect.logInfo("execution.stop.settled").pipe(
              Effect.annotateLogs({ "rika.turn.id": String(turn.id) }),
            )
            yield* ensureIngest(turn.threadId, turn.id)
            yield* flushIngest(turn.id)
            yield* awaitIngestSettled(turn.id)
          }
        },
      )
      const threadInteractions =
        options.threadInteractionRepositoryLayer === undefined
          ? undefined
          : Context.get(dependencyContext, ThreadInteractionRepository.Service)
      yield* Effect.provide(
        Context.get(dependencyContext, TurnRepository.Service).resetQueueClaims,
        executionDependencies,
      )
      const notifyThreadSummaries = Effect.gen(function* () {
        const summaries = yield* ThreadSummaryRepository.Service
        publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
      })
      const settledTitleExecutions = new Set<string>()
      const titleAttempts = new Map<string, number>()
      const maximumTitleAttempts = 3
      const titleThread = Effect.fn("ProductOperation.titleThread")(function* (
        thread: Thread.Thread,
        firstTurn: Turn.AgentExecutionTurn,
        announce: (event: InteractiveEvent) => void,
      ) {
        const program = Effect.gen(function* () {
          if (firstTurn.executionRoute.title === undefined) return
          const backend = yield* ExecutionBackend.Service
          const threads = yield* ThreadRepository.Service
          const current = yield* threads.get(thread.id)
          if (current === undefined || current.title !== temporaryThreadTitle(firstTurn.prompt)) return
          const executionId = titleExecutionId(firstTurn.id)
          if (settledTitleExecutions.has(executionId)) return
          const inspection = yield* backend.inspect(executionId, ExecutionBackend.executionReference)
          if (inspection?.status === "failed" || inspection?.status === "cancelled") {
            settledTitleExecutions.add(executionId)
            return
          }
          let result
          if (inspection === undefined) {
            yield* backend.invokeChild({
              parentTurnId: String(firstTurn.id),
              childId: "title",
              profile: "Title",
              prompt: firstTurn.prompt.slice(0, 2000),
            })
            const spawned = yield* backend.inspect(executionId, ExecutionBackend.executionReference)
            if (spawned !== undefined && isTerminalStatus(spawned.status))
              result = yield* backend.replay(executionId, undefined, ExecutionBackend.executionReference)
            else if (backend.follow !== undefined)
              result = yield* backend.follow(executionId, undefined, undefined, ExecutionBackend.executionReference)
          } else if (isTerminalStatus(inspection.status)) {
            result = yield* backend.replay(executionId, undefined, ExecutionBackend.executionReference)
          } else if (backend.follow !== undefined) {
            result = yield* backend.follow(executionId, undefined, undefined, ExecutionBackend.executionReference)
          }
          if (result === undefined) return
          yield* commitUsageSource(
            executionId,
            String(thread.id),
            String(firstTurn.id),
            result.events,
            isTerminalStatus(result.status),
          )
          yield* usageRepository.readTurn(String(firstTurn.id)).pipe(Effect.flatMap(publishThreadUsage))
          if (!isTerminalStatus(result.status)) return
          settledTitleExecutions.add(executionId)
          if (result.status !== "completed") return
          const text = result.events
            .filter((event) => event.type === "model.output.completed")
            .map((event) => event.text ?? "")
            .join("")
          const title = sanitizeThreadTitle(text)
          if (title.length === 0) return
          const renamed = yield* threads.renameIfTitle(
            thread.id,
            temporaryThreadTitle(firstTurn.prompt),
            title,
            yield* Clock.currentTimeMillis,
          )
          if (renamed === undefined) return
          announce({ _tag: "ThreadTitled", threadId: String(thread.id), title })
          yield* notifyThreadSummaries
        })
        yield* withExecutionAdmission(program).pipe(
          Effect.catchCause((cause) => {
            const executionId = titleExecutionId(firstTurn.id)
            const attempts = (titleAttempts.get(executionId) ?? 0) + 1
            if (attempts >= maximumTitleAttempts) {
              settledTitleExecutions.add(executionId)
              titleAttempts.delete(executionId)
            } else titleAttempts.set(executionId, attempts)
            return Effect.logWarning("thread-title.failed").pipe(
              Effect.annotateLogs({
                "rika.failure.kind": failureKind(cause),
                "rika.failure.cause": Cause.pretty(cause),
                "rika.title.attempts": attempts,
              }),
            )
          }),
        )
      })
      const notifyTurnChanged = (turn: Pick<Turn.Turn, "id" | "threadId">) =>
        Effect.sync(() => dirtyTurnObservers.add(turn.id)).pipe(
          Effect.andThen(PubSub.publish(turnChanges, undefined)),
          Effect.asVoid,
        )
      const dispatchThreadSummaries = Effect.fn("ProductOperation.dispatchThreadSummaries")(function* (
        dispatch: (event: InteractiveEvent) => void,
      ) {
        const summaries = yield* ThreadSummaryRepository.Service
        dispatch({ _tag: "ThreadsListed", threads: yield* summaries.list() })
      })
      const ensureTurnSummary = Effect.fn("ProductOperation.ensureTurnSummary")(function* (turn: Turn.Turn) {
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.ensureTurn(turn.id, turn.threadId, turn.updatedAt)
        yield* notifyThreadSummaries
        yield* notifyTurnChanged(turn)
      })
      const projectExecutionResult = Effect.fn("ProductOperation.projectExecutionResult")(function* (
        threadId: Thread.ThreadId,
        result: ExecutionBackend.Result,
      ) {
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.replaceTurn(ThreadActivity.projectionInput(threadId, result, yield* Clock.currentTimeMillis))
        yield* notifyThreadSummaries
      })
      const setTurnStatus = Effect.fn("ProductOperation.setTurnStatus")(function* (
        id: Turn.TurnId,
        status: Turn.Status,
        lastCursor: string | undefined,
        now: number,
      ) {
        const turns = yield* TurnRepository.Service
        const turn = yield* turns.setStatus(id, status, lastCursor, now)
        yield* notifyThreadSummaries
        yield* notifyTurnChanged(turn)
        return turn
      })
      const repairThreadSummaries = Effect.fn("ProductOperation.repairThreadSummaries")(function* () {
        const summaries = yield* ThreadSummaryRepository.Service
        const backend = yield* ExecutionBackend.Service
        let previousBatch: ReadonlyArray<readonly [string, string, string | undefined]> = []
        while (true) {
          const candidates = yield* summaries.listRepairCandidates(100)
          if (candidates.length === 0) return
          const batch = candidates.map(
            (candidate) => [candidate.turnId, candidate.status, candidate.lastCursor] as const,
          )
          if (
            batch.length === previousBatch.length &&
            batch.every(
              (candidate, index) =>
                candidate[0] === previousBatch[index]?.[0] &&
                candidate[1] === previousBatch[index]?.[1] &&
                candidate[2] === previousBatch[index]?.[2],
            )
          )
            return
          previousBatch = batch
          yield* Effect.forEach(
            candidates,
            (candidate) =>
              Effect.gen(function* () {
                if (candidate.status === "queued") {
                  yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
                  return
                }
                const inspection = yield* backend.inspect(candidate.turnId)
                if (inspection === undefined) {
                  yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
                  return
                }
                const result = yield* backend.replay(candidate.turnId)
                const turns = yield* TurnRepository.Service
                const current = yield* turns.get(candidate.turnId)
                if (
                  current === undefined ||
                  !Turn.isAgentExecution(current) ||
                  current.status !== candidate.status ||
                  current.lastCursor !== candidate.lastCursor
                )
                  return
                if (
                  result.status !== candidate.status ||
                  !(yield* turns.repairCursor(
                    candidate.turnId,
                    candidate.status,
                    candidate.lastCursor,
                    ThreadActivity.latestCursor(candidate.turnId, result.events) ?? candidate.lastCursor,
                  ))
                )
                  return
                yield* projectExecutionResult(candidate.threadId, result)
              }).pipe(
                Effect.catch((error) =>
                  Effect.logError("thread-summary.repair.failed").pipe(
                    Effect.annotateLogs("rika.turn.id", candidate.turnId),
                    Effect.annotateLogs("rika.failure.kind", String(error)),
                  ),
                ),
              ),
            { concurrency: 4, discard: true },
          )
        }
      })
      const settleReviewOwner = Effect.fn("ProductOperation.settleReviewOwner")(function* (
        turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">,
        fanOutId: string,
        initial?: ExecutionBackend.FanOutInspection,
      ) {
        const backend = yield* ExecutionBackend.Service
        let inspection = initial
        while (inspection?.state === "joining" || inspection === undefined) {
          inspection = yield* backend.inspectFanOut(fanOutId)
          if (inspection === undefined) {
            yield* setTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
            return yield* operationError(`Review ${fanOutId} disappeared`)
          }
          if (inspection.state === "joining") yield* Effect.sleep("50 millis")
        }
        yield* setTurnStatus(
          turn.id,
          fanOutTurnStatus(inspection.state),
          turn.lastCursor,
          yield* Clock.currentTimeMillis,
        )
        return inspection
      })
      const startReviewSettlement = Effect.fn("ProductOperation.startReviewSettlement")(function* (
        turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">,
        fanOutId: string,
        initial?: ExecutionBackend.FanOutInspection,
      ) {
        return yield* reviewSettlementAdmission.withPermits(1)(
          Effect.gen(function* () {
            const existing = reviewSettlements.get(fanOutId)
            if (existing !== undefined) return existing
            const fiber = yield* Effect.forkIn(
              settleReviewOwner(turn, fanOutId, initial).pipe(
                Effect.provide(executionDependencies),
                Effect.mapError((error) => operationError(String(error))),
                Effect.ensuring(Effect.sync(() => reviewSettlements.delete(fanOutId))),
              ),
              ownerScope,
            )
            reviewSettlements.set(fanOutId, fiber)
            return fiber
          }),
        )
      })
      const testRoute = (mode: ModeId) => Effect.succeed(Turn.testExecutionRoute(mode))
      const resolveExecutionRoute = options.resolveExecutionRoute ?? testRoute
      const executionPrompt = Effect.fn("ProductOperation.executionPrompt")(function* (
        workspace: string,
        prompt: string,
        promptParts?: ReadonlyArray<Turn.PromptPart>,
      ) {
        const context = yield* ResolvedContext.Service
        const threads = yield* ThreadRepository.Service
        const authored =
          promptParts === undefined
            ? prompt
            : promptParts
                .flatMap((part) => (part.type === "text" && part.pasted !== true ? [part.text] : []))
                .join("\n")
        const structured = ContextMentions.parse(authored)
        const bareMentions = [...new Set(FileMentions.parse(authored))].filter(
          (value) => !/^(?:file|ref|guidance|image):/.test(value),
        )
        const mentionKinds = yield* Effect.forEach(
          bareMentions,
          (value) =>
            threads
              .get(Thread.ThreadId.make(value))
              .pipe(Effect.map((thread) => ({ value, isThread: thread !== undefined }))),
          { concurrency: 1 },
        )
        const files = [
          ...new Set([
            ...mentionKinds.filter(({ isThread }) => !isThread).map(({ value }) => value),
            ...structured.files,
            ...structured.images,
          ]),
        ].toSorted()
        const threadIds = [...new Set(mentionKinds.filter(({ isThread }) => isThread).map(({ value }) => value))]
        const resolved = yield* context.resolve({
          workspace,
          targetPaths: files,
          references: [...files, ...structured.references],
        })
        const turns = yield* TurnRepository.Service
        const threadBlocks = yield* Effect.forEach(
          threadIds,
          (id) =>
            Effect.gen(function* () {
              const thread = yield* threads.get(Thread.ThreadId.make(id))
              if (thread === undefined) return `Thread ${id} was not found`
              const history = yield* turns.list(thread.id)
              return `<thread-data format="json">${untrustedData({ id, content: markdownExport(thread, history) })}</thread-data>`
            }),
          { concurrency: 1 },
        )
        const messages = resolved.diagnostics.map((diagnostic) => diagnostic.message + `: ${diagnostic.path}`)
        if (resolved.sources.length === 0 && threadBlocks.length === 0)
          return { prompt, digest: resolved.digest, messages }
        const block = [
          ...resolved.sources.map((source) =>
            source.kind === "guidance"
              ? `<guidance-instructions path=${JSON.stringify(source.path)}>\n${source.content}\n</guidance-instructions>`
              : `<reference-data format="json">${untrustedData({ path: source.path, content: source.content })}</reference-data>`,
          ),
          ...threadBlocks,
        ].join("\n\n")
        return {
          prompt: `${prompt}\n\n<resolved-context>\n${block}\n</resolved-context>`,
          digest: resolved.digest,
          messages,
        }
      })
      const prepareExecution = Effect.fn("ProductOperation.prepareExecution")(function* (
        turn: Turn.AgentExecutionTurn,
        workspace: string,
        persistExtensionPin: boolean = true,
      ) {
        const resolved = yield* executionPrompt(workspace, turn.prompt, turn.promptParts)
        let promptParts = turn.promptParts
        if (promptParts !== undefined && resolved.prompt !== turn.prompt) {
          promptParts = [...promptParts, { type: "text" as const, text: resolved.prompt.slice(turn.prompt.length) }]
        }
        if (options.executionExtensions === undefined)
          return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
        const extensions = yield* ExecutionExtensions.ExecutionExtensionService
        if (turn.extensionPin !== undefined) {
          yield* extensions.resume(turn.extensionPin)
          return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
        }
        const activated = yield* extensions.future(yield* options.executionExtensions.mcpFingerprint, resolved.digest)
        if (persistExtensionPin) {
          const turns = yield* TurnRepository.Service
          yield* turns.setExtensionPin(turn.id, activated.pin)
        }
        return { prompt: resolved.prompt, promptParts, extensionPin: activated.pin, messages: resolved.messages }
      })
      const reconcileExecutions = reconcileInternal(
        extensionService,
        (turn, workspace) =>
          prepareExecution(turn, workspace, false).pipe(Effect.mapError((error) => operationError(String(error)))),
        (turn, inspection) =>
          startReviewSettlement(turn, inspection.fanOutId, inspection).pipe(
            Effect.asVoid,
            Effect.mapError((error) => operationError(String(error))),
          ),
        {
          claim: (turn) => claimTurnObserver(turn.id, turn.status),
          release: releaseTurnObserver,
          claimQueued: claimQueuedTurn,
        },
        false,
      ).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.mapError((error) => operationError(String(error))),
      )
      const reconcileThreadResults = Effect.fn("ProductOperation.reconcileThreadResults")(function* () {
        if (threadInteractions === undefined) return false
        const turns = Context.get(dependencyContext, TurnRepository.Service)
        const transcripts = Context.get(dependencyContext, TranscriptRepository.Service)
        let retry = false
        let after: ThreadInteractionRepository.ResultRouteCursor | undefined
        while (true) {
          const routes = yield* threadInteractions.listUndeliveredResults(100, after)
          if (routes.length === 0) break
          for (const route of routes) {
            const turn = yield* turns.get(route.targetTurnId)
            if (turn === undefined || !Turn.isAgentExecution(turn)) continue
            let currentRoute = route
            if (route.delivery === "awaiting-result" && isTerminalStatus(turn.status)) {
              let projection = yield* transcripts.get(turn.id)
              if (turn.status !== "cancelled" || projection !== undefined) {
                const ingested = yield* Effect.exit(
                  ensureIngest(turn.threadId, turn.id).pipe(Effect.andThen(awaitIngestSettled(turn.id))),
                )
                if (ingested._tag === "Failure") {
                  retry = true
                  continue
                }
                projection = yield* transcripts.get(turn.id)
              }
              let result: ThreadInteractionRepository.RootResult
              if (turn.status === "cancelled" && projection === undefined) result = { status: "cancelled" }
              else {
                const checkpoint = projection?.executionCheckpoints.find(
                  (entry) => entry.executionKey === TranscriptCorrelation.executionKey(String(turn.id)),
                )
                const expectedOutcome = projectedOutcomeStatus(turn.status)
                const outcome = projection?.units.find(
                  (unit) =>
                    unit.parentId === undefined && unit.turnId === turn.id && unit.executionOutcome !== undefined,
                )?.executionOutcome
                if (
                  projection === undefined ||
                  checkpoint === undefined ||
                  checkpoint.status !== turn.status ||
                  checkpoint.cursor.length === 0 ||
                  outcome?.status !== expectedOutcome
                ) {
                  retry = true
                  continue
                }
                if (turn.status === "completed") {
                  const output = TranscriptProjection.Projection.finalAssistantOutput(
                    projection,
                    String(turn.id),
                  )?.slice(0, 8_000)
                  if (output === undefined) {
                    retry = true
                    continue
                  }
                  result = {
                    status: "completed",
                    cursor: checkpoint.cursor,
                    sequence: checkpoint.sequence,
                    output,
                  }
                } else
                  result = {
                    status: turn.status,
                    cursor: checkpoint.cursor,
                    sequence: checkpoint.sequence,
                    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
                  }
              }
              const settled = yield* threadInteractions.settleResult({
                targetTurnId: turn.id,
                result,
                now: yield* Clock.currentTimeMillis,
              })
              if (settled !== undefined) currentRoute = settled
            }
            if (currentRoute.kind !== "reply" || currentRoute.delivery !== "ready") continue
            const delivered = yield* Effect.exit(
              threadInteractions.deliverResult({
                targetTurnId: turn.id,
                deliveredTurnId: Turn.TurnId.make(`thread-result:${turn.id}`),
                queueCapacity: pendingTurnCapacity,
                now: yield* Clock.currentTimeMillis,
              }),
            )
            if (delivered._tag === "Failure") {
              retry = true
              continue
            }
            if (delivered.value.deliveredTurnId === undefined) continue
            const deliveredTurn = yield* turns.get(delivered.value.deliveredTurnId)
            if (deliveredTurn?.status === "accepted") yield* rootTurnOwner.accepted(deliveredTurn.id)
          }
          const last = routes.at(-1)
          if (last === undefined || routes.length < 100) break
          after = { targetTurnId: last.targetTurnId }
        }
        return retry
      })
      const makeInteractiveSession = Effect.fn("ProductOperation.makeInteractiveSession")(function* (
        workspace: string,
        settings: {
          readonly initialThreadId?: string
          readonly registerPromoter?: boolean
        } = {},
      ) {
        const registerPromoter = settings.registerPromoter ?? false
        const sessionId = (interactiveSessionSequence += 1)
        let selectedThreadId = settings.initialThreadId
        let currentSelectionEpoch = 0
        type SessionEnvelope = {
          readonly event: InteractiveEvent
          readonly selectionRequest?: number
          readonly selectedThreadOnly?: boolean
        }
        const sessionEvents = yield* Queue.bounded<SessionEnvelope>(8192)
        let overflow: InteractiveFeedOverflow.State | undefined
        type SelectionLoad = {
          readonly epoch: number
          readonly threadId: string
          readonly previousEpoch: number
          readonly previousThreadId: string | undefined
          readonly events: Array<InteractiveEvent>
          committed: boolean
          overflow?: InteractiveFeedOverflow.State
        }
        let selectionLoad: SelectionLoad | undefined =
          settings.initialThreadId === undefined
            ? undefined
            : {
                epoch: 0,
                threadId: settings.initialThreadId,
                previousEpoch: 0,
                previousThreadId: undefined,
                events: [],
                committed: false,
              }
        let activeSelectionState: SelectionEpochState | undefined
        let candidateSelectionState: SelectionEpochState | undefined
        const bufferSelectionEvent = (event: InteractiveEvent) => {
          const loading = selectionLoad
          if (loading === undefined || interactiveEventThreadId(event) !== loading.threadId) return false
          const selectedEvent = withSelectionEpoch(event, loading.epoch)
          if (loading.overflow !== undefined) {
            InteractiveFeedOverflow.remember(loading.overflow, selectedEvent)
            return true
          }
          if (loading.events.length < 8192) {
            loading.events.push(selectedEvent)
            return true
          }
          loading.overflow = InteractiveFeedOverflow.make()
          for (const buffered of loading.events) InteractiveFeedOverflow.remember(loading.overflow, buffered)
          loading.events.length = 0
          InteractiveFeedOverflow.remember(loading.overflow, selectedEvent)
          return true
        }
        const deliver = (
          event: InteractiveEvent,
          deliveryOptions?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
        ) => {
          const selectedEvent = withSelectionEpoch(event, deliveryOptions?.selectionRequest ?? currentSelectionEpoch)
          const envelope: SessionEnvelope = {
            event: selectedEvent,
            ...(deliveryOptions?.selectionRequest === undefined
              ? {}
              : { selectionRequest: deliveryOptions.selectionRequest }),
            ...(deliveryOptions?.selectedThreadOnly === undefined
              ? {}
              : { selectedThreadOnly: deliveryOptions.selectedThreadOnly }),
          }
          if (overflow !== undefined) {
            InteractiveFeedOverflow.remember(overflow, selectedEvent)
            return false
          }
          if (Queue.offerUnsafe(sessionEvents, envelope)) return true
          overflow = InteractiveFeedOverflow.make()
          InteractiveFeedOverflow.remember(overflow, selectedEvent)
          return false
        }
        const sessionDispatch = (event: InteractiveEvent) => {
          if (!bufferSelectionEvent(event)) deliver(event)
        }
        const dispatchFailure = (
          dispatch: (event: InteractiveEvent) => void,
          error: unknown,
          threadId?: Thread.ThreadId,
        ) =>
          Schema.is(TurnRepository.QueueFull)(error)
            ? dispatch({
                _tag: "QueueFull",
                selectionEpoch: 0,
                threadId: error.threadId,
                capacity: error.capacity,
                count: error.count,
              })
            : dispatch({
                _tag: "ExecutionFailed",
                selectionEpoch: 0,
                ...(threadId === undefined ? {} : { threadId }),
                message: operationFailureDetail(error),
              })
        const selectionDispatch = (request: number) => (event: InteractiveEvent) => {
          deliver(event, { selectionRequest: request })
        }
        const releaseSelectionEvents = (loading: SelectionLoad, epoch: number, reason: string) => {
          if (loading.overflow === undefined) {
            for (const event of loading.events) deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
            return
          }
          for (const event of InteractiveFeedOverflow.events(loading.overflow, epoch, reason))
            deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
        }
        const finishSelection = (epoch: number) =>
          selectionAdmission.withPermits(1)(
            Effect.gen(function* () {
              const loading = selectionLoad
              if (loading === undefined || loading.epoch !== epoch || loading.committed) return
              selectionLoad = undefined
              const restored = yield* Ref.modify(selectionRequest, (current) =>
                current === epoch ? [true, loading.previousEpoch] : [false, current],
              )
              if (!restored) return
              if (candidateSelectionState?.epoch === epoch) candidateSelectionState = undefined
              if (loading.previousThreadId !== loading.threadId) return
              releaseSelectionEvents(loading, loading.previousEpoch, "Reload activity exceeded its bounded live window")
            }),
          )
        const emit = (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => {
          dispatch(event)
          publishInteractiveActivity(sessionId, event)
        }
        const submissionAdmission = yield* Semaphore.make(1)
        const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
        const selectionRequest = yield* Ref.make(0)
        const isCurrentSelectionState = (state: SelectionEpochState) =>
          activeSelectionState === state || candidateSelectionState === state
        const transcriptPageAdmission = yield* Semaphore.make(1)
        const selectionAdmission = yield* Semaphore.make(1)
        const lifecycleAdmission = yield* Semaphore.make(1)
        const sessionScope = yield* Scope.make()
        let selectionBackground: Array<Fiber.Fiber<unknown, unknown>> = []
        let selectionLoadFiber: Fiber.Fiber<unknown, unknown> | undefined
        const interruptSelectionBackground = Effect.suspend(() => {
          const fibers = selectionBackground
          selectionBackground = []
          return Effect.forEach(fibers, Fiber.interrupt, { discard: true })
        })
        const interruptSelectionLoad = Effect.suspend(() => {
          const fiber = selectionLoadFiber
          selectionLoadFiber = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        const openSelectionProjectionFeed = Effect.fn("ProductOperation.interactive.openSelectionProjectionFeed")(function* (
          state: SelectionEpochState,
        ) {
          const scope = yield* Scope.make()
          const watch = yield* executionIngest
            .watchThread(state.thread.id)
            .pipe(Effect.provideService(Scope.Scope, scope))
          state.projectionFeed = { watch, scope, promoted: false }
        })
        const startSelectionProjectionFeed = Effect.fn("ProductOperation.interactive.startSelectionProjectionFeed")(function* (
          state: SelectionEpochState,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const feed = state.projectionFeed
          if (feed === undefined || feed.promoted) return
          feed.promoted = true
          dispatch({
            _tag: "ThreadRefolding",
            selectionEpoch: state.epoch,
            threadId: state.thread.id,
            refolding: feed.watch.refolding,
          })
          for (const snapshot of feed.watch.snapshots)
            dispatch(
              transcriptProjectionEvent({
                _tag: "ProjectionStarted",
                snapshot,
              }),
            )
          selectionBackground.push(
            yield* Effect.forkIn(
              feed.watch.changes.pipe(
                Stream.runForEach((change) => Effect.sync(() => dispatch(transcriptProjectionEvent(change)))),
                Effect.catchTag("ExecutionIngestProjectionWatchOverflow", (error) =>
                  Effect.sync(() =>
                    dispatch({
                      _tag: "TranscriptResyncRequired",
                      selectionEpoch: state.epoch,
                      threadId: state.thread.id,
                      reason: `Projection feed exceeded its bounded capacity of ${error.capacity}`,
                    }),
                  ),
                ),
                Effect.ensuring(Scope.close(feed.scope, Exit.void)),
              ),
              sessionScope,
            ),
          )
        })
        const closeCandidateProjectionFeed = (state: SelectionEpochState) =>
          Effect.suspend(() => {
            const feed = state.projectionFeed
            return feed === undefined || feed.promoted ? Effect.void : Scope.close(feed.scope, Exit.void)
          })
        const activateCreatedThread = Effect.fn("ProductOperation.interactive.activateCreatedThread")(function* (
          thread: Thread.Thread,
          epoch: number,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const queue = yield* turns.readQueue(thread.id)
          const state = makeSelectionState(thread, epoch)
          yield* openSelectionProjectionFeed(state)
          activeSelectionState = state
          currentSelectionEpoch = epoch
          selectedThreadId = String(thread.id)
          yield* Ref.set(interactiveThread, thread)
          dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
          dispatch({
            _tag: "SelectionLoaded",
            selectionEpoch: epoch,
            activitySequence,
            thread,
            entries: [],
            hasOlder: false,
            queueRevision: queue.revision,
            queuedCount: queue.queuedCount,
            queue: queue.turns.map(queueItem),
          })
          yield* startSelectionProjectionFeed(state, dispatch)
          dispatch(initializeSelectedUsage(thread.id, epoch))
        })
        let lifecycle: "open" | "closed" = "open"
        let feedAttached = false
        const sessionClosed = OperationUnavailable.make({
          operation: "InteractiveSession",
          message: "Interactive session is closed",
        })
        const admit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
          lifecycleAdmission
            .withPermits(1)(
              Effect.suspend(() => (lifecycle === "open" ? Effect.succeed(effect) : Effect.fail(sessionClosed))),
            )
            .pipe(Effect.flatten)
        const runOwned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.forkIn(effect, sessionScope).pipe(
            Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))),
          )
        const admitLocal = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
          effect.pipe(runOwned, admit)
        const attachFeed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
          lifecycleAdmission
            .withPermits(1)(
              Effect.suspend(() => {
                if (lifecycle === "closed") return Effect.fail(sessionClosed)
                if (feedAttached)
                  return Effect.fail(
                    OperationUnavailable.make({
                      operation: "InteractiveSession.events",
                      message: "Interactive session already has an event consumer",
                    }),
                  )
                feedAttached = true
                const attached = effect.pipe(Effect.ensuring(Effect.sync(() => (feedAttached = false))))
                return Effect.succeed(runOwned(attached))
              }),
            )
            .pipe(Effect.flatten)
        const submit = Effect.fn("ProductOperation.interactive.submit")(function* (
          prompt: string,
          dispatch: (event: InteractiveEvent) => void,
          mode: ModeId = "medium",
          promptParts?: ReadonlyArray<Turn.PromptPart>,
          modelTuning?: { readonly fastMode?: boolean },
          submissionId?: string,
        ) {
          let observerTurn: Turn.Turn | undefined
          let executionLaunched = false
          const program = Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const backend = yield* ExecutionBackend.Service
            const now = yield* Clock.currentTimeMillis
            let thread = yield* Ref.get(interactiveThread)
            const isNewThread = thread === undefined
            if (thread === undefined) {
              thread = yield* threads.create({
                id: yield* options.makeThreadId,
                workspace,
                title: temporaryThreadTitle(prompt),
                now,
              })
            }
            if (isNewThread) yield* activateCreatedThread(thread, currentSelectionEpoch, dispatch)
            const isFirstTurn = (yield* turns.list(thread.id)).length === 0
            const firstTurnTitle = temporaryThreadTitle(prompt)
            if (isFirstTurn && thread.title === "New thread" && firstTurnTitle !== thread.title) {
              const renamed = yield* threads.renameIfTitle(thread.id, "New thread", firstTurnTitle, now)
              if (renamed !== undefined) {
                thread = renamed
                emit(dispatch, { _tag: "ThreadTitled", threadId: String(thread.id), title: thread.title })
                yield* notifyThreadSummaries
              }
            }
            const turnId = yield* options.makeTurnId
            const executionRoute = yield* resolveExecutionRoute(mode, modelTuning, thread.workspace)
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const observed = yield* createObservedSubmission(turns, {
                  id: turnId,
                  threadId: thread.id,
                  prompt,
                  ...(promptParts === undefined ? {} : { promptParts }),
                  executionRoute,
                  queueCapacity: pendingTurnCapacity,
                  now,
                })
                const turn = observed.turn
                if (turn.status !== "queued") {
                  if (!observed.claimed)
                    return yield* operationError(`Turn ${turn.id} already has an execution observer`)
                  observerTurn = turn
                }
                yield* ensureTurnSummary(turn)
                emit(dispatch, {
                  _tag: "SubmissionAdmitted",
                  selectionEpoch: 0,
                  threadId: thread.id,
                  turnId: turn.id,
                  status: turn.status === "queued" ? "queued" : "active",
                  ...(submissionId === undefined ? {} : { submissionId }),
                })
                yield* Effect.logInfo("turn.accepted").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                    "rika.turn.status": turn.status,
                  }),
                )
                if (turn.status === "queued") {
                  if (turn.queue !== undefined) emit(dispatch, queueMutationEvent(turn.queue))
                  return
                }
                const execution = Effect.gen(function* () {
                  const startedAt = yield* Clock.currentTimeMillis
                  const deliveredCursors = new Set<string>()
                  const outcome = yield* Effect.exit(
                    Effect.gen(function* () {
                      yield* Effect.logInfo("turn.started")
                      if ((yield* awaitSessionQuiescence(backend, thread.id)) !== undefined) {
                        const requeued = yield* turns.requeueAccepted(
                          turn.id,
                          pendingTurnCapacity,
                          yield* Clock.currentTimeMillis,
                        )
                        emit(dispatch, queueMutationEvent(requeued.queue))
                        return undefined
                      }
                      const prepared = yield* prepareExecution(turn, thread.workspace)
                      if (prepared.messages.length > 0)
                        emit(dispatch, {
                          _tag: "ContextDiagnostics",
                          selectionEpoch: 0,
                          threadId: thread.id,
                          turnId: turn.id,
                          messages: prepared.messages,
                        })
                      const runningTurn = yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
                      if (runningTurn.status !== "running") return undefined
                      emit(dispatch, {
                        _tag: "TurnStarted",
                        selectionEpoch: 0,
                        threadId: thread.id,
                        turn: runningTurn,
                        ...(submissionId === undefined ? {} : { submissionId }),
                      })
                      yield* ensureIngest(thread.id, turn.id)
                      const result = yield* rootTurnOwner.start({
                        threadId: thread.id,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                        executionRoute: turn.executionRoute,
                        ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
                        eventScope: "execution",
                        onEvent: (event) => {
                          deliveredCursors.add(event.cursor)
                          executionIngest.deliver(turn.id, event)
                        },
                        ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                      })
                      return result
                    }).pipe(
                      Effect.annotateLogs({
                        "rika.thread.id": String(thread.id),
                        "rika.turn.id": String(turn.id),
                      }),
                    ),
                  )
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      if (outcome._tag === "Failure") {
                        if (Cause.hasInterruptsOnly(outcome.cause)) return
                        const failedAt = yield* Clock.currentTimeMillis
                        yield* Effect.logError("turn.failed").pipe(
                          Effect.annotateLogs({
                            "rika.duration.ms": failedAt - startedAt,
                            "rika.failure.cause": String(outcome.cause),
                            "rika.failure.kind": failureKind(outcome.cause),
                            "rika.thread.id": String(thread.id),
                            "rika.turn.id": String(turn.id),
                          }),
                        )
                        yield* setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
                        emit(dispatch, {
                          _tag: "ExecutionFailed",
                          selectionEpoch: 0,
                          threadId: thread.id,
                          turnId: turn.id,
                          message: executionStartFailureMessage,
                        })
                        return
                      }
                      const result = outcome.value
                      if (result === undefined) {
                        yield* settleThread(thread, dispatch)
                        return
                      }
                      deliverResultEvents(turn.id, result.events, deliveredCursors)
                      const completedAt = yield* Clock.currentTimeMillis
                      yield* Effect.logInfo("turn.finished").pipe(
                        Effect.annotateLogs({
                          "rika.duration.ms": completedAt - startedAt,
                          "rika.thread.id": String(thread.id),
                          "rika.turn.id": String(turn.id),
                          "rika.turn.status": result.status,
                        }),
                      )
                      const updatedTurn = yield* setTurnStatus(
                        turn.id,
                        result.status,
                        result.checkpoint?.cursor ??
                          ThreadActivity.latestCursor(turn.id, result.events) ??
                          turn.lastCursor,
                        completedAt,
                      )
                      yield* projectExecutionResult(thread.id, result)
                      yield* ensureIngest(updatedTurn.threadId, updatedTurn.id)
                      if (result.status === "completed") {
                        yield* settleThread(thread, dispatch)
                        if (isFirstTurn)
                          yield* Effect.interruptible(
                            titleThread(thread, updatedTurn, (event) => emit(dispatch, event)),
                          )
                        return
                      }
                      if (result.status === "waiting" || result.status === "running" || result.status === "queued")
                        return
                      if (
                        result.status === "failed" &&
                        !result.events.some((event) => event.type === "execution.failed")
                      )
                        emit(dispatch, {
                          _tag: "ExecutionFailed",
                          selectionEpoch: 0,
                          threadId: thread.id,
                          turnId: turn.id,
                          message: `Execution ${result.status}`,
                        })
                      if (result.status !== "failed") yield* settleThread(thread, dispatch)
                    }),
                  )
                }).pipe(
                  Effect.provide(executionDependencies),
                  Effect.scoped,
                  Effect.tapCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Effect.logError("interactive.submit.failed").pipe(
                          Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                        ),
                  ),
                  Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
                  Effect.ensuring(releaseTurnObserver(turn.id).pipe(Effect.andThen(notifyTurnChanged(turn)))),
                )
                yield* Effect.forkIn(Effect.interruptible(execution), sessionScope)
                executionLaunched = true
              }),
            )
          })
          yield* submissionAdmission
            .withPermits(1)(program)
            .pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("interactive.submit.failed").pipe(
                      Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                    ),
              ),
              Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
              Effect.ensuring(
                Effect.suspend(() =>
                  observerTurn === undefined || executionLaunched
                    ? Effect.void
                    : releaseTurnObserver(observerTurn.id).pipe(Effect.andThen(notifyTurnChanged(observerTurn))),
                ),
              ),
            )
        })
        const safe = <E>(
          dispatch: (event: InteractiveEvent) => void,
          effect: Effect.Effect<
            void,
            E,
            | ThreadRepository.Service
            | TurnRepository.Service
            | ThreadSummaryRepository.Service
            | TranscriptRepository.Service
            | ExecutionBackend.Service
            | ResolvedContext.Service
            | ExecutionExtensions.ExecutionExtensionService
          >,
        ) =>
          effect.pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
          )
        const readQueue = Effect.fn("ProductOperation.interactive.readQueue")(function* (
          threadId: Thread.ThreadId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const queue = yield* turns.readQueue(threadId)
          dispatch({
            _tag: "QueueUpdated",
            selectionEpoch: 0,
            threadId,
            revision: queue.revision,
            queuedCount: queue.queuedCount,
            change: { _tag: "Reset", items: queue.turns.map(queueItem) },
          })
        })
        const drainQueued = Effect.fn("ProductOperation.interactive.drainQueued")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          let claimed = 0
          let staleRefused = false
          const refuseStaleQueued = Effect.fn("ProductOperation.interactive.refuseStaleQueued")(function* () {
            const queue = yield* turns.readQueue(thread.id)
            const now = yield* Clock.currentTimeMillis
            const staleError = staleQueuedTurnsError(thread.id, queue.turns, now, queuedTurnPromoteMaxAgeMs)
            if (staleError === undefined) return false
            staleRefused = true
            emit(dispatch, {
              _tag: "ExecutionFailed",
              selectionEpoch: 0,
              threadId: thread.id,
              message: staleError.message,
            })
            return yield* staleError
          })
          const runPromoted = Effect.fn("ProductOperation.interactive.runPromoted")(function* (
            claim: TurnRepository.QueueClaim,
          ) {
            const promotedTurn = claim.turn
            const executionRoute = promotedTurn.executionRoute
            const deliveredCursors = new Set<string>()
            const outcome = yield* Effect.gen(function* () {
              const prepared = yield* prepareExecution(promotedTurn, thread.workspace, false)
              if (prepared.messages.length > 0)
                emit(dispatch, {
                  _tag: "ContextDiagnostics",
                  selectionEpoch: 0,
                  threadId: thread.id,
                  turnId: promotedTurn.id,
                  messages: prepared.messages,
                })
              const promotedAt = yield* Clock.currentTimeMillis
              const transition = yield* turns.finishQueuedClaim(
                claim,
                "running",
                promotedTurn.lastCursor,
                prepared.extensionPin,
                promotedAt,
              )
              if (transition._tag === "Unavailable") return undefined
              yield* notifyThreadSummaries
              yield* notifyTurnChanged(transition.turn)
              const runningTurn = transition.turn
              emit(dispatch, queueMutationEvent(transition.queue))
              if (runningTurn.status !== "running") return undefined
              emit(dispatch, {
                _tag: "TurnStarted",
                selectionEpoch: 0,
                threadId: thread.id,
                turn: runningTurn,
              })
              yield* ensureIngest(thread.id, promotedTurn.id)
              const result = yield* rootTurnOwner.start({
                threadId: thread.id,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                executionRoute,
                eventScope: "execution",
                onEvent: (event) => {
                  deliveredCursors.add(event.cursor)
                  executionIngest.deliver(promotedTurn.id, event)
                },
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              return result
            }).pipe(
              Effect.map((value) => ({ _tag: "Success" as const, value })),
              Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
              Effect.onInterrupt(() => turns.releaseQueuedClaim(claim)),
            )
            if (outcome._tag === "Failure") {
              const current = yield* turns.get(promotedTurn.id)
              yield* Effect.logError("turn.failed").pipe(
                Effect.annotateLogs({
                  "rika.failure.cause": String(outcome.error),
                  "rika.thread.id": String(thread.id),
                  "rika.turn.id": String(promotedTurn.id),
                }),
              )
              if (current?.status === "running")
                yield* setTurnStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
              else {
                const transition = yield* turns.finishQueuedClaim(
                  claim,
                  "failed",
                  promotedTurn.lastCursor,
                  promotedTurn.extensionPin,
                  yield* Clock.currentTimeMillis,
                )
                if (transition._tag === "Unavailable") return true
                yield* notifyThreadSummaries
                yield* notifyTurnChanged(transition.turn)
                emit(dispatch, queueMutationEvent(transition.queue))
              }
              emit(dispatch, {
                _tag: "ExecutionFailed",
                selectionEpoch: 0,
                threadId: thread.id,
                turnId: promotedTurn.id,
                message: executionStartFailureMessage,
              })
              return true
            }
            const result = outcome.value
            if (result === undefined) return true
            deliverResultEvents(promotedTurn.id, result.events, deliveredCursors)
            const updatedTurn = yield* setTurnStatus(
              promotedTurn.id,
              result.status,
              result.checkpoint?.cursor ??
                ThreadActivity.latestCursor(promotedTurn.id, result.events) ??
                promotedTurn.lastCursor,
              yield* Clock.currentTimeMillis,
            )
            yield* projectExecutionResult(thread.id, result)
            yield* ensureIngest(updatedTurn.threadId, updatedTurn.id)
            return isTerminalStatus(result.status) && result.status !== "failed"
          })
          const runNext = Effect.fn("ProductOperation.interactive.runNextQueued")(function* () {
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                return yield* claimQueuedTurn(thread.id, yield* Clock.currentTimeMillis)
              }).pipe(
                Effect.flatMap((claim) => {
                  if (claim === undefined) return Effect.void
                  return restore(runPromoted(claim)).pipe(Effect.ensuring(releaseTurnObserver(claim.turn.id)))
                }),
              ),
            )
          })
          while (true) {
            if (staleRefused) break
            if ((yield* turns.readQueue(thread.id)).queuedCount === 0) break
            if (
              (yield* refuseStaleQueued().pipe(Effect.catchTag("StaleQueuedTurns", () => Effect.succeed(true)))) ===
              true
            )
              break
            if ((yield* awaitSessionQuiescence(backend, thread.id)) !== undefined) {
              const wake = yield* turns.requestQueueWake(thread.id)
              if (wake !== undefined && backend.wakeThreadHost !== undefined)
                yield* backend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
              break
            }
            const keepDraining = yield* runNext()
            if (keepDraining === undefined) break
            claimed += 1
            if (!keepDraining) break
          }
          return claimed
        })
        const promoterFor =
          (dispatch: (event: InteractiveEvent) => void) =>
          (threadId: string, generation: number): Effect.Effect<number> =>
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              if (!(yield* turns.consumeQueueWake(Thread.ThreadId.make(threadId), generation))) return 0
              const thread = yield* threads.get(Thread.ThreadId.make(threadId))
              if (thread === undefined) return 0
              return yield* drainQueued(thread, dispatch)
            }).pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  const turns = Context.get(dependencyContext, TurnRepository.Service)
                  const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
                  if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
                    yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
                }).pipe(Effect.orElseSucceed(() => undefined)),
              ),
              Effect.catch(() =>
                Effect.gen(function* () {
                  const turns = Context.get(dependencyContext, TurnRepository.Service)
                  const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
                  if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
                    yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
                  return 0
                }).pipe(Effect.orElseSucceed(() => 0)),
              ),
            )
        const promoteThread = Effect.fn("ProductOperation.interactive.promoteThread")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const backend = yield* ExecutionBackend.Service
          if (backend.wakeThreadHost === undefined || backend.registerTurnPromoter === undefined) {
            yield* drainQueued(thread, dispatch)
            return
          }
          const turns = yield* TurnRepository.Service
          const wake = yield* turns.requestQueueWake(thread.id)
          if (wake === undefined) return
          const now = yield* Clock.currentTimeMillis
          yield* backend.wakeThreadHost({ ...wake, now })
        })
        const settleThread = Effect.fn("ProductOperation.interactive.settleThread")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          yield* promoteThread(thread, dispatch).pipe(
            Effect.catch(() => drainQueued(thread, dispatch).pipe(Effect.asVoid)),
            Effect.orElseSucceed(() => undefined),
          )
        })
        const activeInThread = Effect.fn("ProductOperation.interactive.activeInThread")(function* (threadId: Thread.ThreadId) {
          const turns = yield* TurnRepository.Service
          const turn = yield* turns.findActive(threadId)
          if (turn === undefined) return yield* operationError("No active turn")
          return turn
        })
        const active = Effect.fn("ProductOperation.interactive.active")(function* () {
          const thread = yield* Ref.get(interactiveThread)
          if (thread === undefined) return yield* operationError("No thread selected")
          return yield* activeInThread(thread.id)
        })
        const threadForTurn = Effect.fn("ProductOperation.interactive.threadForTurn")(function* (turn: Turn.Turn) {
          const thread = yield* (yield* ThreadRepository.Service).get(turn.threadId)
          if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
          return thread
        })
        const followClaimedTurn = Effect.fn("ProductOperation.interactive.followClaimedTurn")(function* (
          turnId: Turn.TurnId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          if (backend.follow === undefined) return
          const turn = yield* turns.get(turnId)
          if (turn === undefined) return yield* operationError(`Turn ${turnId} does not exist`)
          if (!Turn.isAgentExecution(turn))
            return yield* operationError(`Recorded shell turn ${turnId} cannot be followed as an execution`)
          const thread = yield* threadForTurn(turn)
          yield* ensureIngest(turn.threadId, turn.id)
          const deliveredCursors = new Set<string>()
          const result = yield* rootTurnOwner.follow(
            turn.id,
            turn.lastCursor,
            (event) => {
              deliveredCursors.add(event.cursor)
              executionIngest.deliver(turn.id, event)
            },
            undefined,
            "execution",
          )
          deliverResultEvents(turn.id, result.events, deliveredCursors)
          const updatedTurn = yield* setTurnStatus(
            turn.id,
            result.status,
            result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          yield* projectExecutionResult(turn.threadId, result)
          yield* ensureIngest(updatedTurn.threadId, updatedTurn.id)
          if (isTerminalStatus(result.status)) {
            yield* settleThread(thread, dispatch)
            if (result.status === "completed" && (yield* turns.list(thread.id))[0]?.id === updatedTurn.id)
              yield* titleThread(thread, updatedTurn, (event) => emit(dispatch, event))
          } else if (result.status !== "waiting" && result.status !== "running" && result.status !== "queued")
            emit(dispatch, {
              _tag: "ExecutionFailed",
              selectionEpoch: 0,
              threadId: turn.threadId,
              turnId: turn.id,
              message: `Execution ${result.status}`,
            })
        })
        const observeTurn = Effect.fn("ProductOperation.interactive.observeTurn")(function* (
          turn: Turn.AgentExecutionTurn,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const backend = yield* ExecutionBackend.Service
          if ((yield* backend.inspect(turn.id)) === undefined) return false
          return yield* Effect.uninterruptibleMask((restore) =>
            claimTurnObserver(turn.id).pipe(
              Effect.flatMap((claimed) =>
                !claimed
                  ? Effect.succeed(false)
                  : restore(followClaimedTurn(turn.id, dispatch)).pipe(
                      Effect.as(true),
                      Effect.ensuring(releaseTurnObserver(turn.id, false)),
                    ),
              ),
            ),
          )
        })
        const initialTranscriptWindow = Effect.fn("ProductOperation.interactive.initialTranscriptWindow")(function* (
          state: SelectionEpochState,
        ) {
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const turnPage = yield* turns.page(state.thread.id, { limit: 50 })
          const window: Array<ReadonlyArray<TranscriptRepository.Entry>> = []
          let entryCount = 0
          let projectedTurns = 0
          let hasOlder = turnPage.hasOlder
          let reduced = false
          let oldestCursor: TranscriptRepository.PageCursor | undefined
          for (const turn of turnPage.turns.toReversed()) {
            if (projectedTurns >= selectionInitialTurnWindow) {
              hasOlder = true
              break
            }
            if (turn.status === "queued") continue
            const projection = yield* transcripts.get(turn.id)
            let entries: ReadonlyArray<TranscriptRepository.Entry>
            if (projection === undefined || projection.projectionVersion < ExecutionIngest.projectionVersion) {
              if (Turn.isRecordedShell(turn))
                return yield* operationError(`Recorded shell turn ${turn.id} has no current durable transcript`)
              yield* ensureIngest(turn.threadId, turn.id)
              if (!Turn.isAgentExecution(turn)) continue
              const seed = TranscriptProjection.Projection.empty(turn.id, turn.prompt)
              entries = seed.units.map((unit) => ({
                turn,
                unit,
                projectionRevision: seed.revision,
                projectionModelPhase: seed.modelPhase,
              }))
            } else {
              if (projection.projectionVersion !== ExecutionIngest.projectionVersion)
                return yield* operationError(
                  `Turn ${turn.id} has unsupported projection version ${projection.projectionVersion}`,
                )
              if (projection.units.length === 0)
                return yield* operationError(`Turn ${turn.id} has an empty current-version transcript`)
              entries = projection.units.map((unit) =>
                Object.assign(
                  {
                    turn: projection.turn,
                    unit,
                    projectionRevision: projection.revision,
                    projectionModelPhase: projection.modelPhase,
                  },
                  projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd },
                ),
              )
            }
            projectedTurns += 1
            if (!reduced && entryCount + entries.length <= selectionInitialEntryWindow) {
              window.unshift(entries)
              entryCount += entries.length
              oldestCursor = transcriptCursorFor(entries[0]) ?? oldestCursor
              continue
            }
            const detail = reduced ? 0 : selectionInitialEntryWindow - entryCount
            reduced = true
            hasOlder = true
            const bounded = boundTurnEntries(entries, detail)
            window.unshift(bounded.entries)
            entryCount += bounded.entries.length
            if (detail > 0) oldestCursor = transcriptCursorFor(entries[bounded.contiguousFrom]) ?? oldestCursor
          }
          return { entries: window.flat(), hasOlder, oldestCursor }
        })
        const loadTranscriptPage = Effect.fn("ProductOperation.interactive.loadTranscriptPage")(function* (
          state: SelectionEpochState,
          dispatch: (event: InteractiveEvent) => void,
          before?: TranscriptRepository.PageCursor,
          clientLoadedKeys?: ReadonlySet<string>,
        ) {
          const thread = state.thread
          const request = state.epoch
          const loadedAt = yield* Clock.currentTimeMillis
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          if (!isCurrentSelectionState(state)) return
          const page =
            before === undefined
              ? yield* initialTranscriptWindow(state)
              : yield* transcripts.page(thread.id, {
                  before,
                  limit: 50,
                  projectionVersion: ExecutionIngest.projectionVersion,
                })
          if (
            page.hasOlder &&
            before !== undefined &&
            (page.entries.length === 0 ||
              page.oldestCursor === undefined ||
              sameTranscriptCursor(page.oldestCursor, before))
          )
            return yield* operationError(`Transcript page did not advance for Thread ${thread.id}`)
          let oldestCursor = page.oldestCursor
          let storedHasOlder = page.hasOlder
          let initialBoundary = -1
          let storedEntries = page.entries
          const bounded = boundTranscriptEntries(storedEntries)
          if (bounded.oversizedEntry)
            return yield* operationError("Transcript entry exceeds the transcript event limit")
          storedEntries = bounded.entries
          if (bounded.truncated) {
            initialBoundary = 1
          }
          if (initialBoundary > 0) {
            const oldest = storedEntries[0]
            if (bounded.partialCursor !== undefined) oldestCursor = bounded.partialCursor
            else oldestCursor = transcriptCursorFor(oldest)
            storedHasOlder = true
          }
          const entries = storedEntries
          const hasOlder = storedHasOlder
          if (transcriptPageEncoder.encode(encodeJson(entries)).byteLength > maximumTranscriptPayloadBytes)
            return yield* operationError("Transcript page exceeds the transcript event limit")
          const deliveredEntries =
            clientLoadedKeys === undefined ? entries : entries.filter((entry) => !clientLoadedKeys.has(entry.unit.key))
          const completedAt = yield* Clock.currentTimeMillis
          if (!isCurrentSelectionState(state)) return
          state.transcriptCursor = oldestCursor
          if (before === undefined)
            state.newestTranscriptCursor =
              "newestCursor" in page ? page.newestCursor : transcriptCursorFor(page.entries.at(-1))
          state.hasOlder = hasOlder
          if (before !== undefined) for (const entry of deliveredEntries) state.loadedKeys.add(entry.unit.key)
          const threadCostUsd = undefined
          const globalCostUsd = undefined
          if (before === undefined) {
            const queue = yield* turns.readQueue(thread.id)
            const activeTurn = yield* turns.findActive(thread.id)
            if (!isCurrentSelectionState(state) || (yield* Ref.get(selectionRequest)) !== request) return
            for (const entry of entries) state.loadedKeys.add(entry.unit.key)
            yield* selectionAdmission.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if ((yield* Ref.get(selectionRequest)) !== request || candidateSelectionState !== state) return
                  const loading = selectionLoad
                  if (loading === undefined || loading.epoch !== request || loading.threadId !== String(thread.id))
                    return
                  yield* interruptSelectionBackground
                  activeSelectionState = state
                  candidateSelectionState = undefined
                  currentSelectionEpoch = request
                  yield* Ref.set(interactiveThread, thread)
                  selectedThreadId = String(thread.id)
                  loading.committed = true
                  dispatch({
                    _tag: "SelectionLoaded",
                    selectionEpoch: request,
                    activitySequence,
                    thread,
                    entries,
                    hasOlder,
                    hasNewer: false,
                    ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
                    ...(globalCostUsd === undefined ? {} : { globalCostUsd }),
                    ...(oldestCursor === undefined ? {} : { oldestCursor }),
                    ...("newestCursor" in page && page.newestCursor !== undefined
                      ? { newestCursor: page.newestCursor }
                      : {}),
                    queueRevision: queue.revision,
                    queuedCount: queue.queuedCount,
                    queue: queue.turns.map(queueItem),
                    ...(activeTurn === undefined ? {} : { activeTurn }),
                  })
                  yield* startSelectionProjectionFeed(state, dispatch)
                  releaseSelectionEvents(loading, request, "Selection activity exceeded its bounded live window")
                  selectionLoad = undefined
                  yield* startSelectionUsage(state, dispatch)
                }),
              ),
            )
          } else {
            if (!isCurrentSelectionState(state)) return
            dispatch({
              _tag: "TranscriptPagePrepended",
              selectionEpoch: request,
              threadId: thread.id,
              entries: deliveredEntries,
              hasOlder,
              ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
              ...(globalCostUsd === undefined ? {} : { globalCostUsd }),
              ...(oldestCursor === undefined ? {} : { oldestCursor }),
            })
          }
          yield* Effect.logInfo("transcript.page.loaded").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(thread.id),
              "rika.transcript.page.kind": before === undefined ? "initial" : "prepend",
              "rika.transcript.page.units": deliveredEntries.length,
              "rika.transcript.page.has_older": hasOlder,
              "rika.duration.ms": completedAt - loadedAt,
            }),
          )
        })
        const startSelectionUsage = (state: SelectionEpochState, dispatch: (event: InteractiveEvent) => void) =>
          Effect.gen(function* () {
            selectionBackground.push(
              yield* Effect.forkIn(
                Effect.gen(function* () {
                  const totals = yield* usageRepository.readThread(String(state.thread.id))
                  if (activeSelectionState !== state) return
                  dispatch({
                    _tag: "ThreadUsageUpdated",
                    selectionEpoch: state.epoch,
                    threadId: state.thread.id,
                    revision: totals.revision,
                    ...persistedThreadUsage(totals),
                  })
                }).pipe(Effect.provide(executionDependencies)),
                sessionScope,
              ),
            )
          })
        const loadThread = Effect.fn("ProductOperation.interactive.loadThread")(function* (
          thread: Thread.Thread,
          request: number,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          if ((yield* Ref.get(selectionRequest)) !== request) return
          const state = makeSelectionState(thread, request)
          candidateSelectionState = state
          yield* openSelectionProjectionFeed(state)
          yield* Effect.gen(function* () {
            yield* transcriptPageAdmission.withPermits(1)(loadTranscriptPage(state, dispatch))
            if (activeSelectionState !== state) return
            const summaries = yield* ThreadSummaryRepository.Service
            yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
            yield* notifyThreadSummaries
          }).pipe(Effect.ensuring(closeCandidateProjectionFeed(state)))
        })
        const runThreadLoad = Effect.fn("ProductOperation.interactive.runThreadLoad")(function* (
          thread: Thread.Thread,
          request: number,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          yield* interruptSelectionLoad
          if ((yield* Ref.get(selectionRequest)) !== request) return
          const fiber = yield* Effect.forkIn(
            loadThread(thread, request, dispatch).pipe(Effect.provide(executionDependencies)),
            sessionScope,
          )
          selectionLoadFiber = fiber
          yield* Fiber.join(fiber).pipe(
            Effect.catchCause((cause) =>
              Ref.get(selectionRequest).pipe(
                Effect.flatMap((current) => (current === request ? Effect.failCause(cause) : Effect.void)),
              ),
            ),
          )
        })
        const createAndSelectThread = Effect.fn("ProductOperation.interactive.createAndSelectThread")(function* () {
          activeSelectionState = undefined
          candidateSelectionState = undefined
          yield* interruptSelectionLoad
          yield* interruptSelectionBackground
          const threads = yield* ThreadRepository.Service
          const thread = yield* threads.create({
            id: yield* options.makeThreadId,
            workspace,
            title: "New thread",
            now: yield* Clock.currentTimeMillis,
          })
          const epoch = currentSelectionEpoch + 1
          selectionLoad = undefined
          yield* Ref.set(selectionRequest, epoch)
          yield* activateCreatedThread(thread, epoch, sessionDispatch)
          yield* notifyThreadSummaries
        })
        const supervise =
          acquiredBackend.follow === undefined
            ? Effect.void
            : Effect.scoped(
                Effect.gen(function* () {
                  const changes = yield* PubSub.subscribe(turnChanges)
                  const turns = yield* TurnRepository.Service
                  const launch = (turn: Turn.AgentExecutionTurn) =>
                    Effect.forkChild(
                      observeTurn(turn, () => undefined).pipe(
                        Effect.flatMap((observed) => {
                          if (!observed) return Effect.void
                          return turns
                            .get(turn.id)
                            .pipe(
                              Effect.flatMap((current) =>
                                current !== undefined &&
                                Turn.isAgentExecution(current) &&
                                !isTerminalStatus(current.status) &&
                                current.status !== "queued"
                                  ? Effect.sleep("50 millis").pipe(Effect.andThen(notifyTurnChanged(current)))
                                  : Effect.void,
                              ),
                            )
                        }),
                        Effect.catch((error) =>
                          Effect.logError("turn.observer.failed").pipe(
                            Effect.annotateLogs({
                              "rika.thread.id": String(turn.threadId),
                              "rika.turn.id": String(turn.id),
                              "rika.failure.kind": String(error),
                            }),
                            Effect.andThen(Effect.sleep("50 millis")),
                            Effect.andThen(notifyTurnChanged(turn)),
                          ),
                        ),
                      ),
                    )
                  const settleStopRequested = settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
                    setTurnStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
                  )
                  const recover = Effect.gen(function* () {
                    const transcripts = yield* TranscriptRepository.Service
                    const nonterminal = yield* turns.listNonterminal
                    const projectionCandidates = yield* transcripts.listProjectionRecoveryCandidates(
                      ExecutionIngest.projectionVersion,
                    )
                    const ensured = new Set<string>()
                    for (const turn of nonterminal)
                      if (turn.status !== "queued") {
                        yield* ensureIngest(turn.threadId, turn.id)
                        ensured.add(String(turn.id))
                        yield* launch(turn)
                      }
                    for (const candidate of projectionCandidates)
                      if (!ensured.has(String(candidate.turnId)))
                        yield* ensureIngest(candidate.threadId, candidate.turnId)
                  })
                  const scanDirty = Effect.gen(function* () {
                    const dirty = [...dirtyTurnObservers]
                    dirtyTurnObservers.clear()
                    for (const turnId of dirty) {
                      const turn = yield* turns.get(turnId)
                      if (
                        turn !== undefined &&
                        Turn.isAgentExecution(turn) &&
                        !isTerminalStatus(turn.status) &&
                        turn.status !== "queued"
                      )
                        yield* launch(turn)
                    }
                  })
                  yield* settleStopRequested
                  yield* recover
                  while (true) {
                    yield* PubSub.take(changes)
                    yield* scanDirty
                  }
                }),
              ).pipe(Effect.provide(executionDependencies))
        if (!registerPromoter) sessionThreadViews.set(sessionId, () => selectedThreadId)
        if (!registerPromoter)
          interactiveSinks.set(sessionId, (_origin, event) => {
            const threadId = interactiveEventThreadId(event)
            if (threadId !== undefined && bufferSelectionEvent(event)) return
            if (
              threadId === undefined ||
              threadId === selectedThreadId ||
              event._tag === "TitleCostUpdated" ||
              event._tag === "ThreadUsageUpdated"
            )
              deliver(event, { selectedThreadOnly: threadId !== undefined && event._tag !== "TitleCostUpdated" })
          })
        let steeringIdentitySequence = 0
        const nextSteeringIdentity = (turnId: string) =>
          `rika:interactive-steer:${turnId}:${steeringIdentitySequence++}`
        const implementation: InteractiveSession = {
          events: (dispatch) =>
            Effect.gen(function* () {
              yield* dispatchThreadSummaries(sessionDispatch)
              while (true) {
                if (overflow !== undefined) {
                  const state = overflow
                  for (const discarded of yield* Queue.takeAll(sessionEvents))
                    InteractiveFeedOverflow.remember(state, discarded.event)
                  overflow = undefined
                  if (state.criticalOverflowed)
                    return yield* OperationUnavailable.make({
                      operation: "InteractiveSession.events",
                      message: "Interactive event feed exceeded its bounded non-recoverable event capacity",
                    })
                  for (const event of InteractiveFeedOverflow.events(
                    state,
                    currentSelectionEpoch,
                    "Interactive event feed exceeded its bounded live window",
                  ))
                    dispatch(event)
                  continue
                }
                const envelope = yield* Queue.take(sessionEvents)
                if (overflow !== undefined) {
                  InteractiveFeedOverflow.remember(overflow, envelope.event)
                  continue
                }
                if (envelope.selectionRequest !== undefined && envelope.selectionRequest !== currentSelectionEpoch)
                  continue
                if (envelope.selectedThreadOnly === true) {
                  const threadId = interactiveEventThreadId(envelope.event)
                  if (threadId !== undefined && threadId !== selectedThreadId) continue
                }
                dispatch(envelope.event)
              }
            }).pipe(
              Effect.provide(executionDependencies),
              Effect.mapError((error) =>
                Schema.is(OperationUnavailable)(error)
                  ? error
                  : OperationUnavailable.make({ operation: "InteractiveSession.events", message: String(error) }),
              ),
            ),
          submit: (prompt, mode, parts, tuning, submissionId) =>
            submit(prompt, sessionDispatch, mode, parts, tuning, submissionId),
          newThread: safe(
            sessionDispatch,
            submissionAdmission.withPermits(1)(Effect.uninterruptible(createAndSelectThread())),
          ),
          shell: (requestedThreadId, command, incognito) => {
            const dispatch = sessionDispatch
            const toolRuntimeLayer = options.toolRuntimeLayer?.(workspace)
            let ownerThreadId = requestedThreadId
            const runOwnedShell = (thread: Thread.Thread) =>
              Effect.gen(function* () {
                const tools = yield* ToolRuntime.Service
                if (incognito) {
                  const result = yield* executeShellCommand(tools, command)
                  dispatch({
                    _tag: "ShellCompleted",
                    threadId: thread.id,
                    command,
                    text: result.text,
                    incognito: true,
                    status: result.exitCode === 0 ? "completed" : "failed",
                  })
                  return
                }
                const transcripts = yield* TranscriptRepository.Service
                const now = yield* Clock.currentTimeMillis
                const runningTurn: Turn.RunningRecordedShellTurn = {
                  _tag: "RecordedShell",
                  id: yield* options.makeTurnId,
                  threadId: thread.id,
                  prompt: `$ ${command}`,
                  command,
                  status: "running",
                  stopIntent: "none",
                  author: { _tag: "Human" },
                  lineage: { _tag: "Original" },
                  createdAt: now,
                  updatedAt: now,
                }
                yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const runningProjection = yield* transcripts.createRecordedShell(
                      runningTurn,
                      ExecutionIngest.projectionVersion,
                    )
                    emit(dispatch, recordedShellStartedEvent(runningTurn, runningProjection))
                    const processExit = yield* Effect.exit(
                      restore(
                        ensureTurnSummary(runningTurn).pipe(
                          Effect.catchCause((cause) =>
                            Cause.hasInterrupts(cause)
                              ? Effect.failCause(cause)
                              : Effect.logError("recorded-shell.summary.start.failed").pipe(
                                  Effect.annotateLogs({
                                    "rika.thread.id": String(runningTurn.threadId),
                                    "rika.turn.id": String(runningTurn.id),
                                    "rika.failure.kind": failureKind(cause),
                                  }),
                                ),
                          ),
                          Effect.andThen(executeShellCommand(tools, command)),
                        ),
                      ),
                    )
                    const completedAt = yield* Clock.currentTimeMillis
                    const interrupted = processExit._tag === "Failure" && Cause.hasInterrupts(processExit.cause)
                    const terminalTurn: Turn.TerminalRecordedShellTurn =
                      processExit._tag === "Success"
                        ? {
                            ...runningTurn,
                            status: processExit.value.exitCode === 0 ? "completed" : "failed",
                            result: processExit.value,
                            updatedAt: completedAt,
                          }
                        : {
                            ...runningTurn,
                            status: interrupted ? "cancelled" : "failed",
                            result: appendRecordedShellOutput(
                              { text: "", truncated: false },
                              interrupted ? "Shell command cancelled" : String(Cause.squash(processExit.cause)),
                            ),
                            updatedAt: completedAt,
                          }
                    const settled = yield* transcripts.settleRecordedShell(
                      runningTurn,
                      terminalTurn,
                      runningProjection.checkpointGeneration,
                      ExecutionIngest.projectionVersion,
                    )
                    if (settled._tag === "Stale")
                      return yield* operationError(
                        `Recorded shell turn ${runningTurn.id} lost projection write authority`,
                      )
                    const terminalEvents = recordedShellSettledEvents(terminalTurn, settled.projection)
                    if (interrupted) {
                      for (const event of terminalEvents) publishInteractiveActivity(sessionId, event)
                    } else {
                      for (const event of terminalEvents) emit(dispatch, event)
                      dispatch({
                        _tag: "ShellCompleted",
                        threadId: thread.id,
                        command,
                        text: terminalTurn.result.text,
                        incognito: false,
                        status: terminalTurn.status,
                      })
                    }
                    yield* Effect.gen(function* () {
                      const summaries = yield* ThreadSummaryRepository.Service
                      yield* summaries.replaceTurn({
                        turnId: terminalTurn.id,
                        threadId: terminalTurn.threadId,
                        complete: true,
                        editTotals: { added: 0, modified: 0, removed: 0 },
                        lastEventAt: terminalTurn.updatedAt,
                        now: terminalTurn.updatedAt,
                      })
                      yield* notifyThreadSummaries
                      yield* notifyTurnChanged(terminalTurn)
                    }).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError("recorded-shell.summary.settle.failed").pipe(
                          Effect.annotateLogs({
                            "rika.thread.id": String(terminalTurn.threadId),
                            "rika.turn.id": String(terminalTurn.id),
                            "rika.failure.kind": failureKind(cause),
                          }),
                        ),
                      ),
                    )
                    if (interrupted) return yield* Effect.interrupt
                  }),
                )
              })
            const program = Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const thread = yield* selectionAdmission.withPermits(1)(
                Effect.gen(function* () {
                  if (requestedThreadId !== undefined) {
                    const requested = yield* threads.get(requestedThreadId)
                    if (requested === undefined)
                      return yield* operationError(`Thread ${requestedThreadId} does not exist`)
                    if (requested.workspace !== workspace)
                      return yield* operationError(
                        `Thread ${requestedThreadId} belongs to workspace ${requested.workspace}, not ${workspace}`,
                      )
                    return requested
                  }
                  const selected = yield* Ref.get(interactiveThread)
                  if (selected !== undefined) return selected
                  const now = yield* Clock.currentTimeMillis
                  const created = yield* threads.create({
                    id: yield* options.makeThreadId,
                    workspace,
                    title: incognito ? "New thread" : clampThreadTitle(`$ ${command}`),
                    now,
                  })
                  yield* activateCreatedThread(created, currentSelectionEpoch, dispatch)
                  return created
                }),
              )
              ownerThreadId = thread.id
              if (toolRuntimeLayer === undefined) {
                dispatch({
                  _tag: "ExecutionFailed",
                  selectionEpoch: 0,
                  threadId: thread.id,
                  message: "Shell runtime is unavailable",
                })
                return
              }
              const toolContext = yield* Layer.build(toolRuntimeLayer)
              yield* runOwnedShell(thread).pipe(
                Effect.provide(Context.merge(executionDependencies, toolContext)),
                Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, thread.id))),
              )
            })
            return program.pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, ownerThreadId))),
              Effect.forkIn(sessionScope),
              Effect.asVoid,
            )
          },
          editQueued: (id, prompt) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                const turnId = Turn.TurnId.make(id)
                if ((yield* turns.get(turnId))?.status !== "queued")
                  return yield* operationError(`Turn ${turnId} is not queued`)
                const turn = yield* turns.editQueued(turnId, prompt, yield* Clock.currentTimeMillis)
                emit(sessionDispatch, queueMutationEvent(turn.queue))
              }),
            ),
          dequeue: (id) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                emit(sessionDispatch, queueMutationEvent(yield* turns.dequeue(Turn.TurnId.make(id))))
              }),
            ),
          steerQueued: (id, text) =>
            safe(
              sessionDispatch,
              turnMutationAdmission.withPermits(1)(
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const turns = yield* TurnRepository.Service
                    const backend = yield* ExecutionBackend.Service
                    const turn = yield* active()
                    const candidate = yield* turns.get(Turn.TurnId.make(id))
                    if (
                      candidate?.status === "queued" &&
                      candidate.promptParts !== undefined &&
                      candidate.promptParts.some((part) => part.type === "image")
                    )
                      return yield* operationError("Queued turns with images cannot be steered")
                    const taken = yield* turns.takeQueued(Turn.TurnId.make(id))
                    const queued = taken.turn
                    const steeringText =
                      queued.promptParts
                        ?.filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("") ??
                      queued.prompt ??
                      text
                    emit(sessionDispatch, queueMutationEvent(taken.queue))
                    const outcome = yield* Effect.exit(
                      restore(backend.steer(turn.id, steeringText, `rika:queued-steer:${queued.id}`)),
                    )
                    if (outcome._tag === "Failure") {
                      const requeued = yield* turns.copy(queued, pendingTurnCapacity)
                      if (requeued.queue === undefined)
                        return yield* operationError(`Turn ${queued.id} was not restored to its queue`)
                      emit(sessionDispatch, queueMutationEvent(requeued.queue))
                      emit(sessionDispatch, {
                        _tag: "ExecutionControlFailed",
                        selectionEpoch: 0,
                        threadId: turn.threadId,
                        turnId: turn.id,
                        action: "steer",
                        message: operationFailureDetail(outcome.cause),
                        steeringText,
                      })
                      return
                    }
                    emit(sessionDispatch, {
                      _tag: "ExecutionControlled",
                      selectionEpoch: 0,
                      threadId: turn.threadId,
                      turnId: turn.id,
                      action: "steered",
                      steeringSequence: outcome.value.sequence,
                      steeringText,
                    })
                  }),
                ),
              ),
            ),
          steer: (text, targetTurnId) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active()
                if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
                  return yield* operationError(`Steering target ${targetTurnId} is no longer the active turn`)
                const outcome = yield* Effect.exit(backend.steer(turn.id, text, nextSteeringIdentity(String(turn.id))))
                if (outcome._tag === "Failure") {
                  emit(sessionDispatch, {
                    _tag: "ExecutionControlFailed",
                    selectionEpoch: 0,
                    threadId: turn.threadId,
                    turnId: turn.id,
                    action: "steer",
                    message: operationFailureDetail(outcome.cause),
                    steeringText: text,
                  })
                  return
                }
                emit(sessionDispatch, {
                  _tag: "ExecutionControlled",
                  selectionEpoch: 0,
                  threadId: turn.threadId,
                  turnId: turn.id,
                  action: "steered",
                  steeringSequence: outcome.value.sequence,
                  steeringText: text,
                })
              }),
            ),
          interruptAndSend: (prompt) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active()
                const thread = yield* threadForTurn(turn)
                const pending = yield* createForSubmission(turns, {
                  id: yield* options.makeTurnId,
                  threadId: turn.threadId,
                  prompt,
                  executionRoute: turn.executionRoute,
                  queueCapacity: pendingTurnCapacity,
                  now: yield* Clock.currentTimeMillis,
                })
                yield* ensureTurnSummary(pending)
                if (pending.status === "accepted") {
                  const requeued = yield* turns.requeueAccepted(
                    pending.id,
                    pendingTurnCapacity,
                    yield* Clock.currentTimeMillis,
                  )
                  emit(sessionDispatch, queueMutationEvent(requeued.queue))
                  yield* drainQueued(thread, sessionDispatch)
                  return
                }
                if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
                if (pending.queue !== undefined) emit(sessionDispatch, queueMutationEvent(pending.queue))
                const cancelledAt = yield* Clock.currentTimeMillis
                const cancelledBeforeStart =
                  turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, cancelledAt))
                if (cancelledBeforeStart) {
                  const cancelled = yield* turns.get(turn.id)
                  yield* notifyThreadSummaries
                  if (cancelled !== undefined) yield* notifyTurnChanged(cancelled)
                } else {
                  const result = yield* backend.cancel(turn.id)
                  deliverResultEvents(turn.id, result.events)
                  yield* setTurnStatus(
                    turn.id,
                    result.status,
                    result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
                    yield* Clock.currentTimeMillis,
                  )
                  yield* projectExecutionResult(turn.threadId, result)
                }
                yield* drainQueued(thread, sessionDispatch)
              }),
            ),
          cancel: Effect.gen(function* () {
            const selectedThread = yield* Ref.get(interactiveThread)
            if (selectedThread === undefined) {
              sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
              return
            }
            const turns = yield* TurnRepository.Service
            const turn = yield* turns.findActive(selectedThread.id)
            if (turn === undefined) {
              sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
              return
            }
            const backend = yield* ExecutionBackend.Service
            const thread = yield* threadForTurn(turn)
            const cancelledAt = yield* Clock.currentTimeMillis
            yield* turns.requestStop(turn.id, cancelledAt)
            const cancelledBeforeStart =
              turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, cancelledAt))
            const cancellation = cancelledBeforeStart
              ? Effect.exit(Effect.succeed({ turnId: turn.id, status: "cancelled" as const, events: [] }))
              : Effect.exit(backend.cancel(turn.id))
            const outcome = yield* cancellation
            if (outcome._tag === "Failure") {
              emit(sessionDispatch, {
                _tag: "ExecutionControlFailed",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                action: "cancel",
                message: operationFailureDetail(outcome.cause),
              })
              return
            }
            const result = outcome.value
            deliverResultEvents(turn.id, result.events)
            if (cancelledBeforeStart) {
              const cancelled = yield* turns.get(turn.id)
              yield* notifyThreadSummaries
              if (cancelled !== undefined) yield* notifyTurnChanged(cancelled)
            }
            yield* setTurnStatus(
              turn.id,
              result.status,
              ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
              yield* Clock.currentTimeMillis,
            )
            yield* projectExecutionResult(turn.threadId, result)
            if (isTerminalStatus(result.status)) yield* ensureIngest(turn.threadId, turn.id)
            if (result.status === "cancelled")
              emit(sessionDispatch, {
                _tag: "ExecutionControlled",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                action: "cancelled",
                agentResponseArrived: agentResponseArrived(result.events),
              })
            else if (result.status === "failed" && !result.events.some((event) => event.type === "execution.failed"))
              emit(sessionDispatch, {
                _tag: "ExecutionFailed",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                message: `Execution ${result.status}`,
              })
            if (isTerminalStatus(result.status)) yield* settleThread(thread, sessionDispatch)
          }).pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.catch((failure) =>
              Effect.sync(() => {
                const selected = Ref.getUnsafe(interactiveThread)
                sessionDispatch({
                  _tag: "ExecutionControlFailed",
                  selectionEpoch: 0,
                  ...(selected === undefined ? {} : { threadId: selected.id }),
                  action: "cancel",
                  message: operationFailureDetail(failure),
                })
              }),
            ),
          ),
          quit: stopActiveExecutionWorkWithProjection().pipe(
            Effect.provide(executionDependencies),
            Effect.mapError((failure) =>
              OperationUnavailable.make({ operation: "InteractiveSession.quit", message: String(failure) }),
            ),
          ),
          selectThread: (id, epoch) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const admitted = yield* selectionAdmission.withPermits(1)(
                  Effect.gen(function* () {
                    if (epoch <= (yield* Ref.get(selectionRequest))) return false
                    const previousThread = yield* Ref.get(interactiveThread)
                    const previousEpoch = currentSelectionEpoch
                    const joined =
                      selectionLoad?.epoch === 0 && selectionLoad.threadId === id ? selectionLoad : undefined
                    selectionLoad = {
                      epoch,
                      threadId: id,
                      previousEpoch,
                      previousThreadId: previousThread === undefined ? undefined : String(previousThread.id),
                      events: joined?.events ?? [],
                      committed: false,
                      ...(joined?.overflow === undefined ? {} : { overflow: joined.overflow }),
                    }
                    yield* Ref.set(selectionRequest, epoch)
                    return true
                  }),
                )
                if (!admitted) return
                const threads = yield* ThreadRepository.Service
                const thread = yield* threads.get(Thread.ThreadId.make(id))
                if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
                yield* runThreadLoad(thread, epoch, selectionDispatch(epoch))
              }).pipe(Effect.ensuring(finishSelection(epoch))),
            ),
          readQueue: (id) =>
            safe(sessionDispatch, readQueue(Thread.ThreadId.make(id), selectionDispatch(currentSelectionEpoch))),
          loadOlder: (threadId, selectionEpoch, before, loadedKeys) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const state = activeSelectionState
                if (state === undefined || state.thread.id !== threadId || state.epoch !== selectionEpoch) return
                yield* transcriptPageAdmission.withPermits(1)(
                  loadTranscriptPage(state, selectionDispatch(state.epoch), before, new Set(loadedKeys)),
                )
              }),
            ),
          loadNewer: (threadId, selectionEpoch, after: TranscriptRepository.PageCursor) =>
            safe(
              sessionDispatch,
              transcriptPageAdmission.withPermits(1)(
                Effect.gen(function* () {
                  const state = activeSelectionState
                  if (state === undefined || state.thread.id !== threadId || state.epoch !== selectionEpoch) return
                  const page = yield* (yield* TranscriptRepository.Service).page(state.thread.id, { after, limit: 50 })
                  if (!isCurrentSelectionState(state)) return
                  const entries = page.entries
                  state.newestTranscriptCursor = page.newestCursor ?? state.newestTranscriptCursor
                  sessionDispatch({
                    _tag: "TranscriptPageAppended",
                    selectionEpoch: state.epoch,
                    threadId: state.thread.id,
                    entries,
                    hasNewer: page.hasNewer ?? false,
                    requestedAfter: after,
                    ...(page.threadCostUsd === undefined ? {} : { threadCostUsd: page.threadCostUsd }),
                    ...(page.newestCursor === undefined ? {} : { newestCursor: page.newestCursor }),
                  })
                }),
              ),
            ),
          previewThread: (id) =>
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              const transcripts = yield* TranscriptRepository.Service
              const backend = yield* ExecutionBackend.Service
              const thread = yield* threads.get(Thread.ThreadId.make(id))
              if (thread === undefined) return
              const recent = yield* turns.listRecentNonqueued(thread.id, 4)
              const previewTurns = yield* Effect.forEach(recent, (turn) =>
                Effect.gen(function* () {
                  const projection = yield* transcripts.get(turn.id)
                  const execution = yield* backend.inspect(turn.id).pipe(Effect.orElseSucceed(() => undefined))
                  if (
                    execution !== undefined &&
                    (!isTerminalStatus(execution.status) ||
                      projection === undefined ||
                      projection.checkpointCursor !== execution.lastCursor)
                  )
                    yield* ensureIngest(turn.threadId, turn.id)
                  return {
                    prompt: turn.prompt,
                    units: projection?.units ?? TranscriptProjection.Projection.empty(turn.id, turn.prompt).units,
                  }
                }).pipe(
                  Effect.orElseSucceed(() => ({
                    prompt: turn.prompt,
                    units: TranscriptProjection.Projection.empty(turn.id, turn.prompt).units,
                  })),
                ),
              )
              sessionDispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
            }).pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.orElseSucceed(() => undefined),
            ),
          reopenThread: (epoch) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                if (epoch <= (yield* Ref.get(selectionRequest))) return
                const summaries = yield* ThreadSummaryRepository.Service
                const summary = (yield* summaries.list({ limit: 1 }))[0]
                if (summary === undefined) return
                const threads = yield* ThreadRepository.Service
                const thread = yield* threads.get(summary.id)
                if (thread === undefined) return yield* operationError(`Thread ${summary.id} does not exist`)
                const admitted = yield* selectionAdmission.withPermits(1)(
                  Effect.gen(function* () {
                    if (epoch <= (yield* Ref.get(selectionRequest))) return false
                    const previousThread = yield* Ref.get(interactiveThread)
                    const previousEpoch = currentSelectionEpoch
                    selectionLoad = {
                      epoch,
                      threadId: String(thread.id),
                      previousEpoch,
                      previousThreadId: previousThread === undefined ? undefined : String(previousThread.id),
                      events: [],
                      committed: false,
                    }
                    yield* Ref.set(selectionRequest, epoch)
                    return true
                  }),
                )
                if (!admitted) return
                yield* runThreadLoad(thread, epoch, selectionDispatch(epoch))
              }).pipe(Effect.ensuring(finishSelection(epoch))),
            ),
        }
        const session: InteractiveSession = {
          events: (dispatch) => attachFeed(implementation.events(dispatch)),
          submit: (prompt, mode, parts, tuning, submissionId) =>
            admit(implementation.submit(prompt, mode, parts, tuning, submissionId)),
          newThread: admitLocal(implementation.newThread),
          shell: (threadId, command, incognito) => admitLocal(implementation.shell(threadId, command, incognito)),
          editQueued: (turnId, prompt) => admitLocal(implementation.editQueued(turnId, prompt)),
          dequeue: (turnId) => admitLocal(implementation.dequeue(turnId)),
          steerQueued: (turnId, text) => admitLocal(implementation.steerQueued(turnId, text)),
          steer: (text, targetTurnId) => admitLocal(implementation.steer(text, targetTurnId)),
          interruptAndSend: (prompt) => admitLocal(implementation.interruptAndSend(prompt)),
          cancel: admitLocal(implementation.cancel),
          quit: implementation.quit,
          selectThread: (threadId, epoch) => admitLocal(implementation.selectThread(threadId, epoch)),
          readQueue: (threadId) => admitLocal(implementation.readQueue(threadId)),
          loadOlder: (threadId, epoch, before, loadedKeys) =>
            admitLocal(implementation.loadOlder(threadId, epoch, before, loadedKeys)),
          loadNewer: (threadId, epoch, after) => admitLocal(implementation.loadNewer(threadId, epoch, after)),
          previewThread: (threadId) => admitLocal(implementation.previewThread(threadId)),
          reopenThread: (epoch) => admitLocal(implementation.reopenThread(epoch)),
        }
        const backend = acquiredBackend
        if (registerPromoter && backend.registerTurnPromoter !== undefined)
          yield* backend.registerTurnPromoter(promoterFor(() => undefined))
        return {
          session,
          supervise,
          followClaimed:
            acquiredBackend.follow === undefined
              ? undefined
              : (turnId: Turn.TurnId) => followClaimedTurn(turnId, ignoreInteractiveEvent),
          close: lifecycleAdmission.withPermits(1)(
            Effect.suspend(() => {
              if (lifecycle === "closed") return Effect.void
              lifecycle = "closed"
              interactiveSinks.delete(sessionId)
              sessionThreadViews.delete(sessionId)
              return Queue.shutdown(sessionEvents).pipe(Effect.andThen(Scope.close(sessionScope, Exit.void)))
            }),
          ),
        }
      })
      const owner = yield* makeInteractiveSession(options.defaultWorkspace, { registerPromoter: true })
      yield* Effect.forkIn(owner.supervise, ownerScope)
      yield* Effect.forkIn(
        settleAbandonedRecoveredWork(
          Duration.fromInputUnsafe(options.recoveredWorkGrace ?? "15 seconds"),
          watchedThreadIds,
        ).pipe(
          Effect.provide(executionDependencies),
          Effect.catch((failure) =>
            Effect.logError("execution.recovery.abandonment_failed").pipe(
              Effect.annotateLogs("rika.failure.kind", String(failure)),
            ),
          ),
        ),
        ownerScope,
      )
      const repairSummariesOnce = yield* Effect.cached(
        repairThreadSummaries().pipe(
          Effect.provide(executionDependencies),
          Effect.catch((error) =>
            Effect.logError("thread-summary.repair.failed").pipe(
              Effect.annotateLogs("rika.failure.kind", String(error)),
            ),
          ),
        ),
      )
      const repairThreadTitles = Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        for (const thread of yield* threads.listAll) {
          const firstTurn = (yield* turns.list(thread.id))[0]
          if (firstTurn !== undefined && Turn.isAgentExecution(firstTurn) && firstTurn.status === "completed")
            yield* titleThread(thread, firstTurn, (event) => publishInteractiveActivity(0, event))
        }
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.catchCause((cause) =>
          Effect.logError("thread-title.repair.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
        ),
      )
      type ReconcileSchedule =
        | { readonly running: false }
        | { readonly running: true; readonly rescan: boolean; readonly completed: Deferred.Deferred<void> }
      const reconcileSchedule = yield* Ref.make<ReconcileSchedule>({ running: false })
      let requestResultRetry: Effect.Effect<void> = Effect.void
      const runScheduledReconcile = Effect.fn("ProductOperation.runScheduledReconcile")(function* (
        completed: Deferred.Deferred<void>,
      ) {
        while (true) {
          yield* reconcileExecutions.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError("execution.repair.failed").pipe(
                    Effect.annotateLogs({
                      "rika.failure.kind": failureKind(cause),
                      "rika.failure.message": String(Cause.squash(cause)),
                    }),
                  ),
            ),
          )
          const retryResults = yield* reconcileThreadResults().pipe(
            Effect.catchCause((cause) =>
              Effect.logError("thread-result.repair.failed").pipe(
                Effect.annotateLogs("rika.failure.message", String(Cause.squash(cause))),
                Effect.as(false),
              ),
            ),
          )
          yield* repairThreadTitles
          const repeat = yield* Ref.modify(reconcileSchedule, (state) => {
            if (!state.running) return [false, state] as const
            return state.rescan
              ? [true, { running: true, rescan: false, completed: state.completed } as const]
              : [false, { running: false } as const]
          })
          if (!repeat) {
            if (retryResults) yield* requestResultRetry
            yield* Deferred.succeed(completed, undefined)
            return
          }
        }
      })
      const scheduleReconcile = Effect.gen(function* () {
        const candidate = yield* Deferred.make<void>()
        const scheduled = yield* Ref.modify(reconcileSchedule, (state) =>
          state.running
            ? [
                { launch: false, completed: state.completed },
                { running: true, rescan: true, completed: state.completed },
              ]
            : [
                { launch: true, completed: candidate },
                { running: true, rescan: false, completed: candidate },
              ],
        )
        if (scheduled.launch) yield* Effect.forkIn(runScheduledReconcile(scheduled.completed), ownerScope)
        return scheduled.completed
      })
      requestResultRetry = Effect.forkIn(
        Effect.sleep("1 second").pipe(Effect.andThen(scheduleReconcile), Effect.asVoid),
        ownerScope,
      ).pipe(Effect.asVoid)
      yield* rootTurnOwner.install({
        run: () => scheduleReconcile.pipe(Effect.flatMap(Deferred.await)),
        reconcile: scheduleReconcile.pipe(Effect.flatMap(Deferred.await)),
      })
      yield* Effect.forkIn(rootTurnOwner.reconcile, ownerScope)
      return Service.of({
        hasActiveExecutionWork: hasActiveExecutionWork().pipe(
          Effect.provide(executionDependencies),
          Effect.mapError((error) =>
            OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
          ),
        ),
        stopActiveExecutionWork: stopActiveExecutionWorkWithProjection().pipe(
          Effect.provide(executionDependencies),
          Effect.mapError((error) =>
            OperationUnavailable.make({ operation: "ResidentAbandonment", message: String(error) }),
          ),
        ),
        authorizeResidentReplacement: replacementAdmission
          .withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(replacementState)
              if (state.closed) return "supersede" as const
              if (state.active > 0 || (yield* hasActiveExecutionWork().pipe(Effect.provide(executionDependencies))))
                return "defer" as const
              for (const [key, workflow] of activeWorkflows) {
                const inspection = yield* rawBackend.inspectWorkflow(
                  workflow.runId,
                  workflow.ownerTurnId,
                  workflow.workspace,
                )
                if (inspection?.status === "running") return "defer" as const
                activeWorkflows.delete(key)
              }
              yield* Ref.set(replacementState, { closed: true, active: 0 })
              return "supersede" as const
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
            ),
          ),
        run: Effect.fn("ProductOperation.product.run")(function* (input) {
          if (
            input._tag === "Interactive" ||
            input._tag === "Run" ||
            input._tag === "Review" ||
            input._tag === "Workflow"
          ) {
            if (input._tag === "Interactive")
              yield* Effect.forkIn(
                Effect.sleep("2 seconds").pipe(
                  Effect.andThen(scheduleReconcile),
                  Effect.flatMap(Deferred.await),
                  Effect.andThen(repairSummariesOnce),
                ),
                ownerScope,
              )
            else {
              yield* Deferred.await(yield* scheduleReconcile)
              yield* repairSummariesOnce
            }
          }
          if (input._tag === "Interactive" && options.interactive !== undefined) {
            let initialThreadId = input.threadId
            if (input.last === true) {
              const summary = (yield* Context.get(dependencyContext, ThreadSummaryRepository.Service)
                .list({ limit: 1 })
                .pipe(Effect.mapError((error) => unavailable(input, String(error)))))[0]
              if (summary === undefined) return yield* unavailable(input, "No threads exist")
              initialThreadId = String(summary.id)
            }
            if (initialThreadId !== undefined) {
              const thread = yield* Context.get(dependencyContext, ThreadRepository.Service)
                .get(Thread.ThreadId.make(initialThreadId))
                .pipe(Effect.mapError((error) => unavailable(input, String(error))))
              if (thread === undefined) return yield* unavailable(input, `Thread ${initialThreadId} does not exist`)
            }
            const made = yield* makeInteractiveSession(
              input.workspace ?? options.defaultWorkspace,
              initialThreadId === undefined ? {} : { initialThreadId },
            )
            yield* options.interactive(input, made.session).pipe(Effect.ensuring(made.close))
            return
          }
          if (input._tag === "Run") {
            const program = Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              const backend = yield* ExecutionBackend.Service
              const now = yield* Clock.currentTimeMillis
              const thread =
                input.threadId === undefined
                  ? yield* threads.create({
                      id: yield* options.makeThreadId,
                      workspace: input.workspace ?? options.defaultWorkspace,
                      title: clampThreadTitle(input.prompt.join(" ")) || "New thread",
                      now,
                    })
                  : yield* threads
                      .get(Thread.ThreadId.make(input.threadId))
                      .pipe(
                        Effect.flatMap((existingThread) =>
                          existingThread === undefined
                            ? operationError(`Thread ${input.threadId} does not exist`)
                            : Effect.succeed(existingThread),
                        ),
                      )
              const runTurn = Effect.fn("ProductOperation.runTurn")(function* (
                turn: Turn.AgentExecutionTurn,
                preparedInput?: {
                  readonly prompt: string
                  readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
                  readonly extensionPin: Turn.ExecutionExtensionPin | undefined
                },
              ) {
                const blockedTurn = yield* awaitSessionQuiescence(backend, turn.threadId)
                if (blockedTurn !== undefined)
                  return yield* operationError(
                    `Cancelled turn ${blockedTurn.id} is still releasing its execution; try again shortly`,
                  )
                const startedAt = yield* Clock.currentTimeMillis
                const deliveredCursors = new Set<string>()
                let directDelivery = true
                let receivedDirectEvent = false
                yield* Effect.logInfo("turn.started").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                  }),
                )
                const execution = yield* Effect.gen(function* () {
                  const prepared = preparedInput ?? (yield* prepareExecution(turn, thread.workspace))
                  const runningTurn = yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
                  publishInteractiveActivity(0, {
                    _tag: "TurnStarted",
                    selectionEpoch: 0,
                    threadId: thread.id,
                    turn: runningTurn,
                  })
                  yield* ensureIngest(turn.threadId, turn.id)
                  const startCompleted = yield* Deferred.make<void>()
                  const started = yield* Effect.forkChild(
                    rootTurnOwner
                      .start({
                        threadId: turn.threadId,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        executionRoute: turn.executionRoute,
                        onEvent: (event) => {
                          if (!directDelivery) return
                          receivedDirectEvent = true
                          deliveredCursors.add(event.cursor)
                          executionIngest.deliver(turn.id, event)
                        },
                        ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                        ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                      })
                      .pipe(Effect.ensuring(Deferred.succeed(startCompleted, undefined))),
                  )
                  let followed = false
                  while (true) {
                    if (receivedDirectEvent || (yield* Deferred.isDone(startCompleted))) break
                    if ((yield* backend.inspect(turn.id)) !== undefined) {
                      for (let attempts = 0; attempts < 100; attempts += 1) {
                        if (receivedDirectEvent) break
                        yield* Effect.yieldNow
                      }
                      if (!receivedDirectEvent && !(yield* Deferred.isDone(startCompleted))) directDelivery = false
                      break
                    }
                    yield* Effect.yieldNow
                  }
                  if (!directDelivery && owner.followClaimed !== undefined)
                    while (!(yield* Deferred.isDone(startCompleted))) {
                      const outcome = yield* Effect.exit(owner.followClaimed(turn.id))
                      if (outcome._tag === "Success") {
                        followed = true
                        break
                      }
                      yield* Effect.sleep("10 millis")
                    }
                  return { result: yield* Fiber.join(started), followed }
                }).pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      const failedAt = yield* Clock.currentTimeMillis
                      yield* Effect.logError("turn.failed").pipe(
                        Effect.annotateLogs({
                          "rika.duration.ms": failedAt - startedAt,
                          "rika.failure.kind": error instanceof Error ? error.name : typeof error,
                          "rika.thread.id": String(thread.id),
                          "rika.turn.id": String(turn.id),
                        }),
                      )
                      yield* setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
                      return yield* error
                    }),
                  ),
                )
                const { result, followed } = execution
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("turn.finished").pipe(
                  Effect.annotateLogs({
                    "rika.duration.ms": completedAt - startedAt,
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                    "rika.turn.status": result.status,
                  }),
                )
                if (!followed) {
                  deliverResultEvents(turn.id, result.events, directDelivery ? deliveredCursors : new Set<string>())
                  const updated = yield* setTurnStatus(
                    turn.id,
                    result.status,
                    result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
                    completedAt,
                  )
                  yield* projectExecutionResult(thread.id, result)
                  yield* ensureIngest(updated.threadId, updated.id)
                  yield* awaitIngestSettled(updated.id)
                }
                return result
              })
              const drainRunQueue = Effect.fn("ProductOperation.drainRunQueue")(function* () {
                while (true) {
                  const queue = yield* turns.readQueue(thread.id)
                  if (queue.queuedCount === 0) return
                  const staleError = staleQueuedTurnsError(
                    thread.id,
                    queue.turns,
                    yield* Clock.currentTimeMillis,
                    queuedTurnPromoteMaxAgeMs,
                  )
                  if (staleError !== undefined) return yield* staleError
                  if ((yield* awaitSessionQuiescence(backend, thread.id)) !== undefined) return
                  const promoted = yield* claimQueuedTurn(thread.id, yield* Clock.currentTimeMillis)
                  if (promoted === undefined) return
                  const prepared = yield* prepareExecution(promoted.turn, thread.workspace, false).pipe(
                    Effect.map((value) => ({ _tag: "Success" as const, value })),
                    Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
                    Effect.onInterrupt(() =>
                      turns.releaseQueuedClaim(promoted).pipe(Effect.andThen(releaseTurnObserver(promoted.turn.id))),
                    ),
                  )
                  if (prepared._tag === "Failure") {
                    const transition = yield* turns.finishQueuedClaim(
                      promoted,
                      "failed",
                      promoted.turn.lastCursor,
                      promoted.turn.extensionPin,
                      yield* Clock.currentTimeMillis,
                    )
                    if (transition._tag === "Transitioned") {
                      publishInteractiveActivity(0, queueMutationEvent(transition.queue))
                    }
                    yield* releaseTurnObserver(promoted.turn.id)
                    continue
                  }
                  const transition = yield* turns.finishQueuedClaim(
                    promoted,
                    "running",
                    promoted.turn.lastCursor,
                    prepared.value.extensionPin,
                    yield* Clock.currentTimeMillis,
                  )
                  if (transition._tag === "Unavailable") {
                    yield* releaseTurnObserver(promoted.turn.id)
                    continue
                  }
                  publishInteractiveActivity(0, queueMutationEvent(transition.queue))
                  yield* runTurn(transition.turn, prepared.value).pipe(
                    Effect.ensuring(releaseTurnObserver(transition.turn.id)),
                  )
                }
              })
              yield* drainRunQueue()
              const turnId = yield* options.makeTurnId
              const prompt = input.prompt.join(" ")
              const observed = yield* createObservedSubmission(turns, {
                id: turnId,
                threadId: thread.id,
                prompt,
                executionRoute: yield* resolveExecutionRoute(input.mode ?? "medium", undefined, thread.workspace),
                queueCapacity: pendingTurnCapacity,
                now,
              })
              const submitted = observed.turn
              yield* ensureTurnSummary(submitted)
              yield* Effect.logInfo("turn.accepted").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": String(thread.id),
                  "rika.turn.id": String(submitted.id),
                  "rika.turn.status": submitted.status,
                }),
              )
              if (submitted.status === "queued") return
              if (!observed.claimed)
                return yield* operationError(`Turn ${submitted.id} already has an execution observer`)
              const result = yield* runTurn(submitted).pipe(Effect.ensuring(releaseTurnObserver(submitted.id)))
              yield* drainRunQueue()
              if (input.streamJson) {
                yield* Effect.forEach(result.events, (event) => Console.log(JSON.stringify(event)), { discard: true })
                return
              }
              const text = result.events
                .filter((event) => event.type === "model.output.completed")
                .map((event) => event.text ?? "")
                .join("")
              if (text.length > 0) yield* Console.log(text)
              if (result.status === "cancelled")
                return yield* operationError(`Turn ${submitted.id} was cancelled before it completed`)
              if (result.status === "failed") {
                const failure = result.events.findLast((event) => event.type === "execution.failed")?.text
                return yield* operationError(
                  failure === undefined ? `Turn ${submitted.id} failed` : `Turn ${submitted.id} failed: ${failure}`,
                )
              }
              if (result.status === "completed" && text.length === 0)
                return yield* operationError(`Turn ${submitted.id} completed without output`)
            })
            yield* program.pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.mapError((error) => unavailable(input, String(error))),
            )
            return
          }
          if (input._tag === "Review") {
            if (options.toolRuntimeLayer === undefined)
              return yield* unavailable(input, "Review requires the local tool runtime")
            const workspace = input.workspace ?? options.defaultWorkspace
            const program = Effect.gen(function* () {
              const tools = yield* ToolRuntime.Service
              const agents = yield* ProductAgent.Service
              if (input.staged && input.base !== undefined)
                return yield* operationError("Review cannot combine --staged with --base")
              if (input.base !== undefined && (input.base.length === 0 || input.base.startsWith("-")))
                return yield* operationError("Review --base must name a Git revision")
              const args = ["diff", "--no-ext-diff", "--no-color"]
              if (input.staged) args.push("--cached")
              else if (input.base !== undefined) args.push("--end-of-options", `${input.base}...HEAD`)
              if (input.paths.length > 0) args.push("--", ...input.paths)
              const diffResult = yield* tools.run({ _tag: "Shell", command: "git", args, waitMillis: 120_000 })
              if (diffResult.exitCode === undefined)
                return yield* operationError("Git diff did not finish before the review timeout")
              if (diffResult.exitCode !== 0) return yield* operationError(diffResult.text || "Git diff failed")
              if (diffResult.truncated) return yield* operationError("Git diff exceeded the review output limit")
              const diff = diffResult.text.trim()
              if (diff.length === 0) {
                yield* Console.log(
                  input.json ? encodeJson({ status: "no-changes", findings: [] }) : "No changes to review.",
                )
                return
              }
              const now = yield* Clock.currentTimeMillis
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              const thread = yield* threads.create({
                id: yield* options.makeThreadId,
                workspace,
                title: "Code review",
                now,
              })
              const parentTurnId = yield* options.makeTurnId
              const executionRoute = yield* resolveExecutionRoute("medium", undefined, thread.workspace)
              const fanOutId = `review:${parentTurnId}`
              const focus = [
                ["correctness", "Find correctness defects, regressions, and edge cases."],
                ["security", "Find security, privacy, and unsafe-input defects."],
                ["quality", "Find missing tests, maintainability risks, and contract violations."],
              ] as const
              let reviewObserverClaimed = false
              const settled = yield* Effect.gen(function* () {
                const settlement = yield* Effect.gen(function* () {
                  const observed = yield* createObservedSubmission(turns, {
                    id: parentTurnId,
                    threadId: thread.id,
                    prompt: "Review workspace changes",
                    executionRoute,
                    reviewFanOutId: fanOutId,
                    queueCapacity: pendingTurnCapacity,
                    now,
                  })
                  const parentTurn = observed.turn
                  if (!observed.claimed)
                    return yield* operationError(`Turn ${parentTurn.id} already has an execution observer`)
                  reviewObserverClaimed = true
                  yield* ensureTurnSummary(parentTurn)
                  const runningParentTurn = yield* setTurnStatus(parentTurnId, "running", undefined, now)
                  const inspection = yield* agents.runReviewLanes({
                    parentTurnId,
                    fanOutId,
                    workspace: thread.workspace,
                    executionRoute,
                    checks: focus.map(([id, instruction]) => ({
                      id: `${fanOutId}:${id}`,
                      prompt: `${instruction}\nReturn concise actionable findings with file and line references. If none, say no findings.\n\n${diff}`,
                    })),
                    maxConcurrency: focus.length,
                    join: "best-effort",
                    createdAt: now,
                  })
                  return yield* startReviewSettlement(runningParentTurn, fanOutId, inspection)
                }).pipe(
                  Effect.catch((error) =>
                    setTurnStatus(parentTurnId, "failed", undefined, now).pipe(Effect.andThen(Effect.fail(error))),
                  ),
                  Effect.uninterruptible,
                )
                return yield* Fiber.join(settlement)
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    reviewObserverClaimed ? releaseTurnObserver(parentTurnId).pipe(Effect.asVoid) : Effect.void,
                  ),
                ),
              )
              const lanes = agents.projectChildren(settled).map((lane) => ({
                id: lane.childId.slice(fanOutId.length + 1),
                status: lane.state,
                output: lane.output,
                error: lane.error,
              }))
              if (settled.state === "failed" || lanes.every((lane) => lane.status !== "completed"))
                return yield* operationError(
                  lanes
                    .map((lane) => lane.error)
                    .filter((error): error is string => error !== undefined && error.length > 0)
                    .join("; ") || "Review failed",
                )
              if (input.json) {
                yield* Console.log(encodeJson({ status: settled.state, lanes }))
                return
              }
              yield* Console.log(
                lanes
                  .map((lane) => {
                    if (lane.output === undefined) {
                      return `## ${lane.id}\nReview lane ${lane.status}${
                        lane.error === undefined ? "" : `: ${lane.error}`
                      }`
                    }
                    const output = typeof lane.output === "string" ? lane.output : encodeJson(lane.output)
                    return `## ${lane.id}\n${output}`
                  })
                  .join("\n\n"),
              )
            })
            const agentLayer = options.productAgentLayer ?? ProductAgent.layer
            const reviewToolRuntimeLayer = options.toolRuntimeLayer(workspace)
            yield* Effect.gen(function* () {
              const reviewContext = yield* Layer.build(
                Layer.mergeAll(
                  reviewToolRuntimeLayer,
                  agentLayer.pipe(Layer.provide(backendLayer)),
                  backendLayer,
                  acquiredDependencies,
                ),
              ).pipe(Effect.mapError((error) => unavailable(input, String(error))))
              yield* program.pipe(
                Effect.provide(reviewContext),
                Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
              )
            }).pipe(Effect.scoped)
            return
          }
          if (input._tag === "ToolCatalog") {
            if (input.action === "list") {
              yield* Console.log(encodeJson(ToolCatalog.definitions))
              return
            }
            const definition = ToolCatalog.get(input.name)
            if (definition === undefined) return yield* unavailable(input, `Tool ${input.name} does not exist`)
            yield* Console.log(encodeJson(definition))
            return
          }
          if (input._tag === "Auth" && options.authOperations !== undefined) {
            return yield* Effect.scoped(runAuth(input, options.authOperations, options.defaultWorkspace))
          }
          if (
            (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") &&
            options.extensionOperations !== undefined
          ) {
            const extensionOperationsLayer = options.extensionOperations.layer
            yield* Effect.gen(function* () {
              const extensionContext = yield* Layer.build(extensionOperationsLayer).pipe(
                Effect.mapError((error) => unavailable(input, String(error))),
              )
              yield* ExtensionOperations.run(input).pipe(
                Effect.provide(extensionContext),
                Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
              )
            }).pipe(Effect.scoped)
            return
          }
          if (
            (input._tag === "Config" ||
              input._tag === "Doctor" ||
              (input._tag === "Mcp" && input.action === "doctor")) &&
            options.configOperations !== undefined
          ) {
            const workspaceConfig =
              options.configOperations.forWorkspace === undefined
                ? options.configOperations
                : yield* options.configOperations
                    .forWorkspace(input.clientWorkspace ?? options.defaultWorkspace)
                    .pipe(Effect.mapError((error) => unavailable(input, String(error))))
            yield* Effect.gen(function* () {
              const configContext = yield* Layer.build(workspaceConfig.layer)
              yield* ConfigOperations.run(input, workspaceConfig.options).pipe(Effect.provide(configContext))
            }).pipe(
              Effect.scoped,
              Effect.mapError((error) => unavailable(input, String(error))),
            )
            return
          }
          if (input._tag === "Workflow") {
            const program = Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              if (input.action === "start") {
                yield* backend.registerWorkflows()
                yield* Console.log(
                  encodeJson(
                    yield* backend.startWorkflow(
                      input.name,
                      input.runId,
                      input.revision,
                      undefined,
                      input.clientWorkspace,
                    ),
                  ),
                )
                return
              }
              const inspection =
                input.action === "inspect"
                  ? yield* backend.inspectWorkflow(input.runId, undefined, input.clientWorkspace)
                  : yield* backend.cancelWorkflow(input.runId, undefined, input.clientWorkspace)
              if (inspection === undefined) return yield* operationError(`Workflow run ${input.runId} does not exist`)
              yield* Console.log(encodeJson(inspection))
            })
            yield* program.pipe(
              Effect.provide(Context.make(ExecutionBackend.Service, acquiredBackend)),
              Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
            )
            return
          }
          if (input._tag !== "Thread") return yield* unavailable(input)
          const program = Effect.gen(function* () {
            const repository = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const now = yield* Clock.currentTimeMillis
            switch (input.action) {
              case "new": {
                const id = yield* options.makeThreadId
                const thread = yield* repository.create({
                  id,
                  workspace: input.clientWorkspace ?? options.defaultWorkspace,
                  title: "New thread",
                  now,
                })
                yield* notifyThreadSummaries
                yield* writeThread(thread)
                return
              }
              case "list": {
                const threads = yield* repository.list({
                  ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                })
                yield* Console.log(encodeJson(threads))
                return
              }
              case "search": {
                const candidates = yield* repository.list({
                  ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
                  limit: 100,
                })
                const terms = input.query.map((term: string) => term.toLowerCase())
                const matches = candidates
                  .filter((thread) => {
                    const fields = [thread.id, thread.title, thread.workspace, ...thread.labels].map((field) =>
                      field.toLowerCase(),
                    )
                    return terms.every((term: string) => fields.some((field) => field.includes(term)))
                  })
                  .slice(0, Math.min(Math.max(input.limit ?? 50, 1), 100))
                yield* Console.log(encodeJson(matches))
                return
              }
              case "last":
              case "top": {
                const thread = (yield* repository.list({ limit: 1 }))[0]
                if (thread === undefined) return yield* operationError("No threads exist")
                yield* writeThread(thread)
                return
              }
              case "continue": {
                yield* Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  let selected: Thread.Thread | ReadonlyArray<Thread.Thread>
                  if ("last" in input) {
                    const thread = (yield* repository.list({ limit: 1 }))[0]
                    if (thread === undefined) return yield* operationError("No threads exist")
                    selected = thread
                  } else {
                    selected = yield* Effect.forEach(input.threadIds as ReadonlyArray<string>, (id) =>
                      requireThread(repository, id),
                    )
                  }
                  const selectedThreads = Array.isArray(selected) ? selected : [selected]
                  const continued = yield* Effect.forEach(selectedThreads, (thread) =>
                    Effect.gen(function* () {
                      const threadTurns = yield* turns.list(thread.id)
                      const history = yield* Effect.forEach(threadTurns, (turn) =>
                        backend
                          .replay(turn.id)
                          .pipe(Effect.map((result) => ({ turn, status: result.status, events: result.events }))),
                      )
                      return { ...thread, turns: history }
                    }),
                  )
                  yield* Console.log(encodeJson(Array.isArray(selected) ? continued : continued[0]))
                }).pipe(Effect.provide(Context.make(ExecutionBackend.Service, acquiredBackend)), Effect.scoped)
                return
              }
              case "rename":
                yield* repository
                  .rename(Thread.ThreadId.make(input.threadId), clampThreadTitle(input.title) || "New thread", now)
                  .pipe(Effect.flatMap(writeThread))
                yield* notifyThreadSummaries
                return
              case "label":
                yield* repository
                  .label(Thread.ThreadId.make(input.threadId), input.labels, now)
                  .pipe(Effect.flatMap(writeThread))
                yield* notifyThreadSummaries
                return
              case "pin":
                yield* repository
                  .setPinned(Thread.ThreadId.make(input.threadId), true, now)
                  .pipe(Effect.flatMap(writeThread))
                yield* notifyThreadSummaries
                return
              case "archive":
                yield* repository
                  .setArchived(Thread.ThreadId.make(input.threadId), true, now)
                  .pipe(Effect.flatMap(writeThread))
                yield* notifyThreadSummaries
                return
              case "unarchive":
                yield* repository
                  .setArchived(Thread.ThreadId.make(input.threadId), false, now)
                  .pipe(Effect.flatMap(writeThread))
                yield* notifyThreadSummaries
                return
              case "delete":
                yield* repository.remove(Thread.ThreadId.make(input.threadId))
                yield* notifyThreadSummaries
                return
              case "export": {
                const thread = yield* requireThread(repository, input.threadId)
                const threadTurns = yield* turns.list(thread.id)
                yield* Console.log(
                  input.format === "json"
                    ? encodeJson({ thread, turns: threadTurns })
                    : markdownExport(thread, threadTurns),
                )
                return
              }
              case "usage": {
                const thread = yield* requireThread(repository, input.threadId)
                const threadTurns = yield* turns.list(thread.id)
                const usage = yield* usageRepository.readThread(String(thread.id))
                const statusNames: ReadonlyArray<Turn.Status> = [
                  "accepted",
                  "queued",
                  "running",
                  "waiting",
                  "completed",
                  "failed",
                  "cancelled",
                ]
                const statuses = Object.fromEntries(
                  statusNames.map((status) => [status, threadTurns.filter((turn) => turn.status === status).length]),
                )
                yield* Console.log(
                  encodeJson({
                    threadId: thread.id,
                    turns: threadTurns.length,
                    statuses,
                    costUsd: usage.costNanoUsd === undefined ? null : usage.costNanoUsd / 1_000_000_000,
                    tokens: usage.tokens ?? null,
                    activeMillis: usage.activeMillis ?? null,
                    attempts: {
                      priced: usage.pricedAttempts,
                      unpriced: usage.unpricedAttempts,
                      counted: usage.countedAttempts,
                      uncounted: usage.uncountedAttempts,
                    },
                    sourceComplete: usage.sourceComplete,
                    projectionVersion: UsageRepository.projectionVersion,
                  }),
                )
                return
              }
              case "fork": {
                return yield* turnMutationAdmission.withPermits(1)(
                  Effect.gen(function* () {
                    const source = yield* requireThread(repository, input.threadId)
                    const sourceTurns = yield* turns.list(source.id)
                    const boundary =
                      input.atTurn === undefined
                        ? sourceTurns.length - 1
                        : sourceTurns.findIndex((turn) => turn.id === input.atTurn)
                    if (boundary < 0 && input.atTurn !== undefined)
                      return yield* operationError(`Turn ${input.atTurn} does not exist in thread ${input.threadId}`)
                    const copiedSourceTurns = sourceTurns.slice(0, boundary + 1)
                    const runningShell = copiedSourceTurns.find(Turn.isRunningRecordedShell)
                    if (runningShell !== undefined)
                      return yield* operationError(
                        `Cannot fork thread ${input.threadId} while recorded shell turn ${runningShell.id} is running`,
                      )
                    const forkId = yield* options.makeThreadId
                    const queuedCopies = copiedSourceTurns.filter((turn) => turn.status === "queued").length
                    if (queuedCopies > pendingTurnCapacity)
                      return yield* TurnRepository.QueueFull.make({
                        threadId: forkId,
                        capacity: pendingTurnCapacity,
                        count: queuedCopies,
                      })
                    let forkCreated = false
                    return yield* Effect.gen(function* () {
                      const fork = yield* repository.create({
                        id: forkId,
                        workspace: source.workspace,
                        title: source.title,
                        now,
                      })
                      forkCreated = true
                      yield* repository.setArchived(fork.id, true, now)
                      if (source.labels.length > 0) yield* repository.label(fork.id, source.labels, now)
                      const summaries = yield* ThreadSummaryRepository.Service
                      const transcripts = yield* TranscriptRepository.Service
                      for (const sourceTurn of copiedSourceTurns) {
                        const id = yield* options.makeTurnId
                        if (Turn.isRecordedShell(sourceTurn)) {
                          if (!Turn.isTerminalRecordedShell(sourceTurn))
                            return yield* operationError(`Cannot fork running recorded shell turn ${sourceTurn.id}`)
                          const copied = yield* transcripts.copyRecordedShell(
                            { ...sourceTurn, id, threadId: fork.id },
                            ExecutionIngest.projectionVersion,
                          )
                          yield* summaries.ensureTurn(copied.turn.id, copied.turn.threadId, copied.turn.updatedAt)
                          continue
                        }
                        const copied = yield* turns.copy({ ...sourceTurn, id, threadId: fork.id }, pendingTurnCapacity)
                        const execution = yield* acquiredBackend.inspect(sourceTurn.id)
                        if (execution === undefined)
                          yield* summaries.ensureTurn(copied.id, copied.threadId, copied.updatedAt)
                        else {
                          const replayed = yield* acquiredBackend.replay(sourceTurn.id)
                          yield* summaries.replaceTurn(
                            ThreadActivity.projectionInput(
                              fork.id,
                              { ...replayed, turnId: copied.id },
                              yield* Clock.currentTimeMillis,
                            ),
                          )
                        }
                      }
                      const published = yield* repository.setArchived(fork.id, false, now)
                      yield* notifyThreadSummaries
                      yield* writeThread(published)
                    }).pipe(
                      Effect.onError(() =>
                        forkCreated
                          ? repository.remove(forkId).pipe(
                              Effect.catch((error) =>
                                Effect.logError("thread.fork.cleanup.failed").pipe(
                                  Effect.annotateLogs({
                                    "rika.thread.id": String(forkId),
                                    "rika.failure.kind": String(error),
                                  }),
                                ),
                              ),
                            )
                          : Effect.void,
                      ),
                    )
                  }),
                )
              }
            }
          })
          yield* program.pipe(
            Effect.provide(dependencyContext),
            Effect.mapError((error) => unavailable(input, String(error))),
          )
        }),
      })
    }),
  )
export const testLayer = (calls: Ref.Ref<ReadonlyArray<Input>>) =>
  Layer.succeed(
    Service,
    Service.of({
      run: Effect.fn("ProductOperation.test.run")(function* (input) {
        yield* Ref.update(calls, (current) => [...current, input])
      }),
    }),
  )
