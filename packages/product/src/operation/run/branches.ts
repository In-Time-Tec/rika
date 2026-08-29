import { Function } from "effect"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Thread from "@rika/product/thread-record"
import * as NoninteractiveOperation from "../dispatch/noninteractive"
import * as ExtensionOperations from "../contract/extension"
import * as ConfigurationOperation from "./configuration"
import * as ThreadOperation from "../dispatch/thread"
import { Console, Context, Effect, Layer } from "effect"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Input, OperationUnavailable } from "../contract/product"
import type { InteractiveSession } from "../interactive/session"
import { OperationError } from "../error"
import type { ProductOperationRuntimeState } from "../runtime/state"
import type { ProductLayerOptions } from "../foundation/options"
import type { FileSystem, Path } from "effect"

export interface ProductOperationRunFactory extends ProductOperationRuntimeState {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly console: Console.Console
  readonly fileSystem: FileSystem.FileSystem | undefined
  readonly path: Path.Path | undefined
  readonly backend: import("@rika/product/execution-gateway").Interface
  readonly writeThread: (thread: Thread.Thread) => Effect.Effect<void>
  readonly requireThread: (
    repository: ThreadRepository.Interface,
    id: string,
  ) => Effect.Effect<Thread.Thread, OperationError, never>
  readonly markdownExport: (
    thread: Thread.Thread,
    turns: ReadonlyArray<import("@rika/product/turn-record").Turn>,
  ) => string
  readonly unavailable: (input: Input, message?: string) => OperationUnavailable
  readonly operationError: typeof import("../error").operationError
  readonly encodeJson: <Value>(value: Value) => string
  readonly extensionOperations: typeof ExtensionOperations
  readonly configOperations: typeof import("../contract/configuration")
  readonly publishInteractiveActivity: (
    origin: number,
    event: import("../interactive/session-event").InteractiveEvent,
  ) => import("../interactive/session-event").InteractiveEvent
  readonly staleQueuedTurnsError: typeof import("../../thread/queue/pending-policy").staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly repairSummariesOnce: Effect.Effect<void, never, never>
}

const unavailable = (
  factory: ProductOperationRunFactory,
  input: Input,
  message?: string,
): import("../contract/product").OperationUnavailable => factory.unavailable(input, message ?? "Operation unavailable")

const runInteractiveOperationImpl = (
  factory: ProductOperationRunFactory,
  input: Extract<Input, { readonly _tag: "Interactive" }>,
) =>
  Effect.gen(function* () {
    const typedDependencyContext: Context.Context<ThreadSummaryRepository.Service | ThreadRepository.Service> =
      factory.dependencyContext
    const typedMakeInteractiveSession: (
      workspace: string,
      settings: { readonly initialThreadId?: string; readonly observeExecution?: boolean },
    ) => Effect.Effect<
      { readonly session: InteractiveSession; readonly close: Effect.Effect<void, never, never> },
      OperationError,
      never
    > = factory.makeInteractiveSession
    if (factory.options.interactive === undefined) return
    const typedInteractiveRun = factory.options.interactive
    let initialThreadId = input.threadId
    if (input.last === true) {
      const summary = (yield* Context.get(typedDependencyContext, ThreadSummaryRepository.Service)
        .list({ limit: 1 })
        .pipe(Effect.mapError((error) => unavailable(factory, input, String(error)))))[0]
      if (summary === undefined) return yield* unavailable(factory, input, "No threads exist")
      initialThreadId = String(summary.id)
    }
    if (initialThreadId !== undefined) {
      const thread = yield* Context.get(typedDependencyContext, ThreadRepository.Service)
        .get(Thread.ThreadId.make(initialThreadId))
        .pipe(Effect.mapError((error) => unavailable(factory, input, String(error))))
      if (thread === undefined) return yield* unavailable(factory, input, `Thread ${initialThreadId} does not exist`)
    }
    const observeExecution = factory.options.executionProjectionOwner !== "external"
    const settings: { readonly initialThreadId?: string; readonly observeExecution?: boolean } =
      initialThreadId === undefined ? { observeExecution } : { initialThreadId, observeExecution }
    const made = yield* typedMakeInteractiveSession(input.workspace ?? factory.options.defaultWorkspace, settings)
    yield* typedInteractiveRun(input, made.session).pipe(Effect.ensuring(made.close))
  })

export const runInteractiveOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Interactive" }>,
  ): (arg0: ProductOperationRunFactory) => ReturnType<typeof runInteractiveOperationImpl>
  (
    arg0: ProductOperationRunFactory,
    arg1: Extract<Input, { readonly _tag: "Interactive" }>,
  ): ReturnType<typeof runInteractiveOperationImpl>
} = Function.dual(2, runInteractiveOperationImpl)

