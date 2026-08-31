import { Controller, ControllerError, DefaultOrphanGraceMillis } from "@rika/e2b-executor/controller"
import * as BindingModules from "@rika/kernel/binding-modules"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as MachineBindings from "@rika/kernel/machine-bindings"
import * as PgClient from "@effect/sql-pg/PgClient"
import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
} from "@rika/product-store/executor-operations"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import * as HostedObservability from "@rika/product/hosted-observability"
import { type OwnerId, ThreadId } from "@rika/product/hosted-model"
import { WorkspacePreparations } from "@rika/product/workspace-preparation"
import { bindingManifest } from "@rika/remote-execution/protocol"
import { HostBindings } from "generalist/repl"
import { Clock, Config, Context, Crypto, Effect, Layer, LayerMap, Schema, Scope } from "effect"
import { HostedEnvironment } from "../hosted/environment/runtime"
import { RunnerExecutor } from "../runner/executor"
import * as RunnerGatewayModule from "../runner/gateway"
import type { RunnerGateway } from "../runner/gateway"
import { HostedToolPolicy } from "../hosted/execution/tool-policy"
import * as ApiBindings from "./api-bindings"
import { LifecycleStores } from "./lifecycle-store"
import { HostedGateway } from "./hosted-gateway"

export { Executor, orphanReaper } from "./contract"
import { Executor, orphanReaper, type Runtime } from "./contract"

const requiredWorkspaceCapabilities = [
  "filesystem",
  "typescriptKernel",
  "git",
  "process",
  "workspaceLifecycle",
] as const

const hostedBindingModules = (workspace: string) =>
  BindingModules.make({ workspace, workspaceDigest: workspace, trustMode: "hosted", servers: [] })

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
    const toolPolicy = yield* HostedToolPolicy
    const sql = yield* PgClient.PgClient
    const crypto = yield* Crypto.Crypto
    const scope = yield* Effect.scope
    const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
    const apiBindings = yield* LayerMap.make((ownerId: OwnerId) =>
      ApiBindings.layer({ ownerId, dataRoot: `${temporaryDirectory}/rika-hosted` }).pipe(
        Layer.provide(Layer.succeed(PgClient.PgClient, sql)),
      ),
    )
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
      Layer.effect(HostedRunnerGateway, RunnerGatewayModule.makeRunnerGateway(runner, toolPolicy)),
      scope,
    )
    const runnerGateway = Context.get(runnerGatewayContext, HostedRunnerGateway)
    const bindings = Effect.fn("Executor.bindings")(function* (
      input: Parameters<Runtime["run"]>[0],
      assignmentId: string,
      ownerId: OwnerId,
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
      const apiContext = yield* apiBindings.contextEffect(ownerId).pipe(Effect.provideService(Scope.Scope, scope))
      const context: Context.Context<ExecutorRuntime.CellServices> = Context.merge(
        Context.merge(input.authority, apiContext),
        machineContext,
      )
      const registry = yield* HostBindings.make(hostedBindingModules(input.workspaceId)).pipe(
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
              const authority = yield* bindings(input, assignment.id, assignment.ownerId, runnerGateway.machine)
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
            const authority = yield* bindings(input, assignment.id, assignment.ownerId, gateway.machine)
            const result = yield* gateway.execute({
              assignmentId: assignment.id,
              ...input,
              bindings: authority,
            })
            return { ...result, eventPersisted: false as const }
          }),
        )
      }),
      cancel: Effect.fn("Executor.cancel")(function* (input) {
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
        const request = { assignmentId: assignment.id, ...input }
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
