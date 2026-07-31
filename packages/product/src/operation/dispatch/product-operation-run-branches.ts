import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as NoninteractiveOperation from "./noninteractive-operation-dispatch"
import * as ReviewOperation from "./review-operation-dispatch"
import * as ExtensionOperations from "./extension-operation-dispatch"
import * as ConfigOperations from "./configuration-operation-dispatch"
import * as WorkflowOperation from "./workflow-operation-dispatch"
import * as ThreadOperation from "./thread-operation-dispatch"
import { Console, Context, Effect, Layer } from "effect"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Input } from "../contract/product-operation"
import type { ModeId } from "@rika/configuration/behavior-mode"

export const runInteractiveOperation = (factory: any, input: Extract<Input, { readonly _tag: "Interactive" }>) =>
  Effect.gen(function* () {
    if (factory.options.interactive === undefined) return
    let initialThreadId = input.threadId
    if (input.last === true) {
      const summary = (yield* Context.get(factory.dependencyContext, ThreadSummaryRepository.Service)
        .list({ limit: 1 })
        .pipe(Effect.mapError((error) => factory.unavailable(input, String(error)))))[0]
      if (summary === undefined) return yield* factory.unavailable(input, "No threads exist")
      initialThreadId = String(summary.id)
    }
    if (initialThreadId !== undefined) {
      const thread = yield* Context.get(factory.dependencyContext, ThreadRepository.Service)
        .get(Thread.ThreadId.make(initialThreadId))
        .pipe(Effect.mapError((error) => factory.unavailable(input, String(error))))
      if (thread === undefined) return yield* factory.unavailable(input, `Thread ${initialThreadId} does not exist`)
    }
    const made = yield* factory.makeInteractiveSession(
      input.workspace ?? factory.options.defaultWorkspace,
      initialThreadId === undefined ? {} : { initialThreadId },
    ) as any
    yield* factory.options.interactive(input, made.session).pipe(Effect.ensuring(made.close))
  })

export const runNoninteractiveOperation = (factory: any, input: Extract<Input, { readonly _tag: "Run" }>) =>
  NoninteractiveOperation.run(input, {
    defaultWorkspace: factory.options.defaultWorkspace,
    pendingTurnCapacity: factory.pendingTurnCapacity,
    makeThreadId: factory.options.makeThreadId,
    makeTurnId: factory.options.makeTurnId,
    resolveExecutionRoute: (mode: string, tuning: any, workspace?: string) =>
      factory.resolveExecutionRoute(mode, tuning, workspace).pipe(Effect.provide(factory.executionDependencies)),
    createObservedSubmission: (turns: any, submission: any) =>
      factory.createObservedSubmission(turns, submission).pipe(Effect.provide(factory.executionDependencies)),
    ensureTurnSummary: (turn: any) =>
      factory.ensureTurnSummary(turn).pipe(Effect.provide(factory.executionDependencies)),
    setTurnStatus: (id: any, status: any, cursor: any, now: number) =>
      factory.setTurnStatus(id, status, cursor, now).pipe(Effect.provide(factory.executionDependencies)),
    publishInteractiveActivity: factory.publishInteractiveActivity,
    rootTurnOwner: factory.rootTurnOwner,
    executionIngest: factory.executionIngest,
    prepareExecution: (turn: any, workspace: string, persist?: boolean) =>
      factory.prepareExecution(turn, workspace, persist).pipe(Effect.provide(factory.executionDependencies)),
    claimQueuedTurn: (threadId: any, now: number) =>
      factory.claimQueuedTurn(threadId, now).pipe(Effect.provide(factory.executionDependencies)),
    releaseTurnObserver: factory.releaseTurnObserver,
    queueMutationEvent: factory.queueMutationEvent,
    deliverResultEvents: factory.deliverResultEvents,
    projectExecutionResult: (threadId: any, result: any) =>
      factory.projectExecutionResult(threadId, result).pipe(Effect.provide(factory.executionDependencies)),
    ensureIngest: factory.ensureIngest,
    awaitIngestSettled: factory.awaitIngestSettled,
    executionDependencies: factory.executionDependencies,
    followClaimed:
      factory.owner.followClaimed === undefined
        ? undefined
        : (turnId: any) =>
            factory.owner.followClaimed!(turnId).pipe(
              Effect.provide(factory.executionDependencies),
              Effect.asVoid,
            ) as any,
    staleQueuedTurnsError: factory.staleQueuedTurnsError,
    queuedTurnPromoteMaxAgeMs: factory.queuedTurnPromoteMaxAgeMs,
    awaitSessionQuiescence: (backend: any, threadId: any) =>
      factory.awaitSessionQuiescence(backend, threadId).pipe(Effect.provide(factory.executionDependencies)),
    operationError: factory.operationError,
    unavailable: factory.unavailable,
  })

