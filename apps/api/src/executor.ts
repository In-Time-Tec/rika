import {
  Controller,
  ControllerError,
  layer as controllerLayer,
  type Interface as ControllerService,
} from "@rika/e2b-executor/controller"
import { Inspector, InspectionError } from "@rika/e2b-executor/checkpoint"
import { CredentialError, Credentials } from "@rika/e2b-executor/checkout"
import { layer as providerLayer } from "@rika/e2b-executor/provider"
import * as BindingModules from "@rika/kernel/binding-modules"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as MachineBindings from "@rika/kernel/machine-bindings"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { ExecutorAssignmentId } from "@rika/product/hosted-model"
import { bindingManifest, CellLifecycleFrame } from "@rika/remote-execution/protocol"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect"
import { GatewayError, makeGateway, type Gateway, type LifecycleStore } from "./executor-gateway"
import { HostedEnvironment } from "./hosted-environment"
import type { AuthenticatedPrincipal } from "./hosted-product"
import { LocalExecutor } from "./local-executor"
import { makeLocalGateway, type LocalGateway } from "./local-executor-gateway"

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
  admittedAt: Schema.NullOr(Schema.String),
  deadline: Schema.NullOr(Schema.String),
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))

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
  }
})

export type ExecutorConfig = Effect.Success<ReturnType<typeof loadConfig>>

