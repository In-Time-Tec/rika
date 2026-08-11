import { ModelRegistry } from "@batonfx/core"
import type { HarnessState } from "@batonfx/harness"
import { KernelPool, KernelStateStore } from "@batonfx/repl"
import type * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as CellCallContext from "./baton-cell-call-context"
import { Approval, Run, RunTree, Runtime } from "@batonfx/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import type { Status } from "@rika/product/execution-status"
import { ProviderCredentialStore, type ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
export type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
export type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Cause, Context, Deferred, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import type { AgentToolHandlers, KernelOptions } from "./baton-route-options"
import { configure, makeResolver } from "./baton-route"
import * as PreviewAdapter from "./baton-preview-adapter"
import { TreeProjector } from "./projection/tree"

export type AgentToolServices = AgentToolHandlers

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

const kernelOptions = (options: Options): KernelOptions => options.kernel ?? derivedKernelOptions(options.filename)

/** The kernel a cell runs in, plus the seam that answers its host requests. */
export type KernelPoolServices = KernelPool.KernelPool | CellCallContext.CellCallContext

export interface Options {
  readonly filename: string
  readonly kernel?: KernelOptions
  /**
   * The kernel a cell runs in, already built and owned by the caller's scope. It outlives every
   * cell, so a host builds it once where a Server-lifetime scope exists rather than letting the
   * first cell that needs one decide how long it lives.
   */
  readonly kernelPool?:
    | Context.Context<KernelPoolServices>
    | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly agentServices?: (workspace: string) => Layer.Layer<AgentToolServices, never, never>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly credentialStore?: Layer.Layer<ProviderCredentialStore, never, never>
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
  readonly subscriberQueueCapacity?: number
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

const make = (
  options: Options,
  credentialStore: ProviderCredentialStoreShape | undefined,
  durableRuntimeSlot: Deferred.Deferred<Runtime.Runtime["Service"]> | undefined,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime
    if (durableRuntimeSlot !== undefined) yield* Deferred.succeed(durableRuntimeSlot, runtime)
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
          const configured = yield* configure({
            executionRoute: input.executionRoute,
            workspace: input.workspace,
            kernel: kernelOptions(options),
            durableRuntime: Effect.succeedSome(runtime),
            ...(options.kernelPool === undefined ? {} : { kernelPool: options.kernelPool }),
            ...(options.skills === undefined ? {} : { skills: options.skills }),
            ...(options.harnessSnapshot === undefined ? {} : { harnessSnapshot: options.harnessSnapshot }),
            ...(credentialStore === undefined ? {} : { credentialStore }),
            ...(options.openAiAccountAuth === undefined ? {} : { openAiAccountAuth: options.openAiAccountAuth }),
            ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices(input.workspace) }),
            ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
          })
          const receipt = yield* runtime.start({
            executable: configured.executable,
            registrations: configured.registrations,
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
          .pipe(Effect.mapError((cause) => ExecutionGateway.SteeringFailure.make({ message: message(cause) }))),
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
                Stream.catchTag("@batonfx/runtime/RunNotFound", () =>
                  Stream.succeed({ _tag: "title" as const, snapshot: undefined }),
                ),
              )
        let pendingTitle: Run.RunSnapshot | null | undefined
        let rootProjected = input?.checkpoint !== undefined
        const projections = Stream.merge(rootEvents, titleEvents).pipe(
          Stream.map((event) => {
            if (event._tag === "title") {
              if (!rootProjected && pendingTitle === undefined) {
                pendingTitle = event.snapshot ?? null
                return []
              }
              if (event.snapshot === undefined) return [projector.applyTitle(undefined, [])]
              const outcome = event.snapshot.outcome
              const text = outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
              return [projector.applyTitle(text, event.snapshot.usage)]
            }
            rootProjected = true
            const patches: Array<ReturnType<typeof projector.apply> | undefined> = [projector.apply(event.event)]
            if (pendingTitle !== undefined) {
              const snapshot = pendingTitle
              pendingTitle = undefined
              if (snapshot === null) patches.push(projector.applyTitle(undefined, []))
              else {
                const outcome = snapshot.outcome
                const text = outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
                patches.push(projector.applyTitle(text, snapshot.usage))
              }
            }
            return patches
          }),
          Stream.flatMap(Stream.fromIterable),
          Stream.filter((patch): patch is NonNullable<typeof patch> => patch !== undefined),
          Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: message(cause) })),
        )
        const durable =
          input?.checkpoint === undefined
            ? Stream.concat(Stream.succeed(projector.snapshot()), projections)
            : projections
        const previews = (runtime as typeof runtime & PreviewAdapter.PreviewRuntime).previews({ runId: link.runId })
        return PreviewAdapter.merge({ projections: durable, previews })
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
          Effect.catchTag("@batonfx/runtime/RunNotFound", () => Effect.succeed({ status: "unavailable" as const })),
          Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: message(cause) })),
        ),
    })
    const unavailable = (cause: unknown) => ExecutionSessionLifecycle.Unavailable.make({ message: message(cause) })
    const pool =
      options.kernelPool === undefined ? Option.none() : Context.getOption(options.kernelPool, KernelPool.KernelPool)
    const stateStore =
      options.kernelPool === undefined
        ? Option.none()
        : Context.getOption(options.kernelPool, KernelStateStore.KernelStateStore)
    const lifecycle = ExecutionSessionLifecycle.Service.of({
      requestCancellation: (input) => runtime.cancelSession(input).pipe(Effect.mapError(unavailable)),
      awaitTerminal: (input) => runtime.awaitSessionTerminal(input).pipe(Effect.mapError(unavailable)),
      closeKernel: ({ sessionId }) =>
        Option.match(pool, {
          onNone: () => Effect.void,
          onSome: (service) => service.close(sessionId).pipe(Effect.mapError(unavailable)),
        }),
      dropKernelState: ({ sessionId }) =>
        Option.match(stateStore, {
          onNone: () => Effect.void,
          onSome: (service) => service.drop(sessionId).pipe(Effect.mapError(unavailable)),
        }),
    })
    return Context.make(ExecutionGateway.Service, gateway).pipe(
      Context.add(ExecutionSessionLifecycle.Service, lifecycle),
    )
  })

