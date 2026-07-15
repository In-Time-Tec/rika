import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummary from "@rika/persistence/thread-summary"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as ProductAgent from "./product-agent"
import { ExecutionExtensions } from "@rika/extensions"
import { ConfigService } from "@rika/config"
import * as ExtensionOperations from "./extension-operations"
import { Catalog as ToolCatalog, Runtime as ToolRuntime } from "@rika/tools"
import {
  Cause,
  Clock,
  Console,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Runtime,
  Schema,
  Semaphore,
} from "effect"
import * as FileMentions from "./file-mentions"
import * as ContextMentions from "./context-mentions"
import * as ConfigOperations from "./config-operations"
import * as ResolvedContext from "./resolved-context"
import * as ThreadActivity from "./thread-activity"

const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
const ClientWorkspace = { clientWorkspace: Schema.optionalKey(Schema.String) }

const startupDispatch = () => undefined

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const Interactive = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Interactive"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.Boolean),
  ephemeral: Schema.Boolean,
})

const Run = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Run"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  streamJson: Schema.Boolean,
  streamJsonInput: Schema.Boolean,
  streamJsonThinking: Schema.Boolean,
})

const Review = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Review"),
  staged: Schema.Boolean,
  base: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  json: Schema.Boolean,
  paths: Schema.Array(Schema.String),
})

const ThreadNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["new", "last", "top"]),
})
const ThreadContinueLast = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  last: Schema.tag(true),
})
const ThreadContinueIds = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  threadIds: Schema.NonEmptyArray(Schema.String),
})
const ThreadList = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("list"),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadSearch = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("search"),
  query: Schema.NonEmptyArray(Schema.String),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadRename = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("rename"),
  threadId: Schema.String,
  title: Schema.String,
})
const ThreadLabel = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("label"),
  threadId: Schema.String,
  labels: Schema.NonEmptyArray(Schema.String),
})
const ThreadById = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["pin", "archive", "unarchive", "delete", "usage"]),
  threadId: Schema.String,
})
const ThreadFork = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("fork"),
  threadId: Schema.String,
  atTurn: Schema.optionalKey(Schema.String),
})
const ThreadExport = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("export"),
  threadId: Schema.String,
  format: Schema.Literals(["json", "markdown"]),
})

const ConfigNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.Literals(["list", "keymap"]),
})
const ConfigEdit = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.tag("edit"),
  workspace: Schema.Boolean,
})

const McpNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["list", "doctor"]),
})
const McpAddCommand = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
})
const McpAddUrl = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  url: Schema.String,
})
const McpNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["remove", "enable", "disable", "oauth-login", "oauth-logout"]),
  name: Schema.String,
})
const McpApprove = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("approve"),
  name: Schema.String,
  workspace: Schema.optionalKey(Schema.String),
})
const McpOauthStatus = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("oauth-status"),
  name: Schema.optionalKey(Schema.String),
})

const SkillList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Skill"), action: Schema.tag("list") })
const SkillNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.Literals(["inspect", "remove"]),
  name: Schema.String,
})
const SkillAdd = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.tag("add"),
  source: Schema.String,
})

const ToolList = Schema.Struct({
  _tag: Schema.tag("ToolCatalog"),
  action: Schema.tag("list"),
  mode: Schema.optionalKey(Mode),
})
const ToolShow = Schema.Struct({ _tag: Schema.tag("ToolCatalog"), action: Schema.tag("show"), name: Schema.String })

const Extension = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Extension"),
  action: Schema.Literals(["create-skill", "create-plugin", "enable", "disable", "rollback"]),
  name: Schema.String,
})
const ExtensionList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Extension"), action: Schema.tag("list") })

const Doctor = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Doctor") })
const Update = Schema.Struct({ _tag: Schema.tag("Update") })
const WorkflowStart = Schema.Struct({
  _tag: Schema.tag("Workflow"),
  action: Schema.tag("start"),
  name: Schema.Literals(["delivery", "research-synthesis"]),
  runId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
})
const WorkflowInspect = Schema.Struct({
  _tag: Schema.tag("Workflow"),
  action: Schema.tag("inspect"),
  runId: Schema.String,
})

export const Input = Schema.Union([
  Interactive,
  Run,
  Review,
  ThreadNoInput,
  ThreadContinueLast,
  ThreadContinueIds,
  ThreadList,
  ThreadSearch,
  ThreadRename,
  ThreadLabel,
  ThreadById,
  ThreadFork,
  ThreadExport,
  ConfigNoInput,
  ConfigEdit,
  McpNoInput,
  McpAddCommand,
  McpAddUrl,
  McpNamed,
  McpApprove,
  McpOauthStatus,
  SkillList,
  SkillNamed,
  SkillAdd,
  ToolList,
  ToolShow,
  Extension,
  ExtensionList,
  Doctor,
  Update,
  WorkflowStart,
  WorkflowInspect,
])
export type Input = typeof Input.Type

export class OperationUnavailable extends Schema.TaggedErrorClass<OperationUnavailable>()("OperationUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  message: Schema.String,
}) {}

const operationError = (message: string) => OperationError.make({ message })
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, OperationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/operation/Service") {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    run: Effect.fn("Operation.run")(function* (input) {
      return yield* OperationUnavailable.make({
        operation: input._tag,
        message: `${input._tag} is specified but not implemented yet`,
      })
    }),
  }),
)

