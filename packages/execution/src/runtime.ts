import { ModelRegistry } from "tenetkit"
import type { HarnessState } from "tenetkit/harness"
import { KernelPool, KernelStateStore } from "tenetkit/repl"
import type * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import {
  Approval,
  Errors,
  ExecutableManifest,
  ExecutableRegistration,
  Message,
  Run,
  RunTree,
  Runtime,
  TreePolicy,
} from "tenetkit/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as HostedObservability from "@rika/product/hosted-observability"
import type { Status } from "@rika/product/execution-status"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
export type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
export type ProviderCredentialStoreService = ProviderCredentialStore["Service"]
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { type ConfigureOptions, type KernelOptions, type RemoteCellRoute, configure, resolveCellRoute } from "./route"
import * as Route from "./route"
import * as Postgres from "./postgres"
import { TreeProjector } from "./projection/tree/projector"
import { resolveSemanticTreeEvent, type SemanticTreeEvent } from "./projection/semantic/event"

export const approvalTarget = TreeProjector.authorizationTarget

const derivedKernelOptions = (dataRoot: string): KernelOptions => ({ runtimeVersion: Bun.version, dataRoot })

/** The kernel a cell runs in, plus the seam that answers its host requests. */
export type KernelPoolServices = KernelPool.KernelPool | ExecutorRuntime.CellContext

export interface LocalCells extends Route.LocalCellResolver {
  readonly built: Effect.Effect<
    ReadonlyArray<
      Context.Context<KernelPoolServices> | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
    >
  >
}

export type Cells = LocalCells | RemoteCellRoute

export interface CommonOptions {
  readonly kernel: KernelOptions
  readonly cells?: Cells
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: HarnessState.HarnessState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly credentialStore?: Layer.Layer<ProviderCredentialStore, never, never>
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
  readonly subscriberQueueCapacity?: number
  readonly scheduler?: Runtime.LayerOptions["scheduler"]
}

export interface HostedOptions extends CommonOptions {
  readonly cells: Cells
  readonly postgres: Postgres.Options
}

export interface MemoryOptions extends Omit<CommonOptions, "kernel"> {
  readonly dataRoot: string
  readonly kernel?: KernelOptions
}

export interface LocalCellsOptions {
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

export const localCells = (options: LocalCellsOptions): LocalCells => ({
  _tag: "Local",
  ...options,
})

export const remoteCells = (options: Omit<RemoteCellRoute, "_tag">): RemoteCellRoute => ({
  _tag: "Remote",
  ...options,
})

const resolveCells = (cells: Cells | undefined): Route.CellResolver | undefined => {
  if (cells === undefined || cells._tag === "Remote") return cells
  return {
    _tag: "Local",
    forWorkspace: cells.forWorkspace,
  }
}

const message = (cause: unknown) => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  const encoded = JSON.stringify(cause)
  return encoded === undefined || encoded === "{}" ? String(cause) : encoded
}
const watchFailureMessage = (cause: unknown) => {
  if (Schema.is(Errors.TreeCursorInvalid)(cause)) return `Run-tree checkpoint cursor is invalid: ${cause.message}`
  if (Schema.is(Errors.TreeCursorRootMismatch)(cause)) return "Run-tree checkpoint belongs to a different root Run"
  if (Schema.is(Errors.TreeCursorExpired)(cause)) return "Run-tree checkpoint expired before projection resumed"
  if (Schema.is(Errors.TreeCursorFuture)(cause)) return "Run-tree checkpoint is ahead of committed execution"
  if (Schema.is(Errors.TreeReplayLimitInvalid)(cause))
    return `Run-tree replay limit ${cause.received} is outside ${cause.minimum}..${cause.maximum}`
  if (Schema.is(Errors.RunNotFound)(cause)) return `Root Run ${cause.runId} is unavailable`
  if (Schema.is(Errors.RuntimeUnavailable)(cause)) return cause.message
  return message(cause)
}
const titleRunId = (rootRunId: string) => `${rootRunId}:title`
const isApprovalResponseFailure = Schema.is(ExecutionGateway.ApprovalResponseFailure)
const decodeCauseTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