const runNoninteractiveOperationImpl = (
  factory: ProductOperationRunFactory,
  input: Extract<Input, { readonly _tag: "Run" | "Review" }>,
) => {
  const typedExecutionDependencies = factory.executionDependencies
  return NoninteractiveOperation.run(input, {
    defaultWorkspace: factory.options.defaultWorkspace,
    pendingTurnCapacity: factory.pendingTurnCapacity,
    makeThreadId: factory.options.makeThreadId,
    makeTurnId: factory.options.makeTurnId,
    resolveExecutionRoute: (mode, tuning, workspace) =>
      factory.resolveExecutionRoute(mode, tuning, workspace).pipe(Effect.provide(typedExecutionDependencies)),
    createObservedSubmission: (turns, submission) =>
      factory.createObservedSubmission(turns, submission).pipe(Effect.provide(typedExecutionDependencies)),
    ensureTurnSummary: (turn) => factory.ensureTurnSummary(turn).pipe(Effect.provide(typedExecutionDependencies)),
    setTurnStatus: (id, status, now) =>
      factory.setTurnStatus(id, status, now).pipe(Effect.provide(typedExecutionDependencies)),
    publishInteractiveActivity: factory.publishInteractiveActivity,
    rootTurnOwner: factory.rootTurnOwner,
    prepareExecution: (turn, workspace) =>
      factory.prepareExecution(turn, workspace).pipe(Effect.provide(typedExecutionDependencies)),
    claimQueuedTurn: (threadId, now) =>
      factory.claimQueuedTurn(threadId, now).pipe(Effect.provide(typedExecutionDependencies)),
    releaseTurnObserver: factory.releaseTurnObserver,
    queueMutationEvent: factory.queueMutationEvent,
    executionDependencies: typedExecutionDependencies,
    staleQueuedTurnsError: factory.staleQueuedTurnsError,
    queuedTurnPromoteMaxAgeMs: factory.queuedTurnPromoteMaxAgeMs,
    operationError: factory.operationError,
    unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
  })
}

export const runNoninteractiveOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Run" | "Review" }>,
  ): (arg0: ProductOperationRunFactory) => ReturnType<typeof runNoninteractiveOperationImpl>
  (
    arg0: ProductOperationRunFactory,
    arg1: Extract<Input, { readonly _tag: "Run" | "Review" }>,
  ): ReturnType<typeof runNoninteractiveOperationImpl>
} = Function.dual(2, runNoninteractiveOperationImpl)

const runExtensionOperationImpl = (
  factory: ProductOperationRunFactory,
  input: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
) =>
  Effect.gen(function* () {
    const typedExtensionOperations: import("../foundation/integrations").ProductExtensionOperations | undefined =
      factory.options.extensionOperations
    if (typedExtensionOperations === undefined) return
    const extensionLayer = typedExtensionOperations.layer
    const context = yield* Layer.build(extensionLayer).pipe(
      Effect.mapError((error) => unavailable(factory, input, String(error))),
    )
    yield* ExtensionOperations.run(input).pipe(
      Effect.provide(context),
      Effect.provideService(Console.Console, factory.console),
      Effect.mapError((error) => unavailable(factory, input, error instanceof Error ? error.message : String(error))),
    )
  }).pipe(Effect.scoped)

export const runExtensionOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
  ): (arg0: ProductOperationRunFactory) => ReturnType<typeof runExtensionOperationImpl>
  (
    arg0: ProductOperationRunFactory,
    arg1: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
  ): ReturnType<typeof runExtensionOperationImpl>
} = Function.dual(2, runExtensionOperationImpl)

const runSystemOperationImpl = (
  factory: ProductOperationRunFactory,
  input: Input,
): Effect.Effect<void, OperationError | OperationUnavailable, never> => {
  if (input._tag === "ToolCatalog") {
    if (input.action === "list") return Console.log(factory.encodeJson(ToolCatalog.definitions))
    const definition = ToolCatalog.get(input.name)
    return definition === undefined
      ? unavailable(factory, input, `Tool ${input.name} does not exist`)
      : Console.log(factory.encodeJson(definition)).pipe(Effect.provideService(Console.Console, factory.console))
  }
  if (
    (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") &&
    factory.options.extensionOperations !== undefined
  )
    return runExtensionOperation(factory, input)
  if (
    (input._tag === "Config" || input._tag === "Doctor" || (input._tag === "Mcp" && input.action === "doctor")) &&
    factory.options.configOperations !== undefined
  )
    return ConfigurationOperation.runConfigurationOperation(factory, input)
  if (input._tag === "Thread") {
    const typedSystemExecutionDependencies: Context.Context<
      ThreadRepository.Service | TurnRepository.Service | ThreadSummaryRepository.Service | TranscriptRepository.Service
    > = factory.dependencyContext
    const typedNotifyThreadSummaries = factory.notifyThreadSummaries.pipe(
      Effect.mapError((error) => factory.operationError(error.message, error)),
    )
    const threadDependencies: ThreadOperation.Dependencies = {
      defaultWorkspace: factory.options.defaultWorkspace,
      pendingTurnCapacity: factory.pendingTurnCapacity,
      makeThreadId: factory.options.makeThreadId,
      makeTurnId: factory.options.makeTurnId,
      withThreadMutation: factory.withThreadMutation,
      backend: factory.backend,
      notifyThreadSummaries: typedNotifyThreadSummaries,
      deleteThread: factory.deleteThread,
      writeThread: factory.writeThread,
      requireThread: factory.requireThread,
      markdownExport: factory.markdownExport,
      encodeJson: factory.encodeJson,
      unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
    }
    return ThreadOperation.run(input, threadDependencies).pipe(Effect.provide(typedSystemExecutionDependencies))
  }
  return unavailable(factory, input)
}

export const runSystemOperation: {
  (arg1: Input): (arg0: ProductOperationRunFactory) => ReturnType<typeof runSystemOperationImpl>
  (arg0: ProductOperationRunFactory, arg1: Input): ReturnType<typeof runSystemOperationImpl>
} = Function.dual(2, runSystemOperationImpl)
