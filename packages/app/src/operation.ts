import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as ProductAgent from "./product-agent"
import { ExecutionExtensions } from "@rika/extensions"
import { ConfigService } from "@rika/config"
import * as ExtensionOperations from "./extension-operations"
import { Catalog as ToolCatalog, Runtime as ToolRuntime } from "@rika/tools"
import { Clock, Console, Context, Deferred, Effect, Layer, Ref, Runtime, Schema, Semaphore } from "effect"
import * as FileMentions from "./file-mentions"
import * as ContextMentions from "./context-mentions"
import * as ConfigOperations from "./config-operations"
import * as ResolvedContext from "./resolved-context"

const Mode = Schema.Literals(["low", "medium", "high", "ultra"])

const startupDispatch = () => undefined

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const Interactive = Schema.Struct({
  _tag: Schema.tag("Interactive"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.Boolean),
  ephemeral: Schema.Boolean,
})

const Run = Schema.Struct({
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
  _tag: Schema.tag("Review"),
  staged: Schema.Boolean,
  base: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  json: Schema.Boolean,
  paths: Schema.Array(Schema.String),
})

const ThreadNoInput = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["new", "last", "top"]),
})
const ThreadContinueLast = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  last: Schema.tag(true),
})
const ThreadContinueIds = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  threadIds: Schema.NonEmptyArray(Schema.String),
})
const ThreadList = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("list"),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadSearch = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("search"),
  query: Schema.NonEmptyArray(Schema.String),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadRename = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("rename"),
  threadId: Schema.String,
  title: Schema.String,
})
const ThreadLabel = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("label"),
  threadId: Schema.String,
  labels: Schema.NonEmptyArray(Schema.String),
})
const ThreadById = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["pin", "archive", "unarchive", "delete", "usage"]),
  threadId: Schema.String,
})
const ThreadFork = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("fork"),
  threadId: Schema.String,
  atTurn: Schema.optionalKey(Schema.String),
})
const ThreadExport = Schema.Struct({
  _tag: Schema.tag("Thread"),
  action: Schema.tag("export"),
  threadId: Schema.String,
  format: Schema.Literals(["json", "markdown"]),
})

const ConfigNoInput = Schema.Struct({ _tag: Schema.tag("Config"), action: Schema.Literals(["list", "keymap"]) })
const ConfigEdit = Schema.Struct({ _tag: Schema.tag("Config"), action: Schema.tag("edit"), workspace: Schema.Boolean })

const McpNoInput = Schema.Struct({ _tag: Schema.tag("Mcp"), action: Schema.Literals(["list", "doctor"]) })
const McpAddCommand = Schema.Struct({
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
})
const McpAddUrl = Schema.Struct({
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  url: Schema.String,
})
const McpNamed = Schema.Struct({
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["remove", "enable", "disable", "oauth-login", "oauth-logout"]),
  name: Schema.String,
})
const McpApprove = Schema.Struct({
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("approve"),
  name: Schema.String,
  workspace: Schema.optionalKey(Schema.String),
})
const McpOauthStatus = Schema.Struct({
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("oauth-status"),
  name: Schema.optionalKey(Schema.String),
})

const SkillList = Schema.Struct({ _tag: Schema.tag("Skill"), action: Schema.tag("list") })
const SkillNamed = Schema.Struct({
  _tag: Schema.tag("Skill"),
  action: Schema.Literals(["inspect", "remove"]),
  name: Schema.String,
})
const SkillAdd = Schema.Struct({ _tag: Schema.tag("Skill"), action: Schema.tag("add"), source: Schema.String })

const ToolList = Schema.Struct({
  _tag: Schema.tag("ToolCatalog"),
  action: Schema.tag("list"),
  mode: Schema.optionalKey(Mode),
})
const ToolShow = Schema.Struct({ _tag: Schema.tag("ToolCatalog"), action: Schema.tag("show"), name: Schema.String })