export const layer = (
  options: Options,
): Layer.Layer<ExecutionGateway.Service | ExecutionSessionLifecycle.Service, ExecutionGateway.StartTurnFailure> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const credentialStore: ProviderCredentialStoreShape | undefined =
        options.credentialStore === undefined
          ? undefined
          : Context.get(yield* Layer.build(options.credentialStore), ProviderCredentialStore)
      /**
       * Baton takes the resolver as an argument to the layer that BUILDS the Runtime, so the
       * resolver cannot close over one. A cell needs it anyway: `rika.agents` acts through the
       * durable Runtime, and Baton hosts a tool with `ChildRuns` rather than the Runtime. The
       * resolver therefore reads this slot per Run, which is long after the layer filled it.
       */
      const durableRuntimeSlot = yield* Deferred.make<Runtime.Runtime["Service"]>()
      const durableRuntime = Effect.flatMap(
        Deferred.poll(durableRuntimeSlot),
        Option.match({ onNone: () => Effect.succeedNone, onSome: Effect.map(Option.some) }),
      )
      const runtimeLayer = Runtime.layerSqlite({
        filename: options.filename,
        resolver: makeResolver({
          kernel: kernelOptions(options),
          durableRuntime,
          ...(options.kernelPool === undefined ? {} : { kernelPool: options.kernelPool }),
          ...(options.skills === undefined ? {} : { skills: options.skills }),
          ...(options.harnessSnapshot === undefined ? {} : { harnessSnapshot: options.harnessSnapshot }),
          ...(credentialStore === undefined ? {} : { credentialStore }),
          ...(options.openAiAccountAuth === undefined ? {} : { openAiAccountAuth: options.openAiAccountAuth }),
          ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices }),
          ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
        }),
        addresses: [],
        ...(options.subscriberQueueCapacity === undefined
          ? {}
          : { subscriberQueueCapacity: options.subscriberQueueCapacity }),
      })
      const executionLayer = Layer.effectContext(make(options, credentialStore, durableRuntimeSlot)).pipe(
        Layer.provide(runtimeLayer),
      )
      return executionLayer.pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )
