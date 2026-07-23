import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import * as ProductAgent from "./product-agent"
import { ExecutionExtensions } from "@rika/extensions"
import { ConfigService } from "@rika/config"
import * as ExtensionOperations from "./extension-operations"
import * as OpenAiAuth from "./openai-auth"
import { Catalog as ToolCatalog, Runtime as ToolRuntime } from "@rika/tools"
import {
  Cause,
  Clock,
  Console,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Function,
  Layer,
  PubSub,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Scope,
} from "effect"
import * as FileMentions from "./file-mentions"
import * as ContextMentions from "./context-mentions"
import * as ConfigOperations from "./config-operations"
import * as ResolvedContext from "./resolved-context"
import * as ThreadActivity from "./thread-activity"
import * as InteractiveFeedOverflow from "./interactive-feed-overflow"
import * as UsageCost from "./usage-cost"
import {
  Input,
  InteractiveEventSchema,
  InvalidInput,
  OperationUnavailable,
  Service,
  unavailableLayer,
} from "./operation-contract"
import type {
  Interface,
  InteractiveCommand,
  InteractiveEvent,
  InteractiveSession,
  QueueChange,
  QueueItem,
} from "./operation-contract"

export { Input, InteractiveEventSchema, InvalidInput, OperationUnavailable, Service, unavailableLayer }
export type { Interface, InteractiveCommand, InteractiveEvent, InteractiveSession, QueueChange, QueueItem }

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

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const isAgentResponseEvent = (event: ExecutionBackend.Event): boolean =>
  event.type.includes("reasoning") ||
  event.type === "model.output.delta" ||
  event.type === "model.output.completed" ||
  event.type === "model.toolcall.delta" ||
  event.type === "tool.call.requested" ||
  event.type === "tool.approval.requested" ||
  event.type === "permission.ask.requested" ||
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

const temporaryThreadTitle = (prompt: string) => [...prompt].slice(0, 80).join("") || "New thread"

const titleExecutionId = (turnId: Turn.TurnId) => `title:${turnId}`

