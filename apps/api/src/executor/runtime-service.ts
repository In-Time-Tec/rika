import { Controller, ControllerError, DefaultOrphanGraceMillis } from "@rika/e2b-executor/controller"
import * as RemoteTools from "@rika/execution/remote-tools"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import * as PgClient from "@effect/sql-pg/PgClient"
import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
} from "@rika/product-store/executor-operations"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import * as HostedObservability from "@rika/product/hosted-observability"
import { FencingGeneration, ThreadId } from "@rika/product/hosted-model"
import { WorkspacePreparations } from "@rika/product/workspace-preparation"
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect"
import { HostedEnvironment } from "../hosted/environment/runtime"
import { RunnerExecutor } from "../runner/executor"
import * as RunnerGatewayModule from "../runner/gateway"
import type { RunnerGateway } from "../runner/gateway"
import { LifecycleStores } from "./lifecycle-store"
import { HostedGateway } from "./hosted-gateway"

export { Executor, orphanReaper } from "./contract"
import { Executor, orphanReaper } from "./contract"

const requiredWorkspaceCapabilities = ["filesystem", "nativeTools", "git", "process", "workspaceLifecycle"] as const
/** How long an Active Orb session may go without reporting a preparation start before admission fails. */
const preparationStartDeadlineMillis = 60_000
// After the host reports preparation ready it sends the refreshed capability snapshot as a separate
// message; the assignment briefly reports stale capabilities in between.
const capabilityRefreshGraceMillis = 30_000
/** Retryable preparation failures (checkout, credentials) are retried up to this many attempts per generation. */
const maxPreparationAttempts = 3

const NativeToolPayload = Schema.Struct({ toolName: Schema.String, request: NativeToolRuntime.Request })
const encodeNativeToolPayload = Schema.encodeSync(Schema.fromJsonString(NativeToolPayload))

class HostedRunnerGateway extends Context.Service<HostedRunnerGateway, RunnerGateway>()(
  "@rika/api/executor/runtime-service/HostedRunnerGateway",
) {}

