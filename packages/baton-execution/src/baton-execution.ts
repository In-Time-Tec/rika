import { ModelRegistry } from "tenetkit"
import type { HarnessState } from "tenetkit/harness"
import { KernelPool, KernelStateStore } from "tenetkit/repl"
import type * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as CellCallContext from "./baton-cell-call-context"
import { Approval, Run, RunTree, Runtime } from "tenetkit/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import type { Status } from "@rika/product/execution-status"
import { ProviderCredentialStore, type ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
export type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
export type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Cause, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import {
  type CellResolver,
  type KernelOptions,
  type LocalCellResolver,
  type LocalCellServices,
  type RemoteCellRoute,
  resolveCellRoute,
} from "./baton-route-options"
import { configure, makeResolver } from "./baton-route"
import * as PostgresControlPlane from "./postgres-control-plane"
import { TreeProjector } from "./projection/tree"
import { resolveSemanticTreeEvent } from "./projection/semantic-event"

/**
 * The runtime database always lives directly under the profile data root as `<dataRoot>/baton.db`,
 * so the root the kernel pins is derived from the one path the composition root already supplies
 * rather than threaded through the product Turn contract. Deriving it keeps the pinned profile
 * describing the kernel this host actually runs; a supplied value overrides it verbatim.
 */
const derivedKernelOptions = (filename: string): KernelOptions => {
  const separator = filename.lastIndexOf("/")
  return { runtimeVersion: Bun.version, dataRoot: separator > 0 ? filename.slice(0, separator) : "." }
}

/** The kernel a cell runs in, plus the seam that answers its host requests. */
export type KernelPoolServices = KernelPool.KernelPool | CellCallContext.CellCallContext

export interface LocalCellAdapter extends LocalCellResolver {
  readonly built: Effect.Effect<
    ReadonlyArray<
      Context.Context<KernelPoolServices> | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
    >
  >
}

export type CellAdapter = LocalCellAdapter | RemoteCellRoute

interface SharedOptions {
  readonly kernel: KernelOptions
  readonly cell: CellAdapter
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: HarnessState.HarnessState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly credentialStore?: Layer.Layer<ProviderCredentialStore, never, never>
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
  readonly subscriberQueueCapacity?: number
  readonly scheduler?: Runtime.LayerOptions["scheduler"]
}

export interface Options extends SharedOptions {
  readonly postgres: PostgresControlPlane.Options
}

export interface SqliteTestOptions extends Omit<SharedOptions, "kernel"> {
  readonly filename: string
  readonly kernel?: KernelOptions
}

export interface LocalCellAdapterOptions {
  readonly forWorkspace: (
    workspace: string,
  ) => Effect.Effect<
    Context.Context<KernelPoolServices> | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
  >
  /**
   * Every kernel built so far. A Session is closed by thread, not by workspace, and a thread that
   * moved between workspaces has state in more than one, so closing asks all of them.
   */
  readonly built: Effect.Effect<
    ReadonlyArray<
      Context.Context<KernelPoolServices> | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
    >
  >
}

export const localCellAdapter = (options: LocalCellAdapterOptions): LocalCellAdapter => ({
  _tag: "Local",
  ...options,
})

export const remoteCellAdapter = (options: Omit<RemoteCellRoute, "_tag">): RemoteCellRoute => ({
  _tag: "Remote",
  ...options,
})

const cellResolver = (cell: CellAdapter): CellResolver =>
  cell._tag === "Remote"
    ? cell
    : {
        _tag: "Local",
        forWorkspace: (workspace) =>
          cell.forWorkspace(workspace).pipe(Effect.map((services) => services as Context.Context<LocalCellServices>)),
      }

const message = (cause: unknown) => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  const encoded = JSON.stringify(cause)
  return encoded === undefined || encoded === "{}" ? String(cause) : encoded
}
const titleRunId = (rootRunId: string) => `${rootRunId}:title`
const isApprovalResponseFailure = Schema.is(ExecutionGateway.ApprovalResponseFailure)

const approvalFailure = (cause: unknown): ExecutionGateway.ApprovalResponseFailure => {
  if (isApprovalResponseFailure(cause)) return cause
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : ""
  let kind: ExecutionGateway.ApprovalResponseFailure["kind"] = "unavailable"
  if (tag.endsWith("/ApprovalStale")) kind = "stale"
  else if (tag.endsWith("/ApprovalMismatch")) kind = "mismatch"
  let failureMessage = "Approval service is unavailable"
  if (kind === "stale") failureMessage = "Authorization is no longer pending"
  else if (kind === "mismatch") failureMessage = "Authorization response conflicts with its current state"
  return ExecutionGateway.ApprovalResponseFailure.make({ kind, message: failureMessage })
}
const steeringFailure = (cause: Runtime.SteerError): ExecutionGateway.SteeringFailure =>
  ExecutionGateway.SteeringFailure.make({
    kind:
      cause._tag === "tenetkit/runtime/RunNotFound" ||
      cause._tag === "tenetkit/runtime/RunTerminal" ||
      cause._tag === "tenetkit/runtime/SteeringConflict"
        ? "rejected"
        : "unknown",
    message: message(cause),
  })
const prompt = (input: ExecutionGateway.StartTurn) =>
  input.promptParts === undefined
    ? input.prompt
    : [
        {
          role: "user" as const,
          content: input.promptParts.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "file" as const,
                  mediaType: part.mediaType,
                  data: part.data,
                  ...(part.filename === undefined ? {} : { fileName: part.filename }),
                },
          ),
        },
      ]

const status = (value: Run.RunStatus): Status => {
  switch (value) {
    case "queued":
      return "queued"
    case "waiting":
      return "waiting"
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "needs-resolution":
      return "waiting"
    case "cancelling":
      return "cancelling"
    case "running":
      return "running"
  }
}

