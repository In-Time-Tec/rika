import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import {
  Controller,
  ControllerError,
  DefaultOrphanGraceMillis,
  layer as controllerLayer,
  type AssignmentKey,
  type Interface as ControllerService,
} from "@rika/e2b-executor/controller"
import { s3ObjectStoreLayer, vaultLayer } from "@rika/e2b-executor/checkpoint"
import { CredentialError, Credentials } from "@rika/e2b-executor/checkout"
import { layer as providerLayer } from "@rika/e2b-executor/provider"
import * as BindingModules from "@rika/kernel/binding-modules"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as MachineBindings from "@rika/kernel/machine-bindings"
import * as PgClient from "@effect/sql-pg/PgClient"
import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
  type OperationRecord,
} from "@rika/product-store/executor-operations"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import * as HostedObservability from "@rika/product/hosted-observability"
import {
  AssignmentLeaseEpoch,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { WorkspacePreparations } from "@rika/product/workspace-preparation"
import { bindingManifest, CellResponse, type CellResponse as CellResponseValue } from "@rika/remote-execution/protocol"
import { HostBindingRegistry } from "tenetkit/repl"
import { Clock, Context, Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect"
import {
  ExecutorGateway,
  GatewayError,
  gatewayLayer,
  type ExecutionResult,
  type Gateway,
  type LifecycleStore,
} from "./gateway"
import { HostedEnvironment } from "../hosted/environment/runtime"
import type { AuthenticatedPrincipal } from "../hosted/product"
import { RunnerExecutor, type RunnerAdmission } from "../runner/executor"
import { HostedRepositories } from "../hosted/repositories"
import * as RunnerGatewayModule from "../runner/gateway"
import type { RunnerGateway } from "../runner/gateway"
import { HostedToolPolicy } from "../hosted/execution/tool-policy"

export class ExecutorConfigError extends Schema.TaggedError<ExecutorConfigError>()("ExecutorConfigError", {
  message: Schema.String,
}) {}

const orbUnavailable = () => ControllerError.make({ kind: "provider", message: "Orb execution is not configured" })

export const runnerOnlyControllerLayer = Layer.succeed(
  Controller,
  Controller.of({
    provision: () => Effect.fail(orbUnavailable()),
    replace: () => Effect.fail(orbUnavailable()),
    resume: () => Effect.fail(orbUnavailable()),
    pause: () => Effect.fail(orbUnavailable()),
    kill: () => Effect.fail(orbUnavailable()),
    portal: () => Effect.fail(orbUnavailable()),
    hello: () => Effect.fail(orbUnavailable()),
    reconnect: () => Effect.fail(orbUnavailable()),
    validateAccess: () => Effect.fail(orbUnavailable()),
    heartbeat: () => Effect.fail(orbUnavailable()),
    checkpoint: () => Effect.fail(orbUnavailable()),
    credential: () => Effect.fail(orbUnavailable()),
    revokeCredential: () => Effect.fail(orbUnavailable()),
    workspace: () => Effect.fail(orbUnavailable()),
    ready: () => Effect.fail(orbUnavailable()),
    loadSetupCache: () => Effect.fail(orbUnavailable()),
    storeSetupCache: () => Effect.fail(orbUnavailable()),
    activatePhase: () => Effect.fail(orbUnavailable()),
    cleanupOrphans: Effect.succeed([]),
  }),
)

const required = (environment: Record<string, string | undefined>, name: string) => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0
    ? Effect.fail(ExecutorConfigError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const OperationIdentity = Schema.Struct({
  workspaceId: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  runId: Schema.String,
  rootRunId: Schema.String,
  toolCallId: Schema.String,
  code: Schema.String,
  attempt: Schema.Int,
  replayPolicy: Schema.Literals(["pure", "provider-idempotent", "never"]),
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))
const requiredWorkspaceCapabilities = [
  "filesystem",
  "typescriptKernel",
  "git",
  "process",
  "workspaceLifecycle",
] as const
export const loadConfig = Effect.fn("ExecutorConfig.load")(function* (environment: Record<string, string | undefined>) {
  const apiUrl = yield* required(environment, "RIKA_EXECUTOR_API_URL")
  return {
    appId: yield* required(environment, "E2B_APP_ID"),
    deploymentId: yield* required(environment, "E2B_DEPLOYMENT_ID"),
    templateId: yield* required(environment, "E2B_TEMPLATE_ID"),
    templateBuildId: yield* required(environment, "E2B_TEMPLATE_BUILD_ID"),
    apiUrl,
    controlEgress: [new URL(apiUrl).hostname],
    apiKey: Redacted.make(yield* required(environment, "E2B_API_KEY"), { label: "e2b-api-key" }),
    checkpointBucket: yield* required(environment, "RIKA_WORKSPACE_CHECKPOINT_BUCKET"),
    checkpointRegion: yield* required(environment, "RIKA_WORKSPACE_CHECKPOINT_REGION"),
    checkpointEndpoint: environment.RIKA_WORKSPACE_CHECKPOINT_ENDPOINT?.trim() || undefined,
    checkpointKey: Redacted.make(yield* required(environment, "RIKA_WORKSPACE_ENCRYPTION_KEY"), {
      label: "workspace-encryption-key",
    }),
    setupCache: environment.RIKA_WORKSPACE_SETUP_CACHE === "true",
  }
})

export type ExecutorConfig = Effect.Success<ReturnType<typeof loadConfig>>

export const layer = (options: ExecutorConfig) =>
  controllerLayer(options).pipe(
    Layer.provide(providerLayer({ apiKey: options.apiKey })),
    Layer.provide(
      vaultLayer(options.checkpointKey).pipe(
        Layer.provide(
          s3ObjectStoreLayer(
            Object.assign(
              {
                bucket: options.checkpointBucket,
                region: options.checkpointRegion,
              },
              options.checkpointEndpoint === undefined ? undefined : { endpoint: options.checkpointEndpoint },
            ),
          ),
        ),
        Layer.provide(BunFileSystem.layer),
      ),
    ),
    Layer.provide(
      Layer.effect(
        Credentials,
        Effect.gen(function* () {
          const repositories = yield* HostedRepositories
          return Credentials.of({
            issue: (request) =>
              repositories
                .credential(
                  request.purpose === "branch-push"
                    ? {
                        access: request.access,
                        ownerId: request.ownerId,
                        workspaceId: request.workspaceId,
                        repositoryId: request.repositoryId,
                        purpose: "branch-push",
                        publicationId: request.publicationId,
                        branch: request.branch,
                        ref: request.ref,
                        commitSha: request.commitSha,
                      }
                    : {
                        access: request.access,
                        ownerId: request.ownerId,
                        workspaceId: request.workspaceId,
                        repositoryId: request.repositoryId,
                        purpose: request.purpose,
                      },
                )
                .pipe(Effect.mapError((error) => CredentialError.make({ message: error.message }))),
            revoke: (access, purpose, publicationId) =>
              repositories
                .revoke(access, purpose, publicationId)
                .pipe(Effect.mapError((error) => CredentialError.make({ message: error.message }))),
          })
        }),
      ),
    ),
  )

export interface Runtime {
  readonly controller: ControllerService
  readonly gateway: Gateway
  readonly runnerGateway: RunnerGateway
  readonly admitRunner: (input: {
    readonly threadId: string
    readonly workspaceFingerprint: string
    readonly principal: AuthenticatedPrincipal
    readonly executorUrl: string
  }) => Effect.Effect<RunnerAdmission, ControllerError>
  readonly admitRun: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly workspaceId: string
  }) => Effect.Effect<void, ControllerError>
  readonly run: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly runId: string
    readonly sessionId: string
    readonly workspaceId: string
    readonly toolCallId: string
    readonly operationKey: string
    readonly code: string
    readonly rootRunId: string
    readonly attempt: number
    readonly replayPolicy: "pure" | "provider-idempotent" | "never"
    readonly admittedAt: string | null
    readonly deadlineAt: string
    readonly authority: Context.Context<ExecutorRuntime.CellServices>
  }) => Effect.Effect<
    {
      readonly access?: import("@rika/remote-execution/protocol").AccessWire
      readonly response: import("@rika/remote-execution/protocol").CellResponse
      readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
      readonly eventPersisted: boolean
    },
    ControllerError | GatewayError
  >
  readonly ready: Effect.Effect<void, ControllerError>
  readonly pause: (key: AssignmentKey) => Effect.Effect<void, ControllerError | GatewayError>
  readonly resume: (key: AssignmentKey) => Effect.Effect<void, ControllerError>
  readonly replace: (key: AssignmentKey) => Effect.Effect<void, ControllerError>
}