export const layer = (options: ExecutorConfig) =>
  controllerLayer(options).pipe(
    Layer.provide(providerLayer({ apiKey: options.apiKey })),
    Layer.provide(
      Layer.succeed(
        Inspector,
        Inspector.of({ inspect: () => Effect.fail(InspectionError.make({ message: "Checkpoints are unavailable" })) }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Credentials,
        Credentials.of({ issue: () => Effect.fail(CredentialError.make({ message: "Checkout is unavailable" })) }),
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
    readonly admittedAt: string | null
    readonly deadline: string | null
    readonly authority: Context.Context<ExecutorRuntime.CellServices>
  }) => Effect.Effect<
    {
      readonly access?: import("@rika/remote-execution/protocol").AccessWire
      readonly response: import("@rika/remote-execution/protocol").CellResponse
      readonly eventPersisted: boolean
    },
    ControllerError | GatewayError
  >
  readonly ready: Effect.Effect<void, ControllerError>
}

export class Executor extends Context.Service<Executor, Runtime>()("@rika/api/executor") {}

export const service = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const controller = yield* Controller
    const assignments = yield* ExecutorAssignments
    const environment = yield* HostedEnvironment
    const sql = yield* PgClient.PgClient
    const crypto = yield* Crypto.Crypto
    const scope = yield* Effect.scope
    const decodeLifecycle = Schema.decodeUnknownEffect(CellLifecycleFrame)
    const equivalentLifecycle = Schema.toEquivalence(CellLifecycleFrame)
    const lifecycle: LifecycleStore = {
      append: (assignmentId, frame) =>
        sql`INSERT INTO rika_hosted_executor_operation_frames
          (assignment_id, operation_key, attempt, cursor, kind, frame)
          VALUES (${assignmentId}, ${frame.attribution.operationKey}, ${frame.attribution.attempt},
            ${frame.cursor}, ${frame._tag}, ${sql.json(frame)})
          ON CONFLICT DO NOTHING`.pipe(
          Effect.andThen(
            sql<{ readonly frame: unknown }>`SELECT frame FROM rika_hosted_executor_operation_frames
              WHERE assignment_id = ${assignmentId}
                AND operation_key = ${frame.attribution.operationKey}
                AND cursor = ${frame.cursor}`,
          ),
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? GatewayError.make({
                  kind: "fenced",
                  message: "Executor lifecycle cursor conflicts with a terminal receipt",
                })
              : decodeLifecycle(rows[0].frame).pipe(
                  Effect.filterOrFail(
                    (persisted) => equivalentLifecycle(persisted, frame),
                    () =>
                      GatewayError.make({
                        kind: "fenced",
                        message: "Executor lifecycle cursor has different content",
                      }),
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
                ),
          ),
          Effect.catchTag("SqlError", () =>
            GatewayError.make({ kind: "transport", message: "Could not persist executor lifecycle frame" }),
          ),
        ),
      load: (assignmentId, operationKey) =>
        sql<{ readonly frame: unknown }>`SELECT frame
          FROM rika_hosted_executor_operation_frames
          WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey}
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
             turn_id, run_id, root_run_id, tool_call_id, code, attempt, admitted_at, deadline, state)
            SELECT assignment.id, assignment.owner_id, ${input.operationKey}, ${requestDigest},
              ${input.workspaceId}, ${input.sessionId}, ${input.threadId}, ${input.turnId}, ${input.runId},
              ${input.rootRunId}, ${input.toolCallId}, ${input.code}, ${input.attempt}, ${input.admittedAt},
              ${input.deadline}, 'accepted'
            FROM rika_hosted_executor_assignments assignment
            WHERE assignment.id = ${input.assignmentId}
            ON CONFLICT (assignment_id, operation_key) DO NOTHING`
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
            readonly admittedAt: string | null
            readonly deadline: string | null
          }>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId", session_id AS "sessionId",
              thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId", root_run_id AS "rootRunId",
              tool_call_id AS "toolCallId", code, attempt::text AS attempt, admitted_at AS "admittedAt", deadline
            FROM rika_hosted_executor_operations
            WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}`
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
    }
    const gateway = yield* makeGateway(controller, lifecycle, {
      activate: (access, phase, use) =>
        environment
          .usePhase({ assignmentId: access.fence.assignmentId, phase }, (resolved) =>
            controller
              .activatePhase(
                {
                  ...access,
                  sessionToken: Redacted.make(access.sessionToken, { label: "executor-session" }),
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
      replace: (key) =>
        environment
          .usePhase({ assignmentId: key.assignmentId, phase: "runtime" }, (resolved) =>
            controller.replace(key, resolved.egress).pipe(Effect.asVoid),
          )
          .pipe(
            Effect.mapError(() =>
              GatewayError.make({ kind: "fenced", message: "Executor replacement authorization was rejected" }),
            ),
          ),
    })
    const local = yield* LocalExecutor
    const localGateway = yield* makeLocalGateway(local)
    const bindings = Effect.fn("Executor.bindings")(function* (
      input: Parameters<Runtime["run"]>[0],
      machine: typeof gateway.machine,
    ) {
      const machineContext = yield* Layer.buildWithScope(
        MachineBindings.layer({
          execute: (request) =>
            machine(input.threadId, input.operationKey, request).pipe(
              Effect.mapError((error) => new MachineBindings.Unavailable({ message: error.message })),
            ),
        }),
        scope,
      )
      const context = Context.merge(input.authority, machineContext)
      const registry = yield* HostBindingRegistry.make(
        BindingModules.make({
          workspace: input.workspaceId,
          workspaceDigest: input.workspaceId,
          trustMode: "hosted",
          servers: [],
        }),
      ).pipe(Effect.provideContext(context), Effect.orDie)
      const manifest = yield* bindingManifest(registry.descriptors).pipe(Effect.provideService(Crypto.Crypto, crypto))
      return { registry, context, manifest }
    })
    return {
      controller,
      gateway,
      localGateway,
      admitLocal: (input) => local.admit(input),
      run: Effect.fn("Executor.run")(function* (input) {
        const assignment = yield* assignments
          .get(ExecutorAssignmentId.make(input.threadId))
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
        if (assignment.placement._tag === "LocalDevicePlacement") {
          const authority = yield* bindings(input, localGateway.machine)
          return yield* localGateway.execute({
            assignmentId: input.threadId,
            ...input,
            bindings: authority,
          })
        }
        const phase =
          assignment.lifecycle._tag === "Paused" || assignment.lifecycle._tag === "Active" ? "runtime" : "setup"
        yield* environment
          .usePhase({ assignmentId: input.threadId, phase }, (resolved) =>
            controller.provision(input.threadId, resolved.egress),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(ControllerError)(error)
                ? error
                : ControllerError.make({ kind: "repository", message: "Executor phase authorization was rejected" }),
            ),
          )
        const authority = yield* bindings(input, gateway.machine)
        const result = yield* gateway.execute({
          assignmentId: input.threadId,
          ...input,
          bindings: authority,
        })
        return { ...result, eventPersisted: false as const }
      }),
      ready: assignments.listManaged.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })),
      ),
    }
  }),
)