const make = (options: SharedOptions, credentialStore: ProviderCredentialStoreShape | undefined) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime
    // A replayPolicy:"never" operation interrupted by cancellation parks the Run in
    // `needs-resolution` until it is explicitly resolved. Baton cannot decide the outcome of a
    // side-effecting operation on its own, so the product settles it as Failed and lets the Run
    // reach its terminal state. Idempotent and restart-safe: resolving an already-resolved
    // operation is a no-op, and the operation id is recovered from durable history.
    const resolveParkedOperations = (runId: string, reason: string) =>
      Effect.gen(function* () {
        const inspection = yield* RunTree.inspect(runId).pipe(Effect.provideService(Runtime.Runtime, runtime))
        const parked = inspection.runs.filter(({ run }) => run.status === "needs-resolution")
        if (parked.length === 0) return
        yield* Effect.forEach(
          parked,
          ({ run }) =>
            runtime.history({ runId: run.runId, limit: 512 }).pipe(
              Effect.map((events) =>
                events.flatMap((event) => (event._tag === "OperationUnknown" ? [event.operationId] : [])),
              ),
              Effect.flatMap((operationIds) =>
                Effect.forEach(
                  [...new Set(operationIds)],
                  (operationId) =>
                    runtime.resolveOperation({
                      runId: run.runId,
                      operationId,
                      idempotencyKey: `${operationId}:cancelled`,
                      resolution: {
                        _tag: "Failed",
                        error: { _tag: "OperationInterrupted", message: reason },
                      },
                    }),
                  { discard: true },
                ),
              ),
            ),
          { discard: true },
        )
      }).pipe(Effect.ignore)

    // Cancellation is only complete once the Run is terminal. A parked Run is resolved and then
    // re-checked, because the park may be recorded after `cancel` returns.
    const awaitSettledCancellation = (runId: string, reason: string) =>
      resolveParkedOperations(runId, reason).pipe(
        Effect.andThen(RunTree.inspect(runId).pipe(Effect.provideService(Runtime.Runtime, runtime))),
        Effect.map((inspection) =>
          inspection.runs.some(({ run }) => run.status === "needs-resolution" || run.status === "cancelling"),
        ),
        Effect.flatMap((pending) => (pending ? Effect.fail("pending" as const) : Effect.void)),
        Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
        Effect.ignore,
      )

    const respondToApproval = (
      decision: "approve" | "deny",
      link: ExecutionGateway.ExecutionLink,
      input: ExecutionGateway.AuthorizationResponse,
    ) =>
      Effect.gen(function* () {
        const target = TreeProjector.authorizationTarget(input.checkpoint, input.authorizationId)
        if (target === undefined)
          return yield* ExecutionGateway.ApprovalResponseFailure.make({
            kind: "stale",
            message: "Authorization is no longer pending",
          })
        const inspection = yield* RunTree.inspect(link.runId).pipe(Effect.provideService(Runtime.Runtime, runtime))
        if (!inspection.runs.some(({ run }) => run.runId === target.runId))
          return yield* ExecutionGateway.ApprovalResponseFailure.make({
            kind: "mismatch",
            message: "Authorization does not belong to this turn",
          })
        yield* (decision === "approve" ? Approval.approve(target) : Approval.deny(target)).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
        )
      }).pipe(Effect.mapError(approvalFailure))

    const gateway = ExecutionGateway.Service.of({
      startTurn: (input) =>
        Effect.gen(function* () {
          const cell = yield* resolveCellRoute(cellResolver(options.cell), input.workspace)
          const turnCapabilities =
            options.capabilities === undefined ? undefined : yield* options.capabilities(input.workspace)
          const configured = yield* configure({
            executionRoute: input.executionRoute,
            workspace: input.workspace,
            kernel: options.kernel,
            cell,
            ...(turnCapabilities === undefined
              ? {}
              : { skills: turnCapabilities.skills, harnessSnapshot: turnCapabilities.harnessSnapshot }),
            ...(credentialStore === undefined ? {} : { credentialStore }),
            ...(options.openAiAccountAuth === undefined ? {} : { openAiAccountAuth: options.openAiAccountAuth }),
            ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
          })
          const receipt = yield* runtime.start({
            executable: configured.executable,
            registrations: configured.registrations,
            treePolicy: input.executionRoute.subagents,
            sessionId: input.threadId,
            idempotencyKey: input.turnId,
            prompt: prompt(input),
            metadata: { threadId: input.threadId, turnId: input.turnId },
            ...(input.reviewIntent === undefined
              ? {}
              : {
                  initialFanOuts: [
                    {
                      idempotencyKey: `${input.turnId}:review`,
                      members: input.reviewIntent.lanes.map((lane) => ({
                        key: lane.key,
                        selection: "Review",
                        prompt: lane.prompt,
                        metadata: {
                          threadId: input.threadId,
                          turnId: input.turnId,
                          productIntent: "review",
                          reviewLane: lane.key,
                        },
                      })),
                      concurrency: input.reviewIntent.concurrency,
                      join: { _tag: "AllSettled" },
                      remainder: "await",
                    },
                  ],
                }),
          })
          const derivedTitleRunId = titleRunId(receipt.runId)
          if (input.titleIntent !== undefined)
            yield* runtime.start({
              runId: derivedTitleRunId,
              executable: configured.titleExecutable,
              registrations: configured.titleRegistrations,
              sessionId: derivedTitleRunId,
              prompt: `Generate a title for this request:\n\n${input.prompt}`,
              idempotencyKey: `${input.turnId}:title`,
              metadata: {
                threadId: input.threadId,
                turnId: input.turnId,
                productIntent: "thread-title",
                expectedTitle: input.titleIntent.expectedTitle,
              },
            })
          return {
            runId: receipt.runId,
            ...(input.titleIntent === undefined ? {} : { titleRunId: derivedTitleRunId }),
            turnId: input.turnId,
            threadId: input.threadId,
          }
        }).pipe(Effect.mapError((cause) => ExecutionGateway.StartTurnFailure.make({ message: message(cause) }))),
      cancelTurn: (link, reason) =>
        Effect.all(
          [
            runtime
              .cancel({ runId: link.runId, reason })
              .pipe(Effect.andThen(awaitSettledCancellation(link.runId, reason))),
            link.titleRunId === undefined
              ? Effect.void
              : runtime.cancel({ runId: link.titleRunId, reason }).pipe(Effect.ignore),
          ],
          { concurrency: 2, discard: true },
        ).pipe(Effect.mapError((cause) => ExecutionGateway.CancelTurnFailure.make({ message: message(cause) }))),
      steerTurn: (link, input) =>
        runtime
          .steer({ runId: link.runId, idempotencyKey: input.idempotencyKey, prompt: input.text })
          .pipe(Effect.mapError(steeringFailure)),
      approveTurn: (link, input) => respondToApproval("approve", link, input),
      denyTurn: (link, input) => respondToApproval("deny", link, input),
      watchTurn: (link, input) => {
        let projector: ReturnType<typeof TreeProjector.make>
        try {
          projector = TreeProjector.make(
            link.turnId,
            input?.prompt ?? "",
            input?.checkpoint,
            input?.units ?? [],
            link.titleRunId !== undefined,
            input?.pricing,
          )
        } catch (cause) {
          return Stream.fail(ExecutionGateway.WatchTurnFailure.make({ message: message(cause) }))
        }
        const rootEvents = RunTree.watch({
          rootRunId: link.runId,
          settlement: "root-blocked",
          ...(input?.checkpoint === undefined ? {} : { cursor: RunTree.TreeCursor.make(input.checkpoint.cursor) }),
        }).pipe(
          Stream.provideService(Runtime.Runtime, runtime),
          Stream.mapEffect((event) => resolveSemanticTreeEvent(event, runtime.resolveModelResponse)),
          Stream.map((event) => ({ _tag: "root" as const, event })),
        )
        const titleId = link.titleRunId
        const titleEvents =
          titleId === undefined
            ? Stream.empty
            : runtime.events({ runId: titleId }).pipe(
                Stream.filter(
                  (event) =>
                    event._tag === "RunCompleted" || event._tag === "RunFailed" || event._tag === "RunCancelled",
                ),
                Stream.take(1),
                Stream.mapEffect(() => runtime.snapshot(titleId)),
                Stream.map((snapshot) => ({ _tag: "title" as const, snapshot })),
                Stream.catchTag("tenetkit/runtime/RunNotFound", () =>
                  Stream.succeed({ _tag: "title" as const, snapshot: undefined }),
                ),
              )
        let pendingTitle: Run.RunSnapshot | null | undefined
        let rootProjected = input?.checkpoint !== undefined
        const projected = Stream.merge(rootEvents, titleEvents).pipe(
          Stream.map((event) => {
            if (event._tag === "title") {
              if (!rootProjected && pendingTitle === undefined) {
                pendingTitle = event.snapshot ?? null
                return []
              }
              if (event.snapshot === undefined) {
                const change = projector.applyTitle(undefined, [])
                return change === undefined ? [] : [{ change }]
              }
              const outcome = event.snapshot.outcome
              const text = outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
              const change = projector.applyTitle(text, event.snapshot.usage)
              return change === undefined ? [] : [{ change }]
            }
            rootProjected = true
            const change = projector.apply(event.event)
            const changes: Array<{
              readonly change: ReturnType<typeof projector.apply>
              readonly childRunId?: string
            }> = [
              {
                change,
                ...(event.event.event._tag === "ChildLinked" ? { childRunId: event.event.event.childRunId } : {}),
              },
            ]
            if (pendingTitle !== undefined) {
              const snapshot = pendingTitle
              pendingTitle = undefined
              if (snapshot === null) {
                const titleChange = projector.applyTitle(undefined, [])
                if (titleChange !== undefined) changes.push({ change: titleChange })
              } else {
                const outcome = snapshot.outcome
                const text = outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
                const titleChange = projector.applyTitle(text, snapshot.usage)
                if (titleChange !== undefined) changes.push({ change: titleChange })
              }
            }
            return changes
          }),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: message(cause) })),
        )
        return Stream.unwrap(
          Stream.broadcastN(projected, { n: 2, capacity: 64 }).pipe(
            Effect.map(([projectionEvents, childEvents]) => {
              const projections = Stream.map(projectionEvents, ({ change }) => change)
              const durable =
                input?.checkpoint === undefined
                  ? Stream.concat(Stream.succeed(projector.snapshot()), projections)
                  : projections
              const previewRunIds = Stream.concat(
                Stream.fromIterable([link.runId, ...projector.previewRunIds()]),
                childEvents.pipe(
                  Stream.flatMap(({ childRunId }) =>
                    childRunId === undefined ? Stream.empty : Stream.succeed(childRunId),
                  ),
                ),
              )
              const previews = previewRunIds.pipe(
                Stream.flatMap(
                  (runId) => {
                    const parentId = projector.previewParentId(runId)
                    return runtime.previews({ runId }).pipe(
                      Stream.map((event) => ({
                        ...event,
                        ...(parentId === undefined ? {} : { parentId }),
                      })),
                    )
                  },
                  { concurrency: "unbounded" },
                ),
              )
              return Stream.merge(durable, previews, { haltStrategy: "left" })
            }),
          ),
        )
      },
      inspectTurn: (link) =>
        RunTree.inspect(link.runId).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
          Effect.map((inspection) => {
            const root = inspection.runs.find(({ run }) => run.runId === link.runId)
            return root === undefined
              ? { status: "unavailable" as const }
              : { status: status(root.run.status), cursor: inspection.cursor }
          }),
          Effect.catchTag("tenetkit/runtime/RunNotFound", () => Effect.succeed({ status: "unavailable" as const })),
          Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: message(cause) })),
        ),
    })
    const unavailable = (cause: unknown) => ExecutionSessionLifecycle.Unavailable.make({ message: message(cause) })
    const builtPools = options.cell._tag === "Local" ? options.cell.built : Effect.succeed([])
    const lifecycle = ExecutionSessionLifecycle.Service.of({
      requestCancellation: (input) => runtime.cancelSession(input).pipe(Effect.mapError(unavailable)),
      awaitTerminal: (input) => runtime.awaitSessionTerminal(input).pipe(Effect.mapError(unavailable)),
      closeKernel: ({ sessionId }) =>
        Effect.flatMap(builtPools, (pools) =>
          Effect.forEach(
            pools.flatMap((pool) => Option.toArray(Context.getOption(pool, KernelPool.KernelPool))),
            (service) => service.close(sessionId).pipe(Effect.mapError(unavailable)),
            { discard: true },
          ),
        ),
      dropKernelState: ({ sessionId }) =>
        Effect.flatMap(builtPools, (pools) =>
          Effect.forEach(
            pools.flatMap((pool) => Option.toArray(Context.getOption(pool, KernelStateStore.KernelStateStore))),
            (service) => service.drop(sessionId).pipe(Effect.mapError(unavailable)),
            { discard: true },
          ),
        ),
    })
    return Context.make(ExecutionGateway.Service, gateway).pipe(
      Context.add(ExecutionSessionLifecycle.Service, lifecycle),
    )
  })