export interface ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError = never> {
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadError>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnError>
  readonly threadSummaryRepositoryLayer?: Layer.Layer<ThreadSummaryRepository.Service, ThreadSummaryError>
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly resolveExecutionRoute?: (
    mode: "low" | "medium" | "high" | "ultra",
    tuning?: { readonly reasoningEffort?: string; readonly fastMode?: boolean },
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
  readonly shellPermission?: "ask" | "allow" | ((workspace: string) => Effect.Effect<"ask" | "allow">)
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
  readonly interactive?: (
    input: Extract<Input, { readonly _tag: "Interactive" }>,
    session: InteractiveSession,
  ) => Effect.Effect<void, OperationUnavailable>
}

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
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const active = yield* turns.listNonterminal
  yield* Effect.forEach(
    active.filter((turn) => turn.status !== "queued"),
    (turn) => {
      if (turn.reviewFanOutId !== undefined)
        return backend.inspectFanOut(turn.reviewFanOutId).pipe(
          Effect.flatMap((inspection) =>
            Effect.gen(function* () {
              const status =
                inspection === undefined
                  ? "failed"
                  : inspection.state === "joining"
                    ? "running"
                    : inspection.state === "satisfied"
                      ? "completed"
                      : inspection.state
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
      return backend.inspect(turn.id).pipe(
        Effect.flatMap((inspection) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (inspection === undefined) {
              if (turn.executionRoute === undefined) {
                yield* turns.setStatus(turn.id, "failed", turn.lastCursor, now)
                return
              }
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
              yield* turns.setStatus(turn.id, result.status, result.events.at(-1)?.cursor ?? turn.lastCursor, now)
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
    },
    { discard: true },
  )
  const threadIds = [...new Set(active.map((turn) => turn.threadId))]
  if (backend.ensureThreadHost !== undefined && backend.notifyThreadHost !== undefined) {
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* backend.ensureThreadHost!(threadId, now)
          yield* backend.notifyThreadHost!(threadId, undefined, now)
        }),
      { discard: true },
    )
    return
  }
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
        const thread = prepare === undefined ? undefined : yield* (yield* ThreadRepository.Service).get(threadId)
        if (prepare !== undefined && thread === undefined) return
        let promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
        while (promoted !== undefined) {
          const promotedTurn = promoted
          if (promotedTurn.executionRoute === undefined) {
            yield* turns.setStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
            promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
            continue
          }
          const executionRoute = promotedTurn.executionRoute
          const result = yield* Effect.gen(function* () {
            const prepared =
              prepare === undefined
                ? {
                    prompt: promotedTurn.prompt,
                    promptParts: promotedTurn.promptParts,
                    extensionPin: promotedTurn.extensionPin,
                  }
                : yield* prepare(promotedTurn, thread!.workspace)
            return yield* backend.start({
              threadId,
              turnId: promotedTurn.id,
              prompt: prepared.prompt,
              ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
              startedAt: promotedTurn.updatedAt,
              executionRoute,
              ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
            })
          }).pipe(
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
          yield* turns.setStatus(
            promotedTurn.id,
            result.status,
            result.events.at(-1)?.cursor,
            yield* Clock.currentTimeMillis,
          )
          if (!isTerminalStatus(result.status)) return
          promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
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

export type InteractiveEvent =
  | {
      readonly _tag: "ExecutionEventReceived"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly event: ExecutionBackend.Event
    }
  | { readonly _tag: "ThreadsListed"; readonly threads: ReadonlyArray<ThreadSummary.ThreadSummary> }
  | { readonly _tag: "AssistantCompleted"; readonly text: string }
  | {
      readonly _tag: "ExecutionFailed"
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly message: string
    }
  | { readonly _tag: "QueueChanged"; readonly threadId: Thread.ThreadId; readonly turns: ReadonlyArray<Turn.Turn> }
  | { readonly _tag: "TurnStarted"; readonly threadId: Thread.ThreadId; readonly turn: Turn.Turn }
  | { readonly _tag: "ThreadSelected"; readonly thread: Thread.Thread; readonly turns: ReadonlyArray<Turn.Turn> }
  | {
      readonly _tag: "ExecutionReplayed"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly result: ExecutionBackend.Result
    }
  | { readonly _tag: "ShellPermissionRequested"; readonly id: string; readonly command: string }
  | { readonly _tag: "ShellCompleted"; readonly command: string; readonly text: string; readonly incognito: boolean }
  | {
      readonly _tag: "ExecutionControlled"
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steered" | "cancelled" | "permission-resolved"
    }
  | { readonly _tag: "ThreadTitled"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly events: ReadonlyArray<ExecutionBackend.Event> }>
    }

export interface InteractiveSession {
  readonly initialize: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly watchThreads: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly submit: (
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
    mode?: "low" | "medium" | "high" | "ultra",
    promptParts?: ReadonlyArray<Turn.PromptPart>,
    modelTuning?: { readonly reasoningEffort?: string; readonly fastMode?: boolean },
  ) => Effect.Effect<void, never>
  readonly shell: (
    command: string,
    incognito: boolean,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never>
  readonly editQueued: (
    turnId: string,
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never>
  readonly dequeue: (turnId: string, dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly steerQueued: (
    turnId: string,
    text: string,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never>
  readonly steer: (text: string, dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly interruptAndSend: (prompt: string, dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly cancel: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly resolvePermission: (
    waitId: string,
    kind: "permission" | "tool-approval",
    decision: "allow" | "deny" | "always",
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never>
  readonly selectThread: (threadId: string, dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly previewThread: (threadId: string, dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly reopenThread: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly followSelected: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, never>
  readonly replay: (
    turnId: string,
    afterCursor: string | undefined,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never>
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

export const productLayer = <ThreadError, TurnError, BackendError, ThreadSummaryError = never>(
  options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError>,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ownerScope = yield* Effect.scope
      const submissionAdmission = yield* Semaphore.make(1)
      const queueDrain = yield* Semaphore.make(1)
      const reviewSettlementAdmission = yield* Semaphore.make(1)
      const threadSummaryChanges = yield* PubSub.sliding<void>(1)
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
      const notifyThreadSummaries = PubSub.publish(threadSummaryChanges, undefined).pipe(Effect.asVoid)
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
        return turn
      })
      const repairThreadSummaries = Effect.fn("Operation.repairThreadSummaries")(function* () {
        const summaries = yield* ThreadSummaryRepository.Service
        const backend = yield* ExecutionBackend.Service
        const candidates = yield* summaries.listRepairCandidates(100)
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
              yield* projectExecutionResult(candidate.threadId, yield* backend.replay(candidate.turnId))
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
              if (thread === undefined) return `--- thread: ${id} ---\nThread not found`
              const history = yield* turns.list(thread.id)
              return `--- thread: ${id} ---\n${markdownExport(thread, history)}`
            }),
          { concurrency: 1 },
        )
        if (resolved.sources.length === 0 && threadBlocks.length === 0) return { prompt, digest: resolved.digest }
        const block = [
          ...resolved.sources.map((source) => `--- ${source.kind}: ${source.path} ---\n${source.content}`),
          ...threadBlocks,
        ].join("\n\n")
        return { prompt: `${prompt}\n\n<resolved-context>\n${block}\n</resolved-context>`, digest: resolved.digest }
      })
      const prepareExecution = Effect.fn("Operation.prepareExecution")(function* (turn: Turn.Turn, workspace: string) {
        const resolved = yield* executionPrompt(workspace, turn.prompt)
        const promptParts =
          turn.promptParts === undefined
            ? undefined
            : resolved.prompt === turn.prompt
              ? turn.promptParts
              : [...turn.promptParts, { type: "text" as const, text: resolved.prompt.slice(turn.prompt.length) }]
        if (options.executionExtensions === undefined)
          return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin }
        const extensions = yield* ExecutionExtensions.Service
        if (turn.extensionPin !== undefined) {
          yield* extensions.resume(turn.extensionPin)
          return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin }
        }
        const activated = yield* extensions.future(yield* options.executionExtensions.mcpFingerprint, resolved.digest)
        const turns = yield* TurnRepository.Service
        yield* turns.setExtensionPin(turn.id, activated.pin)
        return { prompt: resolved.prompt, promptParts, extensionPin: activated.pin }
      })
      const reconcileExecutions = reconcile(
        extensionService,
        (turn, workspace) =>
          prepareExecution(turn, workspace).pipe(Effect.mapError((error) => operationError(String(error)))),
        (turn, inspection) =>
          startReviewSettlement(turn, inspection.fanOutId, inspection).pipe(
            Effect.asVoid,
            Effect.mapError((error) => operationError(String(error))),
          ),
      ).pipe(Effect.provide(executionDependencies), Effect.scoped)
      const makeInteractiveSession = Effect.fn("Operation.makeInteractiveSession")(function* (workspace: string) {
        const shellPermission =
          typeof options.shellPermission === "function"
            ? yield* options.shellPermission(workspace)
            : (options.shellPermission ?? "allow")
        const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
        const selectionRequest = yield* Ref.make(0)
        const followOwnership = yield* Semaphore.make(1)
        const shellApprovals = new Map<string, Deferred.Deferred<boolean>>()
        let shellPermissionSequence = 0
        const submit = Effect.fn("Operation.interactive.submit")(function* (
          prompt: string,
          dispatch: (event: InteractiveEvent) => void,
          mode: "low" | "medium" | "high" | "ultra" = "medium",
          promptParts?: ReadonlyArray<Turn.PromptPart>,
          modelTuning?: { readonly reasoningEffort?: string; readonly fastMode?: boolean },
        ) {
          const program = Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const backend = yield* ExecutionBackend.Service
            const admitted = yield* submissionAdmission.withPermits(1)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                let thread = yield* Ref.get(interactiveThread)
                const isNewThread = thread === undefined
                if (thread === undefined) {
                  thread = yield* threads.create({
                    id: yield* options.makeThreadId,
                    workspace,
                    title: prompt.slice(0, 80) || "New thread",
                    now,
                  })
                  yield* Ref.set(interactiveThread, thread)
                }
                if (isNewThread) dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
                const turn = yield* turns.createForSubmission({
                  id: yield* options.makeTurnId,
                  threadId: thread.id,
                  prompt,
                  ...(promptParts === undefined ? {} : { promptParts }),
                  executionRoute: yield* resolveExecutionRoute(mode, modelTuning, thread.workspace),
                  now,
                })
                yield* ensureTurnSummary(turn)
                return { thread, isNewThread, turn }
              }),
            )
            const { thread, isNewThread, turn } = admitted
            yield* Effect.logInfo("turn.accepted").pipe(
              Effect.annotateLogs({
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
                "rika.turn.status": turn.status,
              }),
            )
            if (turn.status === "queued") {
              yield* promoteThread(thread, turn.id, dispatch)
              return
            }
            dispatch({ _tag: "TurnStarted", threadId: thread.id, turn })
            const startedAt = yield* Clock.currentTimeMillis
            const deliveredCursors = new Set<string>()
            const outcome = yield* Effect.exit(
              Effect.gen(function* () {
                yield* Effect.logInfo("turn.started")
                const prepared = yield* prepareExecution(turn, thread.workspace)
                yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
                const result = yield* backend.start({
                  threadId: thread.id,
                  turnId: turn.id,
                  prompt: prepared.prompt,
                  ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                  startedAt,
                  executionRoute: turn.executionRoute!,
                  ...(modelTuning?.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: modelTuning.reasoningEffort }),
                  ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
                  onEvent: (event) => {
                    deliveredCursors.add(event.cursor)
                    dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: turn.id, event })
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
            if (outcome._tag === "Failure") {
              const failedAt = yield* Clock.currentTimeMillis
              yield* Effect.logError("turn.failed").pipe(
                Effect.annotateLogs({
                  "rika.duration.ms": failedAt - startedAt,
                  "rika.failure.kind": failureKind(outcome.cause),
                  "rika.thread.id": String(thread.id),
                  "rika.turn.id": String(turn.id),
                }),
              )
              yield* setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
              dispatch({
                _tag: "ExecutionFailed",
                threadId: thread.id,
                turnId: turn.id,
                message: String(outcome.cause),
              })
              yield* settleThread(thread, dispatch)
              return
            }
            const result = outcome.value
            for (const event of result.events)
              if (!deliveredCursors.has(event.cursor))
                dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: turn.id, event })
            const completedAt = yield* Clock.currentTimeMillis
            yield* Effect.logInfo("turn.finished").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": completedAt - startedAt,
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
                "rika.turn.status": result.status,
              }),
            )
            yield* setTurnStatus(turn.id, result.status, result.events.at(-1)?.cursor, completedAt)
            yield* projectExecutionResult(thread.id, result)
            if (result.status === "completed") {
              yield* settleThread(thread, dispatch)
              if (isNewThread) yield* titleThread(thread, prompt, turn.executionRoute!, dispatch)
              return
            }
            if (result.status === "waiting" || result.status === "running" || result.status === "queued") return
            if (result.status === "failed" && !result.events.some((event) => event.type === "execution.failed"))
              dispatch({
                _tag: "ExecutionFailed",
                threadId: thread.id,
                turnId: turn.id,
                message: `Execution ${result.status}`,
              })
            yield* settleThread(thread, dispatch)
          })
          yield* program.pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.tapCause((cause) =>
              Effect.logError("interactive.submit.failed").pipe(
                Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
              ),
            ),
            Effect.catch((error) => Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) }))),
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
            | ExecutionBackend.Service
            | ResolvedContext.Service
            | ExecutionExtensions.Service
          >,
        ) =>
          effect.pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.catch((error) => Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) }))),
          )
        const queueChanged = Effect.fn("Operation.interactive.queueChanged")(function* (
          threadId: Thread.ThreadId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          dispatch({ _tag: "QueueChanged", threadId, turns: yield* turns.listQueued(threadId) })
        })
        const queueChangedCurrent = (dispatch: (event: InteractiveEvent) => void) =>
          Ref.get(interactiveThread).pipe(
            Effect.flatMap((thread) => (thread === undefined ? Effect.void : queueChanged(thread.id, dispatch))),
          )
        const drainQueuedUnlocked = Effect.fn("Operation.interactive.drainQueued")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          let claimed = 0
          let promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
          while (promoted !== undefined) {
            claimed += 1
            const promotedTurn = promoted
            if (promotedTurn.executionRoute === undefined) {
              yield* setTurnStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
              promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
              continue
            }
            const executionRoute = promotedTurn.executionRoute
            dispatch({ _tag: "TurnStarted", threadId: thread.id, turn: promotedTurn })
            yield* queueChanged(thread.id, dispatch)
            const promotedAt = yield* Clock.currentTimeMillis
            const outcome = yield* Effect.exit(
              Effect.gen(function* () {
                const prepared = yield* prepareExecution(promotedTurn, thread.workspace)
                yield* setTurnStatus(promotedTurn.id, "running", promotedTurn.lastCursor, promotedAt)
                const result = yield* backend.start({
                  threadId: thread.id,
                  turnId: promotedTurn.id,
                  prompt: prepared.prompt,
                  ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                  startedAt: promotedAt,
                  executionRoute,
                  onEvent: (event) =>
                    dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: promotedTurn.id, event }),
                  ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                })
                return result
              }),
            )
            if (outcome._tag === "Failure") {
              yield* setTurnStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
              dispatch({
                _tag: "ExecutionFailed",
                threadId: thread.id,
                turnId: promotedTurn.id,
                message: String(outcome.cause),
              })
            } else {
              const result = outcome.value
              for (const event of result.events)
                dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: promotedTurn.id, event })
              yield* setTurnStatus(
                promotedTurn.id,
                result.status,
                result.events.at(-1)?.cursor,
                yield* Clock.currentTimeMillis,
              )
              yield* projectExecutionResult(thread.id, result)
              if (!isTerminalStatus(result.status)) break
            }
            promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
          }
          yield* queueChanged(thread.id, dispatch)
          return claimed
        })
        const drainQueued = (thread: Thread.Thread, dispatch: (event: InteractiveEvent) => void) =>
          queueDrain.withPermits(1)(drainQueuedUnlocked(thread, dispatch))
        const promoterFor =
          (dispatch: (event: InteractiveEvent) => void) =>
          (threadId: string): Effect.Effect<number> =>
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const thread = yield* threads.get(Thread.ThreadId.make(threadId))
              if (thread === undefined) return 0
              return yield* drainQueued(thread, dispatch)
            }).pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.orElseSucceed(() => 0),
            )
        const promoteThread = Effect.fn("Operation.interactive.promoteThread")(function* (
          thread: Thread.Thread,
          turnId: Turn.TurnId | undefined,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const backend = yield* ExecutionBackend.Service
          if (
            backend.ensureThreadHost === undefined ||
            backend.notifyThreadHost === undefined ||
            backend.registerTurnPromoter === undefined
          ) {
            yield* drainQueued(thread, dispatch)
            return
          }
          const now = yield* Clock.currentTimeMillis
          yield* backend.ensureThreadHost(thread.id, now)
          yield* backend.notifyThreadHost(thread.id, turnId === undefined ? undefined : String(turnId), now)
          yield* queueChanged(thread.id, dispatch)
        })
        const settleThread = Effect.fn("Operation.interactive.settleThread")(function* (
          thread: Thread.Thread,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          yield* promoteThread(thread, undefined, dispatch).pipe(
            Effect.catch(() => queueChanged(thread.id, dispatch)),
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
        const followTurn = Effect.fn("Operation.interactive.followTurn")(function* (
          turnId: Turn.TurnId,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          if (backend.follow === undefined) return
          const follow = backend.follow
          yield* followOwnership.withPermits(1)(
            Effect.gen(function* () {
              const turn = yield* turns.get(turnId)
              if (turn === undefined) return yield* operationError(`Turn ${turnId} does not exist`)
              const thread = yield* threadForTurn(turn)
              const deliveredCursors = new Set<string>()
              const result = yield* follow(turn.id, turn.lastCursor, (event) => {
                deliveredCursors.add(event.cursor)
                dispatch({ _tag: "ExecutionEventReceived", threadId: turn.threadId, turnId: turn.id, event })
              })
              for (const event of result.events)
                if (!deliveredCursors.has(event.cursor))
                  dispatch({ _tag: "ExecutionEventReceived", threadId: turn.threadId, turnId: turn.id, event })
              yield* setTurnStatus(
                turn.id,
                result.status,
                result.events.at(-1)?.cursor ?? turn.lastCursor,
                yield* Clock.currentTimeMillis,
              )
              yield* projectExecutionResult(turn.threadId, result)
              if (isTerminalStatus(result.status)) yield* settleThread(thread, dispatch)
              else if (result.status !== "waiting" && result.status !== "running" && result.status !== "queued")
                dispatch({
                  _tag: "ExecutionFailed",
                  threadId: turn.threadId,
                  turnId: turn.id,
                  message: `Execution ${result.status}`,
                })
            }),
          )
        })
        const titleThread = Effect.fn("Operation.interactive.titleThread")(function* (
          thread: Thread.Thread,
          seedPrompt: string,
          executionRoute: Turn.ExecutionRoutePin,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const program = Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const threads = yield* ThreadRepository.Service
            const startedAt = yield* Clock.currentTimeMillis
            const turnId = `title:${thread.id}:${startedAt}`
            const result = yield* backend.start({
              threadId: thread.id,
              turnId,
              prompt: `Generate a concise 3-6 word title for a conversation that starts with the following user message. Reply with only the title, no quotes, no punctuation.\n\n${seedPrompt.slice(0, 2000)}`,
              startedAt,
              executionRoute,
            })
            const text = result.events
              .filter((event) => event.type === "model.output.completed")
              .map((event) => event.text ?? "")
              .join("")
              .trim()
            const title =
              text
                .replace(/^["'#\s]+/, "")
                .replace(/["'\s]+$/, "")
                .split("\n")[0]
                ?.slice(0, 80) ?? ""
            if (title.length === 0) return
            yield* threads.rename(thread.id, title, yield* Clock.currentTimeMillis)
            dispatch({ _tag: "ThreadTitled", threadId: String(thread.id), title })
            yield* notifyThreadSummaries
          })
          yield* program.pipe(Effect.orElseSucceed(() => undefined))
        })
        const loadThread = Effect.fn("Operation.interactive.loadThread")(function* (
          thread: Thread.Thread,
          request: number,
          dispatch: (event: InteractiveEvent) => void,
        ) {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          const history = yield* turns.list(thread.id)
          if ((yield* Ref.get(selectionRequest)) !== request) return
          yield* Ref.set(interactiveThread, thread)
          const summaries = yield* ThreadSummaryRepository.Service
          yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
          yield* notifyThreadSummaries
          dispatch({ _tag: "ThreadSelected", thread, turns: history })
          dispatch({ _tag: "QueueChanged", threadId: thread.id, turns: yield* turns.listQueued(thread.id) })
          for (const turn of history) {
            if (turn.status === "queued") continue
            const execution = yield* backend.inspect(turn.id)
            if ((yield* Ref.get(selectionRequest)) !== request) return
            dispatch({
              _tag: "ExecutionReplayed",
              threadId: thread.id,
              turnId: turn.id,
              result:
                execution === undefined
                  ? { turnId: turn.id, status: turn.status, events: [] }
                  : yield* backend.replay(turn.id),
            })
          }
        })
        const session: InteractiveSession = {
          initialize: (dispatch) => safe(dispatch, dispatchThreadSummaries(dispatch)),
          watchThreads: (dispatch) =>
            safe(
              dispatch,
              Effect.scoped(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(threadSummaryChanges)
                  yield* dispatchThreadSummaries(dispatch)
                  while (true) {
                    yield* PubSub.take(subscription)
                    yield* dispatchThreadSummaries(dispatch)
                  }
                }),
              ),
            ),
          submit,
          shell: (command, incognito, dispatch) => {
            const toolRuntimeLayer = options.toolRuntimeLayer?.(workspace)
            if (toolRuntimeLayer === undefined) {
              dispatch({ _tag: "ExecutionFailed", message: "Shell runtime is unavailable" })
              return Effect.void
            }
            const program = Effect.gen(function* () {
              if (shellPermission === "ask") {
                const permissionId = `shell-permission-${shellPermissionSequence++}`
                const approval = yield* Deferred.make<boolean>()
                shellApprovals.set(permissionId, approval)
                dispatch({ _tag: "ShellPermissionRequested", id: permissionId, command })
                const approved = yield* Deferred.await(approval).pipe(
                  Effect.ensuring(Effect.sync(() => shellApprovals.delete(permissionId))),
                )
                if (!approved) {
                  dispatch({ _tag: "ExecutionFailed", message: "Shell command denied" })
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
                }
                const turn = yield* turns.createForSubmission({
                  id: yield* options.makeTurnId,
                  threadId: thread.id,
                  prompt: `$ ${command}\n\n<shell-result>\n${text}\n</shell-result>`,
                  executionRoute: yield* resolveExecutionRoute("medium", undefined, thread.workspace),
                  now,
                })
                yield* ensureTurnSummary(turn)
                if (turn.status !== "queued")
                  yield* setTurnStatus(turn.id, "completed", undefined, yield* Clock.currentTimeMillis)
                yield* queueChangedCurrent(dispatch)
              }
              dispatch({ _tag: "ShellCompleted", command, text, incognito })
            })
            return Effect.gen(function* () {
              const toolContext = yield* Layer.build(toolRuntimeLayer)
              yield* program.pipe(
                Effect.provide(Context.merge(executionDependencies, toolContext)),
                Effect.catch((error) =>
                  Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) })),
                ),
              )
            }).pipe(
              Effect.scoped,
              Effect.catch((error) => Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) }))),
            )
          },
          editQueued: (id, prompt, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                yield* turns.editQueued(Turn.TurnId.make(id), prompt, yield* Clock.currentTimeMillis)
                yield* queueChangedCurrent(dispatch)
              }),
            ),
          dequeue: (id, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                yield* turns.dequeue(Turn.TurnId.make(id))
                yield* queueChangedCurrent(dispatch)
              }),
            ),
          steerQueued: (id, text, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active()
                const queued = yield* turns.get(Turn.TurnId.make(id))
                if (queued === undefined || queued.status !== "queued")
                  return yield* operationError(`Turn ${id} is not queued`)
                if (queued.promptParts !== undefined && queued.promptParts.some((part) => part.type === "image"))
                  return yield* operationError("Queued turns with images cannot be steered")
                const steeringText =
                  queued.promptParts
                    ?.filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("") ??
                  queued.prompt ??
                  text
                yield* backend.steer(turn.id, steeringText, yield* Clock.currentTimeMillis)
                yield* turns.dequeue(queued.id)
                yield* queueChanged(turn.threadId, dispatch)
                dispatch({ _tag: "ExecutionControlled", threadId: turn.threadId, turnId: turn.id, action: "steered" })
              }),
            ),
          steer: (text, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active()
                yield* backend.steer(turn.id, text, yield* Clock.currentTimeMillis)
                dispatch({ _tag: "ExecutionControlled", threadId: turn.threadId, turnId: turn.id, action: "steered" })
              }),
            ),
          interruptAndSend: (prompt, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const turns = yield* TurnRepository.Service
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active()
                const thread = yield* threadForTurn(turn)
                const executionRoute =
                  turn.executionRoute ?? (yield* resolveExecutionRoute("medium", undefined, thread.workspace))
                const pending = yield* turns.createForSubmission({
                  id: yield* options.makeTurnId,
                  threadId: turn.threadId,
                  prompt,
                  executionRoute,
                  now: yield* Clock.currentTimeMillis,
                })
                yield* ensureTurnSummary(pending)
                if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
                yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
                yield* setTurnStatus(turn.id, "cancelled", turn.lastCursor, yield* Clock.currentTimeMillis)
                yield* drainQueued(thread, dispatch)
              }),
            ),
          cancel: (dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const turn = yield* active().pipe(Effect.orElseSucceed(() => undefined))
                if (turn === undefined) {
                  dispatch({ _tag: "ExecutionControlled", action: "cancelled" })
                  return
                }
                const thread = yield* threadForTurn(turn)
                const result = yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
                yield* setTurnStatus(
                  turn.id,
                  result.status,
                  result.events.at(-1)?.cursor ?? turn.lastCursor,
                  yield* Clock.currentTimeMillis,
                )
                yield* projectExecutionResult(turn.threadId, result)
                dispatch({ _tag: "ExecutionControlled", threadId: turn.threadId, turnId: turn.id, action: "cancelled" })
                if (isTerminalStatus(result.status)) yield* settleThread(thread, dispatch)
              }),
            ),
          resolvePermission: (waitId, kind, decision, dispatch) =>
            shellApprovals.has(waitId)
              ? Effect.gen(function* () {
                  const approval = shellApprovals.get(waitId)
                  if (approval !== undefined) yield* Deferred.succeed(approval, decision !== "deny")
                  dispatch({ _tag: "ExecutionControlled", action: "permission-resolved" })
                })
              : safe(
                  dispatch,
                  Effect.gen(function* () {
                    const backend = yield* ExecutionBackend.Service
                    const activeTurn = yield* active()
                    const resolvedAt = yield* Clock.currentTimeMillis
                    if (kind === "tool-approval")
                      yield* backend.resolveToolApproval(waitId, decision !== "deny", resolvedAt)
                    else
                      yield* backend.resolvePermission(
                        waitId,
                        decision === "allow" ? "Approved" : decision === "deny" ? "Denied" : "Always",
                        resolvedAt,
                      )
                    dispatch({
                      _tag: "ExecutionControlled",
                      threadId: activeTurn.threadId,
                      turnId: activeTurn.id,
                      action: "permission-resolved",
                    })
                    yield* followTurn(activeTurn.id, dispatch)
                  }),
                ),
          selectThread: (id, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const request = yield* Ref.updateAndGet(selectionRequest, (value) => value + 1)
                const threads = yield* ThreadRepository.Service
                const thread = yield* threads.get(Thread.ThreadId.make(id))
                if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
                yield* loadThread(thread, request, dispatch)
              }),
            ),
          previewThread: (id, dispatch) =>
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
              dispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
            }).pipe(
              Effect.provide(executionDependencies),
              Effect.scoped,
              Effect.orElseSucceed(() => undefined),
            ),
          reopenThread: (dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const request = yield* Ref.updateAndGet(selectionRequest, (value) => value + 1)
                const threads = yield* ThreadRepository.Service
                const thread = (yield* threads.list({ limit: 1 }))[0]
                if (thread === undefined) return yield* operationError("No threads exist")
                yield* loadThread(thread, request, dispatch)
              }),
            ),
          followSelected: (dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const thread = yield* Ref.get(interactiveThread)
                if (thread === undefined) return
                const turns = yield* TurnRepository.Service
                let followedTurnId: Turn.TurnId | undefined
                let initialized = false
                while (true) {
                  const turn = yield* turns.findActive(thread.id)
                  if (turn === undefined) {
                    initialized = true
                    yield* Effect.sleep("100 millis")
                    continue
                  }
                  if (turn.id !== followedTurnId) {
                    followedTurnId = turn.id
                    if (initialized) dispatch({ _tag: "TurnStarted", threadId: thread.id, turn })
                  }
                  initialized = true
                  const backend = yield* ExecutionBackend.Service
                  const execution = yield* backend.inspect(turn.id)
                  if (execution === undefined) {
                    const current = yield* turns.get(turn.id)
                    if (current !== undefined && !isTerminalStatus(current.status)) yield* Effect.sleep("100 millis")
                    continue
                  }
                  yield* followTurn(turn.id, dispatch)
                }
              }),
            ),
          replay: (id, cursor, dispatch) =>
            safe(
              dispatch,
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const turnId = Turn.TurnId.make(id)
                const thread = yield* Ref.get(interactiveThread)
                if (thread === undefined) return yield* operationError("No thread selected")
                dispatch({
                  _tag: "ExecutionReplayed",
                  threadId: thread.id,
                  turnId,
                  result: yield* backend.replay(id, cursor),
                })
              }),
            ),
        }
        const backend = acquiredBackend
        if (backend.registerTurnPromoter !== undefined) {
          yield* backend.registerTurnPromoter(promoterFor(startupDispatch))
        }
        return session
      })
      yield* makeInteractiveSession(options.defaultWorkspace)
      const reconcileOnce = yield* Effect.cached(
        Effect.gen(function* () {
          yield* Effect.forkIn(reconcileExecutions, ownerScope).pipe(Effect.flatMap(Fiber.join))
          yield* Effect.forkIn(
            repairThreadSummaries().pipe(
              Effect.provide(executionDependencies),
              Effect.catch((error) =>
                Effect.logError("thread-summary.repair.failed").pipe(
                  Effect.annotateLogs("rika.failure.kind", String(error)),
                ),
              ),
            ),
            ownerScope,
          )
        }).pipe(Effect.uninterruptible),
      )
      return Service.of({
        run: Effect.fn("Operation.product.run")(function* (input) {
          if (
            input._tag === "Interactive" ||
            input._tag === "Run" ||
            input._tag === "Review" ||
            input._tag === "Workflow"
          )
            yield* reconcileOnce.pipe(Effect.mapError((error) => unavailable(input, String(error))))
          if (input._tag === "Interactive" && options.interactive !== undefined) {
            const session = yield* makeInteractiveSession(input.workspace ?? options.defaultWorkspace)
            yield* options.interactive(input, session)
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
              const turnId = yield* options.makeTurnId
              const prompt = input.prompt.join(" ")
              const submitted = yield* turns.createForSubmission({
                id: turnId,
                threadId: thread.id,
                prompt,
                executionRoute: yield* resolveExecutionRoute(input.mode ?? "medium", undefined, thread.workspace),
                now,
              })
              yield* ensureTurnSummary(submitted)
              yield* Effect.logInfo("turn.accepted").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": String(thread.id),
                  "rika.turn.id": String(submitted.id),
                  "rika.turn.status": submitted.status,
                }),
              )
              if (submitted.status === "queued") return
              const runTurn = Effect.fn("Operation.runTurn")(function* (turn: Turn.Turn) {
                const startedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("turn.started").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                  }),
                )
                const result = yield* Effect.gen(function* () {
                  const prepared = yield* prepareExecution(turn, thread.workspace)
                  yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
                  return yield* backend.start({
                    threadId: turn.threadId,
                    turnId: turn.id,
                    prompt: prepared.prompt,
                    startedAt,
                    executionRoute: turn.executionRoute!,
                    ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                  })
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
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("turn.finished").pipe(
                  Effect.annotateLogs({
                    "rika.duration.ms": completedAt - startedAt,
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                    "rika.turn.status": result.status,
                  }),
                )
                yield* setTurnStatus(turn.id, result.status, result.events.at(-1)?.cursor, completedAt)
                yield* projectExecutionResult(thread.id, result)
                return result
              })
              const result = yield* runTurn(submitted)
              let promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
              while (promoted !== undefined) {
                yield* runTurn(promoted)
                promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
              }
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
              const args = ["diff", "--no-ext-diff", "--no-color"]
              if (input.staged) args.push("--cached")
              else if (input.base !== undefined) args.push(`${input.base}...HEAD`)
              if (input.paths.length > 0) args.push("--", ...input.paths)
              const diffResult = yield* tools.run({ _tag: "Shell", command: "git", args, waitMillis: 120_000 })
              if (diffResult.exitCode === undefined)
                return yield* operationError("Git diff did not finish before the review timeout")
              if (diffResult.exitCode !== 0) return yield* operationError(diffResult.text || "Git diff failed")
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
              const settlement = yield* Effect.gen(function* () {
                const parentTurn = yield* turns.createForSubmission({
                  id: parentTurnId,
                  threadId: thread.id,
                  prompt: "Review workspace changes",
                  executionRoute,
                  reviewFanOutId: fanOutId,
                  now,
                })
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
              const settled = yield* Fiber.join(settlement)
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
                  .map(
                    (lane) =>
                      `## ${lane.id}\n${lane.output === undefined ? `Review lane ${lane.status}${lane.error === undefined ? "" : `: ${lane.error}`}` : typeof lane.output === "string" ? lane.output : encodeJson(lane.output)}`,
                  )
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
                yield* Console.log(encodeJson(yield* backend.startWorkflow(input.name, input.runId, input.revision)))
                return
              }
              const inspection = yield* backend.inspectWorkflow(input.runId)
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
                const source = yield* requireThread(repository, input.threadId)
                const sourceTurns = yield* turns.list(source.id)
                const boundary =
                  input.atTurn === undefined
                    ? sourceTurns.length - 1
                    : sourceTurns.findIndex((turn) => turn.id === input.atTurn)
                if (boundary < 0 && input.atTurn !== undefined)
                  return yield* operationError(`Turn ${input.atTurn} does not exist in thread ${input.threadId}`)
                const fork = yield* repository.create({
                  id: yield* options.makeThreadId,
                  workspace: source.workspace,
                  title: source.title,
                  now,
                })
                if (source.labels.length > 0) yield* repository.label(fork.id, source.labels, now)
                for (const sourceTurn of sourceTurns.slice(0, boundary + 1)) {
                  const copied = yield* turns.createForSubmission({
                    id: yield* options.makeTurnId,
                    threadId: fork.id,
                    prompt: sourceTurn.prompt,
                    ...(sourceTurn.executionRoute === undefined ? {} : { executionRoute: sourceTurn.executionRoute }),
                    now: sourceTurn.createdAt,
                  })
                  yield* setTurnStatus(copied.id, sourceTurn.status, sourceTurn.lastCursor, sourceTurn.updatedAt)
                  const execution = yield* acquiredBackend.inspect(sourceTurn.id)
                  if (execution === undefined) yield* ensureTurnSummary(copied)
                  else {
                    const replayed = yield* acquiredBackend.replay(sourceTurn.id)
                    yield* projectExecutionResult(fork.id, { ...replayed, turnId: copied.id })
                  }
                }
                yield* notifyThreadSummaries
                yield* writeThread(yield* requireThread(repository, fork.id))
                return
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
