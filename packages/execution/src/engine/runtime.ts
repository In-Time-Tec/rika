import {
  Approval,
  ExecutableManifest,
  ExecutableRegistration,
  ExecutableResolver,
  Message,
  RunTree,
  Runtime,
  TreePolicy,
} from "generalist/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
export type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
export type ProviderCredentialStoreService = ProviderCredentialStore["Service"]
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { type ConfigureOptions, type RemoteToolRoute, configure } from "../routing/route"
import * as Route from "../routing/route"
import * as Postgres from "../postgres"
import { TreeProjector } from "../projection/tree/projector"
import { RuntimeProjection } from "./runtime-projection"
import {
  activateFailure,
  admitFailure,
  approvalFailure,
  message,
  prepareFailure,
  runtimePrompt,
  status,
  steeringFailure,
  titlePrompt,
  titleRunId,
} from "./runtime-support"
import type { CommonOptions, HostedOptions, MemoryOptions } from "./runtime-options"
export { makeHostedModelObserver, makeModelTerminalTelemetry } from "./runtime-telemetry"
export type { ModelTerminalObservation } from "./runtime-telemetry"
export type { CommonOptions, HostedOptions, MemoryOptions } from "./runtime-options"
export const approvalTarget = TreeProjector.authorizationTarget
export const remoteTools = (options: Omit<RemoteToolRoute, "_tag">): RemoteToolRoute => ({ _tag: "Remote", ...options })
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
      if (options.tools?._tag === "Remote")
        yield* options.tools.admit({ threadId: input.threadId, turnId: input.turnId, workspaceId: input.workspaceId })
      const turnCapabilities =
        options.capabilities === undefined ? undefined : yield* options.capabilities(input.workspaceId)
      const configureOptions: ConfigureOptions = {
        executionRoute: input.executionRoute,
        workspace: input.workspaceId,
        executionIdentity: { threadId: input.threadId, turnId: input.turnId },
      }
      Object.assign(configureOptions, {
        tools: options.tools === undefined ? { _tag: "Local" as const } : options.tools,
      })
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
        prompt: runtimePrompt(input),
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
        prompt: titlePrompt(input.prompt),
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
      watchTurn: (link, input) => RuntimeProjection.watchTurn(runtime, hosted, link, input),
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
          Effect.catchTag("generalist/runtime/RunNotFound", () => Effect.succeed({ status: "unavailable" as const })),
          Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: message(cause) })),
        ),
    })
    const unavailable = (cause: unknown) => ExecutionSessionLifecycle.Unavailable.make({ message: message(cause) })
    const lifecycle = ExecutionSessionLifecycle.Service.of({
      requestCancellation: (input) => runtime.cancelSession(input).pipe(Effect.mapError(unavailable)),
      awaitTerminal: (input) => runtime.awaitSessionTerminal(input).pipe(Effect.mapError(unavailable)),
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
  let resolverOptions: Route.ResolverOptions = {}
  if (options.tools !== undefined) resolverOptions = { ...resolverOptions, tools: options.tools }
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
  const shared: CommonOptions = options
  return executionLayer(shared, (credentialStore) => {
    const resolver = resolverFor(shared, credentialStore)
    let runtimeOptions: Parameters<typeof Runtime.layerMemory>[0] = {
      addresses: [],
    }
    if (options.subscriberQueueCapacity !== undefined)
      runtimeOptions = { ...runtimeOptions, subscriberQueueCapacity: options.subscriberQueueCapacity }
    if (options.scheduler !== undefined) runtimeOptions = { ...runtimeOptions, scheduler: options.scheduler }
    return Runtime.layerMemory(runtimeOptions).pipe(
      Layer.provide(Layer.succeed(ExecutableResolver.ExecutableResolver, resolver)),
    )
  })
}