const approvalFailure = (cause: unknown): ExecutionGateway.ApprovalResponseFailure => {
  if (isApprovalResponseFailure(cause)) return cause
  const tag = Option.getOrElse(
    Option.map(decodeCauseTag(cause), (tagged) => tagged._tag),
    () => "",
  )
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
  input.promptParts === undefined || input.promptParts.length === 0
    ? input.prompt
    : [
        {
          role: "user" as const,
          content: input.promptParts.map((part) => {
            if (part.type === "text") return { type: "text" as const, text: part.text }
            if (part.filename === undefined)
              return { type: "file" as const, mediaType: part.mediaType, data: part.data }
            return { type: "file" as const, mediaType: part.mediaType, data: part.data, fileName: part.filename }
          }),
        },
      ]

const RuntimeAdmission = Schema.Struct({
  runId: Schema.String,
  treePolicy: Schema.optionalKey(TreePolicy.TreePolicy),
  executable: ExecutableManifest.PinnedExecutable,
  registrations: Schema.Array(ExecutableRegistration.ExecutableRegistration),
  sessionId: Schema.String,
  idempotencyKey: Schema.String,
  prompt: Prompt.Prompt,
  metadata: Schema.optionalKey(Message.Metadata),
})
const RuntimeAdmissionJson = Schema.fromJsonString(RuntimeAdmission)

const prepareFailure = (cause: unknown) =>
  ExecutionGateway.PrepareTurnFailure.make({
    kind: "invalid",
    message: message(cause),
  })
const isAdmitTurnFailure = Schema.is(ExecutionGateway.AdmitTurnFailure)
const admitFailure = (cause: unknown) => {
  if (isAdmitTurnFailure(cause)) return cause
  let kind: ExecutionGateway.AdmitTurnFailure["kind"] = "invalid"
  if (Schema.is(Errors.IdempotencyConflict)(cause)) kind = "idempotency-conflict"
  else if (Schema.is(Errors.RunIdConflict)(cause)) kind = "run-id-conflict"
  else if (Schema.is(Errors.RuntimeUnavailable)(cause)) kind = "unavailable"
  return ExecutionGateway.AdmitTurnFailure.make({ kind, message: message(cause) })
}
const isActivateTurnFailure = Schema.is(ExecutionGateway.ActivateTurnFailure)
const activateFailure = (cause: unknown) =>
  isActivateTurnFailure(cause)
    ? cause
    : ExecutionGateway.ActivateTurnFailure.make({
        kind: Schema.is(Errors.RunNotFound)(cause) ? "missing" : "unavailable",
        message: message(cause),
      })

const status = (value: Run.RunStatus): Exclude<Status, "accepted"> => {
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

type ModelTerminalEvent = Extract<
  SemanticTreeEvent["event"],
  { readonly _tag: "ModelAttemptCompleted" | "ModelAttemptFailed" }
>

export interface ModelTerminalObservation {
  readonly modelAttemptId: string
  readonly outcome: "success" | "failure" | "interrupted"
  readonly durationMillis: number
  readonly syntheticStart: boolean
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}

const tokenTotal = (value: number | undefined) => {
  if (value === undefined) return undefined
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

const retainRecent = <A>(map: Map<string, A>, key: string, value: A, limit: number) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
}

export const makeModelTerminalTelemetry = (limit = 256) => {
  const capacity = Math.max(1, Math.floor(limit))
  const started = new Map<string, number>()
  const observed = new Map<string, true>()
  return {
    started(modelAttemptId: string, startedAt: number) {
      if (observed.has(modelAttemptId) || started.has(modelAttemptId)) return false
      retainRecent(started, modelAttemptId, startedAt, capacity)
      return true
    },
    terminal(event: ModelTerminalEvent): ModelTerminalObservation | undefined {
      if (observed.has(event.modelAttemptId)) {
        retainRecent(observed, event.modelAttemptId, true, capacity)
        return undefined
      }
      const terminalAt = event._tag === "ModelAttemptCompleted" ? event.completedAt : event.failedAt
      const recordedStart = started.get(event.modelAttemptId)
      const startedAt = recordedStart ?? terminalAt
      started.delete(event.modelAttemptId)
      retainRecent(observed, event.modelAttemptId, true, capacity)
      const inputTokens = tokenTotal(
        event._tag === "ModelAttemptCompleted" ? event.usage.inputTokens.total : event.providerUsage?.inputTokens,
      )
      const outputTokens = tokenTotal(
        event._tag === "ModelAttemptCompleted" ? event.usage.outputTokens.total : event.providerUsage?.outputTokens,
      )
      let usage: ModelTerminalObservation["usage"]
      if (inputTokens !== undefined && outputTokens !== undefined) usage = { inputTokens, outputTokens }
      else if (inputTokens !== undefined) usage = { inputTokens }
      else if (outputTokens !== undefined) usage = { outputTokens }
      let outcome: ModelTerminalObservation["outcome"] = "success"
      if (event._tag === "ModelAttemptFailed") outcome = event.category === "cancellation" ? "interrupted" : "failure"
      const observation = {
        modelAttemptId: event.modelAttemptId,
        outcome,
        durationMillis: Math.max(0, terminalAt - startedAt),
        syntheticStart: recordedStart === undefined,
      }
      return usage === undefined ? observation : { ...observation, usage }
    },
  }
}

export const makeHostedModelObserver = (link: ExecutionGateway.ExecutionLink) => {
  const modelTelemetry = makeModelTerminalTelemetry()
  return (treeEvent: SemanticTreeEvent) => {
    const event = treeEvent.event
    if (event._tag === "ModelAttemptStarted") {
      if (!modelTelemetry.started(event.modelAttemptId, event.startedAt)) return Effect.void
      return HostedObservability.event("model_start", "success", {
        threadId: link.threadId,
        turnId: link.turnId,
        runId: treeEvent.runId,
        modelAttemptId: event.modelAttemptId,
      })
    }
    if (event._tag === "ModelAttemptCompleted" || event._tag === "ModelAttemptFailed") {
      const observation = modelTelemetry.terminal(event)
      if (observation === undefined) return Effect.void
      const terminal = HostedObservability.modelObserved(
        {
          threadId: link.threadId,
          turnId: link.turnId,
          runId: treeEvent.runId,
          modelAttemptId: observation.modelAttemptId,
        },
        observation.outcome,
        observation.durationMillis,
        observation.usage,
      )
      return observation.syntheticStart
        ? HostedObservability.event("model_start", "success", {
            threadId: link.threadId,
            turnId: link.turnId,
            runId: treeEvent.runId,
            modelAttemptId: event.modelAttemptId,
          }).pipe(Effect.andThen(terminal))
        : terminal
    }
    return Effect.void
  }
}

const make = (
  options: CommonOptions,
  credentialStore: ProviderCredentialStore["Service"] | undefined,
  hosted: boolean,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime
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
        const checkpoint = yield* RunTree.checkpoint(link.runId).pipe(Effect.provideService(Runtime.Runtime, runtime))
        const inspection = checkpoint.inspection
        if (!inspection.runs.some(({ run }) => run.runId === target.runId))
          return yield* ExecutionGateway.ApprovalResponseFailure.make({
            kind: "mismatch",
            message: "Authorization does not belong to this turn",
          })
        yield* (decision === "approve" ? Approval.approve(target) : Approval.deny(target)).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
        )
      }).pipe(Effect.mapError(approvalFailure))

    const prepareTurn: ExecutionGateway.Interface["prepareTurn"] = Effect.fn("ExecutionGateway.prepareTurn")(function* (
      input,
    ) {
      const resolver = resolveCells(options.cells)
      const cell = resolver === undefined ? undefined : yield* resolveCellRoute(resolver, input.workspaceId)
      if (cell?._tag === "Remote")
        yield* cell.admit({ threadId: input.threadId, turnId: input.turnId, workspaceId: input.workspaceId })
      const turnCapabilities =
        options.capabilities === undefined ? undefined : yield* options.capabilities(input.workspaceId)
      const configureOptions: ConfigureOptions = {
        executionRoute: input.executionRoute,
        workspace: input.workspaceId,
        executionIdentity: { threadId: input.threadId, turnId: input.turnId },
        kernel: options.kernel,
      }
      if (cell !== undefined) Object.assign(configureOptions, { cell })
      if (turnCapabilities !== undefined)
        Object.assign(configureOptions, {
          skills: turnCapabilities.skills,
          harnessSnapshot: turnCapabilities.harnessSnapshot,
        })
      if (credentialStore !== undefined) Object.assign(configureOptions, { credentialStore })
      if (options.openAiAccountAccess !== undefined)
        Object.assign(configureOptions, { openAiAccountAccess: options.openAiAccountAccess })
      if (options.modelServices !== undefined) Object.assign(configureOptions, { modelServices: options.modelServices })
      const configured = yield* configure(configureOptions)
      const runId = input.turnId
      const rootAdmissionJson = yield* Schema.encodeEffect(RuntimeAdmissionJson)({
        runId,
        treePolicy: input.executionRoute.subagents,
        executable: configured.executable,
        registrations: configured.registrations,
        sessionId: input.threadId,
        idempotencyKey: input.turnId,
        prompt: Prompt.make(prompt(input)),
        metadata: { threadId: input.threadId, turnId: input.turnId },
      })
      if (input.titleIntent === undefined) {
        const prepared: ExecutionGateway.PreparedTurn = {
          threadId: input.threadId,
          turnId: input.turnId,
          runId,
          rootAdmissionJson,
        }
        if (input.reviewIntent !== undefined) Object.assign(prepared, { reviewIntent: input.reviewIntent })
        return prepared
      }
      const derivedTitleRunId = titleRunId(runId)
      const titleAdmissionJson = yield* Schema.encodeEffect(RuntimeAdmissionJson)({
        runId: derivedTitleRunId,
        executable: configured.titleExecutable,
        registrations: configured.titleRegistrations,
        sessionId: derivedTitleRunId,
        idempotencyKey: `${input.turnId}:title`,
        prompt: Prompt.make(`Generate a title for this request:\n\n${input.prompt}`),
        metadata: {
          threadId: input.threadId,
          turnId: input.turnId,
          productIntent: "thread-title",
          expectedTitle: input.titleIntent.expectedTitle,
        },
      })
      const prepared: ExecutionGateway.PreparedTurn = {
        threadId: input.threadId,
        turnId: input.turnId,
        runId,
        titleRunId: derivedTitleRunId,
        rootAdmissionJson,
        titleAdmissionJson,
      }
      if (input.reviewIntent !== undefined) Object.assign(prepared, { reviewIntent: input.reviewIntent })
      return prepared
    }, Effect.mapError(prepareFailure))
    const admitTurn: ExecutionGateway.Interface["admitTurn"] = Effect.fn("ExecutionGateway.admitTurn")(function* (
      input,
    ) {
      const root = yield* Schema.decodeEffect(RuntimeAdmissionJson)(input.rootAdmissionJson)
      if (root.runId !== input.runId || input.runId !== input.turnId)
        return yield* ExecutionGateway.AdmitTurnFailure.make({
          kind: "invalid",
          message: "Prepared root admission identity is invalid",
        })
      yield* runtime.admit(root)
      if (input.titleRunId !== undefined) {
        if (input.titleAdmissionJson === undefined)
          return yield* ExecutionGateway.AdmitTurnFailure.make({
            kind: "invalid",
            message: "Prepared title admission is missing",
          })
        const title = yield* Schema.decodeEffect(RuntimeAdmissionJson)(input.titleAdmissionJson)
        if (title.runId !== input.titleRunId)
          return yield* ExecutionGateway.AdmitTurnFailure.make({
            kind: "invalid",
            message: "Prepared title admission identity is invalid",
          })
        yield* runtime.admit(title)
      }
      const link: ExecutionGateway.ExecutionLink = {
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
      }
      if (input.titleRunId !== undefined) Object.assign(link, { titleRunId: input.titleRunId })
      return link
    }, Effect.mapError(admitFailure))
    const activateTurn: ExecutionGateway.Interface["activateTurn"] = Effect.fn("ExecutionGateway.activateTurn")(
      function* (input, link) {
        if (
          input.runId !== link.runId ||
          input.turnId !== link.turnId ||
          input.threadId !== link.threadId ||
          input.titleRunId !== link.titleRunId
        )
          return yield* ExecutionGateway.ActivateTurnFailure.make({
            kind: "missing",
            message: "Prepared Turn does not match its execution link",
          })
        const root = yield* runtime.activate({ runId: link.runId })
        const rootStatus = status(root.status)
        if (rootStatus !== "running" && rootStatus !== "waiting") {
          if (link.titleRunId !== undefined)
            yield* runtime.cancel({ runId: link.titleRunId, reason: "Root Run did not activate" }).pipe(Effect.ignore)
          if (rootStatus === "queued")
            return yield* ExecutionGateway.ActivateTurnFailure.make({
              kind: "unavailable",
              message: "Runtime activation returned a queued Run",
            })
          return rootStatus
        }
        yield* Effect.all(
          [
            input.reviewIntent === undefined
              ? Effect.void
              : runtime.fanOut({
                  parentRunId: link.runId,
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
                }),
            link.titleRunId === undefined ? Effect.void : runtime.activate({ runId: link.titleRunId }),
          ],
          { concurrency: 2, discard: true },
        )
        return rootStatus
      },
      Effect.mapError(activateFailure),
    )
    const gateway = ExecutionGateway.Service.of({
      startTurn: (input) =>
        Effect.gen(function* () {
          const prepared = yield* prepareTurn(input)
          const link = yield* admitTurn(prepared)
          yield* activateTurn(prepared, link)
          return link
        }).pipe(Effect.mapError((cause) => ExecutionGateway.StartTurnFailure.make({ message: message(cause) }))),
      prepareTurn,
      admitTurn,
      activateTurn,
      cancelTurn: (link, reason) =>
        Effect.all(
          [
            runtime
              .cancel({ runId: link.runId, reason })
              .pipe(
                Effect.andThen(RunTree.awaitTerminal(link.runId).pipe(Effect.provideService(Runtime.Runtime, runtime))),
                Effect.asVoid,
              ),
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
        const observeModel = hosted ? makeHostedModelObserver(link) : () => Effect.void
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
        let watchOptions: Parameters<typeof RunTree.watch>[0] = {
          rootRunId: link.runId,
          settlement: "root-blocked",
        }
        if (input?.checkpoint !== undefined)
          watchOptions = { ...watchOptions, cursor: RunTree.TreeCursor.make(input.checkpoint.cursor) }
        const replayThenWatch = (
          cursor: RunTree.TreeCursor,
        ): Stream.Stream<RunTree.TreeEvent, Runtime.TreeReplayError | Runtime.TreeEventsError, Runtime.Runtime> =>
          Stream.unwrap(
            RunTree.replay({ rootRunId: link.runId, cursor, limit: 1_000 }).pipe(
              Effect.map((page) =>
                Stream.concat(
                  Stream.fromIterable(page.events),
                  page.hasMore
                    ? replayThenWatch(page.cursor)
                    : RunTree.watch({ rootRunId: link.runId, cursor: page.cursor, settlement: "root-blocked" }),
                ),
              ),
            ),
          )
        const rootTreeEvents =
          input?.checkpoint === undefined
            ? RunTree.watch(watchOptions)
            : replayThenWatch(RunTree.TreeCursor.make(input.checkpoint.cursor))
        const rootEvents = rootTreeEvents.pipe(
          Stream.provideService(Runtime.Runtime, runtime),
          Stream.mapEffect((event) => resolveSemanticTreeEvent(event, runtime.resolveModelResponse)),
          Stream.tap(observeModel),
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
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
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
              if (event.event.event._tag === "ToolExecutionCompleted" && event.event.event.call.name === "typescript") {
                const decoded = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(
                  event.event.event.call.params,
                )
                if (Option.isSome(decoded))
                  yield* projector.formatCellSource(event.event.runId, event.event.event.call.id, decoded.value.code)
              }
              const change = projector.apply(event.event)
              const changes: Array<{
                readonly change: ReturnType<typeof projector.apply>
                readonly childRunId?: string
              }> = []
              if (event.event.event._tag === "ChildLinked")
                changes.push({ change, childRunId: event.event.event.childRunId })
              else changes.push({ change })
              if (pendingTitle !== undefined) {
                const snapshot = pendingTitle
                pendingTitle = undefined
                if (snapshot === null) {
                  const titleChange = projector.applyTitle(undefined, [])
                  if (titleChange !== undefined) changes.push({ change: titleChange })
                } else {
                  const outcome = snapshot.outcome
                  const text =
                    outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
                  const titleChange = projector.applyTitle(text, snapshot.usage)
                  if (titleChange !== undefined) changes.push({ change: titleChange })
                }
              }
              return changes
            }),
          ),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: watchFailureMessage(cause) })),
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
                    return runtime
                      .previews({ runId })
                      .pipe(Stream.map((event) => (parentId === undefined ? event : { ...event, parentId })))
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
        RunTree.checkpoint(link.runId).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
          Effect.map((checkpoint) => {
            const inspection = checkpoint.inspection
            const root = inspection.runs.find(({ run }) => run.runId === link.runId)
            return root === undefined
              ? { status: "unavailable" as const }
              : { status: status(root.run.status), cursor: checkpoint.cursor }
          }),
          Effect.catchTag("tenetkit/runtime/RunNotFound", () => Effect.succeed({ status: "unavailable" as const })),
          Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: message(cause) })),
        ),
    })
    const unavailable = (cause: unknown) => ExecutionSessionLifecycle.Unavailable.make({ message: message(cause) })
    const builtPools: Effect.Effect<
      ReadonlyArray<
        Context.Context<KernelPoolServices> | Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>
      >
    > = options.cells?._tag === "Local" ? options.cells.built : Effect.succeed([])
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
  options: CommonOptions,
  runtimeLayer: (credentialStore: ProviderCredentialStore["Service"] | undefined) => Layer.Layer<Runtime.Runtime, E>,
): Layer.Layer<
  ExecutionGateway.Service | ExecutionSessionLifecycle.Service | Runtime.Runtime,
  ExecutionGateway.StartTurnFailure
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const credentialStore: ProviderCredentialStore["Service"] | undefined =
        options.credentialStore === undefined
          ? undefined
          : Context.get(yield* Layer.build(options.credentialStore), ProviderCredentialStore)
      const runtime = runtimeLayer(credentialStore)
      const providedExecution = Layer.effectContext(make(options, credentialStore, false)).pipe(Layer.provide(runtime))
      return Layer.merge(providedExecution, runtime).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )

const resolverFor = (options: CommonOptions, credentialStore: ProviderCredentialStore["Service"] | undefined) => {
  const cell = resolveCells(options.cells)
  let resolverOptions: Route.ResolverOptions = { kernel: options.kernel }
  if (cell !== undefined) resolverOptions = { ...resolverOptions, cell }
  if (options.capabilities !== undefined) resolverOptions = { ...resolverOptions, capabilities: options.capabilities }
  if (credentialStore !== undefined) resolverOptions = { ...resolverOptions, credentialStore }
  if (options.openAiAccountAccess !== undefined)
    resolverOptions = { ...resolverOptions, openAiAccountAccess: options.openAiAccountAccess }
  if (options.modelServices !== undefined)
    resolverOptions = { ...resolverOptions, modelServices: options.modelServices }
  return Route.makeResolver(resolverOptions)
}

export const layerHosted = (
  options: HostedOptions,
): Layer.Layer<
  ExecutionGateway.Service | ExecutionSessionLifecycle.Service | Postgres.Readiness | Runtime.Runtime,
  ExecutionGateway.StartTurnFailure,
  PgClient.PgClient
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const credentialStore: ProviderCredentialStore["Service"] | undefined =
        options.credentialStore === undefined
          ? undefined
          : Context.get(yield* Layer.build(options.credentialStore), ProviderCredentialStore)
      let postgresOptions: Parameters<typeof Postgres.layer>[0] = {
        postgres: options.postgres,
        resolver: resolverFor(options, credentialStore),
      }
      if (options.subscriberQueueCapacity !== undefined)
        postgresOptions = { ...postgresOptions, subscriberQueueCapacity: options.subscriberQueueCapacity }
      if (options.scheduler !== undefined) postgresOptions = { ...postgresOptions, scheduler: options.scheduler }
      const apiPostgres = Postgres.layer(postgresOptions)
      const execution = Layer.effectContext(make(options, credentialStore, true)).pipe(Layer.provide(apiPostgres))
      const readiness = Layer.effect(Postgres.Readiness, Effect.map(Postgres.Readiness, Postgres.Readiness.of)).pipe(
        Layer.provide(apiPostgres),
      )
      const runtime = Layer.effect(Runtime.Runtime, Effect.map(Runtime.Runtime, Runtime.Runtime.of)).pipe(
        Layer.provide(apiPostgres),
      )
      return Layer.mergeAll(execution, readiness, runtime).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )

export const layerMemory = (
  options: MemoryOptions,
): Layer.Layer<
  ExecutionGateway.Service | ExecutionSessionLifecycle.Service | Runtime.Runtime,
  ExecutionGateway.StartTurnFailure
> => {
  const shared: CommonOptions = {
    ...options,
    kernel: options.kernel ?? derivedKernelOptions(options.dataRoot),
  }
  return executionLayer(shared, (credentialStore) => {
    let runtimeOptions: Parameters<typeof Runtime.layerMemory>[0] = {
      resolver: resolverFor(shared, credentialStore),
      addresses: [],
    }
    if (options.subscriberQueueCapacity !== undefined)
      runtimeOptions = { ...runtimeOptions, subscriberQueueCapacity: options.subscriberQueueCapacity }
    if (options.scheduler !== undefined) runtimeOptions = { ...runtimeOptions, scheduler: options.scheduler }
    return Runtime.layerMemory(runtimeOptions)
  })
}