const sanitizeThreadTitle = (text: string) =>
  [
    ...(text.split(/\r?\n/, 1)[0] ?? "")
      .replace(/\p{C}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'#\s]+/, "")
      .replace(/["'\s]+$/, ""),
  ]
    .slice(0, 80)
    .join("")
    .trimEnd()

const withSelectionEpoch = (event: InteractiveEvent, selectionEpoch: number): InteractiveEvent => {
  switch (event._tag) {
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPatched":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "QueueFull":
    case "TurnStarted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "ExecutionControlled":
      return { ...event, selectionEpoch }
    default:
      return event
  }
}

class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  message: Schema.String,
}) {}

const operationError = (message: string) => OperationError.make({ message })
const operationFailureDetail = (error: unknown) =>
  Schema.is(OperationError)(error) ||
  Schema.is(OperationUnavailable)(error) ||
  Schema.is(TurnRepository.QueuedTurnUnavailable)(error)
    ? error.message
    : operationFailureMessage
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const untrustedData = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")

export interface ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
> {
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadError>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnError>
  readonly threadSummaryRepositoryLayer?: Layer.Layer<ThreadSummaryRepository.Service, ThreadSummaryError>
  readonly transcriptRepositoryLayer?: Layer.Layer<TranscriptRepository.Service, TranscriptError>
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly resolveExecutionRoute?: (
    mode: "low" | "medium" | "high" | "ultra",
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<Turn.ExecutionRoutePin, OperationError, ExecutionBackend.Service>
  readonly productAgentLayer?: Layer.Layer<ProductAgent.Service, OperationError, ExecutionBackend.Service>
  readonly toolRuntimeLayer?: (workspace: string) => Layer.Layer<ToolRuntime.Service, OperationError, never>
  readonly resolvedContextLayer?: Layer.Layer<ResolvedContext.Service, OperationError>
  readonly executionExtensions?: {
    readonly layer: Layer.Layer<ExecutionExtensions.Service, OperationError>
    readonly mcpFingerprint: Effect.Effect<string>
  }
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity?: number
  readonly shellPermission?: "ask" | "allow" | "deny" | ((workspace: string) => Effect.Effect<"ask" | "allow" | "deny">)
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly configOperations?: {
    readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigService.Service, OperationError>
    readonly options: ConfigOperations.Options
    readonly forWorkspace?: (workspace: string) => Effect.Effect<
      {
        readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigService.Service, OperationError>
        readonly options: ConfigOperations.Options
      },
      OperationError
    >
  }
  readonly extensionOperations?: {
    readonly layer: Layer.Layer<
      | ExtensionOperations.Service
      | import("@rika/extensions").McpOAuth.Service
      | import("effect").FileSystem.FileSystem
      | import("effect").Path.Path
      | import("effect").Crypto.Crypto
      | import("@rika/extensions").SkillRegistry.SkillFileSystem,
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

export const runAuth = Effect.fn("Operation.runAuth")(function* (
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

const reconcileInternal = Effect.fn("Operation.reconcile")(function* (
  extensions?: ExecutionExtensions.Interface,
  prepare?: (
    turn: Turn.Turn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    TurnRepository.Service | ThreadRepository.Service | ResolvedContext.Service | ExecutionExtensions.Service
  >,
  watchReviewOwner?: (
    turn: Turn.Turn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
  ownership?: {
    readonly claim: (
      turn: Pick<Turn.Turn, "id" | "status">,
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
  const skipRepair = (turn: Turn.Turn) =>
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
                    if (inspection.state === "joining") status = "running"
                    else if (inspection.state === "satisfied") status = "completed"
                    else status = inspection.state
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
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  if (inspection === undefined) {
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
                    const result = yield* backend.start({
                      threadId: turn.threadId,
                      turnId: turn.id,
                      prompt: prepared.prompt,
                      ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                      startedAt: turn.updatedAt,
                      executionRoute: turn.executionRoute,
                      ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                    })
                    yield* turns.setStatus(
                      turn.id,
                      result.status,
                      ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
                      now,
                    )
                    return
                  }
                  yield* turns.setStatus(turn.id, inspection.status, inspection.lastCursor ?? turn.lastCursor, now)
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                  return yield* error
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
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
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
                startedAt: promotedTurn.updatedAt,
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
            ThreadActivity.latestCursor(result.events),
            yield* Clock.currentTimeMillis,
          )
          if (!isTerminalStatus(result.status) || result.status === "failed") return
        }
      }),
    { discard: true },
  )
})

export const reconcile = Effect.fn("Operation.reconcilePublic")(function* (
  extensions?: ExecutionExtensions.Interface,
  prepare?: (
    turn: Turn.Turn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    TurnRepository.Service | ThreadRepository.Service | ResolvedContext.Service | ExecutionExtensions.Service
  >,
  watchReviewOwner?: (
    turn: Turn.Turn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
): Effect.fn.Return<
  void,
  OperationError,
  | ExecutionBackend.Service
  | TurnRepository.Service
  | ThreadRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
> {
  return yield* reconcileInternal(extensions, prepare, watchReviewOwner).pipe(
    Effect.mapError((error) => operationError(String(error))),
  )
})

const normalizeChildExecutionId = (executionId: string): string => executionId.replace(/^execution:/, "")

const displayGlobalCostUsd = (totals: UsageCost.Snapshot): number | undefined =>
  totals.complete ? totals.globalCostUsd : undefined

const transcriptPatch = (turn: Turn.Turn, event: ExecutionBackend.Event): InteractiveEvent => {
  const executionId = event.executionId ?? event.data?.execution_id
  const turnId =
    typeof executionId === "string" && executionId.length > 0
      ? Turn.TurnId.make(normalizeChildExecutionId(executionId))
      : turn.id
  return {
    _tag: "TranscriptPatched",
    selectionEpoch: 0,
    threadId: turn.threadId,
    turnId,
    ...(turnId === turn.id ||
    (event.type !== "model.usage.reported" &&
      event.type !== "model.attempt.completed" &&
      event.type !== "child_run.spawned")
      ? {}
      : { rootTurnId: turn.id }),
    event,
    revision: event.sequence,
  }
}

const sourceProjection = (projection: TranscriptRepository.Projection): Transcript.Projection => ({
  units: projection.units,
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.oldestCursor === undefined ? {} : { oldestCursor: projection.oldestCursor }),
  ...(projection.checkpointCursor === undefined ? {} : { checkpointCursor: projection.checkpointCursor }),
  ...(projection.costUsd === undefined ? {} : { costUsd: projection.costUsd }),
  ...(projection.usageCursors === undefined ? {} : { usageCursors: projection.usageCursors }),
  ...(projection.pricingVersion === undefined ? {} : { pricingVersion: projection.pricingVersion }),
})

export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event>
  (events: ReadonlyArray<ExecutionBackend.Event>): (turnId: string) => ReadonlyArray<ExecutionBackend.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
    events.filter(
      (event) =>
        !event.cursor.startsWith("child:") &&
        (!event.cursor.startsWith("execution:") || event.cursor.startsWith(`execution:${turnId}:`)),
    ),
)

const rootCheckpointCursor = (turnId: string, cursor: string | undefined): string | undefined =>
  cursor === undefined ||
  cursor.startsWith("child:") ||
  (cursor.startsWith("execution:") && !cursor.startsWith(`execution:${turnId}:`))
    ? undefined
    : cursor

const toolForChild = (projection: Transcript.Projection, childExecutionId: string) =>
  Transcript.childParentMatch(
    projection.units.flatMap((unit) =>
      unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
        ? [
            {
              id: unit.content.block.id,
              scope: unit.turnId,
              childId: unit.content.block.childId,
              family: unit.content.block.presentation.family,
              tool: unit.content.block,
            },
          ]
        : [],
    ),
    childExecutionId,
  )?.tool

const realChildUnit = (unit: Transcript.Unit): boolean =>
  unit.content._tag === "Block" || (unit.content._tag === "Entry" && unit.content.text.length > 0)

const storedChildUnits = (projection: Transcript.Projection): ReadonlyMap<string, ReadonlyArray<Transcript.Unit>> => {
  const groups = new Map<string, Array<Transcript.Unit>>()
  for (const unit of projection.units) {
    if (unit.parentId === undefined) continue
    const key = normalizeChildExecutionId(unit.turnId)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [unit])
    else group.push(unit)
  }
  return groups
}

const recordedChildIds = (projection: Transcript.Projection): ReadonlySet<string> => {
  const ids = new Set<string>()
  for (const unit of projection.units) {
    if (unit.parentId !== undefined || unit.content._tag !== "Block") continue
    const block = unit.content.block
    if (block._tag === "ToolCall" && block.childId !== undefined) ids.add(normalizeChildExecutionId(block.childId))
    else if (block._tag === "ChildAgent") ids.add(normalizeChildExecutionId(block.id))
  }
  return ids
}

const hasChildrenAwaitingBackfill = (projection: Transcript.Projection): boolean => {
  const stored = storedChildUnits(projection)
  return [...recordedChildIds(projection)].some((childId) => !(stored.get(childId) ?? []).some(realChildUnit))
}

const replayChildTranscript = Effect.fn("Operation.replayChildTranscript")(function* (
  backend: ExecutionBackend.Interface,
  executionId: string,
) {
  const turnId = normalizeChildExecutionId(executionId)
  if (backend.pageEvents === undefined) {
    const result = yield* backend.replay(executionId, undefined, ExecutionBackend.executionReference)
    return Transcript.project(turnId, "", result.events)
  }
  let projection = Transcript.empty(turnId, "")
  let after: string | undefined
  const cursors = new Set<string>()
  while (true) {
    const page = yield* backend.pageEvents(executionId, "forward", after, 200, ExecutionBackend.executionReference)
    for (const event of page.events.toSorted((left, right) => left.sequence - right.sequence))
      projection = Transcript.applyEvent(projection, event)
    if (!page.hasMore) return projection
    const next = page.newestCursor
    if (next === undefined || cursors.has(next)) return projection
    cursors.add(next)
    after = next
  }
})

const settledChildStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
): "complete" | "failed" | "cancelled" | undefined => {
  if (status === "completed") return "complete"
  if (status === "failed") return "failed"
  if (status === "cancelled") return "cancelled"
  return undefined
}

const storedChildProjection = (units: ReadonlyArray<Transcript.Unit>): Transcript.Projection => ({
  units,
  revision: units.reduce((latest, unit) => Math.max(latest, unit.revision), -1),
  modelPhase: 0,
})

const withoutSynthesizedTwins = (
  projection: Transcript.Projection,
  parents: ReadonlyMap<string, string>,
): Transcript.Projection => ({
  ...projection,
  units: projection.units.filter((unit) => {
    if (unit.parentId !== undefined || unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
      return true
    const block = unit.content.block
    if (block.childId === undefined) return true
    const childKey = normalizeChildExecutionId(block.childId)
    const parent = parents.get(childKey)
    return block.id !== childKey || parent === undefined || parent === block.id
  }),
})

const backfillChildTranscripts = Effect.fn("Operation.backfillChildTranscripts")(function* (
  backend: ExecutionBackend.Interface,
  rootExecutionId: string,
  root: Transcript.Projection,
) {
  const stored = storedChildUnits(root)
  const nested: Array<Transcript.NestedProjection> = []
  const parents = new Map<string, string>()
  let rootProjection = root
  const pending: Array<{
    readonly executionId: string
    readonly nestedIndex: number | undefined
    readonly reference: boolean
  }> = [{ executionId: rootExecutionId, nestedIndex: undefined, reference: false }]
  const seen = new Set([normalizeChildExecutionId(rootExecutionId)])
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(
      current.executionId,
      current.reference ? ExecutionBackend.executionReference : undefined,
    )
    if (inspection === undefined) continue
    const parentProjection = () =>
      current.nestedIndex === undefined ? rootProjection : nested[current.nestedIndex]!.projection
    const settleParent = (projection: Transcript.Projection) => {
      if (current.nestedIndex === undefined) rootProjection = projection
      else nested[current.nestedIndex] = { ...nested[current.nestedIndex]!, projection }
    }
    for (const child of inspection.children) {
      const childKey = normalizeChildExecutionId(child.executionId)
      if (seen.has(childKey)) continue
      seen.add(childKey)
      const replayed = yield* replayChildTranscript(backend, child.executionId)
      if (replayed.revision < 0)
        yield* Effect.logWarning("execution.child.replay_empty").pipe(
          Effect.annotateLogs({
            "rika.execution.parent": current.executionId,
            "rika.execution.child": child.executionId,
          }),
        )
      const storedUnits = stored.get(childKey) ?? []
      const storedTranscript = storedUnits.some(realChildUnit) ? storedChildProjection(storedUnits) : undefined
      let projection: Transcript.Projection | undefined = replayed
      if (replayed.revision < 0) projection = undefined
      if (storedTranscript !== undefined && storedTranscript.revision > replayed.revision) projection = storedTranscript
      if (projection === undefined) continue
      let parent = toolForChild(parentProjection(), child.executionId)
      if (parent === undefined) {
        const ensured = Transcript.ensureChildTool(parentProjection(), child.executionId, "task")
        settleParent(ensured.projection)
        parent = ensured.tool
        yield* Effect.logWarning("execution.child.parent_synthesized").pipe(
          Effect.annotateLogs({
            "rika.execution.parent": current.executionId,
            "rika.execution.child": child.executionId,
          }),
        )
      }
      const settled = settledChildStatus(child.status)
      if (settled !== undefined)
        settleParent(
          Transcript.settleChild(parentProjection(), child.executionId, settled, parentProjection().revision),
        )
      parents.set(childKey, parent.id)
      nested.push({ parentId: parent.id, projection })
      pending.push({ executionId: child.executionId, nestedIndex: nested.length - 1, reference: true })
    }
  }
  for (const [childKey, units] of stored) {
    if (parents.has(childKey) || !units.some(realChildUnit)) continue
    const parentId = units[0]!.parentId
    if (parentId === undefined) continue
    parents.set(childKey, parentId)
    nested.push({ parentId, projection: storedChildProjection(units) })
  }
  if (nested.length === 0) return rootProjection
  return Transcript.withNestedProjections(withoutSynthesizedTwins(rootProjection, parents), nested)
})

const activeDescendantExecutionIds = Effect.fn("Operation.activeDescendantExecutionIds")(function* (
  backend: ExecutionBackend.Interface,
  rootExecutionId: string,
) {
  const pending: Array<{ readonly executionId: string; readonly reference: boolean }> = [
    { executionId: rootExecutionId, reference: false },
  ]
  const seen = new Set([normalizeChildExecutionId(rootExecutionId)])
  const active: Array<string> = []
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(
      current.executionId,
      current.reference ? ExecutionBackend.executionReference : undefined,
    )
    if (inspection === undefined) continue
    for (const child of inspection.children) {
      const normalized = normalizeChildExecutionId(child.executionId)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      pending.push({ executionId: child.executionId, reference: true })
      if (!isTerminalStatus(child.status)) active.push(child.executionId)
    }
  }
  return active
})

const sessionQuiescencePollAttempts = 40
const sessionQuiescenceCandidateLimit = 8

const executionTreeQuiescent = Effect.fn("Operation.executionTreeQuiescent")(function* (
  backend: ExecutionBackend.Interface,
  turnId: string,
) {
  const root = yield* backend.inspect(turnId)
  if (root === undefined) return true
  if (!isTerminalStatus(root.status) || root.pendingTools.length > 0) return false
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
    if (!isTerminalStatus(inspection.status) || inspection.pendingTools.length > 0) return false
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

const blockedSessionWriter = Effect.fn("Operation.blockedSessionWriter")(function* (
  backend: ExecutionBackend.Interface,
  threadId: Thread.ThreadId,
) {
  const turns = yield* TurnRepository.Service
  const history = yield* turns.list(threadId)
  const candidates = history
    .filter((turn) => turn.status === "cancelled" || turn.status === "failed")
    .slice(-sessionQuiescenceCandidateLimit)
    .toReversed()
  for (const candidate of candidates) {
    const quiescent = yield* executionTreeQuiescent(backend, candidate.id).pipe(Effect.orElseSucceed(() => false))
    if (!quiescent) return candidate
  }
  return undefined
})

const cancelLiveDescendants = Effect.fn("Operation.cancelLiveDescendants")(function* (
  backend: ExecutionBackend.Interface,
  turnId: string,
) {
  const descendants = yield* activeDescendantExecutionIds(backend, turnId).pipe(Effect.orElseSucceed(() => []))
  if (descendants.length === 0) return
  const cancelledAt = yield* Clock.currentTimeMillis
  yield* Effect.forEach(
    descendants.toReversed(),
    (executionId) => backend.cancel(executionId, cancelledAt, ExecutionBackend.executionReference).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  )
})

const awaitSessionQuiescence = Effect.fn("Operation.awaitSessionQuiescence")(function* (
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
  yield* cancelLiveDescendants(backend, blocked.id)
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

const sessionOwnershipMarker = "is owned by execution"

const sessionOwnershipRejected = (failure: unknown): boolean => {
  if (failure === undefined || failure === null) return false
  if (typeof failure === "object" && "message" in failure) {
    const message = (failure as { readonly message: unknown }).message
    if (typeof message === "string" && message.includes(sessionOwnershipMarker)) return true
  }
  return String(failure).includes(sessionOwnershipMarker)
}

const backfillTranscriptTree = Effect.fn("Operation.backfillTranscriptTree")(function* (
  turn: Turn.Turn,
  force: boolean,
) {
  const transcripts = yield* TranscriptRepository.Service
  const current = yield* transcripts.get(turn.id)
  if (current === undefined) return
  const root = sourceProjection(current)
  if (!force && !hasChildrenAwaitingBackfill(root)) return
  const backend = yield* ExecutionBackend.Service
  const tree = yield* backfillChildTranscripts(backend, turn.id, root)
  if (tree === root) return
  yield* transcripts.replace(turn, tree)
})

const childExecutionId = (event: ExecutionBackend.Event): string | undefined => {
  if (event.type !== "child_run.spawned") return undefined
  const member = event.data?.member
  const nested =
    member !== null && typeof member === "object" ? (member as Readonly<Record<string, unknown>>) : undefined
  const value = nested?.child_execution_id ?? event.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const childTranscriptPatch = (
  threadId: Thread.ThreadId,
  executionId: string,
  rootTurnId: Turn.TurnId,
  event: ExecutionBackend.Event,
): InteractiveEvent => ({
  _tag: "TranscriptPatched",
  selectionEpoch: 0,
  threadId,
  turnId: Turn.TurnId.make(normalizeChildExecutionId(executionId)),
  ...(event.type === "model.usage.reported" ||
  event.type === "model.attempt.completed" ||
  event.type === "child_run.spawned"
    ? { rootTurnId }
    : {}),
  event,
  revision: event.sequence,
})

const queueItem = (turn: Turn.Turn): QueueItem => {
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

const requireThread = Effect.fn("Operation.requireThread")(function* (
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

export const productLayer = <ThreadError, TurnError, BackendError, ThreadSummaryError = never, TranscriptError = never>(
  options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
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
      let interactiveSessionSequence = 0
      let activitySequence = 0
      const interactiveSinks = new Map<number, (origin: number, event: InteractiveEvent) => void>()
      const turnObserverAdmission = yield* Semaphore.make(1)
      const observedTurns = new Set<string>()
      const claimTurnObserver = (turnId: Turn.TurnId, expectedStatus?: Turn.Status) =>
        turnObserverAdmission.withPermits(1)(
          Effect.gen(function* () {
            const key = String(turnId)
            if (observedTurns.has(key)) return false
            if (expectedStatus !== undefined) {
              const turns = yield* TurnRepository.Service
              const current = yield* turns.get(turnId)
              if (current?.status !== expectedStatus) return false
            }
            observedTurns.add(key)
            return true
          }),
        )
      const releaseTurnObserver = (turnId: Turn.TurnId) =>
        turnObserverAdmission.withPermits(1)(Effect.sync(() => observedTurns.delete(String(turnId))))
      const createObservedSubmission = (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) =>
        Effect.gen(function* () {
          const turn = yield* turns.createForSubmission(input)
          if (turn.status === "queued") return { turn, claimed: false }
          const key = String(turn.id)
          if (observedTurns.has(key)) return { turn, claimed: false }
          observedTurns.add(key)
          return { turn, claimed: true }
        }).pipe(turnObserverAdmission.withPermits(1), turnMutationAdmission.withPermits(1))
      const claimQueuedTurn = (threadId: Thread.ThreadId, now: number) =>
        turnObserverAdmission.withPermits(1)(
          Effect.gen(function* () {
            const turns = yield* TurnRepository.Service
            const promoted = yield* turns.claimNextQueued(threadId, now)
            if (promoted === undefined) return undefined
            const key = String(promoted.turn.id)
            if (observedTurns.has(key)) {
              yield* turns.releaseQueuedClaim(promoted)
              return undefined
            }
            observedTurns.add(key)
            return promoted
          }),
        )
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
      const dependencies = Layer.mergeAll(
        repositories,
        threadSummaryRepositoryLayer,
        options.transcriptRepositoryLayer ?? TranscriptRepository.memoryLayer,
        resolvedContextLayer,
        ...(options.executionExtensions === undefined ? [] : [options.executionExtensions.layer]),
      )
      const dependencyContext = yield* Layer.buildWithScope(dependencies, ownerScope)
      const acquiredDependencies = Layer.succeedContext(dependencyContext)
      const acquiredBackend = Context.get(
        yield* Layer.buildWithScope(options.backendLayer, ownerScope),
        ExecutionBackend.Service,
      )
      const backendLayer = Layer.succeed(ExecutionBackend.Service, acquiredBackend)
      const extensionService =
        options.executionExtensions === undefined
          ? undefined
          : Context.get(dependencyContext, ExecutionExtensions.Service)
      const executionDependencies = Context.merge(
        dependencyContext,
        Context.make(ExecutionBackend.Service, acquiredBackend),
      )
      yield* Effect.provide(
        Context.get(dependencyContext, TurnRepository.Service).resetQueueClaims,
        executionDependencies,
      )
      const readUsageCosts = Effect.fn("Operation.readUsageCosts")(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const roots = (yield* Effect.forEach(
          yield* threads.list({ includeArchived: true, limit: UsageCost.maximumGlobalThreads }),
          (thread) =>
            turns.list(thread.id).pipe(
              Effect.map((values) => {
                const threadRoots: Array<UsageCost.RootExecution> = values.map((turn) => ({
                  threadId: String(thread.id),
                  turnId: String(turn.id),
                }))
                const first = values[0]
                if (first?.executionRoute.title !== undefined)
                  threadRoots.push({
                    threadId: String(thread.id),
                    turnId: String(first.id),
                    executionId: titleExecutionId(first.id),
                    optional: true,
                  })
                return threadRoots
              }),
            ),
        )).flat()
        return { roots, snapshot: yield* UsageCost.collect(acquiredBackend, roots) }
      })
      const usageCostAdmission = yield* Semaphore.make(1)
      let usageSnapshot: UsageCost.Snapshot = { ...UsageCost.empty, complete: false, collectionComplete: false }
      let usageCostsLoaded = false
      const deletedUsageThreads = new Set<string>()
      const pendingUsageEvents: Array<UsageCost.RootExecution & { readonly event: ExecutionBackend.Event }> = []
      const currentUsageCosts = (): UsageCost.Snapshot => usageSnapshot
      const observeUsage = (input: UsageCost.RootExecution & { readonly event: ExecutionBackend.Event }) => {
        if (deletedUsageThreads.has(input.threadId)) return usageSnapshot
        if (!usageCostsLoaded) pendingUsageEvents.push(input)
        usageSnapshot = UsageCost.observe(usageSnapshot, input)
        return usageSnapshot
      }
      const loadUsageCosts = usageCostAdmission.withPermits(1)(
        Effect.suspend(() => {
          if (usageCostsLoaded) return Effect.void
          return readUsageCosts().pipe(
            Effect.provide(executionDependencies),
            Effect.tap(({ roots, snapshot }) =>
              Effect.sync(() => {
                usageSnapshot = pendingUsageEvents.reduce(UsageCost.observe, snapshot)
                pendingUsageEvents.length = 0
                usageCostsLoaded = true
                if (!usageSnapshot.complete) return
                const threadByTurn = new Map(roots.map((root) => [root.turnId, root.threadId]))
                for (const [turnId, turnCostUsd] of usageSnapshot.turnCostUsd) {
                  const threadId = threadByTurn.get(turnId)
                  if (threadId === undefined) continue
                  publishInteractiveActivity(0, {
                    _tag: "TitleCostUpdated",
                    threadId: Thread.ThreadId.make(threadId),
                    turnId: Turn.TurnId.make(turnId),
                    turnCostUsd,
                    threadCostUsd: usageSnapshot.threadCostUsd.get(threadId)!,
                    globalCostUsd: usageSnapshot.globalCostUsd,
                  })
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("usage-cost.read.failed").pipe(
                Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
              ),
            ),
            Effect.asVoid,
          )
        }),
      )
      let usageCostLoadStarted = false
      const startUsageCostLoad = Effect.suspend(() => {
        if (usageCostLoadStarted) return Effect.void
        usageCostLoadStarted = true
        return Effect.forkIn(
          Effect.sleep("1 second").pipe(
            Effect.andThen(loadUsageCosts),
            Effect.ensuring(Effect.sync(() => (usageCostLoadStarted = usageCostsLoaded))),
          ),
          ownerScope,
        ).pipe(Effect.asVoid)
      })
      const notifyThreadSummaries = Effect.gen(function* () {
        const summaries = yield* ThreadSummaryRepository.Service
        publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
      })
      const settledTitleExecutions = new Set<string>()
      const titleThread = Effect.fn("Operation.titleThread")(function* (
        thread: Thread.Thread,
        firstTurn: Turn.Turn,
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
          const inspection = yield* backend.inspect(executionId)
          if (inspection?.status === "failed" || inspection?.status === "cancelled") {
            settledTitleExecutions.add(executionId)
            return
          }
          const titleExecutionRoute = {
            ...firstTurn.executionRoute,
            main: { ...firstTurn.executionRoute.title, role: "main" as const },
          }
          let result
          if (inspection === undefined) {
            result = yield* backend.start({
              threadId: thread.id,
              turnId: executionId,
              prompt: `Generate a concise 3-6 word title for a conversation that starts with the following user message. Reply with only the title, no quotes, no punctuation.\n\n${firstTurn.prompt.slice(0, 2000)}`,
              startedAt: firstTurn.updatedAt,
              executionRoute: titleExecutionRoute,
              sessionPurpose: { _tag: "ThreadTitle", owningTurnId: String(firstTurn.id) },
            })
          } else if (isTerminalStatus(inspection.status)) {
            result = yield* backend.replay(executionId)
          } else if (backend.follow !== undefined) {
            result = yield* backend.follow(executionId, undefined)
          }
          if (result === undefined) return
          const previousGlobalCostUsd = currentUsageCosts().globalCostUsd
          for (const event of result.events)
            observeUsage({
              threadId: String(thread.id),
              turnId: String(firstTurn.id),
              event,
            })
          const totals = currentUsageCosts()
          if (totals.complete && totals.globalCostUsd !== previousGlobalCostUsd)
            announce({
              _tag: "TitleCostUpdated",
              threadId: thread.id,
              turnId: firstTurn.id,
              turnCostUsd: totals.turnCostUsd.get(firstTurn.id) ?? 0,
              threadCostUsd: totals.threadCostUsd.get(thread.id)!,
              globalCostUsd: totals.globalCostUsd,
            })
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
        yield* program.pipe(Effect.orElseSucceed(() => undefined))
      })
      const notifyTurnChanged = (_turn: Pick<Turn.Turn, "id" | "threadId">) =>
        PubSub.publish(turnChanges, undefined).pipe(Effect.asVoid)
      const dispatchThreadSummaries = Effect.fn("Operation.dispatchThreadSummaries")(function* (
        dispatch: (event: InteractiveEvent) => void,
      ) {
        const summaries = yield* ThreadSummaryRepository.Service
        dispatch({ _tag: "ThreadsListed", threads: yield* summaries.list() })
      })
      const ensureTurnSummary = Effect.fn("Operation.ensureTurnSummary")(function* (turn: Turn.Turn) {
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.ensureTurn(turn.id, turn.threadId, turn.updatedAt)
        yield* notifyThreadSummaries
        yield* notifyTurnChanged(turn)
      })
      const projectExecutionResult = Effect.fn("Operation.projectExecutionResult")(function* (
        threadId: Thread.ThreadId,
        result: ExecutionBackend.Result,
      ) {
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.replaceTurn(ThreadActivity.projectionInput(threadId, result, yield* Clock.currentTimeMillis))
        yield* notifyThreadSummaries
      })
      const setTurnStatus = Effect.fn("Operation.setTurnStatus")(function* (
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
      const repairThreadSummaries = Effect.fn("Operation.repairThreadSummaries")(function* () {
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
                    ThreadActivity.latestCursor(result.events) ?? candidate.lastCursor,
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
      const settleReviewOwner = Effect.fn("Operation.settleReviewOwner")(function* (
        turn: Pick<Turn.Turn, "id" | "lastCursor">,
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
          inspection.state === "satisfied" ? "completed" : inspection.state,
          turn.lastCursor,
          yield* Clock.currentTimeMillis,
        )
        return inspection
      })
      const startReviewSettlement = Effect.fn("Operation.startReviewSettlement")(function* (
        turn: Pick<Turn.Turn, "id" | "lastCursor">,
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
      const testRoute = (mode: "low" | "medium" | "high" | "ultra") => Effect.succeed(Turn.testExecutionRoute(mode))
      const resolveExecutionRoute = options.resolveExecutionRoute ?? testRoute
      const executionPrompt = Effect.fn("Operation.executionPrompt")(function* (workspace: string, prompt: string) {
        const context = yield* ResolvedContext.Service
        const threads = yield* ThreadRepository.Service
        const structured = ContextMentions.parse(prompt)
        const bareMentions = [...new Set(FileMentions.parse(prompt))].filter(
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
      const prepareExecution = Effect.fn("Operation.prepareExecution")(function* (
        turn: Turn.Turn,
        workspace: string,
        persistExtensionPin: boolean = true,
      ) {
        const resolved = yield* executionPrompt(workspace, turn.prompt)
        let promptParts = turn.promptParts
        if (promptParts !== undefined && resolved.prompt !== turn.prompt) {
          promptParts = [...promptParts, { type: "text" as const, text: resolved.prompt.slice(turn.prompt.length) }]
        }
        if (options.executionExtensions === undefined)
          return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
        const extensions = yield* ExecutionExtensions.Service
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
      const makeInteractiveSession = Effect.fn("Operation.makeInteractiveSession")(function* (
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
        const bufferSelectionEvent = (event: InteractiveEvent) => {
          if (InteractiveFeedOverflow.isCritical(event)) return false
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
        let observeChildSpawn = ignoreInteractiveEvent
        const withUsageCosts = (event: InteractiveEvent): InteractiveEvent => {
          if (
            event._tag !== "TranscriptPatched" ||
            (event.event.type !== "model.usage.reported" && event.event.type !== "model.attempt.completed")
          )
            return event
          const rootTurnId = event.rootTurnId ?? event.turnId
          observeUsage({
            threadId: String(event.threadId),
            turnId: String(rootTurnId),
            event: event.event,
          })
          const totals = currentUsageCosts()
          if (!totals.complete) return { ...event, rootTurnId }
          return {
            ...event,
            rootTurnId,
            ...(totals.turnCostUsd.has(rootTurnId) ? { rootTurnCostUsd: totals.turnCostUsd.get(rootTurnId)! } : {}),
            ...(totals.threadCostUsd.has(event.threadId)
              ? { threadCostUsd: totals.threadCostUsd.get(event.threadId)! }
              : {}),
            globalCostUsd: totals.globalCostUsd,
          }
        }
        const deliver = (
          event: InteractiveEvent,
          deliveryOptions?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
        ) => {
          const selectedEvent = withSelectionEpoch(
            withUsageCosts(event),
            deliveryOptions?.selectionRequest ?? currentSelectionEpoch,
          )
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
          if (Queue.offerUnsafe(sessionEvents, envelope)) {
            observeChildSpawn(selectedEvent)
            return true
          }
          overflow = InteractiveFeedOverflow.make()
          InteractiveFeedOverflow.remember(overflow, selectedEvent)
          return false
        }
        const sessionDispatch = (event: InteractiveEvent) => {
          if (!bufferSelectionEvent(event)) deliver(event)
        }
        const dispatchFailure = (dispatch: (event: InteractiveEvent) => void, error: unknown) =>
          Schema.is(TurnRepository.QueueFull)(error)
            ? dispatch({
                _tag: "QueueFull",
                selectionEpoch: 0,
                threadId: error.threadId,
                capacity: error.capacity,
                count: error.count,
              })
            : dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: operationFailureDetail(error) })
        const selectionDispatch = (request: number) => (event: InteractiveEvent) => {
          deliver(event, { selectionRequest: request })
        }
        const finishSelection = (epoch: number) =>
          Effect.gen(function* () {
            const loading = selectionLoad
            if (loading === undefined || loading.epoch !== epoch) return
            selectionLoad = undefined
            if (!loading.committed) {
              const restored = yield* Ref.modify(selectionRequest, (current) =>
                current === epoch ? [true, loading.previousEpoch] : [false, current],
              )
              if (!restored) return
              selectedThreadId = loading.previousThreadId
              currentSelectionEpoch = loading.previousEpoch
              return
            }
            if (loading.overflow === undefined) {
              for (const event of loading.events) deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
              return
            }
            const threadId = Thread.ThreadId.make(loading.threadId)
            if (loading.overflow.transcriptThreadIds.size > 0)
              deliver(
                {
                  _tag: "TranscriptResyncRequired",
                  selectionEpoch: epoch,
                  threadId,
                  reason: "Selection activity exceeded its bounded live window",
                },
                { selectionRequest: epoch, selectedThreadOnly: true },
              )
            if (loading.overflow.queueThreadIds.size > 0)
              deliver(
                {
                  _tag: "QueueResyncRequired",
                  selectionEpoch: epoch,
                  threadId,
                  reason: "Selection queue activity exceeded its bounded live window",
                },
                { selectionRequest: epoch, selectedThreadOnly: true },
              )
          })
        const emit = (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => {
          dispatch(event)
          publishInteractiveActivity(sessionId, event)
        }
        const requeueOwnedSession = Effect.fn("Operation.interactive.requeueOwnedSession")(function* (
          running: Turn.Turn,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const now = yield* Clock.currentTimeMillis
          const retryId = yield* options.makeTurnId
          const requeued = yield* turns
            .copy(
              {
                id: retryId,
                threadId: running.threadId,
                prompt: running.prompt,
                ...(running.promptParts === undefined ? {} : { promptParts: running.promptParts }),
                status: "queued",
                executionRoute: running.executionRoute,
                ...(running.reviewFanOutId === undefined ? {} : { reviewFanOutId: running.reviewFanOutId }),
                createdAt: now,
                updatedAt: now,
              },
              pendingTurnCapacity,
            )
            .pipe(
              Effect.map((submission) => submission.queue),
              Effect.orElseSucceed(() => undefined),
            )
          if (requeued === undefined) return false
          yield* setTurnStatus(running.id, "cancelled", running.lastCursor, now)
          emit(dispatch, queueMutationEvent(requeued))
          return true
        })
        const submissionAdmission = yield* Semaphore.make(1)
        const shellPermission =
          typeof options.shellPermission === "function"
            ? yield* options.shellPermission(workspace)
            : (options.shellPermission ?? "allow")
        let shellPermissionAlways = shellPermission === "allow"
        const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
        const selectionRequest = yield* Ref.make(0)
        const transcriptCursor = yield* Ref.make<TranscriptRepository.PageCursor | undefined>(undefined)
        const projectedTurnCursor = yield* Ref.make<TurnRepository.PageCursor | undefined>(undefined)
        const transcriptHasUnprojectedTurns = yield* Ref.make(false)
        const transcriptHasOlder = yield* Ref.make(false)
        const projectionAdmission = yield* Semaphore.make(1)
        const backfillTree = (turn: Turn.Turn, force: boolean) =>
          projectionAdmission.withPermits(1)(backfillTranscriptTree(turn, force))
        const appendProjection = (turn: Turn.Turn, events: ReadonlyArray<ExecutionBackend.Event>) =>
          projectionAdmission.withPermits(1)(
            Effect.gen(function* () {
              const transcripts = yield* TranscriptRepository.Service
              yield* transcripts.appendAll(turn, rootExecutionEvents(turn.id, events))
            }),
          )
        const flushProjection = Effect.void
        const shellApprovals = new Map<string, Deferred.Deferred<boolean>>()
        const lifecycleAdmission = yield* Semaphore.make(1)
        const closed = yield* Deferred.make<void>()
        const sessionScope = yield* Scope.make()
        type ChildFollowerSelection = {
          readonly generation: number
          readonly threadId: string | undefined
          readonly stopped: Deferred.Deferred<void>
        }
        type ChildFollowerJob = {
          readonly key: string
          readonly executionId: string
          readonly threadId: Thread.ThreadId
          readonly rootTurnId: Turn.TurnId
          readonly selection: ChildFollowerSelection
        }
        type ChildFollowerState =
          | { readonly _tag: "Idle"; readonly afterCursor?: string }
          | {
              readonly _tag: "Following"
              readonly selection: ChildFollowerSelection
              readonly afterCursor?: string
            }
          | {
              readonly _tag: "Waiting"
              readonly executionId: string
              readonly threadId: Thread.ThreadId
              readonly rootTurnId: Turn.TurnId
              readonly afterCursor?: string
            }
          | { readonly _tag: "Terminal"; readonly afterCursor?: string }
        const childFollowerJobs = yield* Queue.bounded<ChildFollowerJob>(512)
        const childFollowerStates = new Map<string, ChildFollowerState>()
        const deliveredChildCursors = new Map<string, Set<string>>()
        let childFollowerSelection: ChildFollowerSelection = {
          generation: 0,
          threadId: settings.initialThreadId,
          stopped: yield* Deferred.make<void>(),
        }
        const activateChildFollowers = Effect.fn("Operation.interactive.activateChildFollowers")(function* (
          threadId: Thread.ThreadId,
        ) {
          const previous = childFollowerSelection
          for (const [key, state] of childFollowerStates)
            if (state._tag === "Following" && state.selection === previous)
              childFollowerStates.set(
                key,
                state.afterCursor === undefined ? { _tag: "Idle" } : { _tag: "Idle", afterCursor: state.afterCursor },
              )
          childFollowerSelection = {
            generation: previous.generation + 1,
            threadId: String(threadId),
            stopped: yield* Deferred.make<void>(),
          }
          yield* Deferred.succeed(previous.stopped, undefined)
          yield* Queue.clear(childFollowerJobs)
        })
        const enqueueChildFollower = (
          threadId: Thread.ThreadId,
          executionId: string,
          rootTurnId: Turn.TurnId,
          status?: ExecutionBackend.Status,
        ) => {
          const key = normalizeChildExecutionId(executionId)
          const selection = childFollowerSelection
          if (selection.threadId !== String(threadId)) return
          const current = childFollowerStates.get(key) ?? { _tag: "Idle" as const }
          if (current._tag === "Terminal") return
          if (isTerminalStatus(status ?? "running") && current.afterCursor === undefined) {
            childFollowerStates.set(
              key,
              current.afterCursor === undefined
                ? { _tag: "Terminal" }
                : { _tag: "Terminal", afterCursor: current.afterCursor },
            )
            return
          }
          if (
            (current._tag === "Waiting" && (status === undefined || status === "waiting")) ||
            (current._tag === "Following" && current.selection === selection)
          )
            return
          const following: ChildFollowerState =
            current.afterCursor === undefined
              ? { _tag: "Following", selection }
              : { _tag: "Following", selection, afterCursor: current.afterCursor }
          childFollowerStates.set(key, following)
          if (
            !Queue.offerUnsafe(childFollowerJobs, {
              key,
              executionId,
              threadId,
              rootTurnId,
              selection,
            })
          )
            childFollowerStates.set(
              key,
              following.afterCursor === undefined
                ? { _tag: "Idle" }
                : { _tag: "Idle", afterCursor: following.afterCursor },
            )
        }
        const resumeWaitingChildFollowers = (threadId: Thread.ThreadId) => {
          for (const [key, state] of childFollowerStates) {
            if (state._tag !== "Waiting" || state.threadId !== threadId) continue
            childFollowerStates.set(
              key,
              state.afterCursor === undefined ? { _tag: "Idle" } : { _tag: "Idle", afterCursor: state.afterCursor },
            )
            enqueueChildFollower(state.threadId, state.executionId, state.rootTurnId)
          }
        }
        const deliverChildEvent = (
          threadId: Thread.ThreadId,
          executionId: string,
          rootTurnId: Turn.TurnId,
          event: ExecutionBackend.Event,
          publishUsage: boolean,
        ) => {
          const key = normalizeChildExecutionId(executionId)
          const delivered = deliveredChildCursors.get(key) ?? new Set<string>()
          if (delivered.has(event.cursor)) return
          delivered.add(event.cursor)
          deliveredChildCursors.set(key, delivered)
          const state = childFollowerStates.get(key)
          if (state !== undefined)
            childFollowerStates.set(
              key,
              event.type === "execution.completed" ||
                event.type === "execution.failed" ||
                event.type === "execution.cancelled"
                ? { _tag: "Terminal", afterCursor: event.cursor }
                : { ...state, afterCursor: event.cursor },
            )
          const patch = childTranscriptPatch(threadId, executionId, rootTurnId, event)
          sessionDispatch(patch)
          if (publishUsage && (event.type === "model.usage.reported" || event.type === "model.attempt.completed"))
            publishInteractiveActivity(sessionId, patch)
        }
        observeChildSpawn = (event) => {
          if (event._tag !== "TranscriptPatched") return
          const executionId = childExecutionId(event.event)
          if (executionId !== undefined)
            enqueueChildFollower(event.threadId, executionId, event.rootTurnId ?? event.turnId)
        }
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
        let shellPermissionSequence = 0
        const submit = Effect.fn("Operation.interactive.submit")(function* (
          prompt: string,
          dispatch: (event: InteractiveEvent) => void,
          mode: "low" | "medium" | "high" | "ultra" = "medium",
          promptParts?: ReadonlyArray<Turn.PromptPart>,
          modelTuning?: { readonly fastMode?: boolean },
          submissionId?: string,
        ) {
          let observerTurn: Turn.Turn | undefined
          let executionLaunched = false
          const program = Effect.gen(function* () {
            yield* startUsageCostLoad
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
              yield* Ref.set(interactiveThread, thread)
              selectedThreadId = String(thread.id)
              yield* activateChildFollowers(thread.id)
            }
            if (isNewThread) dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
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
                      const result = yield* backend.start({
                        threadId: thread.id,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                        startedAt,
                        executionRoute: turn.executionRoute,
                        ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
                        eventScope: "execution",
                        onEvent: (event) => {
                          deliveredCursors.add(event.cursor)
                          emit(dispatch, transcriptPatch(turn, event))
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
                        yield* flushProjection
                        const failedAt = yield* Clock.currentTimeMillis
                        if (sessionOwnershipRejected(outcome.cause) && (yield* requeueOwnedSession(turn, dispatch))) {
                          yield* Effect.logInfo("execution.admission.rejected").pipe(
                            Effect.annotateLogs({
                              "rika.thread.id": String(thread.id),
                              "rika.turn.id": String(turn.id),
                            }),
                          )
                          yield* settleThread(thread, dispatch)
                          return
                        }
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
                      for (const event of result.events)
                        if (!deliveredCursors.has(event.cursor)) emit(dispatch, transcriptPatch(turn, event))
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
                        ThreadActivity.latestCursor(result.events),
                        completedAt,
                      )
                      yield* projectExecutionResult(thread.id, result)
                      yield* appendProjection(updatedTurn, result.events)
                      yield* backfillTree(updatedTurn, true)
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
                    Effect.logError("interactive.submit.failed").pipe(
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
                Effect.logError("interactive.submit.failed").pipe(
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
            | ExecutionExtensions.Service
          >,
        ) =>
          effect.pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
          )
        const followChildExecution = Effect.fn("Operation.interactive.followChildExecution")(function* (
          job: ChildFollowerJob,
        ) {
          const follow = acquiredBackend.follow
          if (follow === undefined) return
          while (true) {
            const state = childFollowerStates.get(job.key)
            if (state?._tag !== "Following" || state.selection !== job.selection) return
            const deliverEvent = (event: ExecutionBackend.Event) => {
              if (childFollowerSelection !== job.selection) return
              deliverChildEvent(job.threadId, job.executionId, job.rootTurnId, event, true)
            }
            const result = yield* Effect.raceFirst(
              follow(
                job.executionId,
                state.afterCursor,
                deliverEvent,
                ExecutionBackend.executionReference,
                "execution",
              ),
              Deferred.await(job.selection.stopped).pipe(Effect.as(undefined)),
            )
            if (result === undefined || childFollowerSelection !== job.selection) {
              const current = childFollowerStates.get(job.key)
              if (current?._tag === "Following" && current.selection === job.selection)
                childFollowerStates.set(
                  job.key,
                  current.afterCursor === undefined
                    ? { _tag: "Idle" }
                    : { _tag: "Idle", afterCursor: current.afterCursor },
                )
              return
            }
            for (const event of result.events) deliverEvent(event)
            const current = childFollowerStates.get(job.key)
            if (current?._tag !== "Following" || current.selection !== job.selection) return
            if (isTerminalStatus(result.status)) {
              childFollowerStates.set(
                job.key,
                current.afterCursor === undefined
                  ? { _tag: "Terminal" }
                  : { _tag: "Terminal", afterCursor: current.afterCursor },
              )
              return
            }
            if (result.status === "waiting") {
              childFollowerStates.set(job.key, {
                _tag: "Waiting",
                executionId: job.executionId,
                threadId: job.threadId,
                rootTurnId: job.rootTurnId,
                ...(current.afterCursor === undefined ? {} : { afterCursor: current.afterCursor }),
              })
              return
            }
            const nextCursor = ThreadActivity.latestCursor(result.events)
            if (nextCursor === undefined || nextCursor === state.afterCursor) {
              childFollowerStates.set(
                job.key,
                current.afterCursor === undefined
                  ? { _tag: "Idle" }
                  : { _tag: "Idle", afterCursor: current.afterCursor },
              )
              return
            }
          }
        })
        const runChildFollower = Effect.forever(
          Queue.take(childFollowerJobs).pipe(
            Effect.flatMap((job) =>
              childFollowerSelection === job.selection
                ? followChildExecution(job).pipe(
                    Effect.catch((error) =>
                      (String(error).includes("ExecutionNotFound")
                        ? Effect.logInfo("child-execution.absent")
                        : Effect.logError("child-execution.follow.failed").pipe(
                            Effect.annotateLogs("rika.failure.kind", String(error)),
                          )
                      ).pipe(
                        Effect.annotateLogs({
                          "rika.execution.id": job.executionId,
                          "rika.thread.id": String(job.threadId),
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        )
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.forkIn(runChildFollower, sessionScope), {
          discard: true,
        })
        const readQueue = Effect.fn("Operation.interactive.readQueue")(function* (
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
        const drainQueued = Effect.fn("Operation.interactive.drainQueued")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          let claimed = 0
          const runPromoted = Effect.fn("Operation.interactive.runPromoted")(function* (
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
              const result = yield* backend.start({
                threadId: thread.id,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                startedAt: promotedAt,
                executionRoute,
                eventScope: "execution",
                onEvent: (event) => {
                  deliveredCursors.add(event.cursor)
                  emit(dispatch, transcriptPatch(promotedTurn, event))
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
              if (
                sessionOwnershipRejected(outcome.error) &&
                current?.status === "running" &&
                (yield* requeueOwnedSession(current, dispatch))
              ) {
                yield* Effect.logInfo("execution.admission.rejected").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(promotedTurn.id),
                  }),
                )
                yield* flushProjection
                const wake = yield* turns.requestQueueWake(thread.id)
                if (wake !== undefined && backend.wakeThreadHost !== undefined)
                  yield* backend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
                return false
              }
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
              yield* flushProjection
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
            for (const event of result.events)
              if (!deliveredCursors.has(event.cursor)) emit(dispatch, transcriptPatch(promotedTurn, event))
            const updatedTurn = yield* setTurnStatus(
              promotedTurn.id,
              result.status,
              ThreadActivity.latestCursor(result.events),
              yield* Clock.currentTimeMillis,
            )
            yield* projectExecutionResult(thread.id, result)
            yield* appendProjection(updatedTurn, result.events)
            yield* backfillTree(updatedTurn, true)
            return isTerminalStatus(result.status) && result.status !== "failed"
          })
          const runNext = Effect.fn("Operation.interactive.runNextQueued")(function* () {
            return yield* Effect.uninterruptibleMask((restore) =>
              turnObserverAdmission
                .withPermits(1)(
                  Effect.gen(function* () {
                    const promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
                    if (promoted === undefined) return undefined
                    const key = String(promoted.turn.id)
                    if (observedTurns.has(key)) return { _tag: "Collision" as const, claim: promoted }
                    observedTurns.add(key)
                    return { _tag: "Claimed" as const, claim: promoted }
                  }),
                )
                .pipe(
                  Effect.flatMap((claim) => {
                    if (claim === undefined) return Effect.void
                    if (claim._tag === "Collision")
                      return Effect.gen(function* () {
                        yield* turns.releaseQueuedClaim(claim.claim)
                        return false
                      })
                    return restore(runPromoted(claim.claim)).pipe(
                      Effect.ensuring(releaseTurnObserver(claim.claim.turn.id)),
                    )
                  }),
                ),
            )
          })
          while (true) {
            if ((yield* turns.readQueue(thread.id)).queuedCount === 0) break
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
        const promoteThread = Effect.fn("Operation.interactive.promoteThread")(function* (
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
        const settleThread = Effect.fn("Operation.interactive.settleThread")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          yield* promoteThread(thread, dispatch).pipe(
            Effect.catch(() => drainQueued(thread, dispatch).pipe(Effect.asVoid)),
            Effect.orElseSucceed(() => undefined),
          )
        })
        const active = Effect.fn("Operation.interactive.active")(function* () {
          const thread = yield* Ref.get(interactiveThread)
          if (thread === undefined) return yield* operationError("No thread selected")
          const turns = yield* TurnRepository.Service
          const turn = yield* turns.findActive(thread.id)
          if (turn === undefined) return yield* operationError("No active turn")
          return turn
        })
        const threadForTurn = Effect.fn("Operation.interactive.threadForTurn")(function* (turn: Turn.Turn) {
          const thread = yield* (yield* ThreadRepository.Service).get(turn.threadId)
          if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
          return thread
        })
        const followClaimedTurn = Effect.fn("Operation.interactive.followClaimedTurn")(function* (
          turnId: Turn.TurnId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          if (backend.follow === undefined) return
          const follow = backend.follow
          const turn = yield* turns.get(turnId)
          if (turn === undefined) return yield* operationError(`Turn ${turnId} does not exist`)
          const thread = yield* threadForTurn(turn)
          const deliveredCursors = new Set<string>()
          const result = yield* follow(
            turn.id,
            turn.lastCursor,
            (event) => {
              deliveredCursors.add(event.cursor)
              emit(dispatch, transcriptPatch(turn, event))
            },
            undefined,
            "execution",
          )
          for (const event of result.events)
            if (!deliveredCursors.has(event.cursor)) {
              emit(dispatch, transcriptPatch(turn, event))
            }
          const updatedTurn = yield* setTurnStatus(
            turn.id,
            result.status,
            ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          yield* projectExecutionResult(turn.threadId, result)
          yield* appendProjection(updatedTurn, result.events)
          yield* backfillTree(updatedTurn, true)
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
        const followTurn = Effect.fn("Operation.interactive.followTurn")(function* (
          turnId: Turn.TurnId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          return yield* Effect.uninterruptibleMask((restore) =>
            turnObserverAdmission
              .withPermits(1)(
                Effect.gen(function* () {
                  const key = String(turnId)
                  if (observedTurns.has(key)) return undefined
                  const turns = yield* TurnRepository.Service
                  const current = yield* turns.get(turnId)
                  if (current === undefined || current.status === "queued" || isTerminalStatus(current.status))
                    return undefined
                  observedTurns.add(key)
                  return current
                }),
              )
              .pipe(
                Effect.flatMap((current) =>
                  current === undefined
                    ? Effect.succeed(false)
                    : restore(followClaimedTurn(current.id, dispatch)).pipe(
                        Effect.as(true),
                        Effect.ensuring(releaseTurnObserver(current.id)),
                      ),
                ),
              ),
          )
        })
        const observeTurn = Effect.fn("Operation.interactive.observeTurn")(function* (
          turn: Turn.Turn,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const backend = yield* ExecutionBackend.Service
          if ((yield* backend.inspect(turn.id)) === undefined) return false
          return yield* Effect.uninterruptibleMask((restore) =>
            turnObserverAdmission
              .withPermits(1)(
                Effect.gen(function* () {
                  const key = String(turn.id)
                  if (observedTurns.has(key)) return undefined
                  const turns = yield* TurnRepository.Service
                  const current = yield* turns.get(turn.id)
                  if (current === undefined || current.status === "queued" || isTerminalStatus(current.status))
                    return undefined
                  observedTurns.add(key)
                  return current
                }),
              )
              .pipe(
                Effect.flatMap((current) =>
                  current === undefined
                    ? Effect.succeed(false)
                    : restore(followClaimedTurn(current.id, dispatch)).pipe(
                        Effect.as(true),
                        Effect.ensuring(releaseTurnObserver(current.id)),
                      ),
                ),
              ),
          )
        })
        const projectExecutionPages = Effect.fn("Operation.interactive.projectExecutionPages")(function* (
          backend: ExecutionBackend.Interface,
          turn: Turn.Turn,
          status: Turn.Status,
        ) {
          const transcripts = yield* TranscriptRepository.Service
          const current = yield* transcripts.get(turn.id)
          const boundary = rootCheckpointCursor(turn.id, current?.checkpointCursor)
          if (backend.pageEvents === undefined) {
            const result = yield* backend.replay(turn.id, boundary)
            yield* appendProjection({ ...turn, status }, result.events)
            return
          }
          const cursors = new Set<string>()
          let after = boundary
          while (true) {
            const page = yield* backend.pageEvents(turn.id, "forward", after, 200)
            yield* appendProjection({ ...turn, status }, page.events)
            if (!page.hasMore) return
            const next = page.newestCursor
            if (next === undefined || cursors.has(next)) {
              return yield* operationError(`Transcript event cursor did not advance for Turn ${turn.id}`)
            }
            cursors.add(next)
            after = next
          }
        })
        const healedTurns = new Set<string>()
        const healTerminalTurn = Effect.fn("Operation.interactive.healTerminalTurn")(function* (turn: Turn.Turn) {
          if (!isTerminalStatus(turn.status) || healedTurns.has(String(turn.id))) return
          healedTurns.add(String(turn.id))
          const transcripts = yield* TranscriptRepository.Service
          const current = yield* transcripts.get(turn.id)
          if (current === undefined) return
          if (Transcript.hasRunningBlocks(sourceProjection(current))) {
            yield* backfillTree(turn, true)
            const settled = yield* transcripts.get(turn.id)
            if (settled !== undefined) {
              const source = sourceProjection(settled)
              if (Transcript.hasRunningBlocks(source)) {
                const leftover = turn.status === "failed" ? ("failed" as const) : ("cancelled" as const)
                yield* projectionAdmission.withPermits(1)(
                  transcripts.replace(turn, Transcript.settleRunning(source, leftover, source.revision)),
                )
              }
            }
          }
        })
        const projectTurnPage = Effect.fn("Operation.interactive.projectTurnPage")(function* (
          thread: Thread.Thread,
          request: number,
          before?: TurnRepository.PageCursor,
        ) {
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const backend = yield* ExecutionBackend.Service
          const page = yield* turns.page(thread.id, { ...(before === undefined ? {} : { before }), limit: 50 })
          yield* Effect.forEach(
            page.turns,
            (turn) =>
              Effect.gen(function* () {
                const projected = yield* transcripts.get(turn.id)
                if (
                  projected !== undefined &&
                  isTerminalStatus(turn.status) &&
                  projected.checkpointCursor === turn.lastCursor
                ) {
                  yield* backfillTree(turn, false)
                  yield* healTerminalTurn(turn)
                  return
                }
                if (turn.status === "queued") {
                  return
                }
                const execution = yield* backend.inspect(turn.id)
                if (execution === undefined) {
                  if (projected === undefined)
                    yield* projectionAdmission.withPermits(1)(
                      transcripts.replace(turn, Transcript.empty(turn.id, turn.prompt)),
                    )
                  else if (isTerminalStatus(turn.status)) yield* healTerminalTurn(turn)
                  return
                }
                yield* projectExecutionPages(backend, turn, execution.status)
                yield* backfillTree({ ...turn, status: execution.status }, true)
                yield* healTerminalTurn({ ...turn, status: execution.status })
              }),
            { concurrency: 4, discard: true },
          )
          if ((yield* Ref.get(selectionRequest)) !== request) return false
          yield* Ref.set(projectedTurnCursor, page.oldestCursor)
          yield* Ref.set(transcriptHasUnprojectedTurns, page.hasOlder)
          return true
        })
        const loadTranscriptPage = Effect.fn("Operation.interactive.loadTranscriptPage")(function* (
          thread: Thread.Thread,
          request: number,
          dispatch: (event: InteractiveEvent) => void,
          before?: TranscriptRepository.PageCursor,
        ) {
          const loadedAt = yield* Clock.currentTimeMillis
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const backend = yield* ExecutionBackend.Service
          if (before === undefined) {
            if (!(yield* projectTurnPage(thread, request))) return
            while (yield* Ref.get(transcriptHasUnprojectedTurns)) {
              const available = yield* transcripts.page(thread.id, { limit: 200 })
              if (available.entries.length >= 200) break
              const turnBefore = yield* Ref.get(projectedTurnCursor)
              if (turnBefore === undefined || !(yield* projectTurnPage(thread, request, turnBefore))) return
            }
          } else {
            const available = yield* transcripts.page(thread.id, { before, limit: 50 })
            if (!available.hasOlder && (yield* Ref.get(transcriptHasUnprojectedTurns))) {
              const turnBefore = yield* Ref.get(projectedTurnCursor)
              if (turnBefore !== undefined && !(yield* projectTurnPage(thread, request, turnBefore))) return
            }
          }
          if ((yield* Ref.get(selectionRequest)) !== request) return
          const page = yield* transcripts.page(thread.id, { ...(before === undefined ? {} : { before }), limit: 50 })
          const olderPages: Array<typeof page.entries> = []
          let entryCount = page.entries.length
          let oldestCursor = page.oldestCursor
          let storedHasOlder = page.hasOlder
          let initialBoundary = -1
          if (before === undefined) {
            const locateInitialBoundary = () => {
              const loaded = olderPages.toReversed().flat().concat(page.entries)
              const latestAllowed = loaded.length - 200
              return latestAllowed < 0
                ? -1
                : loaded.findLastIndex(
                    (entry, index) => index <= latestAllowed && entry.unit.key === `turn:${entry.turn.id}:user`,
                  )
            }
            initialBoundary = locateInitialBoundary()
            while (storedHasOlder && oldestCursor !== undefined && initialBoundary < 0) {
              const older = yield* transcripts.page(thread.id, {
                before: oldestCursor,
                limit: entryCount < 200 ? Math.min(50, 200 - entryCount) : 50,
              })
              if (older.entries.length === 0) break
              olderPages.push(older.entries)
              entryCount += older.entries.length
              oldestCursor = older.oldestCursor
              storedHasOlder = older.hasOlder
              initialBoundary = locateInitialBoundary()
            }
          }
          const loadedEntries =
            olderPages.length === 0 ? page.entries : olderPages.toReversed().flat().concat(page.entries)
          const storedEntries = initialBoundary <= 0 ? loadedEntries : loadedEntries.slice(initialBoundary)
          if (initialBoundary > 0) {
            const oldest = storedEntries[0]
            if (oldest !== undefined)
              oldestCursor = {
                createdAt: oldest.turn.createdAt,
                turnId: oldest.turn.id,
                sequence: oldest.unit.order.sequence,
                part: oldest.unit.order.part,
                key: oldest.unit.key,
              }
            storedHasOlder = true
          }
          const usageCosts = currentUsageCosts()
          const entries = storedEntries.map((entry) => {
            const costUsd = usageCosts.turnCostUsd.get(entry.turn.id)
            return costUsd === undefined || (costUsd === 0 && entry.projectionCostUsd === undefined)
              ? entry
              : Object.assign({}, entry, { projectionCostUsd: costUsd })
          })
          const hasOlder = storedHasOlder || (yield* Ref.get(transcriptHasUnprojectedTurns))
          const completedAt = yield* Clock.currentTimeMillis
          if ((yield* Ref.get(selectionRequest)) !== request) return
          yield* Ref.set(transcriptCursor, oldestCursor)
          yield* Ref.set(transcriptHasOlder, hasOlder)
          const threadCostUsd = usageCosts.complete ? (usageCosts.threadCostUsd.get(thread.id) ?? 0) : undefined
          const globalCostUsd = displayGlobalCostUsd(usageCosts)
          if (before === undefined) {
            const queue = yield* turns.readQueue(thread.id)
            const activeTurn = yield* turns.findActive(thread.id)
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if ((yield* Ref.get(selectionRequest)) !== request) return
                yield* activateChildFollowers(thread.id)
                yield* Ref.set(interactiveThread, thread)
                selectedThreadId = String(thread.id)
                const loading = selectionLoad
                if (loading !== undefined && loading.epoch === request && loading.threadId === String(thread.id))
                  loading.committed = true
                dispatch({
                  _tag: "SelectionLoaded",
                  selectionEpoch: request,
                  activitySequence,
                  thread,
                  entries,
                  hasOlder,
                  ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
                  ...(globalCostUsd === undefined ? {} : { globalCostUsd }),
                  ...(oldestCursor === undefined ? {} : { oldestCursor }),
                  queueRevision: queue.revision,
                  queuedCount: queue.queuedCount,
                  queue: queue.turns.map(queueItem),
                  ...(activeTurn === undefined ? {} : { activeTurn }),
                })
              }),
            )
            yield* startUsageCostLoad
            if (activeTurn !== undefined) {
              const inspection = yield* backend.inspect(activeTurn.id)
              for (const child of inspection?.children ?? [])
                enqueueChildFollower(thread.id, child.executionId, activeTurn.id, child.status)
            }
          } else
            dispatch({
              _tag: "TranscriptPagePrepended",
              selectionEpoch: request,
              threadId: thread.id,
              entries,
              hasOlder,
              ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
              ...(globalCostUsd === undefined ? {} : { globalCostUsd }),
              ...(oldestCursor === undefined ? {} : { oldestCursor }),
            })
          yield* Effect.logInfo("transcript.page.loaded").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(thread.id),
              "rika.transcript.page.kind": before === undefined ? "initial" : "prepend",
              "rika.transcript.page.units": entries.length,
              "rika.transcript.page.has_older": hasOlder,
              "rika.duration.ms": completedAt - loadedAt,
            }),
          )
        })
        const loadThread = Effect.fn("Operation.interactive.loadThread")(function* (
          thread: Thread.Thread,
          request: number,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          if ((yield* Ref.get(selectionRequest)) !== request) return
          yield* Ref.set(transcriptCursor, undefined)
          yield* Ref.set(projectedTurnCursor, undefined)
          yield* Ref.set(transcriptHasUnprojectedTurns, false)
          yield* Ref.set(transcriptHasOlder, false)
          yield* loadTranscriptPage(thread, request, dispatch)
          if ((yield* Ref.get(selectionRequest)) !== request) return
          const summaries = yield* ThreadSummaryRepository.Service
          yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
          yield* notifyThreadSummaries
        })
        const createAndSelectThread = Effect.fn("Operation.interactive.createAndSelectThread")(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const thread = yield* threads.create({
            id: yield* options.makeThreadId,
            workspace,
            title: "New thread",
            now: yield* Clock.currentTimeMillis,
          })
          const epoch = currentSelectionEpoch + 1
          const queue = yield* turns.readQueue(thread.id)
          yield* activateChildFollowers(thread.id)
          currentSelectionEpoch = epoch
          selectedThreadId = String(thread.id)
          selectionLoad = undefined
          yield* Ref.set(selectionRequest, epoch)
          yield* Ref.set(interactiveThread, thread)
          yield* Ref.set(transcriptCursor, undefined)
          yield* Ref.set(projectedTurnCursor, undefined)
          yield* Ref.set(transcriptHasUnprojectedTurns, false)
          yield* Ref.set(transcriptHasOlder, false)
          sessionDispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
          sessionDispatch({
            _tag: "SelectionLoaded",
            selectionEpoch: epoch,
            activitySequence,
            thread,
            entries: [],
            hasOlder: false,
            ...(currentUsageCosts().complete
              ? { threadCostUsd: 0, globalCostUsd: currentUsageCosts().globalCostUsd }
              : {}),
            queueRevision: queue.revision,
            queuedCount: queue.queuedCount,
            queue: queue.turns.map(queueItem),
          })
          yield* startUsageCostLoad
          yield* notifyThreadSummaries
        })
        const supervise =
          acquiredBackend.follow === undefined
            ? Effect.void
            : Effect.scoped(
                Effect.gen(function* () {
                  const changes = yield* PubSub.subscribe(turnChanges)
                  const turns = yield* TurnRepository.Service
                  const launch = (turn: Turn.Turn) =>
                    Effect.forkChild(
                      observeTurn(turn, () => undefined).pipe(
                        Effect.flatMap((observed) => {
                          if (!observed) return Effect.void
                          return turns
                            .get(turn.id)
                            .pipe(
                              Effect.flatMap((current) =>
                                current !== undefined &&
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
                  const scan = Effect.gen(function* () {
                    for (const turn of yield* turns.listNonterminal) if (turn.status !== "queued") yield* launch(turn)
                  })
                  yield* scan
                  while (true) {
                    yield* PubSub.take(changes)
                    yield* scan
                  }
                }),
              ).pipe(Effect.provide(executionDependencies))
        if (!registerPromoter)
          interactiveSinks.set(sessionId, (_origin, event) => {
            const threadId = interactiveEventThreadId(event)
            if (threadId !== undefined && bufferSelectionEvent(event)) return
            if (
              threadId === undefined ||
              threadId === selectedThreadId ||
              event._tag === "TitleCostUpdated" ||
              (event._tag === "TranscriptPatched" &&
                (event.event.type === "model.usage.reported" || event.event.type === "model.attempt.completed"))
            )
              deliver(event, { selectedThreadOnly: threadId !== undefined && event._tag !== "TitleCostUpdated" })
          })
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
                    yield* Ref.get(selectionRequest),
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
                if (
                  envelope.selectionRequest !== undefined &&
                  envelope.selectionRequest !== (yield* Ref.get(selectionRequest))
                )
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
          shell: (command, incognito) => {
            const dispatch = sessionDispatch
            if (shellPermission === "deny") {
              dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell command denied" })
              return Effect.void
            }
            const toolRuntimeLayer = options.toolRuntimeLayer?.(workspace)
            if (toolRuntimeLayer === undefined) {
              dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell runtime is unavailable" })
              return Effect.void
            }
            const program = Effect.gen(function* () {
              if (!shellPermissionAlways) {
                const permissionId = `shell-permission-${shellPermissionSequence++}`
                const approval = yield* Deferred.make<boolean>()
                shellApprovals.set(permissionId, approval)
                dispatch({ _tag: "ShellPermissionRequested", id: permissionId, command })
                const approved = yield* Effect.raceFirst(
                  Deferred.await(approval),
                  Deferred.await(closed).pipe(Effect.as(false)),
                ).pipe(Effect.ensuring(Effect.sync(() => shellApprovals.delete(permissionId))))
                if (!approved) {
                  dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell command denied" })
                  return
                }
              }
              const tools = yield* ToolRuntime.Service
              const result = yield* tools.run({
                _tag: "Shell",
                command: "sh",
                args: ["-lc", command],
                waitMillis: 120_000,
              })
              const text = result.text
              if (!incognito) {
                const threads = yield* ThreadRepository.Service
                const turns = yield* TurnRepository.Service
                const now = yield* Clock.currentTimeMillis
                let thread = yield* Ref.get(interactiveThread)
                if (thread === undefined) {
                  thread = yield* threads.create({
                    id: yield* options.makeThreadId,
                    workspace,
                    title: `$ ${command}`.slice(0, 80),
                    now,
                  })
                  yield* Ref.set(interactiveThread, thread)
                  selectedThreadId = String(thread.id)
                }
                const turn = yield* createForSubmission(turns, {
                  id: yield* options.makeTurnId,
                  threadId: thread.id,
                  prompt: `$ ${command}\n\n<shell-result>\n${text}\n</shell-result>`,
                  executionRoute: yield* resolveExecutionRoute("medium", undefined, thread.workspace),
                  queueCapacity: pendingTurnCapacity,
                  now,
                })
                yield* ensureTurnSummary(turn)
                if (turn.status === "queued") {
                  if (turn.queue !== undefined) emit(dispatch, queueMutationEvent(turn.queue))
                } else yield* setTurnStatus(turn.id, "completed", undefined, yield* Clock.currentTimeMillis)
              }
              dispatch({ _tag: "ShellCompleted", command, text, incognito })
            })
            return Effect.gen(function* () {
              const toolContext = yield* Layer.build(toolRuntimeLayer)
              yield* program.pipe(
                Effect.provide(Context.merge(executionDependencies, toolContext)),
                Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
              )
            }).pipe(
              Effect.scoped,
              Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
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
                      restore(backend.steer(turn.id, steeringText, yield* Clock.currentTimeMillis)),
                    )
                    if (outcome._tag === "Failure") {
                      const requeued = yield* turns.copy(queued, pendingTurnCapacity)
                      if (requeued.queue === undefined)
                        return yield* operationError(`Turn ${queued.id} was not restored to its queue`)
                      emit(sessionDispatch, queueMutationEvent(requeued.queue))
                      return yield* Effect.failCause(outcome.cause)
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
                const receipt = yield* backend.steer(turn.id, text, yield* Clock.currentTimeMillis)
                emit(sessionDispatch, {
                  _tag: "ExecutionControlled",
                  selectionEpoch: 0,
                  threadId: turn.threadId,
                  turnId: turn.id,
                  action: "steered",
                  steeringSequence: receipt.sequence,
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
                if (turn.status !== "accepted") yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
                yield* setTurnStatus(turn.id, "cancelled", turn.lastCursor, yield* Clock.currentTimeMillis)
                yield* drainQueued(thread, sessionDispatch)
              }),
            ),
          cancel: safe(
            sessionDispatch,
            Effect.gen(function* () {
              const localApprovals = [...shellApprovals.entries()]
              if (localApprovals.length > 0) {
                for (const [id, approval] of localApprovals) {
                  shellApprovals.delete(id)
                  yield* Deferred.succeed(approval, false)
                  sessionDispatch({ _tag: "ShellPermissionCancelled", id })
                }
                sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
                return
              }
              const backend = yield* ExecutionBackend.Service
              const turn = yield* active().pipe(Effect.orElseSucceed(() => undefined))
              if (turn === undefined) {
                sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
                return
              }
              const thread = yield* threadForTurn(turn)
              const cancelledAt = yield* Clock.currentTimeMillis
              const childIds =
                turn.status === "accepted"
                  ? []
                  : yield* activeDescendantExecutionIds(backend, turn.id).pipe(Effect.orElseSucceed(() => []))
              const result =
                turn.status === "accepted"
                  ? { turnId: turn.id, status: "cancelled" as const, events: [] }
                  : yield* backend.cancel(turn.id, cancelledAt)
              const cancellationOrder = childIds.toReversed()
              const childOutcomes = yield* Effect.forEach(
                cancellationOrder,
                (childId) => Effect.result(backend.cancel(childId, cancelledAt, ExecutionBackend.executionReference)),
                { concurrency: "unbounded" },
              )
              for (const [index, outcome] of childOutcomes.entries()) {
                const childId = cancellationOrder[index]!
                if (outcome._tag === "Success") {
                  for (const event of outcome.success.events)
                    deliverChildEvent(thread.id, childId, turn.id, event, false)
                } else
                  yield* Effect.logError("child-execution.cancel.failed").pipe(
                    Effect.annotateLogs({
                      "rika.execution.id": childId,
                      "rika.failure.kind": String(outcome.failure),
                    }),
                  )
              }
              yield* setTurnStatus(
                turn.id,
                result.status,
                ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
                yield* Clock.currentTimeMillis,
              )
              yield* projectExecutionResult(turn.threadId, result)
              if (isTerminalStatus(result.status)) yield* activateChildFollowers(thread.id)
              emit(sessionDispatch, {
                _tag: "ExecutionControlled",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                action: "cancelled",
                agentResponseArrived: agentResponseArrived(result.events),
              })
              if (isTerminalStatus(result.status)) yield* settleThread(thread, sessionDispatch)
            }),
          ),
          resolvePermission: (waitId, kind, decision) =>
            shellApprovals.has(waitId)
              ? Effect.gen(function* () {
                  const approval = shellApprovals.get(waitId)
                  if (decision === "always") shellPermissionAlways = true
                  if (approval !== undefined) yield* Deferred.succeed(approval, decision !== "deny")
                  sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "permission-resolved" })
                })
              : safe(
                  sessionDispatch,
                  Effect.gen(function* () {
                    const backend = yield* ExecutionBackend.Service
                    const activeTurn = yield* active()
                    const resolvedAt = yield* Clock.currentTimeMillis
                    if (kind === "tool-approval")
                      yield* backend.resolveToolApproval(waitId, decision !== "deny", resolvedAt)
                    else {
                      let resolution: "Approved" | "Denied" | "Always"
                      if (decision === "allow") resolution = "Approved"
                      else if (decision === "deny") resolution = "Denied"
                      else resolution = "Always"
                      yield* backend.resolvePermission(waitId, resolution, resolvedAt)
                    }
                    resumeWaitingChildFollowers(activeTurn.threadId)
                    emit(sessionDispatch, {
                      _tag: "ExecutionControlled",
                      selectionEpoch: 0,
                      threadId: activeTurn.threadId,
                      turnId: activeTurn.id,
                      action: "permission-resolved",
                    })
                    yield* followTurn(activeTurn.id, sessionDispatch)
                  }),
                ),
          selectThread: (id, epoch) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                if (epoch <= currentSelectionEpoch) return
                const previousThread = yield* Ref.get(interactiveThread)
                const previousEpoch = currentSelectionEpoch
                currentSelectionEpoch = epoch
                selectedThreadId = id
                const joined = selectionLoad?.epoch === 0 && selectionLoad.threadId === id ? selectionLoad : undefined
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
                const threads = yield* ThreadRepository.Service
                const thread = yield* threads.get(Thread.ThreadId.make(id))
                if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
                yield* loadThread(thread, epoch, selectionDispatch(epoch))
              }).pipe(Effect.ensuring(finishSelection(epoch))),
            ),
          readQueue: (id) =>
            safe(
              sessionDispatch,
              Ref.get(selectionRequest).pipe(
                Effect.flatMap((request) => readQueue(Thread.ThreadId.make(id), selectionDispatch(request))),
              ),
            ),
          loadOlder: safe(
            sessionDispatch,
            Effect.gen(function* () {
              if (!(yield* Ref.get(transcriptHasOlder))) return
              const thread = yield* Ref.get(interactiveThread)
              const before = yield* Ref.get(transcriptCursor)
              if (thread === undefined || before === undefined) return
              const request = yield* Ref.get(selectionRequest)
              yield* loadTranscriptPage(thread, request, selectionDispatch(request), before)
            }),
          ),
          previewThread: (id) =>
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              const backend = yield* ExecutionBackend.Service
              const thread = yield* threads.get(Thread.ThreadId.make(id))
              if (thread === undefined) return
              const history = yield* turns.list(thread.id)
              const recent = history.filter((turn) => turn.status !== "queued").slice(-4)
              const previewTurns = yield* Effect.forEach(recent, (turn) =>
                backend.inspect(turn.id).pipe(
                  Effect.flatMap((execution) =>
                    execution === undefined
                      ? Effect.succeed({ prompt: turn.prompt, events: [] as ReadonlyArray<ExecutionBackend.Event> })
                      : backend
                          .replay(turn.id)
                          .pipe(Effect.map((result) => ({ prompt: turn.prompt, events: result.events }))),
                  ),
                  Effect.orElseSucceed(() => ({
                    prompt: turn.prompt,
                    events: [] as ReadonlyArray<ExecutionBackend.Event>,
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
                if (epoch <= currentSelectionEpoch) return
                const threads = yield* ThreadRepository.Service
                const thread = (yield* threads.list({ limit: 1 }))[0]
                if (thread === undefined || epoch <= currentSelectionEpoch) return
                const previousThread = yield* Ref.get(interactiveThread)
                const previousEpoch = currentSelectionEpoch
                currentSelectionEpoch = epoch
                yield* Ref.set(selectionRequest, epoch)
                selectedThreadId = String(thread.id)
                selectionLoad = {
                  epoch,
                  threadId: String(thread.id),
                  previousEpoch,
                  previousThreadId: previousThread === undefined ? undefined : String(previousThread.id),
                  events: [],
                  committed: false,
                }
                yield* loadThread(thread, epoch, selectionDispatch(epoch))
              }).pipe(Effect.ensuring(finishSelection(epoch))),
            ),
          replay: (id, cursor) =>
            safe(
              sessionDispatch,
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const turnId = Turn.TurnId.make(id)
                const thread = yield* Ref.get(interactiveThread)
                if (thread === undefined) return yield* operationError("No thread selected")
                const result = yield* backend.replay(id, cursor)
                for (const event of result.events)
                  sessionDispatch({
                    _tag: "TranscriptPatched",
                    selectionEpoch: yield* Ref.get(selectionRequest),
                    threadId: thread.id,
                    turnId,
                    event,
                    revision: event.sequence,
                  })
              }),
            ),
        }
        const session: InteractiveSession = {
          events: (dispatch) => attachFeed(implementation.events(dispatch)),
          submit: (prompt, mode, parts, tuning, submissionId) =>
            admit(implementation.submit(prompt, mode, parts, tuning, submissionId)),
          newThread: admitLocal(implementation.newThread),
          shell: (command, incognito) => admitLocal(implementation.shell(command, incognito)),
          editQueued: (turnId, prompt) => admitLocal(implementation.editQueued(turnId, prompt)),
          dequeue: (turnId) => admitLocal(implementation.dequeue(turnId)),
          steerQueued: (turnId, text) => admitLocal(implementation.steerQueued(turnId, text)),
          steer: (text, targetTurnId) => admitLocal(implementation.steer(text, targetTurnId)),
          interruptAndSend: (prompt) => admitLocal(implementation.interruptAndSend(prompt)),
          cancel: admitLocal(implementation.cancel),
          resolvePermission: (waitId, kind, decision) =>
            admitLocal(implementation.resolvePermission(waitId, kind, decision)),
          selectThread: (threadId, epoch) => admitLocal(implementation.selectThread(threadId, epoch)),
          readQueue: (threadId) => admitLocal(implementation.readQueue(threadId)),
          loadOlder: admitLocal(implementation.loadOlder),
          previewThread: (threadId) => admitLocal(implementation.previewThread(threadId)),
          reopenThread: (epoch) => admitLocal(implementation.reopenThread(epoch)),
          replay: (turnId, afterCursor) => admitLocal(implementation.replay(turnId, afterCursor)),
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
              const approvals = [...shellApprovals.values()]
              shellApprovals.clear()
              return Effect.forEach(approvals, (approval) => Deferred.succeed(approval, false), { discard: true }).pipe(
                Effect.andThen(Deferred.succeed(closed, undefined)),
                Effect.andThen(Queue.shutdown(sessionEvents)),
                Effect.andThen(Scope.close(sessionScope, Exit.void)),
              )
            }),
          ),
        }
      })
      const owner = yield* makeInteractiveSession(options.defaultWorkspace, { registerPromoter: true })
      yield* Effect.forkIn(owner.supervise, ownerScope)
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
          if (firstTurn?.status === "completed")
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
      const runScheduledReconcile = Effect.fn("Operation.runScheduledReconcile")(function* (
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
          yield* repairThreadTitles
          const repeat = yield* Ref.modify(reconcileSchedule, (state) => {
            if (!state.running) return [false, state] as const
            return state.rescan
              ? [true, { running: true, rescan: false, completed: state.completed } as const]
              : [false, { running: false } as const]
          })
          if (!repeat) {
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
      return Service.of({
        run: Effect.fn("Operation.product.run")(function* (input) {
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
            if (input.threadId !== undefined) {
              const thread = yield* Context.get(dependencyContext, ThreadRepository.Service)
                .get(Thread.ThreadId.make(input.threadId))
                .pipe(Effect.mapError((error) => unavailable(input, String(error))))
              if (thread === undefined) return yield* unavailable(input, `Thread ${input.threadId} does not exist`)
            }
            const made = yield* makeInteractiveSession(
              input.workspace ?? options.defaultWorkspace,
              input.threadId === undefined ? {} : { initialThreadId: input.threadId },
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
                      title: input.prompt.join(" ").slice(0, 80) || "New thread",
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
              const runTurn = Effect.fn("Operation.runTurn")(function* (
                turn: Turn.Turn,
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
                  const startCompleted = yield* Deferred.make<void>()
                  const started = yield* Effect.forkChild(
                    backend
                      .start({
                        threadId: turn.threadId,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        startedAt,
                        executionRoute: turn.executionRoute,
                        onEvent: (event) => {
                          if (!directDelivery) return
                          receivedDirectEvent = true
                          deliveredCursors.add(event.cursor)
                          publishInteractiveActivity(0, transcriptPatch(turn, event))
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
                  for (const event of result.events)
                    if (!directDelivery || !deliveredCursors.has(event.cursor))
                      publishInteractiveActivity(0, transcriptPatch(turn, event))
                  const updated = yield* setTurnStatus(
                    turn.id,
                    result.status,
                    ThreadActivity.latestCursor(result.events),
                    completedAt,
                  )
                  yield* projectExecutionResult(thread.id, result)
                  yield* (yield* TranscriptRepository.Service).appendAll(
                    updated,
                    rootExecutionEvents(updated.id, result.events),
                  )
                  yield* backfillTranscriptTree(updated, true)
                }
                return result
              })
              const drainRunQueue = Effect.fn("Operation.drainRunQueue")(function* () {
                while (true) {
                  if ((yield* turns.readQueue(thread.id)).queuedCount === 0) return
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
                    if (transition._tag === "Transitioned")
                      publishInteractiveActivity(0, queueMutationEvent(transition.queue))
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
              yield* Console.log(text)
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
                  yield* setTurnStatus(parentTurnId, "running", undefined, now)
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
                  return yield* startReviewSettlement({ id: parentTurnId }, fanOutId, inspection)
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
                const terms = input.query.map((term) => term.toLowerCase())
                const matches = candidates
                  .filter((thread) => {
                    const fields = [thread.id, thread.title, thread.workspace, ...thread.labels].map((field) =>
                      field.toLowerCase(),
                    )
                    return terms.every((term) => fields.some((field) => field.includes(term)))
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
                    selected = yield* Effect.forEach(input.threadIds, (id) => requireThread(repository, id))
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
                  .rename(Thread.ThreadId.make(input.threadId), input.title, now)
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
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* repository.remove(Thread.ThreadId.make(input.threadId))
                    deletedUsageThreads.add(input.threadId)
                    usageSnapshot = { ...UsageCost.empty, complete: false, collectionComplete: false }
                    usageCostsLoaded = false
                    usageCostLoadStarted = false
                    pendingUsageEvents.length = 0
                  }),
                )
                yield* loadUsageCosts
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
                yield* Console.log(encodeJson({ threadId: thread.id, turns: threadTurns.length, statuses }))
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
                      for (const sourceTurn of copiedSourceTurns) {
                        const copied = yield* turns.copy(
                          {
                            ...sourceTurn,
                            id: yield* options.makeTurnId,
                            threadId: fork.id,
                          },
                          pendingTurnCapacity,
                        )
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
      run: Effect.fn("Operation.test.run")(function* (input) {
        yield* Ref.update(calls, (current) => [...current, input])
      }),
    }),
  )
