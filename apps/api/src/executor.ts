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
import { GatewayError, makeGateway, type Gateway, type LifecycleStore } from "./executor-gateway"
import { HostedEnvironment } from "./hosted-environment"
import type { AuthenticatedPrincipal } from "./hosted-product"
import { LocalExecutor } from "./local-executor"
import { HostedRepositories } from "./hosted-repositories"
import { makeLocalGateway, type LocalGateway } from "./local-executor-gateway"
import { HostedToolPolicy } from "./hosted-tool-policy"

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
  deadline: Schema.NullOr(Schema.String),
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

const cellOutcome = (outcome: "completed" | "failed" | "cancelled" | "unknown"): HostedObservability.Outcome => {
  switch (outcome) {
    case "completed":
      return "success"
    case "cancelled":
      return "interrupted"
    case "failed":
      return "failure"
    case "unknown":
      return "unknown"
  }
}

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
  readonly localGateway: LocalGateway
  readonly admitLocal: (input: {
    readonly threadId: string
    readonly workspaceFingerprint: string
    readonly principal: AuthenticatedPrincipal
    readonly executorUrl: string
  }) => Effect.Effect<import("./local-executor").LocalAdmission, ControllerError>
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
    readonly deadline: string | null
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

export class Executor extends Context.Service<Executor, Runtime>()("@rika/api/executor") {}

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
      append: (assignmentId, frame) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_hosted_executor_operation_frames
              (assignment_id, operation_key, attempt, cursor, kind, frame)
              VALUES (${assignmentId}, ${frame.attribution.operationKey}, ${frame.attribution.attempt},
                ${frame.cursor}, ${frame._tag}, ${sql.json(frame)})
              ON CONFLICT DO NOTHING`
              const rows = yield* sql<{ readonly frame: unknown }>`SELECT frame
              FROM rika_hosted_executor_operation_frames
              WHERE assignment_id = ${assignmentId}
                AND operation_key = ${frame.attribution.operationKey}
                AND attempt = ${frame.attribution.attempt}::bigint
                AND cursor = ${frame.cursor}`
              if (rows[0] === undefined)
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor lifecycle cursor conflicts with a terminal receipt",
                })
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
              if (frame._tag === "Started")
                yield* sql`UPDATE rika_hosted_executor_operations
                SET started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp()
                WHERE assignment_id = ${assignmentId} AND operation_key = ${frame.attribution.operationKey}
                  AND attempt = ${frame.attribution.attempt}::bigint AND state = 'dispatched'`
              if (frame._tag === "Terminal")
                yield* sql`UPDATE rika_hosted_executor_operations SET
                  state = ${frame.outcome === "unknown" ? "unknown" : "completed"},
                  response = ${sql.json(frame.response)},
                  resolution_state = ${frame.outcome === "unknown" ? "pending" : null},
                  dispatch_deadline_at = NULL,
                  updated_at = clock_timestamp()
                WHERE assignment_id = ${assignmentId} AND operation_key = ${frame.attribution.operationKey}
                  AND attempt = ${frame.attribution.attempt}::bigint
                  AND state = 'dispatched'`
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
            deadline: input.deadline,
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
             turn_id, run_id, root_run_id, tool_call_id, code, attempt, replay_policy, admitted_at, deadline, state)
            SELECT assignment.id, assignment.owner_id, ${input.operationKey}, ${requestDigest},
              ${input.workspaceId}, ${input.sessionId}, ${input.threadId}, ${input.turnId}, ${input.runId},
              ${input.rootRunId}, ${input.toolCallId}, ${input.code}, ${input.attempt}, ${input.replayPolicy}, ${input.admittedAt},
              ${input.deadline}, 'accepted'
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
            readonly deadline: string | null
          }>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId", session_id AS "sessionId",
              thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId", root_run_id AS "rootRunId",
              tool_call_id AS "toolCallId", code, attempt::text AS attempt, replay_policy AS "replayPolicy",
              admitted_at AS "admittedAt", deadline
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
            row.deadline !== input.deadline
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
          readonly dispatchedGeneration: string | null
          readonly dispatchedExecutorInstanceId: string | null
          readonly dispatchedProcessIncarnation: string | null
        }>`SELECT state, started_at IS NOT NULL AS started, response,
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
                dispatch_deadline_at = clock_timestamp() + interval '5 minutes', updated_at = clock_timestamp()
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
      reassign: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly state: "accepted" | "dispatched" | "completed" | "unknown"
                readonly started: boolean
              }>`SELECT state, started_at IS NOT NULL AS started
              FROM rika_hosted_executor_operations
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint
              FOR UPDATE`
              const row = rows[0]
              if (row === undefined)
                return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              if (row.state === "accepted") return
              if (row.state !== "dispatched" || row.started)
                return yield* GatewayError.make({
                  kind: "fenced",
                  message: "Executor operation cannot be reassigned after it started",
                })
              yield* sql`UPDATE rika_hosted_executor_operations SET state = 'accepted',
                dispatched_generation = NULL, dispatched_lease_epoch = NULL,
                dispatched_executor_instance_id = NULL, dispatched_process_incarnation = NULL,
                dispatch_deadline_at = NULL, updated_at = clock_timestamp()
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = 'dispatched' AND started_at IS NULL`
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              GatewayError.make({ kind: "transport", message: "Could not safely reassign executor operation" }),
            ),
          ),
      markUnknown: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly state: "accepted" | "dispatched" | "completed" | "unknown"
                readonly started: boolean
              }>`SELECT state, started_at IS NOT NULL AS started
              FROM rika_hosted_executor_operations
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint
              FOR UPDATE`
              const row = rows[0]
              if (row === undefined)
                return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              if (row.state === "unknown" || row.state === "completed") return
              if (row.state !== "dispatched" || !row.started)
                return yield* GatewayError.make({ kind: "fenced", message: "Executor operation has not started" })
              yield* sql`UPDATE rika_hosted_executor_operations SET state = 'unknown',
                response = ${sql.json(unknownResponse)}, resolution_state = 'pending',
                dispatch_deadline_at = NULL, updated_at = clock_timestamp()
              WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = 'dispatched' AND started_at IS NOT NULL`
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              GatewayError.make({ kind: "transport", message: "Could not mark executor operation unknown" }),
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
    const local = yield* LocalExecutor
    const localGateway = yield* makeLocalGateway(local, toolPolicy)
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
      localGateway,
      admitLocal: (input) => local.admit(input),
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
          "workspace_prepare",
          { ownerId: initial.ownerId, threadId: input.threadId, turnId: input.turnId, assignmentId: initial.id },
          Effect.gen(function* () {
            if (initial.placement._tag === "E2BPlacement") {
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
        if (assignment.placement._tag === "LocalDevicePlacement") {
          return yield* HostedObservability.observe(
            "executor_wait",
            correlation,
            Effect.gen(function* () {
              const authority = yield* bindings(input, localGateway.machine)
              const execute = localGateway
                .execute({
                  assignmentId: assignment.id,
                  ...input,
                  bindings: authority,
                })
                .pipe(
                  Effect.map((result) => {
                    const failure = result.response._tag === "DomainFailure" ? result.response.failure : undefined
                    const kind =
                      typeof failure === "object" && failure !== null && "kind" in failure ? failure.kind : undefined
                    let outcome: "completed" | "failed" | "cancelled" | "unknown"
                    if (kind === "unknown") outcome = "unknown"
                    else if (kind === "cancelled") outcome = "cancelled"
                    else if (result.response._tag === "Success") outcome = "completed"
                    else outcome = "failed"
                    return { ...result, outcome }
                  }),
                )
              return yield* HostedObservability.observe("cell", correlation, execute, (result) =>
                cellOutcome(result.outcome),
              )
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
          "executor_wait",
          correlation,
          Effect.gen(function* () {
            const authority = yield* bindings(input, gateway.machine)
            const result = yield* HostedObservability.observe(
              "cell",
              correlation,
              gateway.execute({
                assignmentId: assignment.id,
                ...input,
                bindings: authority,
              }),
              (completed) => cellOutcome(completed.outcome),
            )
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