const Extension = Schema.Struct({
  _tag: Schema.tag("Extension"),
  action: Schema.Literals(["create-skill", "create-plugin", "enable", "disable", "rollback"]),
  name: Schema.String,
})
const ExtensionList = Schema.Struct({ _tag: Schema.tag("Extension"), action: Schema.tag("list") })

const Doctor = Schema.Struct({ _tag: Schema.tag("Doctor") })
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

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, OperationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/Operation") {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    run: Effect.fn("Operation.run")(function* (input) {
      return yield* new OperationUnavailable({
        operation: input._tag,
        message: `${input._tag} is specified but not implemented yet`,
      })
    }),
  }),
)

export interface ProductLayerOptions<ThreadError, TurnError, BackendError> {
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadError>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnError>
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly backendLayerForMode?: (
    mode: "low" | "medium" | "high" | "ultra",
  ) => Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly productAgentLayer?: Layer.Layer<ProductAgent.Service, unknown, ExecutionBackend.Service>
  readonly toolRuntimeLayer?: (workspace: string) => Layer.Layer<ToolRuntime.Service, unknown, never>
  readonly resolvedContextLayer?: Layer.Layer<ResolvedContext.Service, unknown>
  readonly executionExtensions?: {
    readonly layer: Layer.Layer<ExecutionExtensions.Service, unknown>
    readonly mcpFingerprint: Effect.Effect<string>
  }
  readonly defaultWorkspace: string
  readonly shellPermission?: "ask" | "allow"
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly configOperations?: {
    readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigService.Service, unknown>
    readonly options: ConfigOperations.Options
  }
  readonly extensionOperations?: {
    readonly layer: Layer.Layer<
      | ExtensionOperations.Service
      | import("@rika/extensions").McpOAuth.Service
      | import("effect").FileSystem.FileSystem
      | import("effect").Path.Path
      | import("effect").Crypto.Crypto
      | import("@rika/extensions").SkillRegistry.SkillFileSystem,
      unknown
    >
  }
  readonly interactive?: (
    input: Extract<Input, { readonly _tag: "Interactive" }>,
    session: InteractiveSession,
  ) => Effect.Effect<void, OperationUnavailable>
}

