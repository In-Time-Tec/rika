import { Function } from "effect"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Thread from "@rika/product/thread-record"
import * as NoninteractiveOperation from "./noninteractive-operation-dispatch"
import * as ReviewOperation from "./review-operation-dispatch"
import * as ExtensionOperations from "./../contract/extension-operation"
import * as WorkflowOperation from "./workflow-operation-dispatch"
import * as ConfigurationOperation from "./product-operation-run-configuration"
import * as ThreadOperation from "./thread-operation-dispatch"
import { Console, Context, Effect, Layer } from "effect"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Input, OperationUnavailable } from "../contract/product-operation"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { InteractiveSession } from "../interactive/interactive-session"
import { OperationError } from "../operation-error"

const unavailable = (
  factory: any,
  input: Input,
  message?: string,
): import("../contract/product-operation").OperationUnavailable =>
  factory.unavailable(input, message ?? "Operation unavailable")

const runInteractiveOperationImpl = (factory: any, input: Extract<Input, { readonly _tag: "Interactive" }>) =>
  Effect.gen(function* () {
    const typedDependencyContext: Context.Context<ThreadSummaryRepository.Service | ThreadRepository.Service> =
      factory.dependencyContext
    const typedMakeInteractiveSession: (
      workspace: string,
      settings: { readonly initialThreadId?: string },
    ) => Effect.Effect<
      { readonly session: InteractiveSession; readonly close: Effect.Effect<void, never, never> },
      OperationError,
      never
    > = factory.makeInteractiveSession
    const typedInteractiveRun: (
      input: Extract<Input, { readonly _tag: "Interactive" }>,
      session: InteractiveSession,
    ) => Effect.Effect<void, OperationError, never> = factory.options.interactive
    if (factory.options.interactive === undefined) return
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
    const made = yield* typedMakeInteractiveSession(
      input.workspace ?? factory.options.defaultWorkspace,
      initialThreadId === undefined ? {} : { initialThreadId },
    )
    yield* typedInteractiveRun(input, made.session).pipe(Effect.ensuring(made.close))
  })

export const runInteractiveOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Interactive" }>,
  ): (arg0: any) => ReturnType<typeof runInteractiveOperationImpl>
  (arg0: any, arg1: Extract<Input, { readonly _tag: "Interactive" }>): ReturnType<typeof runInteractiveOperationImpl>
} = Function.dual(2, runInteractiveOperationImpl)

const runNoninteractiveOperationImpl = (factory: any, input: Extract<Input, { readonly _tag: "Run" }>) => {
  const typedExecutionDependencies: NoninteractiveOperation.Dependencies["executionDependencies"] =
    factory.executionDependencies
  return NoninteractiveOperation.run(input, {
    defaultWorkspace: factory.options.defaultWorkspace,
    pendingTurnCapacity: factory.pendingTurnCapacity,
    makeThreadId: factory.options.makeThreadId,
    makeTurnId: factory.options.makeTurnId,
    resolveExecutionRoute: (mode: string, tuning: any, workspace?: string) =>
      factory.resolveExecutionRoute(mode, tuning, workspace).pipe(Effect.provide(typedExecutionDependencies)),
    createObservedSubmission: (turns: any, submission: any) =>
      factory.createObservedSubmission(turns, submission).pipe(Effect.provide(typedExecutionDependencies)),
    ensureTurnSummary: (turn: any) => factory.ensureTurnSummary(turn).pipe(Effect.provide(typedExecutionDependencies)),
    setTurnStatus: (id: any, status: any, cursor: any, now: number) =>
      factory.setTurnStatus(id, status, cursor, now).pipe(Effect.provide(typedExecutionDependencies)),
    publishInteractiveActivity: factory.publishInteractiveActivity,
    rootTurnOwner: factory.rootTurnOwner,
    executionIngest: factory.executionIngest,
    prepareExecution: (turn: any, workspace: string, persist?: boolean) =>
      factory.prepareExecution(turn, workspace, persist).pipe(Effect.provide(typedExecutionDependencies)),
    claimQueuedTurn: (threadId: any, now: number) =>
      factory.claimQueuedTurn(threadId, now).pipe(Effect.provide(typedExecutionDependencies)),
    releaseTurnObserver: factory.releaseTurnObserver,
    queueMutationEvent: factory.queueMutationEvent,
    deliverResultEvents: factory.deliverResultEvents,
    projectExecutionResult: (threadId: any, result: any) =>
      factory.projectExecutionResult(threadId, result).pipe(Effect.provide(typedExecutionDependencies)),
    ensureIngest: factory.ensureIngest,
    awaitIngestSettled: factory.awaitIngestSettled,
    executionDependencies: typedExecutionDependencies,
    followClaimed:
      factory.owner.followClaimed === undefined
        ? undefined
        : (turnId: any) =>
            factory.owner.followClaimed!(turnId).pipe(Effect.provide(typedExecutionDependencies), Effect.asVoid),
    staleQueuedTurnsError: factory.staleQueuedTurnsError,
    queuedTurnPromoteMaxAgeMs: factory.queuedTurnPromoteMaxAgeMs,
    awaitSessionQuiescence: (backend: any, threadId: any) =>
      factory.awaitSessionQuiescence(backend, threadId).pipe(Effect.provide(typedExecutionDependencies)),
    operationError: factory.operationError,
    unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
  })
}

export const runNoninteractiveOperation: {
  (arg1: Extract<Input, { readonly _tag: "Run" }>): (arg0: any) => ReturnType<typeof runNoninteractiveOperationImpl>
  (arg0: any, arg1: Extract<Input, { readonly _tag: "Run" }>): ReturnType<typeof runNoninteractiveOperationImpl>
} = Function.dual(2, runNoninteractiveOperationImpl)