const executionLayer = <E>(
  options: SharedOptions,
  runtimeLayer: (credentialStore: ProviderCredentialStoreShape | undefined) => Layer.Layer<Runtime.Runtime, E>,
): Layer.Layer<ExecutionGateway.Service | ExecutionSessionLifecycle.Service, ExecutionGateway.StartTurnFailure> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const credentialStore: ProviderCredentialStoreShape | undefined =
        options.credentialStore === undefined
          ? undefined
          : Context.get(yield* Layer.build(options.credentialStore), ProviderCredentialStore)
      const providedExecution = Layer.effectContext(make(options, credentialStore)).pipe(
        Layer.provide(runtimeLayer(credentialStore)),
      )
      return providedExecution.pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )

const resolverFor = (options: SharedOptions, credentialStore: ProviderCredentialStoreShape | undefined) =>
  makeResolver({
    kernel: options.kernel,
    cell: cellResolver(options.cell),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(credentialStore === undefined ? {} : { credentialStore }),
    ...(options.openAiAccountAuth === undefined ? {} : { openAiAccountAuth: options.openAiAccountAuth }),
    ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
  })

export const layerPostgres = (
  options: Options,
): Layer.Layer<
  ExecutionGateway.Service | ExecutionSessionLifecycle.Service | PostgresControlPlane.Readiness,
  ExecutionGateway.StartTurnFailure
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const credentialStore: ProviderCredentialStoreShape | undefined =
        options.credentialStore === undefined
          ? undefined
          : Context.get(yield* Layer.build(options.credentialStore), ProviderCredentialStore)
      const controlPlane = PostgresControlPlane.layer({
        postgres: options.postgres,
        resolver: resolverFor(options, credentialStore),
        ...(options.subscriberQueueCapacity === undefined
          ? {}
          : { subscriberQueueCapacity: options.subscriberQueueCapacity }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      })
      const execution = Layer.effectContext(make(options, credentialStore)).pipe(Layer.provide(controlPlane))
      const readiness = Layer.effect(
        PostgresControlPlane.Readiness,
        Effect.map(PostgresControlPlane.Readiness, PostgresControlPlane.Readiness.of),
      ).pipe(Layer.provide(controlPlane))
      return Layer.merge(execution, readiness).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )

export const layerSqliteTest = (
  options: SqliteTestOptions,
): Layer.Layer<ExecutionGateway.Service | ExecutionSessionLifecycle.Service, ExecutionGateway.StartTurnFailure> => {
  const shared: SharedOptions = {
    ...options,
    kernel: options.kernel ?? derivedKernelOptions(options.filename),
  }
  return executionLayer(shared, (credentialStore) =>
    Runtime.layerSqlite({
      filename: options.filename,
      resolver: resolverFor(shared, credentialStore),
      addresses: [],
      ...(options.subscriberQueueCapacity === undefined
        ? {}
        : { subscriberQueueCapacity: options.subscriberQueueCapacity }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    }),
  )
}

export const layer = layerPostgres