export const reconcile = Effect.fn("Operation.reconcile")(function* (
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
    unknown,
    TurnRepository.Service | ThreadRepository.Service | ResolvedContext.Service | ExecutionExtensions.Service
  >,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const active = yield* turns.listNonterminal()
  yield* Effect.forEach(
    active.filter((turn) => turn.status !== "queued"),
    (turn) =>
      backend.inspect(turn.id).pipe(
        Effect.flatMap((inspection) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (inspection === undefined) {
              if (prepare === undefined && extensions !== undefined && turn.extensionPin === undefined)
                return yield* Effect.fail(new Error(`Turn ${turn.id} has no durable extension pin`))
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
                            ? Effect.fail(new Error(`Thread ${turn.threadId} does not exist`))
                            : prepare(turn, thread.workspace),
                        ),
                      )
              const result = yield* backend.start({
                threadId: turn.threadId,
                turnId: turn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                startedAt: turn.updatedAt,
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
            return yield* Effect.fail(error)
          }),
        ),
      ),
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
                return yield* Effect.fail(error)
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

export type InteractiveEvent =
  | {
      readonly _tag: "ExecutionEventReceived"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly event: ExecutionBackend.Event
    }
  | { readonly _tag: "ThreadsListed"; readonly threads: ReadonlyArray<Thread.Thread> }
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
  new OperationUnavailable({ operation: input._tag, message })

const writeThread = (thread: Thread.Thread) => Console.log(JSON.stringify(thread))

const requireThread = Effect.fn("Operation.requireThread")(function* (
  repository: ThreadRepository.Interface,
  id: string,
) {
  const thread = yield* repository.get(Thread.ThreadId.make(id))
  if (thread === undefined) return yield* Effect.fail(new Error(`Thread ${id} does not exist`))
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

export const productLayer = <ThreadError, TurnError, BackendError>(
  options: ProductLayerOptions<ThreadError, TurnError, BackendError>,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
      const selectionRequest = yield* Ref.make(0)
      const submissionAdmission = yield* Semaphore.make(1)
      const queueDrain = yield* Semaphore.make(1)
      const followOwnership = yield* Semaphore.make(1)
      const shellApprovals = new Map<string, Deferred.Deferred<boolean>>()
      let shellPermissionSequence = 0
      const resolvedContextLayer =
        options.resolvedContextLayer ??
        ResolvedContext.testLayer({
          resolve: () => Effect.succeed({ sources: [], diagnostics: [], digest: "" }),
        })
      const dependencies = Layer.mergeAll(
        options.repositoryLayer,
        options.turnRepositoryLayer,
        resolvedContextLayer,
        ...(options.executionExtensions === undefined ? [] : [options.executionExtensions.layer]),
      )
      const defaultBackendContext = yield* Layer.build(options.backendLayer)
      const defaultBackendLayer = Layer.succeed(
        ExecutionBackend.Service,
        Context.get(defaultBackendContext, ExecutionBackend.Service),
      )
      const backendLayersByMode = new Map<"low" | "medium" | "high" | "ultra", Layer.Layer<ExecutionBackend.Service>>()
      backendLayersByMode.set("medium", defaultBackendLayer)
      yield* Effect.forEach(["low", "high", "ultra"] as const, (mode) =>
        Effect.gen(function* () {
          const configuredLayer = options.backendLayerForMode?.(mode) ?? defaultBackendLayer
          const context = yield* Layer.build(configuredLayer)
          backendLayersByMode.set(
            mode,
            Layer.succeed(ExecutionBackend.Service, Context.get(context, ExecutionBackend.Service)),
          )
        }),
      )
      const extensionService =
        options.executionExtensions === undefined
          ? undefined
          : yield* ExecutionExtensions.Service.pipe(Effect.provide(options.executionExtensions.layer), Effect.scoped)
      const executionDependencies = Layer.merge(dependencies, options.backendLayer)
      const executionPrompt = Effect.fn("Operation.executionPrompt")(function* (workspace: string, prompt: string) {
        const context = yield* ResolvedContext.Service
        const structured = ContextMentions.parse(prompt)
        const legacy = [...new Set(FileMentions.parse(prompt))].filter(
          (value) => !/^(?:file|ref|guidance|thread|image):/.test(value),
        )
        const files = [...new Set([...legacy, ...structured.files, ...structured.images])].toSorted()
        const resolved = yield* context.resolve({
          workspace,
          targetPaths: files,
          references: [...files, ...structured.references],
        })
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const threadBlocks = yield* Effect.forEach(
          structured.threads,
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
      const promoterForStartup = (threadId: string): Effect.Effect<number> =>
        Effect.suspend(() => promoterFor(startupDispatch)(threadId))
      const reconcileExecutions = Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.registerTurnPromoter !== undefined) {
          yield* backend.registerTurnPromoter(promoterForStartup)
        }
        yield* reconcile(extensionService, prepareExecution)
      }).pipe(Effect.provide(executionDependencies), Effect.scoped)
      const submit = Effect.fn("Operation.interactive.submit")(function* (
        prompt: string,
        dispatch: (event: InteractiveEvent) => void,
        mode: "low" | "medium" | "high" | "ultra" = "medium",
        promptParts?: ReadonlyArray<Turn.PromptPart>,
        modelTuning?: { readonly reasoningEffort?: string; readonly fastMode?: boolean },
      ) {
        const selectedBackendLayer = backendLayersByMode.get(mode) ?? defaultBackendLayer
        const selectedExecutionDependencies = Layer.merge(dependencies, selectedBackendLayer)
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
                  workspace: options.defaultWorkspace,
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
                now,
              })
              return { thread, isNewThread, turn }
            }),
          )
          const { thread, isNewThread, turn } = admitted
          if (turn.status === "queued") {
            yield* promoteThread(thread, turn.id, dispatch)
            return
          }
          dispatch({ _tag: "TurnStarted", threadId: thread.id, turn })
          const startedAt = yield* Clock.currentTimeMillis
          const outcome = yield* Effect.exit(
            Effect.gen(function* () {
              const prepared = yield* prepareExecution(turn, thread.workspace)
              yield* turns.setStatus(turn.id, "running", turn.lastCursor, startedAt)
              const result = yield* backend.start({
                threadId: thread.id,
                turnId: turn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                startedAt,
                ...(modelTuning?.reasoningEffort === undefined ? {} : { reasoningEffort: modelTuning.reasoningEffort }),
                ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
                onEvent: (event) =>
                  dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: turn.id, event }),
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              return result
            }),
          )
          if (outcome._tag === "Failure") {
            yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
            dispatch({ _tag: "ExecutionFailed", threadId: thread.id, turnId: turn.id, message: String(outcome.cause) })
            yield* promoteThread(thread, undefined, dispatch)
            return
          }
          const result = outcome.value
          for (const event of result.events)
            dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: turn.id, event })
          yield* turns.setStatus(turn.id, result.status, result.events.at(-1)?.cursor, yield* Clock.currentTimeMillis)
          if (result.status === "completed") {
            yield* promoteThread(thread, undefined, dispatch)
            if (isNewThread) yield* titleThread(thread, prompt, dispatch)
            return
          }
          if (result.status === "waiting" || result.status === "running" || result.status === "queued") return
          if (result.status === "failed")
            dispatch({
              _tag: "ExecutionFailed",
              threadId: thread.id,
              turnId: turn.id,
              message: `Execution ${result.status}`,
            })
          yield* promoteThread(thread, undefined, dispatch)
        })
        yield* program.pipe(
          Effect.provide(selectedExecutionDependencies),
          Effect.scoped,
          Effect.catch((error) => Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) }))),
        )
      })
      const safe = (
        dispatch: (event: InteractiveEvent) => void,
        effect: Effect.Effect<
          void,
          unknown,
          | ThreadRepository.Service
          | TurnRepository.Service
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
          dispatch({ _tag: "TurnStarted", threadId: thread.id, turn: promotedTurn })
          yield* queueChanged(thread.id, dispatch)
          const promotedAt = yield* Clock.currentTimeMillis
          const outcome = yield* Effect.exit(
            Effect.gen(function* () {
              const prepared = yield* prepareExecution(promotedTurn, thread.workspace)
              yield* turns.setStatus(promotedTurn.id, "running", promotedTurn.lastCursor, promotedAt)
              const result = yield* backend.start({
                threadId: thread.id,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                startedAt: promotedAt,
                onEvent: (event) =>
                  dispatch({ _tag: "ExecutionEventReceived", threadId: thread.id, turnId: promotedTurn.id, event }),
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              return result
            }),
          )
          if (outcome._tag === "Failure") {
            yield* turns.setStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
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
            yield* turns.setStatus(
              promotedTurn.id,
              result.status,
              result.events.at(-1)?.cursor,
              yield* Clock.currentTimeMillis,
            )
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
            Effect.provide(Layer.merge(dependencies, defaultBackendLayer)),
            Effect.scoped,
            Effect.catch(() => Effect.succeed(0)),
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
        yield* backend.registerTurnPromoter(promoterFor(dispatch))
        const now = yield* Clock.currentTimeMillis
        yield* backend.ensureThreadHost(thread.id, now)
        yield* backend.notifyThreadHost(thread.id, turnId === undefined ? undefined : String(turnId), now)
        yield* queueChanged(thread.id, dispatch)
      })
      const active = Effect.fn("Operation.interactive.active")(function* () {
        const thread = yield* Ref.get(interactiveThread)
        if (thread === undefined) return yield* Effect.fail(new Error("No thread selected"))
        const turns = yield* TurnRepository.Service
        const turn = yield* turns.findActive(thread.id)
        if (turn === undefined) return yield* Effect.fail(new Error("No active turn"))
        return turn
      })
      const threadForTurn = Effect.fn("Operation.interactive.threadForTurn")(function* (turn: Turn.Turn) {
        const thread = yield* (yield* ThreadRepository.Service).get(turn.threadId)
        if (thread === undefined) return yield* Effect.fail(new Error(`Thread ${turn.threadId} does not exist`))
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
            if (turn === undefined) return yield* Effect.fail(new Error(`Turn ${turnId} does not exist`))
            const thread = yield* threadForTurn(turn)
            const result = yield* follow(turn.id, turn.lastCursor, (event) => {
              dispatch({ _tag: "ExecutionEventReceived", threadId: turn.threadId, turnId: turn.id, event })
            })
            for (const event of result.events)
              dispatch({ _tag: "ExecutionEventReceived", threadId: turn.threadId, turnId: turn.id, event })
            yield* turns.setStatus(
              turn.id,
              result.status,
              result.events.at(-1)?.cursor ?? turn.lastCursor,
              yield* Clock.currentTimeMillis,
            )
            if (isTerminalStatus(result.status)) yield* promoteThread(thread, undefined, dispatch)
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
        dispatch: (event: InteractiveEvent) => void,
      ) {
        const lowBackendLayer = backendLayersByMode.get("low") ?? defaultBackendLayer
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
          dispatch({ _tag: "ThreadsListed", threads: yield* threads.list() })
        })
        yield* program.pipe(
          Effect.provide(Layer.merge(dependencies, lowBackendLayer)),
          Effect.scoped,
          Effect.catch(() => Effect.void),
        )
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
        initialize: (dispatch) =>
          safe(
            dispatch,
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const listed = yield* threads.list()
              dispatch({ _tag: "ThreadsListed", threads: listed })
            }),
          ),
        submit,
        shell: (command, incognito, dispatch) => {
          const toolRuntimeLayer = options.toolRuntimeLayer?.(options.defaultWorkspace)
          if (toolRuntimeLayer === undefined) {
            dispatch({ _tag: "ExecutionFailed", message: "Shell runtime is unavailable" })
            return Effect.void
          }
          const program = Effect.gen(function* () {
            if ((options.shellPermission ?? "allow") === "ask") {
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
                  workspace: options.defaultWorkspace,
                  title: `$ ${command}`.slice(0, 80),
                  now,
                })
                yield* Ref.set(interactiveThread, thread)
              }
              const turn = yield* turns.createForSubmission({
                id: yield* options.makeTurnId,
                threadId: thread.id,
                prompt: `$ ${command}\n\n<shell-result>\n${text}\n</shell-result>`,
                now,
              })
              if (turn.status !== "queued")
                yield* turns.setStatus(turn.id, "completed", undefined, yield* Clock.currentTimeMillis)
              yield* queueChangedCurrent(dispatch)
            }
            dispatch({ _tag: "ShellCompleted", command, text, incognito })
          })
          return program.pipe(
            Effect.provide(toolRuntimeLayer),
            Effect.provide(dependencies),
            Effect.scoped,
            Effect.catch((error) => Effect.sync(() => dispatch({ _tag: "ExecutionFailed", message: String(error) }))),
            Effect.asVoid,
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
                return yield* Effect.fail(new Error(`Turn ${id} is not queued`))
              if (queued.promptParts?.some((part) => part.type === "image"))
                return yield* Effect.fail(new Error("Queued turns with images cannot be steered"))
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
              const pending = yield* turns.createForSubmission({
                id: yield* options.makeTurnId,
                threadId: turn.threadId,
                prompt,
                now: yield* Clock.currentTimeMillis,
              })
              if (pending.status !== "queued") return yield* Effect.fail(new Error("Pending turn was not queued"))
              yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
              yield* turns.setStatus(turn.id, "cancelled", turn.lastCursor, yield* Clock.currentTimeMillis)
              yield* drainQueued(thread, dispatch)
            }),
          ),
        cancel: (dispatch) =>
          safe(
            dispatch,
            Effect.gen(function* () {
              const turns = yield* TurnRepository.Service
              const backend = yield* ExecutionBackend.Service
              const turn = yield* active().pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (turn === undefined) {
                dispatch({ _tag: "ExecutionControlled", action: "cancelled" })
                return
              }
              const thread = yield* threadForTurn(turn)
              const result = yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
              yield* turns.setStatus(
                turn.id,
                result.status,
                result.events.at(-1)?.cursor ?? turn.lastCursor,
                yield* Clock.currentTimeMillis,
              )
              dispatch({ _tag: "ExecutionControlled", threadId: turn.threadId, turnId: turn.id, action: "cancelled" })
              if (isTerminalStatus(result.status)) yield* promoteThread(thread, undefined, dispatch)
            }),
          ),
        resolvePermission: (waitId, kind, decision, dispatch) =>
          shellApprovals.has(waitId)
            ? Effect.sync(() => {
                const approval = shellApprovals.get(waitId)
                if (approval !== undefined) Effect.runFork(Deferred.succeed(approval, decision !== "deny"))
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
              if (thread === undefined) return yield* Effect.fail(new Error(`Thread ${id} does not exist`))
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
                Effect.catch(() =>
                  Effect.succeed({ prompt: turn.prompt, events: [] as ReadonlyArray<ExecutionBackend.Event> }),
                ),
              ),
            )
            dispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
          }).pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.catch(() => Effect.void),
          ),
        reopenThread: (dispatch) =>
          safe(
            dispatch,
            Effect.gen(function* () {
              const request = yield* Ref.updateAndGet(selectionRequest, (value) => value + 1)
              const threads = yield* ThreadRepository.Service
              const thread = (yield* threads.list({ limit: 1 }))[0]
              if (thread === undefined) return yield* Effect.fail(new Error("No threads exist"))
              yield* loadThread(thread, request, dispatch)
            }),
          ),
        followSelected: (dispatch) =>
          safe(
            dispatch,
            Effect.gen(function* () {
              const thread = yield* Ref.get(interactiveThread)
              if (thread === undefined) return
              const turn = yield* (yield* TurnRepository.Service).findActive(thread.id)
              if (turn !== undefined) yield* followTurn(turn.id, dispatch)
            }),
          ),
        replay: (id, cursor, dispatch) =>
          safe(
            dispatch,
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const turnId = Turn.TurnId.make(id)
              const thread = yield* Ref.get(interactiveThread)
              if (thread === undefined) return yield* Effect.fail(new Error("No thread selected"))
              dispatch({
                _tag: "ExecutionReplayed",
                threadId: thread.id,
                turnId,
                result: yield* backend.replay(id, cursor),
              })
            }),
          ),
      }
      return Service.of({
        run: Effect.fn("Operation.product.run")(function* (input) {
          if (input._tag === "Interactive" && options.interactive !== undefined) {
            yield* reconcileExecutions.pipe(Effect.mapError((error) => unavailable(input, String(error))))
            yield* options.interactive(input, session)
            return
          }
          if (input._tag === "Run") {
            const selectedBackendLayer = options.backendLayerForMode?.(input.mode ?? "medium") ?? options.backendLayer
            const selectedExecutionDependencies = Layer.merge(dependencies, selectedBackendLayer)
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
                            ? Effect.fail(new Error(`Thread ${input.threadId} does not exist`))
                            : Effect.succeed(existingThread),
                        ),
                      )
              const turnId = yield* options.makeTurnId
              const prompt = input.prompt.join(" ")
              const submitted = yield* turns.createForSubmission({ id: turnId, threadId: thread.id, prompt, now })
              if (submitted.status === "queued") return
              const runTurn = Effect.fn("Operation.runTurn")(function* (turn: Turn.Turn) {
                const result = yield* Effect.gen(function* () {
                  const startedAt = yield* Clock.currentTimeMillis
                  const prepared = yield* prepareExecution(turn, thread.workspace)
                  yield* turns.setStatus(turn.id, "running", turn.lastCursor, startedAt)
                  return yield* backend.start({
                    threadId: turn.threadId,
                    turnId: turn.id,
                    prompt: prepared.prompt,
                    startedAt,
                    ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                      return yield* Effect.fail(error)
                    }),
                  ),
                )
                yield* turns.setStatus(
                  turn.id,
                  result.status,
                  result.events.at(-1)?.cursor,
                  yield* Clock.currentTimeMillis,
                )
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
            yield* Effect.andThen(reconcileExecutions, program).pipe(
              Effect.provide(selectedExecutionDependencies),
              Effect.scoped,
              Effect.mapError((error) => unavailable(input, String(error))),
            )
            return
          }
          if (input._tag === "Review") {
            if (options.toolRuntimeLayer === undefined)
              return yield* Effect.fail(unavailable(input, "Review requires the local tool runtime"))
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
                return yield* Effect.fail(new Error("Git diff did not finish before the review timeout"))
              if (diffResult.exitCode !== 0) return yield* Effect.fail(new Error(diffResult.text || "Git diff failed"))
              const diff = diffResult.text.trim()
              if (diff.length === 0) {
                yield* Console.log(
                  input.json ? JSON.stringify({ status: "no-changes", findings: [] }) : "No changes to review.",
                )
                return
              }
              const now = yield* Clock.currentTimeMillis
              const parentTurnId = String(yield* options.makeTurnId)
              const fanOutId = `review:${parentTurnId}`
              const focus = [
                ["correctness", "Find correctness defects, regressions, and edge cases."],
                ["security", "Find security, privacy, and unsafe-input defects."],
                ["quality", "Find missing tests, maintainability risks, and contract violations."],
              ] as const
              let inspection = yield* agents.runReviewLanes({
                parentTurnId,
                fanOutId,
                checks: focus.map(([id, instruction]) => ({
                  id: `${fanOutId}:${id}`,
                  prompt: `${instruction}\nReturn concise actionable findings with file and line references. If none, say no findings.\n\n${diff}`,
                })),
                maxConcurrency: focus.length,
                join: "best-effort",
                createdAt: now,
              })
              while (inspection.state === "joining") {
                yield* Effect.sleep("50 millis")
                const next = yield* agents.inspectFanOut(fanOutId)
                if (next === undefined) return yield* Effect.fail(new Error(`Review ${fanOutId} disappeared`))
                inspection = next
              }
              const lanes = agents.projectChildren(inspection).map((lane) => ({
                id: lane.childId.slice(fanOutId.length + 1),
                status: lane.state,
                output: lane.output,
                error: lane.error,
              }))
              if (inspection.state === "failed" || lanes.every((lane) => lane.status !== "completed"))
                return yield* Effect.fail(
                  new Error(
                    lanes
                      .map((lane) => lane.error)
                      .filter(Boolean)
                      .join("; ") || "Review failed",
                  ),
                )
              if (input.json) {
                yield* Console.log(JSON.stringify({ status: inspection.state, lanes }))
                return
              }
              yield* Console.log(
                lanes
                  .map(
                    (lane) =>
                      `## ${lane.id}\n${lane.output === undefined ? `Review lane ${lane.status}${lane.error === undefined ? "" : `: ${lane.error}`}` : typeof lane.output === "string" ? lane.output : JSON.stringify(lane.output)}`,
                  )
                  .join("\n\n"),
              )
            })
            const agentLayer = options.productAgentLayer ?? ProductAgent.layer
            yield* program.pipe(
              Effect.provide(options.toolRuntimeLayer(workspace)),
              Effect.provide(agentLayer.pipe(Layer.provide(options.backendLayer))),
              Effect.scoped,
              Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
            )
            return
          }
          if (input._tag === "ToolCatalog") {
            if (input.action === "list") {
              yield* Console.log(JSON.stringify(ToolCatalog.definitions))
              return
            }
            const definition = ToolCatalog.get(input.name)
            if (definition === undefined)
              return yield* Effect.fail(unavailable(input, `Tool ${input.name} does not exist`))
            yield* Console.log(JSON.stringify(definition))
            return
          }
          if (
            (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") &&
            options.extensionOperations !== undefined
          ) {
            yield* ExtensionOperations.run(input).pipe(
              Effect.provide(options.extensionOperations.layer),
              Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
            )
            return
          }
          if (
            (input._tag === "Config" ||
              input._tag === "Doctor" ||
              (input._tag === "Mcp" && input.action === "doctor")) &&
            options.configOperations !== undefined
          ) {
            yield* ConfigOperations.run(input, options.configOperations.options).pipe(
              Effect.provide(options.configOperations.layer),
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
                  JSON.stringify(yield* backend.startWorkflow(input.name, input.runId, input.revision)),
                )
                return
              }
              const inspection = yield* backend.inspectWorkflow(input.runId)
              if (inspection === undefined)
                return yield* Effect.fail(new Error(`Workflow run ${input.runId} does not exist`))
              yield* Console.log(JSON.stringify(inspection))
            })
            yield* program.pipe(
              Effect.provide(options.backendLayer),
              Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
            )
            return
          }
          if (input._tag !== "Thread") return yield* Effect.fail(unavailable(input))
          const program = Effect.gen(function* () {
            const repository = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const now = yield* Clock.currentTimeMillis
            switch (input.action) {
              case "new": {
                const id = yield* options.makeThreadId
                const thread = yield* repository.create({
                  id,
                  workspace: options.defaultWorkspace,
                  title: "New thread",
                  now,
                })
                yield* writeThread(thread)
                return
              }
              case "list": {
                const threads = yield* repository.list({
                  ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                })
                yield* Console.log(JSON.stringify(threads))
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
                yield* Console.log(JSON.stringify(matches))
                return
              }
              case "last":
              case "top": {
                const thread = (yield* repository.list({ limit: 1 }))[0]
                if (thread === undefined) return yield* Effect.fail(new Error("No threads exist"))
                yield* writeThread(thread)
                return
              }
              case "continue": {
                yield* Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  let selected: Thread.Thread | ReadonlyArray<Thread.Thread>
                  if ("last" in input) {
                    const thread = (yield* repository.list({ limit: 1 }))[0]
                    if (thread === undefined) return yield* Effect.fail(new Error("No threads exist"))
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
                  yield* Console.log(JSON.stringify(Array.isArray(selected) ? continued : continued[0]))
                }).pipe(Effect.provide(options.backendLayer), Effect.scoped)
                return
              }
              case "rename":
                yield* repository
                  .rename(Thread.ThreadId.make(input.threadId), input.title, now)
                  .pipe(Effect.flatMap(writeThread))
                return
              case "label":
                yield* repository
                  .label(Thread.ThreadId.make(input.threadId), input.labels, now)
                  .pipe(Effect.flatMap(writeThread))
                return
              case "pin":
                yield* repository
                  .setPinned(Thread.ThreadId.make(input.threadId), true, now)
                  .pipe(Effect.flatMap(writeThread))
                return
              case "archive":
                yield* repository
                  .setArchived(Thread.ThreadId.make(input.threadId), true, now)
                  .pipe(Effect.flatMap(writeThread))
                return
              case "unarchive":
                yield* repository
                  .setArchived(Thread.ThreadId.make(input.threadId), false, now)
                  .pipe(Effect.flatMap(writeThread))
                return
              case "delete":
                yield* repository.remove(Thread.ThreadId.make(input.threadId))
                return
              case "export": {
                const thread = yield* requireThread(repository, input.threadId)
                const threadTurns = yield* turns.list(thread.id)
                yield* Console.log(
                  input.format === "json"
                    ? JSON.stringify({ thread, turns: threadTurns })
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
                yield* Console.log(JSON.stringify({ threadId: thread.id, turns: threadTurns.length, statuses }))
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
                  return yield* Effect.fail(
                    new Error(`Turn ${input.atTurn} does not exist in thread ${input.threadId}`),
                  )
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
                    now: sourceTurn.createdAt,
                  })
                  yield* turns.setStatus(copied.id, sourceTurn.status, sourceTurn.lastCursor, sourceTurn.updatedAt)
                }
                yield* writeThread(yield* requireThread(repository, fork.id))
                return
              }
            }
          })
          yield* program.pipe(
            Effect.provide(Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)),
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