const runReviewOperationImpl = (factory: any, input: Extract<Input, { readonly _tag: "Review" }>) => {
  const typedExecutionDependencies: NoninteractiveOperation.Dependencies["executionDependencies"] =
    factory.executionDependencies
  return Effect.gen(function* () {
    if (factory.options.toolRuntimeLayer === undefined)
      return yield* unavailable(factory, input, "Review requires the local tool runtime")
    yield* ReviewOperation.run(input, {
      defaultWorkspace: factory.options.defaultWorkspace,
      pendingTurnCapacity: factory.pendingTurnCapacity,
      makeThreadId: factory.options.makeThreadId,
      makeTurnId: factory.options.makeTurnId,
      resolveExecutionRoute: (mode: ModeId) =>
        factory
          .resolveExecutionRoute(mode, undefined, input.workspace ?? factory.options.defaultWorkspace)
          .pipe(Effect.provide(typedExecutionDependencies)),
      toolRuntimeLayer: factory.options.toolRuntimeLayer,
      productAgentLayer: factory.options.productAgentLayer,
      backendLayer: factory.backendLayer,
      acquiredDependencies: factory.acquiredDependencies,
      createObservedSubmission: (turns: any, submission: any) =>
        factory.createObservedSubmission(turns, submission).pipe(Effect.provide(typedExecutionDependencies)),
      ensureTurnSummary: (turn: any) =>
        factory.ensureTurnSummary(turn).pipe(Effect.provide(typedExecutionDependencies)),
      setTurnStatus: (id: any, status: any, cursor: any, now: number) =>
        factory.setTurnStatus(id, status, cursor, now).pipe(Effect.provide(typedExecutionDependencies)),
      startReviewSettlement: (turn: any, fanOutId: string, initial: any) =>
        factory.startReviewSettlement(turn, fanOutId, initial).pipe(Effect.provide(typedExecutionDependencies)),
      releaseTurnObserver: (turnId: any) => factory.releaseTurnObserver(turnId).pipe(Effect.asVoid),
      encodeJson: factory.encodeJson,
      operationError: factory.operationError,
      unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
    })
  })
}

export const runReviewOperation: {
  (arg1: Extract<Input, { readonly _tag: "Review" }>): (arg0: any) => ReturnType<typeof runReviewOperationImpl>
  (arg0: any, arg1: Extract<Input, { readonly _tag: "Review" }>): ReturnType<typeof runReviewOperationImpl>
} = Function.dual(2, runReviewOperationImpl)

const runExtensionOperationImpl = (
  factory: any,
  input: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
) =>
  Effect.gen(function* () {
    const typedExtensionOperations: import("./product-operation-integrations").ProductExtensionOperations | undefined =
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
  ): (arg0: any) => ReturnType<typeof runExtensionOperationImpl>
  (
    arg0: any,
    arg1: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
  ): ReturnType<typeof runExtensionOperationImpl>
} = Function.dual(2, runExtensionOperationImpl)

const runSystemOperationImpl = (
  factory: any,
  input: Input,
): Effect.Effect<void, OperationError | OperationUnavailable, never> => {
  const typedRunAuth: (
    input: Extract<Input, { readonly _tag: "Auth" }>,
    options: any,
    workspace: string,
  ) => Effect.Effect<void, OperationError, never> = factory.runAuth
  if (input._tag === "ToolCatalog") {
    if (input.action === "list") return Console.log(factory.encodeJson(ToolCatalog.definitions))
    const definition = ToolCatalog.get(input.name)
    return definition === undefined
      ? unavailable(factory, input, `Tool ${input.name} does not exist`)
      : Console.log(factory.encodeJson(definition)).pipe(Effect.provideService(Console.Console, factory.console))
  }
  if (input._tag === "Auth" && factory.options.authOperations !== undefined)
    return Effect.scoped(typedRunAuth(input, factory.options.authOperations, factory.options.defaultWorkspace))
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
  if (input._tag === "Workflow")
    return WorkflowOperation.run(input, {
      backend: factory.backend,
      encodeJson: factory.encodeJson,
      unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
    }).pipe(Effect.provideService(Console.Console, factory.console))
  if (input._tag === "Thread") {
    const typedSystemExecutionDependencies: Context.Context<
      ThreadRepository.Service | TurnRepository.Service | ThreadSummaryRepository.Service | TranscriptRepository.Service
    > = factory.dependencyContext
    const typedNotifyThreadSummaries: Effect.Effect<void, OperationError, ThreadSummaryRepository.Service> =
      factory.notifyThreadSummaries
    const threadDependencies: ThreadOperation.Dependencies = {
      defaultWorkspace: factory.options.defaultWorkspace,
      pendingTurnCapacity: factory.pendingTurnCapacity,
      makeThreadId: factory.options.makeThreadId,
      makeTurnId: factory.options.makeTurnId,
      turnMutationAdmission: factory.turnMutationAdmission,
      backend: factory.backend,
      usageRepository: factory.usageRepository,
      notifyThreadSummaries: typedNotifyThreadSummaries,
      writeThread: factory.writeThread,
      requireThread: factory.requireThread,
      markdownExport: factory.markdownExport,
      encodeJson: factory.encodeJson,
      unavailable: (operationInput: Input, message: string) => unavailable(factory, operationInput, message),
    }
    return ThreadOperation.run(input, threadDependencies).pipe(
      Effect.provide(typedSystemExecutionDependencies),
      Effect.provideService(Console.Console, factory.console),
    )
  }
  return unavailable(factory, input)
}

export const runSystemOperation: {
  (arg1: Input): (arg0: any) => ReturnType<typeof runSystemOperationImpl>
  (arg0: any, arg1: Input): ReturnType<typeof runSystemOperationImpl>
} = Function.dual(2, runSystemOperationImpl)