export class Executor extends Context.Service<Executor, Runtime>()("@rika/api/executor/service/Executor") {}

class HostedRunnerGateway extends Context.Service<HostedRunnerGateway, RunnerGateway>()(
  "@rika/api/executor/service/HostedRunnerGateway",
) {}

export const service = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const controller = yield* Controller
    const assignments = yield* ExecutorAssignments
    const environment = yield* HostedEnvironment
    const preparations = yield* WorkspacePreparations
    const toolPolicy = yield* HostedToolPolicy
    const sql = yield* PgClient.PgClient
    const crypto = yield* Crypto.Crypto
    const scope = yield* Effect.scope
    const operationsContext = yield* Layer.buildWithScope(
      hostedExecutionOperationsLayer.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, sql))),
      scope,
    )
    const operations = Context.get(operationsContext, HostedExecutionOperations)
    yield* Effect.forever(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => preparations.expireOverdue(now)),
        Effect.catch((error) =>
          Effect.logError("workspace-preparation-expiry.failed").pipe(
            Effect.annotateLogs("rika.error.message", error.message),
          ),
        ),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ).pipe(Effect.forkScoped)
    const decodeResponse = Schema.decodeUnknownEffect(CellResponse)
    const unknownResponse: CellResponseValue = {
      _tag: "DomainFailure",
      failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
    }
    const timeoutResponse: CellResponseValue = {
      _tag: "DomainFailure",
      failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
    }
    const terminalResult = Effect.fn("Executor.terminalResult")(function* (
      row: Pick<OperationRecord, "response" | "terminalOutcome">,
    ): Effect.fn.Return<ExecutionResult, GatewayError> {
      if (row.response === null || row.terminalOutcome === null)
        return yield* GatewayError.make({ kind: "transport", message: "Persisted executor terminal is incomplete" })
      const response = yield* decodeResponse(row.response).pipe(
        Effect.mapError(() =>
          GatewayError.make({ kind: "transport", message: "Persisted executor response is invalid" }),
        ),
      )
      return { response, outcome: row.terminalOutcome }
    })
    const persistenceFailure = (message: string) =>
      Effect.mapError(() => GatewayError.make({ kind: "transport", message }))
    const reapOrphans = controller.cleanupOrphans.pipe(
      Effect.catch((error) =>
        Effect.logError("executor.orphan-reaper.failed").pipe(
          Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
        ),
      ),
    )
    const preparationAccess = Effect.fn("Executor.preparationAccess")(function* (
      input: import("@rika/remote-execution/protocol").AccessWire,
    ) {
      const digest = Encoding.encodeHex(
        yield* crypto
          .digest("SHA-256", new TextEncoder().encode(input.sessionToken))
          .pipe(
            Effect.mapError(() =>
              GatewayError.make({ kind: "transport", message: "Could not verify executor access" }),
            ),
          ),
      )
      return {
        assignmentId: ExecutorAssignmentId.make(input.fence.assignmentId),
        assignmentGeneration: FencingGeneration.make(String(input.fence.assignmentGeneration)),
        providerInstanceId: input.fence.instanceId,
        executorInstanceId: ExecutorInstanceId.make(input.fence.executorId),
        processIncarnation: input.fence.processIncarnation,
        leaseEpoch: AssignmentLeaseEpoch.make(String(input.leaseEpoch)),
        presentedSessionCredentialDigest: Redacted.make(digest),
      }
    })
    const preparationFailure = (error: GatewayError | { readonly reason: string; readonly message: string }) =>
      Schema.is(GatewayError)(error)
        ? error
        : GatewayError.make({
            kind: error.reason === "database" ? "transport" : "fenced",
            message: error.message,
          })
    const hostedBindingModules = (workspace: string) =>
      BindingModules.make({
        workspace,
        workspaceDigest: workspace,
        trustMode: "hosted",
        servers: [],
      })
    const bindingContract = (workspace: string) =>
      bindingManifest(
        hostedBindingModules(workspace).map((module) => ({
          module: module.name,
          operations: module.operations.map((operation) => operation.name),
        })),
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.map((manifest) => manifest.digest),
      )
    const lifecycle: LifecycleStore = {
      append: (access, frame) =>
        Effect.gen(function* () {
          const key = {
            assignmentId: access.fence.assignmentId,
            operationKey: frame.attribution.operationKey,
            attempt: frame.attribution.attempt,
          }
          const operation = yield* operations
            .findOperation(key)
            .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
          if (operation === undefined)
            return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle operation is unavailable" })
          const attribution = frame.attribution
          if (
            operation.workspaceId !== attribution.workspaceId ||
            operation.sessionId !== attribution.sessionId ||
            operation.threadId !== attribution.threadId ||
            operation.turnId !== attribution.turnId ||
            operation.runId !== attribution.runId ||
            operation.rootRunId !== attribution.rootRunId ||
            operation.toolCallId !== attribution.toolCallId ||
            operation.dispatchedGeneration !== access.fence.assignmentGeneration ||
            operation.dispatchedExecutorInstanceId !== access.fence.executorId ||
            operation.dispatchedProcessIncarnation !== access.fence.processIncarnation
          )
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor lifecycle does not match its durable operation",
            })
          const result = yield* operations
            .appendFrame(access.fence.assignmentId, frame)
            .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
          if (result === "invalid-sequence")
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor lifecycle cursor has different content",
            })
          if (result === "duplicate")
            return operation.state === "completed" || operation.state === "unknown"
              ? ({ _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const)
              : ({ _tag: "AlreadyAppended" } as const)
          if (result === "already-terminal")
            return { _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const
          if (frame._tag === "Terminal") {
            const completed = yield* operations
              .complete(
                key,
                {
                  assignmentGeneration: access.fence.assignmentGeneration,
                  leaseEpoch: access.leaseEpoch,
                  executorInstanceId: access.fence.executorId,
                  processIncarnation: access.fence.processIncarnation,
                },
                frame.response,
                frame.outcome,
              )
              .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
            if (!completed)
              return yield* GatewayError.make({ kind: "fenced", message: "Executor operation was not dispatched" })
          }
          return { _tag: "Appended" } as const
        }),
      load: (assignmentId, operationKey, attempt) =>
        operations
          .readFrames({ assignmentId, operationKey, attempt })
          .pipe(persistenceFailure("Could not load executor lifecycle frames")),
      replay: (assignmentId) =>
        operations.replayQueue(assignmentId).pipe(persistenceFailure("Could not load executor replay queue")),
      prepare: (input) =>
        Effect.gen(function* () {
          const encoded = encodeOperationIdentity({
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            threadId: input.threadId,
            turnId: input.turnId,
            runId: input.runId,
            rootRunId: input.rootRunId,
            toolCallId: input.toolCallId,
            code: input.code,
            attempt: input.attempt,
            replayPolicy: input.replayPolicy,
          })
          const requestDigest = Encoding.encodeHex(
            yield* crypto
              .digest("SHA-256", new TextEncoder().encode(encoded))
              .pipe(
                Effect.mapError(() =>
                  GatewayError.make({ kind: "transport", message: "Could not identify executor operation" }),
                ),
              ),
          )
          const row = yield* operations
            .upsertOperation({ ...input, requestDigest })
            .pipe(persistenceFailure("Could not persist executor operation"))
          if (
            row === undefined ||
            row.requestDigest !== requestDigest ||
            row.workspaceId !== input.workspaceId ||
            row.sessionId !== input.sessionId ||
            row.threadId !== input.threadId ||
            row.turnId !== input.turnId ||
            row.runId !== input.runId ||
            row.rootRunId !== input.rootRunId ||
            row.toolCallId !== input.toolCallId ||
            row.code !== input.code ||
            row.attempt !== input.attempt ||
            row.replayPolicy !== input.replayPolicy
          )
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor operation key conflicts with a different request",
            })
          return { admittedAt: row.admittedAt, deadlineAt: row.deadlineAt }
        }),
      inspect: (input) =>
        Effect.gen(function* () {
          const row = yield* operations
            .findOperation(input)
            .pipe(persistenceFailure("Could not inspect executor operation"))
          if (row === undefined)
            return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
          const result = { state: row.state, started: row.started }
          if (row.response !== null) Object.assign(result, { response: row.response })
          if (row.terminalOutcome !== null) Object.assign(result, { outcome: row.terminalOutcome })
          if (row.dispatchedGeneration !== null)
            Object.assign(result, { dispatchedGeneration: row.dispatchedGeneration })
          if (row.dispatchedExecutorInstanceId !== null)
            Object.assign(result, { dispatchedExecutorInstanceId: row.dispatchedExecutorInstanceId })
          if (row.dispatchedProcessIncarnation !== null)
            Object.assign(result, { dispatchedProcessIncarnation: row.dispatchedProcessIncarnation })
          return result
        }),
      dispatch: (input, access) =>
        operations
          .claimDispatch(input, {
            assignmentGeneration: access.fence.assignmentGeneration,
            leaseEpoch: access.leaseEpoch,
            providerInstanceId: access.fence.instanceId,
            executorInstanceId: access.fence.executorId,
            processIncarnation: access.fence.processIncarnation,
          })
          .pipe(
            persistenceFailure("Could not persist executor dispatch"),
            Effect.flatMap((result) => {
              if (result === "claimed" || result === "same-fence") return Effect.void
              if (result === "missing")
                return GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              return GatewayError.make({ kind: "fenced", message: "Executor dispatch fence is no longer current" })
            }),
          ),
      resolveDeadline: (input) =>
        Effect.gen(function* () {
          const row = yield* operations
            .findOperation(input)
            .pipe(persistenceFailure("Could not resolve executor operation deadline"))
          if (row === undefined)
            return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
          if (row.state === "completed" || row.state === "unknown")
            return { _tag: "AlreadyTerminal", result: yield* terminalResult(row) } as const
          if (row.state === "dispatched")
            return { _tag: "Resolved", result: { response: unknownResponse, outcome: "unknown" } } as const
          const timedOut = yield* operations
            .timeoutAccepted(input, timeoutResponse)
            .pipe(persistenceFailure("Could not resolve executor operation deadline"))
          if (timedOut === undefined) {
            const current = yield* operations
              .findOperation(input)
              .pipe(persistenceFailure("Could not resolve executor operation deadline"))
            if (current === undefined)
              return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
            if (current.state === "completed" || current.state === "unknown")
              return { _tag: "AlreadyTerminal", result: yield* terminalResult(current) } as const
            return { _tag: "Resolved", result: { response: unknownResponse, outcome: "unknown" } } as const
          }
          return { _tag: "Resolved", result: { response: timeoutResponse, outcome: "failed" } } as const
        }),
    }
    const gatewayContext = yield* Layer.buildWithScope(
      gatewayLayer({
        controller,
        lifecycle,
        phases: {
          activate: (executorAccess, phase, use) =>
            environment
              .usePhase({ assignmentId: executorAccess.fence.assignmentId, phase }, (resolved) =>
                controller
                  .activatePhase(
                    {
                      ...executorAccess,
                      sessionToken: Redacted.make(executorAccess.sessionToken, { label: "executor-session" }),
                    },
                    resolved.egress,
                  )
                  .pipe(
                    Effect.andThen(
                      use({
                        digest: resolved.manifest.digest,
                        values: resolved.values,
                        redactedNames: resolved.manifest.references.map((reference) => reference.name),
                      }),
                    ),
                  ),
              )
              .pipe(
                Effect.mapError((error) =>
                  Schema.is(GatewayError)(error)
                    ? error
                    : GatewayError.make({ kind: "fenced", message: "Executor phase authorization was rejected" }),
                ),
              ),
          publication: (executorAccess, use) =>
            environment
              .usePhase({ assignmentId: executorAccess.fence.assignmentId, phase: "runtime" }, (resolved) =>
                Effect.gen(function* () {
                  const access = {
                    ...executorAccess,
                    sessionToken: Redacted.make(executorAccess.sessionToken, { label: "executor-session" }),
                  }
                  const update = (egress: typeof resolved.egress) =>
                    controller
                      .activatePhase(access, egress)
                      .pipe(
                        Effect.mapError(() =>
                          GatewayError.make({ kind: "fenced", message: "Repository publication egress was rejected" }),
                        ),
                      )
                  yield* update({
                    phase: "runtime",
                    allow: [...new Set([...resolved.egress.allow, "github.com"])].sort(),
                  })
                  const outcome = yield* Effect.exit(use())
                  yield* update(resolved.egress)
                  return yield* outcome
                }),
              )
              .pipe(
                Effect.mapError((error) =>
                  Schema.is(GatewayError)(error)
                    ? error
                    : GatewayError.make({ kind: "fenced", message: "Repository publication egress is unavailable" }),
                ),
              ),
          replace: (key) =>
            environment
              .usePhase({ assignmentId: key.assignmentId, phase: "runtime" }, (resolved) =>
                controller
                  .replace(key, { egress: resolved.egress, environmentDigest: resolved.manifest.digest })
                  .pipe(Effect.asVoid),
              )
              .pipe(
                Effect.mapError(() =>
                  GatewayError.make({ kind: "fenced", message: "Executor replacement authorization was rejected" }),
                ),
              ),
        },
        preparation: {
          start: (input) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              yield* preparations.start({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                now,
                deadlineAt: now + 30 * 60 * 1_000,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          output: (input) =>
            Effect.gen(function* () {
              yield* preparations.appendOutput({
                access: yield* preparationAccess(input.access),
                phase: input.phase,
                attempt: input.attempt,
                stream: input.stream,
                text: input.text,
                redacted: true,
                truncated: input.truncated,
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          complete: (input) =>
            Effect.gen(function* () {
              yield* preparations.complete({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                evidence: { ...input.evidence, workspaceId: WorkspaceId.make(input.evidence.workspaceId) },
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          fail: (input) =>
            Effect.gen(function* () {
              yield* preparations.fail({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                message: input.message,
                retryable: input.retryable,
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          retry: (input) =>
            Effect.flatMap(preparationAccess(input), (resolved) => preparations.retryAttempt(resolved)).pipe(
              Effect.mapError(preparationFailure),
            ),
          ready: (input) =>
            Effect.flatMap(preparationAccess(input), (resolved) => preparations.requireReady(resolved)).pipe(
              Effect.asVoid,
              Effect.mapError(preparationFailure),
            ),
        },
        bindingContract,
        toolPolicy,
      }),
      scope,
    )
    const gateway = Context.get(gatewayContext, ExecutorGateway)
    const runner = yield* RunnerExecutor
    const runnerGatewayContext = yield* Layer.buildWithScope(
      Layer.effect(HostedRunnerGateway, RunnerGatewayModule.makeRunnerGateway(runner, toolPolicy)),
      scope,
    )
    const runnerGateway = Context.get(runnerGatewayContext, HostedRunnerGateway)
    const bindings = Effect.fn("Executor.bindings")(function* (
      input: Parameters<Runtime["run"]>[0],
      assignmentId: string,
      machine: typeof gateway.machine,
    ) {
      const machineContext = yield* Layer.buildWithScope(
        MachineBindings.layer({
          execute: (request) =>
            machine(assignmentId, input.operationKey, input.attempt, request).pipe(
              Effect.mapError((error) => new MachineBindings.Unavailable({ message: error.message })),
            ),
        }),
        scope,
      )
      const context = Context.merge(input.authority, machineContext)
      const registry = yield* HostBindingRegistry.make(hostedBindingModules(input.workspaceId)).pipe(
        Effect.provideContext(context),
        Effect.orDie,
      )
      const manifest = yield* bindingManifest(registry.descriptors).pipe(Effect.provideService(Crypto.Crypto, crypto))
      return { registry, context, manifest }
    })
    return {
      controller,
      gateway,
      runnerGateway,
      admitRunner: (input) => runner.admit(input),
      admitRun: Effect.fn("Executor.admitRun")(function* (input) {
        const initial = yield* assignments
          .getForThread(ThreadId.make(input.threadId))
          .pipe(Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })))
        if (initial === undefined)
          return yield* ControllerError.make({
            kind: "assignment-missing",
            message: "Executor assignment is unavailable",
          })
        if (initial.workspaceId !== input.workspaceId)
          return yield* ControllerError.make({
            kind: "fenced",
            message: "Executor workspace identity does not match the Run workspace",
          })
        yield* HostedObservability.observe(
          "attach",
          { ownerId: initial.ownerId, threadId: input.threadId, turnId: input.turnId, assignmentId: initial.id },
          Effect.gen(function* () {
            if (initial.placement._tag === "OrbPlacement") {
              const phase =
                initial.lifecycle._tag === "Paused" || initial.lifecycle._tag === "Active" ? "runtime" : "setup"
              yield* environment
                .usePhase({ assignmentId: initial.id, phase }, (resolved) =>
                  controller.provision(initial.id, {
                    egress: resolved.egress,
                    environmentDigest: resolved.manifest.digest,
                  }),
                )
                .pipe(
                  Effect.mapError((error) =>
                    Schema.is(ControllerError)(error)
                      ? error
                      : ControllerError.make({
                          kind: "repository",
                          message: "Executor phase authorization was rejected",
                        }),
                  ),
                )
            }
            const awaitActive = (): Effect.Effect<ExecutorAssignment, ControllerError> =>
              Effect.gen(function* () {
                const current = yield* assignments
                  .get(initial.id)
                  .pipe(
                    Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })),
                  )
                if (current === undefined)
                  return yield* ControllerError.make({
                    kind: "assignment-missing",
                    message: "Executor assignment disappeared while awaiting workspace readiness",
                  })
                if (current.generation !== initial.generation)
                  return yield* ControllerError.make({
                    kind: "fenced",
                    message: "Executor assignment was replaced while awaiting workspace readiness",
                  })
                if (
                  current.lifecycle._tag === "Active" &&
                  current.capabilityGeneration === current.generation &&
                  current.capabilities !== null
                )
                  return current
                if (current.lifecycle._tag !== "Provisioning" && current.lifecycle._tag !== "AwaitingBootstrap")
                  return yield* ControllerError.make({
                    kind: "assignment-conflict",
                    message: "Executor workspace stopped preparing before its capabilities became ready",
                  })
                const bootstrapLive = yield* assignments
                  .isBootstrapLive({ assignmentId: current.id, generation: current.generation })
                  .pipe(
                    Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })),
                  )
                if (!bootstrapLive)
                  return yield* ControllerError.make({
                    kind: "assignment-conflict",
                    message: "Executor workspace preparation exceeded its durable bootstrap deadline",
                  })
                yield* Effect.sleep(100)
                return yield* awaitActive()
              })
            const active = yield* awaitActive()
            const capabilities = active.capabilities!
            const unavailable = requiredWorkspaceCapabilities.flatMap((name) => {
              const capability = capabilities[name]
              return capability._tag === "Ready" ? [] : [`${name}: ${capability.reason}`]
            })
            if (unavailable.length > 0)
              return yield* ControllerError.make({
                kind: "protocol",
                message: `Run requires unavailable workspace capabilities: ${unavailable.join("; ")}`,
              })
            const admitted = yield* operations
              .admitWorkspaceCapabilities({
                threadId: input.threadId,
                turnId: input.turnId,
                assignmentId: active.id,
                workspaceId: input.workspaceId,
                assignmentGeneration: Number(active.generation),
                environmentDigest: capabilities.environmentDigest,
                requiredCapabilities: [...requiredWorkspaceCapabilities],
              })
              .pipe(
                Effect.mapError(() =>
                  ControllerError.make({
                    kind: "repository",
                    message: "Could not persist workspace capability admission",
                  }),
                ),
              )
            if (!admitted)
              return yield* ControllerError.make({
                kind: "fenced",
                message: "Run capability admission conflicts with the current assignment environment",
              })
          }),
        )
      }),
      run: Effect.fn("Executor.run")(function* (input) {
        const assignment = yield* assignments
          .getForThread(ThreadId.make(input.threadId))
          .pipe(Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })))
        if (assignment === undefined)
          return yield* ControllerError.make({
            kind: "assignment-missing",
            message: "Executor assignment is unavailable",
          })
        if (assignment.workspaceId !== input.workspaceId)
          return yield* ControllerError.make({
            kind: "fenced",
            message: "Executor workspace identity does not match the assignment",
          })
        const admission =
          assignment.capabilities !== null && assignment.capabilityGeneration === assignment.generation
            ? yield* operations
                .validateWorkspaceCapabilities({
                  threadId: input.threadId,
                  turnId: input.turnId,
                  assignmentId: assignment.id,
                  workspaceId: input.workspaceId,
                  assignmentGeneration: Number(assignment.generation),
                  environmentDigest: assignment.capabilities.environmentDigest,
                })
                .pipe(
                  Effect.mapError(() =>
                    ControllerError.make({ kind: "repository", message: "Could not inspect Run capability admission" }),
                  ),
                )
            : false
        if (!admission || assignment.capabilities === null || assignment.capabilityGeneration !== assignment.generation)
          return yield* ControllerError.make({
            kind: "fenced",
            message: "Run capability admission no longer matches the assignment environment",
          })
        const correlation = {
          ownerId: assignment.ownerId,
          threadId: input.threadId,
          turnId: input.turnId,
          runId: input.runId,
          operationId: input.operationKey,
          assignmentId: assignment.id,
        }
        if (assignment.placement._tag === "RunnerPlacement") {
          return yield* HostedObservability.observe(
            "cell_execution",
            correlation,
            Effect.gen(function* () {
              const authority = yield* bindings(input, assignment.id, runnerGateway.machine)
              return yield* runnerGateway.execute({
                assignmentId: assignment.id,
                ...input,
                bindings: authority,
              })
            }),
          )
        }
        return yield* HostedObservability.observe(
          "cell_execution",
          correlation,
          Effect.gen(function* () {
            const authority = yield* bindings(input, assignment.id, gateway.machine)
            const result = yield* gateway.execute({
              assignmentId: assignment.id,
              ...input,
              bindings: authority,
            })
            return { ...result, eventPersisted: false as const }
          }),
        )
      }),
      pause: (key) =>
        gateway.quiesce(key.assignmentId).pipe(
          Effect.flatMap((barrier) => controller.pause(key, barrier)),
          Effect.catch((error) => (error.kind === "disconnected" ? controller.pause(key) : Effect.fail(error))),
          Effect.asVoid,
        ),
      resume: (key) =>
        environment
          .usePhase({ assignmentId: key.assignmentId, phase: "runtime" }, (resolved) =>
            controller
              .resume(key, { egress: resolved.egress, environmentDigest: resolved.manifest.digest })
              .pipe(Effect.asVoid),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(ControllerError)(error)
                ? error
                : ControllerError.make({ kind: "repository", message: "Executor phase authorization was rejected" }),
            ),
          ),
      replace: (key) =>
        environment
          .usePhase({ assignmentId: key.assignmentId, phase: "runtime" }, (resolved) =>
            controller
              .replace(key, { egress: resolved.egress, environmentDigest: resolved.manifest.digest })
              .pipe(Effect.asVoid),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(ControllerError)(error)
                ? error
                : ControllerError.make({ kind: "repository", message: "Executor phase authorization was rejected" }),
            ),
          ),
      ready: reapOrphans.pipe(
        Effect.andThen(
          Effect.sleep(DefaultOrphanGraceMillis).pipe(
            Effect.andThen(reapOrphans),
            Effect.forever,
            Effect.forkIn(scope),
          ),
        ),
        Effect.asVoid,
      ),
    }
  }),
)
