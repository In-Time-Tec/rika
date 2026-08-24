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
import { ExecutorAssignments } from "@rika/product/executor-assignments"
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
import {
  bindingManifest,
  CellLifecycleFrame,
  CellResponse,
  type CellResponse as CellResponseValue,
} from "@rika/remote-execution/protocol"
import { HostBindingRegistry } from "tenetkit/repl"
import { Clock, Context, Crypto, Effect, Encoding, Layer, Redacted, Schedule, Schema } from "effect"
import {
  GatewayError,
  makeGateway,
  type ExecutionOutcome,
  type ExecutionResult,
  type Gateway,
  type LifecycleStore,
} from "./gateway"
import { HostedEnvironment } from "../hosted/environment/runtime"
import type { AuthenticatedPrincipal } from "../hosted/product"
import { RunnerExecutor, type RunnerAdmission } from "../runner/executor"
import { HostedRepositories } from "../hosted/repositories"
import { makeRunnerGateway, type RunnerGateway } from "../runner/gateway"
import { HostedToolPolicy } from "../hosted/execution/tool-policy"

export class ExecutorConfigError extends Schema.TaggedError<ExecutorConfigError>()("ExecutorConfigError", {
  message: Schema.String,
}) {}

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
  admittedAt: Schema.NullOr(Schema.String),
  deadlineAt: Schema.String,
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))
const requiredWorkspaceCapabilities = [
  "filesystem",
  "typescriptKernel",
  "git",
  "process",
  "workspaceLifecycle",
] as const
const encodeRequiredWorkspaceCapabilities = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
)

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
          s3ObjectStoreLayer({
            bucket: options.checkpointBucket,
            region: options.checkpointRegion,
            ...(options.checkpointEndpoint === undefined ? {} : { endpoint: options.checkpointEndpoint }),
          }),
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
    const decodeLifecycle = Schema.decodeUnknownEffect(CellLifecycleFrame)
    const decodeResponse = Schema.decodeUnknownEffect(CellResponse)
    const equivalentLifecycle = Schema.toEquivalence(CellLifecycleFrame)
    const unknownResponse: CellResponseValue = {
      _tag: "DomainFailure",
      failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
    }
    const timeoutResponse: CellResponseValue = {
      _tag: "DomainFailure",
      failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
    }
    const terminalResult = Effect.fn("Executor.terminalResult")(function* (row: {
      readonly response: unknown | null
      readonly terminalOutcome: ExecutionOutcome | null
    }): Effect.fn.Return<ExecutionResult, GatewayError> {
      if (row.response === null || row.terminalOutcome === null)
        return yield* GatewayError.make({ kind: "transport", message: "Persisted executor terminal is incomplete" })
      const response = yield* decodeResponse(row.response).pipe(
        Effect.mapError(() =>
          GatewayError.make({ kind: "transport", message: "Persisted executor response is invalid" }),
        ),
      )
      return { response, outcome: row.terminalOutcome }
    })
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
        sql
          .withTransaction(
            Effect.gen(function* () {
              const operations = yield* sql<{
                readonly state: "accepted" | "dispatched" | "completed" | "unknown"
                readonly response: unknown | null
                readonly terminalOutcome: ExecutionOutcome | null
                readonly workspaceId: string
                readonly sessionId: string
                readonly threadId: string
                readonly turnId: string
                readonly runId: string
                readonly rootRunId: string
                readonly toolCallId: string
                readonly dispatchedGeneration: string | null
                readonly dispatchedExecutorInstanceId: string | null
                readonly dispatchedProcessIncarnation: string | null
              }>`SELECT state, response, terminal_outcome AS "terminalOutcome", workspace_id AS "workspaceId",
                session_id AS "sessionId", thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId",
                root_run_id AS "rootRunId", tool_call_id AS "toolCallId",
                dispatched_generation::text AS "dispatchedGeneration",
                dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
                dispatched_process_incarnation AS "dispatchedProcessIncarnation"
              FROM rika_hosted_executor_operations
              WHERE assignment_id = ${access.fence.assignmentId} AND operation_key = ${frame.attribution.operationKey}
                AND attempt = ${frame.attribution.attempt}::bigint
              FOR UPDATE`
              const operation = operations[0]
              if (operation === undefined)
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor lifecycle operation is unavailable",
                })
              const attribution = frame.attribution
              if (
                operation.workspaceId !== attribution.workspaceId ||
                operation.sessionId !== attribution.sessionId ||
                operation.threadId !== attribution.threadId ||
                operation.turnId !== attribution.turnId ||
                operation.runId !== attribution.runId ||
                operation.rootRunId !== attribution.rootRunId ||
                operation.toolCallId !== attribution.toolCallId ||
                operation.dispatchedGeneration !== String(access.fence.assignmentGeneration) ||
                operation.dispatchedExecutorInstanceId !== access.fence.executorId ||
                operation.dispatchedProcessIncarnation !== access.fence.processIncarnation
              )
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor lifecycle does not match its durable operation",
                })
              const rows = yield* sql<{ readonly frame: unknown }>`SELECT frame
              FROM rika_hosted_executor_operation_frames
              WHERE assignment_id = ${access.fence.assignmentId}
                AND operation_key = ${frame.attribution.operationKey}
                AND attempt = ${frame.attribution.attempt}::bigint
                AND cursor = ${frame.cursor}`
              if (rows[0] !== undefined) {
                yield* decodeLifecycle(rows[0].frame).pipe(
                  Effect.filterOrFail(
                    (persisted) => equivalentLifecycle(persisted, frame),
                    () =>
                      GatewayError.make({ kind: "fenced", message: "Executor lifecycle cursor has different content" }),
                  ),
                  Effect.asVoid,
                  Effect.mapError((error) =>
                    Schema.is(GatewayError)(error)
                      ? error
                      : GatewayError.make({
                          kind: "transport",
                          message: "Persisted executor lifecycle frame is invalid",
                        }),
                  ),
                )
                return operation.state === "completed" || operation.state === "unknown"
                  ? ({ _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const)
                  : ({ _tag: "AlreadyAppended" } as const)
              }
              if (operation.state === "completed" || operation.state === "unknown")
                return { _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const
              if (operation.state !== "dispatched")
                return yield* GatewayError.make({ kind: "fenced", message: "Executor operation was not dispatched" })
              yield* sql`INSERT INTO rika_hosted_executor_operation_frames
              (assignment_id, operation_key, attempt, cursor, kind, frame)
              VALUES (${access.fence.assignmentId}, ${frame.attribution.operationKey}, ${frame.attribution.attempt},
                ${frame.cursor}, ${frame._tag}, ${sql.json(frame)})`
              if (frame._tag === "Started")
                yield* sql`UPDATE rika_hosted_executor_operations
                SET started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp()
                WHERE assignment_id = ${access.fence.assignmentId} AND operation_key = ${frame.attribution.operationKey}
                  AND attempt = ${frame.attribution.attempt}::bigint AND state = 'dispatched'`
              if (frame._tag === "Terminal")
                yield* sql`UPDATE rika_hosted_executor_operations SET
                  state = ${frame.outcome === "unknown" ? "unknown" : "completed"},
                  response = ${sql.json(frame.response)},
                  terminal_outcome = ${frame.outcome},
                  resolution_state = ${frame.outcome === "unknown" ? "pending" : null},
                  updated_at = clock_timestamp()
                WHERE assignment_id = ${access.fence.assignmentId} AND operation_key = ${frame.attribution.operationKey}
                  AND attempt = ${frame.attribution.attempt}::bigint
                  AND state = 'dispatched'`
              return { _tag: "Appended" } as const
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              GatewayError.make({ kind: "transport", message: "Could not persist executor lifecycle frame" }),
            ),
          ),
      load: (assignmentId, operationKey, attempt) =>
        sql<{ readonly frame: unknown }>`SELECT frame
          FROM rika_hosted_executor_operation_frames
          WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey}
            AND attempt = ${attempt}::bigint
          ORDER BY cursor`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeLifecycle(row.frame).pipe(
                Effect.mapError(() =>
                  GatewayError.make({ kind: "transport", message: "Persisted executor lifecycle frame is invalid" }),
                ),
              ),
            ),
          ),
          Effect.catchTag("SqlError", () =>
            GatewayError.make({ kind: "transport", message: "Could not load executor lifecycle frames" }),
          ),
        ),
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
            admittedAt: input.admittedAt,
            deadlineAt: input.deadlineAt,
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
          yield* sql`INSERT INTO rika_hosted_executor_operations
            (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id,
             turn_id, run_id, root_run_id, tool_call_id, code, attempt, replay_policy, admitted_at, deadline_at, state)
            SELECT assignment.id, assignment.owner_id, ${input.operationKey}, ${requestDigest},
              ${input.workspaceId}, ${input.sessionId}, ${input.threadId}, ${input.turnId}, ${input.runId},
              ${input.rootRunId}, ${input.toolCallId}, ${input.code}, ${input.attempt}, ${input.replayPolicy}, ${input.admittedAt},
              ${input.deadlineAt}, 'accepted'
            FROM rika_hosted_executor_assignments assignment
            WHERE assignment.id = ${input.assignmentId}
            ON CONFLICT (assignment_id, operation_key, attempt) DO NOTHING`
          const rows = yield* sql<{
            readonly requestDigest: string
            readonly workspaceId: string
            readonly sessionId: string
            readonly threadId: string
            readonly turnId: string
            readonly runId: string
            readonly rootRunId: string
            readonly toolCallId: string
            readonly code: string
            readonly attempt: string
            readonly replayPolicy: "pure" | "provider-idempotent" | "never"
            readonly admittedAt: string | null
            readonly deadlineAt: string
          }>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId", session_id AS "sessionId",
              thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId", root_run_id AS "rootRunId",
              tool_call_id AS "toolCallId", code, attempt::text AS attempt, replay_policy AS "replayPolicy",
              admitted_at AS "admittedAt",
              to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deadlineAt"
            FROM rika_hosted_executor_operations
            WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
              AND attempt = ${input.attempt}::bigint`
          const row = rows[0]
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
            Number(row.attempt) !== input.attempt ||
            row.replayPolicy !== input.replayPolicy ||
            row.admittedAt !== input.admittedAt ||
            row.deadlineAt !== input.deadlineAt
          )
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor operation key conflicts with a different request",
            })
        }).pipe(
          Effect.catchTag("SqlError", () =>
            GatewayError.make({ kind: "transport", message: "Could not persist executor operation" }),
          ),
        ),
      inspect: (input) =>
        sql<{
          readonly state: "accepted" | "dispatched" | "completed" | "unknown"
          readonly started: boolean
          readonly response: unknown
          readonly terminalOutcome: ExecutionOutcome | null
          readonly dispatchedGeneration: string | null
          readonly dispatchedExecutorInstanceId: string | null
          readonly dispatchedProcessIncarnation: string | null
        }>`SELECT state, started_at IS NOT NULL AS started, response, terminal_outcome AS "terminalOutcome",
            dispatched_generation::text AS "dispatchedGeneration",
            dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
            dispatched_process_incarnation AS "dispatchedProcessIncarnation"
          FROM rika_hosted_executor_operations
          WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
            AND attempt = ${input.attempt}::bigint`.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0]
            if (row === undefined)
              return GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
            const response: Effect.Effect<CellResponseValue | undefined, GatewayError> =
              row.response === null
                ? Effect.void.pipe(Effect.as(undefined))
                : decodeResponse(row.response).pipe(
                    Effect.mapError(() =>
                      GatewayError.make({ kind: "transport", message: "Persisted executor response is invalid" }),
                    ),
                  )
            return response.pipe(
              Effect.map((decoded) => ({
                state: row.state,
                started: row.started,
                ...(decoded === undefined ? {} : { response: decoded }),
                ...(row.terminalOutcome === null ? {} : { outcome: row.terminalOutcome }),
                ...(row.dispatchedGeneration === null
                  ? {}
                  : { dispatchedGeneration: Number(row.dispatchedGeneration) }),
                ...(row.dispatchedExecutorInstanceId === null
                  ? {}
                  : { dispatchedExecutorInstanceId: row.dispatchedExecutorInstanceId }),
                ...(row.dispatchedProcessIncarnation === null
                  ? {}
                  : { dispatchedProcessIncarnation: row.dispatchedProcessIncarnation }),
              })),
            )
          }),
          Effect.catchTag("SqlError", () =>
            GatewayError.make({ kind: "transport", message: "Could not inspect executor operation" }),
          ),
        ),
      dispatch: (input, access) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const matchingAssignments = yield* sql<{ readonly id: string }>`SELECT assignment.id
              FROM rika_hosted_executor_assignments assignment
              JOIN rika_hosted_workspace_capability_admissions admission
                ON admission.assignment_id = assignment.id AND admission.thread_id = ${input.threadId}
                AND admission.turn_id = ${input.turnId} AND admission.workspace_id = ${input.workspaceId}
                AND admission.assignment_generation = assignment.generation
                AND admission.environment_digest = assignment.capability_snapshot->>'environmentDigest'
              WHERE assignment.id = ${input.assignmentId} AND assignment.lifecycle = 'active'
                AND assignment.capability_generation = assignment.generation
                AND assignment.generation = ${access.fence.assignmentGeneration}::bigint
                AND assignment.lease_epoch = ${access.leaseEpoch}::bigint
                AND assignment.lease_expires_at > clock_timestamp()
                AND assignment.provider_instance_id = ${access.fence.instanceId}
                AND assignment.executor_instance_id = ${access.fence.executorId}
                AND assignment.process_incarnation = ${access.fence.processIncarnation}
              FOR UPDATE`
              if (matchingAssignments[0] === undefined)
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor dispatch fence is no longer current",
                })
              const rows = yield* sql<{
                readonly state: "accepted" | "dispatched" | "completed" | "unknown"
                readonly dispatchedGeneration: string | null
                readonly dispatchedLeaseEpoch: string | null
                readonly dispatchedExecutorInstanceId: string | null
                readonly dispatchedProcessIncarnation: string | null
              }>`SELECT state, dispatched_generation::text AS "dispatchedGeneration",
                dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
                dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
                dispatched_process_incarnation AS "dispatchedProcessIncarnation"
              FROM rika_hosted_executor_operations
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint
              FOR UPDATE`
              const row = rows[0]
              if (row === undefined)
                return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              if (row.state === "dispatched") {
                if (
                  row.dispatchedGeneration === String(access.fence.assignmentGeneration) &&
                  row.dispatchedLeaseEpoch === String(access.leaseEpoch) &&
                  row.dispatchedExecutorInstanceId === access.fence.executorId &&
                  row.dispatchedProcessIncarnation === access.fence.processIncarnation
                )
                  return
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor operation has a different dispatch fence",
                })
              }
              if (row.state !== "accepted")
                return yield* GatewayError.make({ kind: "fenced", message: "Executor operation is already terminal" })
              const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
                state = 'dispatched', dispatched_generation = ${access.fence.assignmentGeneration}::bigint,
                dispatched_lease_epoch = ${access.leaseEpoch}::bigint,
                dispatched_executor_instance_id = ${access.fence.executorId},
                dispatched_process_incarnation = ${access.fence.processIncarnation},
                updated_at = clock_timestamp()
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = 'accepted'
              RETURNING operation_key`
              if (updated[0] === undefined)
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor operation changed before dispatch",
                })
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              GatewayError.make({ kind: "transport", message: "Could not persist executor dispatch" }),
            ),
          ),
      resolveDeadline: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly state: "accepted" | "dispatched" | "completed" | "unknown"
                readonly response: unknown | null
                readonly terminalOutcome: ExecutionOutcome | null
              }>`SELECT state, response, terminal_outcome AS "terminalOutcome"
              FROM rika_hosted_executor_operations
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint
              FOR UPDATE`
              const row = rows[0]
              if (row === undefined)
                return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              if (row.state === "completed" || row.state === "unknown")
                return { _tag: "AlreadyTerminal", result: yield* terminalResult(row) } as const
              const ambiguous = row.state === "dispatched"
              const response = ambiguous ? unknownResponse : timeoutResponse
              yield* sql`UPDATE rika_hosted_executor_operations SET
                state = ${ambiguous ? "unknown" : "completed"}, response = ${sql.json(response)},
                terminal_outcome = ${ambiguous ? "unknown" : "failed"},
                resolution_state = ${ambiguous ? "pending" : null}, updated_at = clock_timestamp()
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = ${row.state}`
              return {
                _tag: "Resolved",
                result: { response, outcome: ambiguous ? ("unknown" as const) : ("failed" as const) },
              } as const
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              GatewayError.make({ kind: "transport", message: "Could not resolve executor operation deadline" }),
            ),
          ),
    }
    const gateway = yield* makeGateway(
      controller,
      lifecycle,
      {
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
      {
        start: (input) =>
          Effect.gen(function* () {
            yield* preparations.start({
              access: yield* preparationAccess(input.access),
              workspaceId: input.workspaceId,
              phase: input.phase,
              attempt: input.attempt,
              now: yield* Clock.currentTimeMillis,
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
    )
    const runner = yield* RunnerExecutor
    const runnerGateway = yield* makeRunnerGateway(runner, toolPolicy)
    const bindings = Effect.fn("Executor.bindings")(function* (
      input: Parameters<Runtime["run"]>[0],
      machine: typeof gateway.machine,
    ) {
      const machineContext = yield* Layer.buildWithScope(
        MachineBindings.layer({
          execute: (request) =>
            machine(input.threadId, input.operationKey, input.attempt, request).pipe(
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
            const active = yield* Effect.suspend(() => assignments.get(initial.id)).pipe(
              Effect.flatMap((current) =>
                current?.lifecycle._tag === "Active" &&
                current.capabilityGeneration === current.generation &&
                current.capabilities !== null
                  ? Effect.succeed(current)
                  : Effect.fail("workspace-not-ready" as const),
              ),
              Effect.retry({ times: 300, schedule: Schedule.spaced("100 millis") }),
              Effect.mapError(() =>
                ControllerError.make({
                  kind: "assignment-conflict",
                  message: "Executor transport connected but workspace capabilities are not ready",
                }),
              ),
            )
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
            yield* sql`INSERT INTO rika_hosted_workspace_capability_admissions
                (thread_id, turn_id, assignment_id, workspace_id, assignment_generation,
                 environment_digest, required_capabilities)
              VALUES (${input.threadId}, ${input.turnId}, ${active.id}, ${input.workspaceId},
                ${active.generation}::bigint, ${capabilities.environmentDigest},
                ${encodeRequiredWorkspaceCapabilities(requiredWorkspaceCapabilities)}::jsonb)
              ON CONFLICT (thread_id, turn_id) DO NOTHING`.pipe(
              Effect.mapError(() =>
                ControllerError.make({
                  kind: "repository",
                  message: "Could not persist workspace capability admission",
                }),
              ),
            )
            const admitted = yield* sql<{
              readonly workspaceId: string
              readonly generation: string
              readonly environmentDigest: string
            }>`SELECT workspace_id AS "workspaceId", assignment_generation::text AS generation,
                environment_digest AS "environmentDigest"
              FROM rika_hosted_workspace_capability_admissions
              WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}`.pipe(
              Effect.mapError(() =>
                ControllerError.make({
                  kind: "repository",
                  message: "Could not inspect workspace capability admission",
                }),
              ),
            )
            const snapshot = admitted[0]
            if (
              snapshot === undefined ||
              snapshot.workspaceId !== input.workspaceId ||
              snapshot.generation !== String(active.generation) ||
              snapshot.environmentDigest !== capabilities.environmentDigest
            )
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
        const admissions = yield* sql<{
          readonly generation: string
          readonly environmentDigest: string
        }>`SELECT assignment_generation::text AS generation, environment_digest AS "environmentDigest"
          FROM rika_hosted_workspace_capability_admissions
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
            AND assignment_id = ${assignment.id} AND workspace_id = ${input.workspaceId}`.pipe(
          Effect.mapError(() =>
            ControllerError.make({ kind: "repository", message: "Could not inspect Run capability admission" }),
          ),
        )
        const admission = admissions[0]
        if (
          admission === undefined ||
          assignment.capabilities === null ||
          assignment.capabilityGeneration !== assignment.generation ||
          admission.generation !== String(assignment.generation) ||
          admission.environmentDigest !== assignment.capabilities.environmentDigest
        )
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
              const authority = yield* bindings(input, runnerGateway.machine)
              return yield* runnerGateway.execute({
                assignmentId: assignment.id,
                ...input,
                bindings: authority,
              })
            }),
          )
        }
        const latestCheckpoint = yield* assignments
          .latestCheckpoint(assignment.id)
          .pipe(Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })))
        const phase =
          assignment.lifecycle._tag === "Paused" ||
          assignment.lifecycle._tag === "Active" ||
          Number(assignment.generation) > 1 ||
          latestCheckpoint !== undefined
            ? "runtime"
            : "setup"
        yield* environment
          .usePhase({ assignmentId: assignment.id, phase }, (resolved) =>
            controller.provision(assignment.id, {
              egress: resolved.egress,
              environmentDigest: resolved.manifest.digest,
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(ControllerError)(error)
                ? error
                : ControllerError.make({ kind: "repository", message: "Executor phase authorization was rejected" }),
            ),
          )
        return yield* HostedObservability.observe(
          "cell_execution",
          correlation,
          Effect.gen(function* () {
            const authority = yield* bindings(input, gateway.machine)
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