export const runReviewOperation = (factory: any, input: Extract<Input, { readonly _tag: "Review" }>) =>
  Effect.gen(function* () {
    if (factory.options.toolRuntimeLayer === undefined)
      return yield* factory.unavailable(input, "Review requires the local tool runtime")
    yield* ReviewOperation.run(input, {
      defaultWorkspace: factory.options.defaultWorkspace,
      pendingTurnCapacity: factory.pendingTurnCapacity,
      makeThreadId: factory.options.makeThreadId,
      makeTurnId: factory.options.makeTurnId,
      resolveExecutionRoute: (mode: ModeId) =>
        factory
          .resolveExecutionRoute(mode, undefined, input.workspace ?? factory.options.defaultWorkspace)
          .pipe(Effect.provide(factory.executionDependencies)),
      toolRuntimeLayer: factory.options.toolRuntimeLayer,
      productAgentLayer: factory.options.productAgentLayer,
      backendLayer: factory.backendLayer,
      acquiredDependencies: factory.acquiredDependencies,
      createObservedSubmission: (turns: any, submission: any) =>
        factory.createObservedSubmission(turns, submission).pipe(Effect.provide(factory.executionDependencies)),
      ensureTurnSummary: (turn: any) =>
        factory.ensureTurnSummary(turn).pipe(Effect.provide(factory.executionDependencies)),
      setTurnStatus: (id: any, status: any, cursor: any, now: number) =>
        factory.setTurnStatus(id, status, cursor, now).pipe(Effect.provide(factory.executionDependencies)),
      startReviewSettlement: (turn: any, fanOutId: string, initial: any) =>
        factory.startReviewSettlement(turn, fanOutId, initial).pipe(Effect.provide(factory.executionDependencies)),
      releaseTurnObserver: (turnId: any) => factory.releaseTurnObserver(turnId).pipe(Effect.asVoid),
      encodeJson: factory.encodeJson,
      operationError: factory.operationError,
      unavailable: factory.unavailable,
    })
  })

export const runExtensionOperation = (
  factory: any,
  input: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
) =>
  Effect.gen(function* () {
    if (factory.options.extensionOperations === undefined) return
    const context = yield* Layer.build(factory.options.extensionOperations.layer).pipe(
      Effect.mapError((error) => factory.unavailable(input, String(error))),
    )
    yield* ExtensionOperations.run(input).pipe(
      Effect.provide(context),
      Effect.mapError((error) => factory.unavailable(input, error instanceof Error ? error.message : String(error))),
    )
  }).pipe(Effect.scoped)

export const runConfigurationOperation = (
  factory: any,
  input: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
) =>
  Effect.gen(function* () {
    if (factory.options.configOperations === undefined || (input._tag === "Mcp" && input.action !== "doctor")) return
    const config =
      factory.options.configOperations.forWorkspace === undefined
        ? factory.options.configOperations
        : yield* factory.options.configOperations
            .forWorkspace(input.clientWorkspace ?? factory.options.defaultWorkspace)
            .pipe(Effect.mapError((error) => factory.unavailable(input, String(error))))
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(config.layer)
      yield* ConfigOperations.run(input, config.options).pipe(Effect.provide(context))
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => factory.unavailable(input, String(error))),
    )
  })

export const runSystemOperation = (factory: any, input: Input) => {
  if (input._tag === "ToolCatalog") {
    if (input.action === "list") return Console.log(factory.encodeJson(ToolCatalog.definitions))
    const definition = ToolCatalog.get(input.name)
    return definition === undefined
      ? factory.unavailable(input, `Tool ${input.name} does not exist`)
      : Console.log(factory.encodeJson(definition))
  }
  if (input._tag === "Auth" && factory.options.authOperations !== undefined)
    return Effect.scoped(factory.runAuth(input, factory.options.authOperations, factory.options.defaultWorkspace))
  if (
    (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") &&
    factory.options.extensionOperations !== undefined
  )
    return runExtensionOperation(factory, input)
  if (
    (input._tag === "Config" || input._tag === "Doctor" || (input._tag === "Mcp" && input.action === "doctor")) &&
    factory.options.configOperations !== undefined
  )
    return runConfigurationOperation(factory, input)
  if (input._tag === "Workflow")
    return WorkflowOperation.run(input, {
      backend: factory.backend,
      encodeJson: factory.encodeJson,
      unavailable: factory.unavailable,
    })
  if (input._tag === "Thread")
    return ThreadOperation.run(input, {
      defaultWorkspace: factory.options.defaultWorkspace,
      pendingTurnCapacity: factory.pendingTurnCapacity,
      makeThreadId: factory.options.makeThreadId,
      makeTurnId: factory.options.makeTurnId,
      turnMutationAdmission: factory.turnMutationAdmission,
      backend: factory.backend,
      usageRepository: factory.usageRepository,
      notifyThreadSummaries: factory.notifyThreadSummaries,
      writeThread: factory.writeThread,
      requireThread: factory.requireThread,
      markdownExport: factory.markdownExport,
      encodeJson: factory.encodeJson,
      unavailable: factory.unavailable,
    }).pipe(Effect.provide(factory.executionDependencies))
  return factory.unavailable(input)
}