export const service = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const controller = yield* Controller
    const assignments = yield* ExecutorAssignments
    const environment = yield* HostedEnvironment
    const preparations = yield* WorkspacePreparations
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
    const reapOrphans = controller.cleanupOrphans.pipe(
      Effect.catch((error) =>
        Effect.logError("executor.orphan-reaper.failed").pipe(
          Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
        ),
      ),
    )
    yield* orphanReaper(reapOrphans, DefaultOrphanGraceMillis).pipe(Effect.forkIn(scope))
    const lifecycle = LifecycleStores.build(operations, crypto)
    const gateway = yield* HostedGateway.build(lifecycle, crypto, scope)
    const runner = yield* RunnerExecutor
    const runnerGatewayContext = yield* Layer.buildWithScope(
      Layer.effect(HostedRunnerGateway, RunnerGatewayModule.makeRunnerGateway(runner)),
      scope,
    )
    const runnerGateway = Context.get(runnerGatewayContext, HostedRunnerGateway)
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
            // Provisioning may replace an unreachable Orb sandbox under a new generation; readiness
            // must then be awaited for the provisioned generation, not the one read before provisioning.
            let expectedGeneration = initial.generation
            if (initial.placement._tag === "OrbPlacement") {
              const phase =
                initial.lifecycle._tag === "Paused" || initial.lifecycle._tag === "Active" ? "runtime" : "setup"
              const provisioned = yield* environment
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
              expectedGeneration = FencingGeneration.make(String(provisioned.generation))
            }
            const repositoryFailure = (cause: { readonly message: string }) =>
              ControllerError.make({ kind: "repository", message: cause.message })
            const unavailableCapabilities = (capabilities: NonNullable<ExecutorAssignment["capabilities"]>) =>
              requiredWorkspaceCapabilities.flatMap((name) => {
                const capability = capabilities[name]
                return capability._tag === "Ready" ? [] : [`${name}: ${capability.reason}`]
              })
            const activeSince = yield* Clock.currentTimeMillis
            const retriedAttempts = new Set<number>()
            // An Orb session opens with the capabilities its host saw before checkout and setup, so an
            // Active assignment is ready only once the snapshot reports the required capabilities. Until
            // then the durable preparation record says whether the host is still preparing, failed, or
            // never started; a retryable failure is retried a bounded number of times from here because
            // the host waits for that retry instruction.
            const awaitOrbPreparation = Effect.fn("Executor.awaitOrbPreparation")(function* (
              current: ExecutorAssignment,
              unavailableFailure: ControllerError,
            ) {
              const preparation = yield* preparations
                .find({ assignmentId: current.id, generation: current.generation })
                .pipe(Effect.mapError(repositoryFailure))
              if (preparation === undefined) {
                if ((yield* Clock.currentTimeMillis) - activeSince > preparationStartDeadlineMillis)
                  return yield* ControllerError.make({
                    kind: "protocol",
                    message: "Executor did not begin workspace preparation",
                  })
                return
              }
              if (preparation.state === "ready") {
                if ((yield* Clock.currentTimeMillis) - preparation.updatedAt > capabilityRefreshGraceMillis)
                  return yield* unavailableFailure
                return
              }
              if (preparation.state === "preparing") return
              const failure = preparation.failure!
              const retry =
                failure.retryable &&
                preparation.attempt < maxPreparationAttempts &&
                !retriedAttempts.has(preparation.attempt)
              if (!retry)
                return yield* ControllerError.make({
                  kind: "protocol",
                  message: `Workspace preparation failed during ${preparation.phase} (attempt ${preparation.attempt}): ${failure.message}`,
                })
              retriedAttempts.add(preparation.attempt)
              yield* Effect.logWarning("executor.workspace-preparation.retrying").pipe(
                Effect.annotateLogs({
                  "rika.executor.assignment.id": current.id,
                  "rika.workspace.preparation.phase": preparation.phase,
                  "rika.workspace.preparation.attempt": preparation.attempt,
                  "rika.failure.message": failure.message,
                }),
              )
              yield* gateway.retryPreparation(current.id).pipe(
                Effect.mapError((error) =>
                  ControllerError.make({
                    kind: "protocol",
                    message: `Workspace preparation failed during ${preparation.phase} and could not be retried: ${error.message}`,
                  }),
                ),
              )
            })
            const awaitActive = (): Effect.Effect<ExecutorAssignment, ControllerError> =>
              Effect.gen(function* () {
                const current = yield* assignments.get(initial.id).pipe(Effect.mapError(repositoryFailure))
                if (current === undefined)
                  return yield* ControllerError.make({
                    kind: "assignment-missing",
                    message: "Executor assignment disappeared while awaiting workspace readiness",
                  })
                if (current.generation !== expectedGeneration)
                  return yield* ControllerError.make({
                    kind: "fenced",
                    message: "Executor assignment was replaced while awaiting workspace readiness",
                  })
                if (current.lifecycle._tag === "Active") {
                  const snapshot = current.capabilityGeneration === current.generation ? current.capabilities : null
                  if (snapshot === null)
                    return yield* ControllerError.make({
                      kind: "assignment-conflict",
                      message: "Executor session has no capability snapshot for its generation",
                    })
                  const unavailable = unavailableCapabilities(snapshot)
                  if (unavailable.length === 0) return current
                  const unavailableFailure = ControllerError.make({
                    kind: "protocol",
                    message: `Run requires unavailable workspace capabilities: ${unavailable.join("; ")}`,
                  })
                  if (current.placement._tag !== "OrbPlacement") return yield* unavailableFailure
                  yield* awaitOrbPreparation(current, unavailableFailure)
                } else {
                  if (current.lifecycle._tag !== "Provisioning" && current.lifecycle._tag !== "AwaitingBootstrap")
                    return yield* ControllerError.make({
                      kind: "assignment-conflict",
                      message: "Executor workspace stopped preparing before its capabilities became ready",
                    })
                  const bootstrapLive = yield* assignments
                    .isBootstrapLive({ assignmentId: current.id, generation: current.generation })
                    .pipe(Effect.mapError(repositoryFailure))
                  if (!bootstrapLive)
                    return yield* ControllerError.make({
                      kind: "assignment-conflict",
                      message: "Executor workspace preparation exceeded its durable bootstrap deadline",
                    })
                }
                yield* Effect.sleep(100)
                return yield* awaitActive()
              })
            const admitCapabilities = Effect.gen(function* () {
              const active = yield* awaitActive()
              const capabilities = active.capabilities!
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
            })
            if (initial.placement._tag === "RunnerPlacement")
              return yield* runnerGateway
                .withReadySession(initial.id, (generation) => {
                  expectedGeneration = FencingGeneration.make(String(generation))
                  return admitCapabilities
                })
                .pipe(
                  Effect.mapError((error) =>
                    Schema.is(ControllerError)(error)
                      ? error
                      : ControllerError.make({ kind: "assignment-conflict", message: error.message }),
                  ),
                )
            return yield* admitCapabilities
          }),
        )
      }),
      runTool: Effect.fn("Executor.runTool")(function* (input) {
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
        const request = {
          assignmentId: assignment.id,
          operationKey: input.operationKey,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          threadId: input.threadId,
          turnId: input.turnId,
          runId: input.runId,
          rootRunId: input.rootRunId,
          toolCallId: input.toolCallId,
          code: encodeNativeToolPayload({ toolName: input.toolName, request: input.request }),
          attempt: input.attempt,
          replayPolicy: input.replayPolicy,
          admittedAt: input.admittedAt,
          deadlineAt: input.deadlineAt,
          machineRequest: { _tag: "NativeTool" as const, request: input.request },
        }
        const result = yield* HostedObservability.observe(
          "tool_execution",
          correlation,
          assignment.placement._tag === "RunnerPlacement" ? runnerGateway.execute(request) : gateway.execute(request),
        )
        const response = yield* Schema.decodeEffect(RemoteTools.Response)(result.response).pipe(
          Effect.mapError(() =>
            ControllerError.make({ kind: "protocol", message: "Persisted remote tool response is invalid" }),
          ),
        )
        return { ...result, response, eventPersisted: false }
      }),
      cancelTool: Effect.fn("Executor.cancelTool")(function* (input) {
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
        const request = {
          assignmentId: assignment.id,
          operationKey: input.operationKey,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          threadId: input.threadId,
          turnId: input.turnId,
          runId: input.runId,
          rootRunId: input.rootRunId,
          toolCallId: input.toolCallId,
          code: encodeNativeToolPayload({ toolName: input.toolName, request: input.request }),
          attempt: input.attempt,
          replayPolicy: input.replayPolicy,
          machineRequest: { _tag: "NativeTool" as const, request: input.request },
        }
        return assignment.placement._tag === "RunnerPlacement"
          ? yield* runnerGateway.cancel(request)
          : yield* gateway.cancel(request)
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
      ready: Effect.void,
    }
  }),
)
