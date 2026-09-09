/* oxlint-disable effecttsgo/effect-succeed-with-void, effecttsgo/strict-effect-provide, max-lines -- this fixture intentionally closes and rebuilds a published Runtime Layer. */
import { BunCrypto } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Scope } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { it } from "@effect/vitest"
import { Agent, Approvals, Permissions, ToolContext } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host, ToolIdentity } from "generalist/host"
import { ExecutableResolver, LocalScheduler as LocalSchedulerModule, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"

import {
  CanonicalResult,
  ExecutorEvidence,
  ExecutorTransportError,
  NativeOperationIntent,
  WorkspaceBinding,
  WorkspaceComponentState,
  makeNativeOperationCoordinator,
  workspaceComponentLayer,
  workspaceComponentJournal,
  workspaceComponentReader,
  type ExecutorBoundary,
} from "../src"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-runtime",
  assignmentId: "assignment-runtime",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-runtime", checkoutFingerprint: "checkout-runtime" },
  buildId: "build-runtime",
  protocolVersion: 1,
})

const intent = Schema.decodeSync(NativeOperationIntent)({
  operationId: "operation-runtime",
  tool: "bash",
  inputDigest: "input-runtime",
  binding,
})

const input = Schema.Struct({ operationId: Schema.String })
const toolFailure = Schema.Struct({ kind: Schema.String, message: Schema.String })
const admitTool = Tool.make("admit_native", {
  description: "Admit one native operation into the Session component.",
  parameters: input,
  success: Schema.Struct({ admitted: Schema.Boolean }),
  failure: toolFailure,
  failureMode: "return",
}).annotate(ToolIdentity, { implementation: "execution-v2-admit", policy: "execution-v2" })
const nativeDispatchParameters = Schema.Struct({ operationId: Schema.String })
const nativeDispatchTool = Tool.make("native_dispatch", {
  description: "Dispatch one admitted native operation.",
  parameters: nativeDispatchParameters,
  success: CanonicalResult,
  failure: toolFailure,
  failureMode: "return",
}).annotate(ToolIdentity, { implementation: "execution-v2", policy: "execution-v2" })
const nativeIndependentTool = Tool.make("native_independent", {
  description: "Dispatch one admitted native operation independently.",
  parameters: nativeDispatchParameters,
  success: CanonicalResult,
  failure: toolFailure,
  failureMode: "return",
})
  .addDependency(ToolContext.ToolContext)
  .addDependency(RunStore.RunStore)
  .annotate(ToolIdentity, { implementation: "execution-v2-independent", policy: "execution-v2" })
const inspectTool = Tool.make("inspect_native", {
  description: "Read the admitted Session component.",
  parameters: Schema.Struct({}),
  success: WorkspaceComponentState,
  failure: toolFailure,
  failureMode: "return",
})
const toolkit = Toolkit.make(admitTool, nativeDispatchTool, inspectTool)
const nativeIndependentToolkit = Toolkit.make(nativeIndependentTool)
const agent = Agent.make({
  name: "rika-runtime",
  input: Schema.String,
  output: Schema.String,
  instructions: "Admit the requested native operation and then finish.",
  toolkit,
  toolExecution: "inline",
})

const testRuntime = (bucket: DurabilityTesting.Simulator) =>
  durabilityLayer({
    environment: "execution-v2-test",
    tenant: "owner",
    partition: "thread-runtime",
    addresses: [],
  }).pipe(
    Layer.provide(ExecutableResolver.layerStatic([])),
    Layer.provide(DurabilityTesting.layer(bucket)),
    Layer.provide(BunCrypto.layer),
  )

const drainRuntime = Effect.gen(function* () {
  const scheduler = yield* LocalSchedulerModule.LocalScheduler
  yield* scheduler.drain({ fuel: 32 })
  yield* scheduler.drain({ fuel: 32 })
  yield* scheduler.drain({ fuel: 32 })
  yield* scheduler.drain({ fuel: 32 })
})

const modelLayer = (mode: "admit" | "inspect") =>
  mode === "admit"
    ? TestModel.layer([
        TestModel.turn([TestModel.toolCall("admit_native", { operationId: intent.operationId }, { id: "admit-call" })]),
        TestModel.turn([
          TestModel.toolCall("native_dispatch", { operationId: intent.operationId }, { id: "dispatch-call" }),
        ]),
        TestModel.turn([TestModel.text(mode)]),
      ])
    : TestModel.layer([
        TestModel.turn([TestModel.toolCall("inspect_native", {}, { id: "inspect-call" })]),
        TestModel.turn([TestModel.text(mode)]),
      ])

const executorEvidence = (outcome: ExecutorEvidence["outcome"], source: ExecutorEvidence["source"] = "dispatch") =>
  Schema.decodeSync(ExecutorEvidence)({
    operationId: intent.operationId,
    inputDigest: intent.inputDigest,
    binding: {
      workspaceId: binding.workspaceId,
      assignmentId: binding.assignmentId,
      generation: binding.generation,
      placement: binding.placement,
      buildId: binding.buildId,
      protocolVersion: binding.protocolVersion,
    },
    source,
    outcome,
  })

const hostLayer = (
  observed: Ref.Ref<unknown>,
  nativeResult: Ref.Ref<CanonicalResult | undefined>,
  dispatches: Ref.Ref<number>,
  outcome: "completed" | "lost",
  mode: "admit" | "inspect",
) =>
  Layer.mergeAll(
    modelLayer(mode),
    Permissions.layerAllowAll,
    Approvals.layerAutoApprove,
    toolkit.toLayer({
      admit_native: (_params) =>
        Effect.gen(function* () {
          const state = yield* workspaceComponentJournal.bind(binding, "bind:runtime")
          const admitted = yield* workspaceComponentJournal.admit(intent, "admit:runtime")
          yield* Ref.set(observed, { state, admitted })
          return { admitted: true }
        }).pipe(Effect.orDie),
      inspect_native: () =>
        workspaceComponentJournal.read.pipe(
          Effect.tap((state) => Ref.set(observed, state)),
          Effect.orDie,
        ),
      native_dispatch: () => {
        const executor: ExecutorBoundary = {
          handshake: () => Effect.succeed(binding),
          dispatch: () => {
            if (outcome === "lost")
              return Ref.update(dispatches, (count) => count + 1).pipe(
                Effect.andThen(
                  Effect.fail(ExecutorTransportError.make({ phase: "after-dispatch", message: "ack lost" })),
                ),
              )
            return Ref.update(dispatches, (count) => count + 1).pipe(
              Effect.andThen(Effect.succeed(executorEvidence({ _tag: "Completed", result: { exitCode: 0 } }))),
            )
          },
          receipt: () => Effect.succeed(undefined),
        }
        return makeNativeOperationCoordinator(workspaceComponentJournal, executor)
          .dispatch(intent)
          .pipe(
            Effect.tap((result) => Ref.set(nativeResult, result)),
            Effect.orDie,
          )
      },
    }),
  )

const nativeDispatchToolkit = Toolkit.make(nativeDispatchTool)

const admissionOnlyModel = TestModel.layer([
  TestModel.turn([TestModel.toolCall("admit_native", { operationId: intent.operationId }, { id: "admit-only-call" })]),
  TestModel.turn([TestModel.text("admit-only")]),
])

const admissionWithForeignModel = TestModel.layer([
  TestModel.turn([TestModel.toolCall("admit_native", { operationId: intent.operationId }, { id: "admit-only-call" })]),
  TestModel.turn([TestModel.text("admit-only")]),
  TestModel.turn([TestModel.text("foreign")]),
])

it.effect(
  "independently schedules a native Tool from canonical parent admission without a Session writer claim",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const dispatches = yield* Ref.make(0)
      const nativeResult = yield* Ref.make<CanonicalResult | undefined>(undefined)
      const executor: ExecutorBoundary = {
        handshake: () => Effect.succeed(binding),
        dispatch: () =>
          Ref.update(dispatches, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed(executorEvidence({ _tag: "Completed", result: { exitCode: 0 } }))),
          ),
        receipt: () => Effect.succeed(undefined),
      }
      const independentHostLayer = Layer.mergeAll(
        admissionWithForeignModel,
        Permissions.layerAllowAll,
        Approvals.layerAutoApprove,
        workspaceComponentLayer,
        toolkit.toLayer({
          admit_native: () =>
            Effect.gen(function* () {
              yield* workspaceComponentJournal.bind(binding, "bind:independent")
              yield* workspaceComponentJournal.admit(intent, "admit:independent")
              return { admitted: true }
            }).pipe(Effect.orDie),
          inspect_native: () => Effect.die("inspect is not part of admission"),
          native_dispatch: () => Effect.die("agent dispatch is not part of admission"),
        }),
        nativeIndependentToolkit.toLayer({
          native_independent: () =>
            Effect.gen(function* () {
              const component = workspaceComponentReader(yield* ToolContext.ToolContext, yield* RunStore.RunStore)
              return yield* makeNativeOperationCoordinator(component, executor).dispatch(intent)
            }).pipe(
              Effect.tap((result) => Ref.set(nativeResult, result)),
              Effect.orDie,
            ),
        }).pipe(Layer.provide(ToolContext.layerDefault)),
      )
      const runtime = testRuntime(bucket)
      const completed = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "execution-v2-independent-tool",
            tools: [nativeIndependentTool],
          }).pipe(Effect.provide(independentHostLayer))
          yield* activate
          const session = yield* host.sessions.create({ id: "session:execution-v2:independent", agent: agent.name })
          const parent = yield* host.runs.start(session.id, agent, "admit operation")
          yield* drainRuntime
          expect(yield* parent.await).toBe("admit-only")
          const run = yield* host.tools.start(
            nativeIndependentTool,
            { operationId: intent.operationId },
            { parentRunId: parent.id, commandId: "native-independent" },
          )
          yield* drainRuntime
          const result = yield* run.await
          const orphan = yield* host.tools.start(
            nativeIndependentTool,
            { operationId: intent.operationId },
            { commandId: "native-orphan" },
          )
          yield* drainRuntime
          expect((yield* host.runs.inspect(orphan.id)).status).toBe("needs-resolution")
          const foreignSession = yield* host.sessions.create({
            id: "session:execution-v2:foreign",
            agent: agent.name,
          })
          const foreignParent = yield* host.runs.start(foreignSession.id, agent, "foreign parent")
          yield* drainRuntime
          expect(yield* foreignParent.await).toBe("foreign")
          const foreignTool = yield* host.tools.start(
            nativeIndependentTool,
            { operationId: intent.operationId },
            { parentRunId: foreignParent.id, commandId: "native-foreign" },
          )
          yield* drainRuntime
          expect((yield* host.runs.inspect(foreignTool.id)).status).toBe("needs-resolution")
          expect(yield* Ref.get(dispatches)).toBe(1)
          return { result, runId: run.id }
        }).pipe(Effect.provide(runtime)),
      )
      expect(completed.result).toMatchObject({ _tag: "Completed", operationId: intent.operationId })
      expect(yield* Ref.get(nativeResult)).toMatchObject({ _tag: "Completed", operationId: intent.operationId })
      expect(yield* Ref.get(dispatches)).toBe(1)
      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "execution-v2-independent-tool",
            tools: [nativeIndependentTool],
          }).pipe(Effect.provide(independentHostLayer))
          yield* activate
          const run = yield* host.tools.get(nativeIndependentTool, completed.runId)
          return yield* run.await
        }).pipe(Effect.provide(runtime)),
      )
      expect(recovered).toEqual(completed.result)
      expect(yield* Ref.get(dispatches)).toBe(1)
    }),
  60_000,
)

it.effect(
  "retains canonical Unknown after native Tool interruption and fresh Runtime recovery without redispatch",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const dispatches = yield* Ref.make(0)
      const executor: ExecutorBoundary = {
        handshake: () => Effect.succeed(binding),
        dispatch: () =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(dispatches, (current) => current + 1)
            if (count > 1) return yield* Effect.die("native Tool was blindly redispatched")
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return executorEvidence({ _tag: "Completed", result: { exitCode: 0 } })
          }),
        receipt: () => Effect.succeed(undefined),
      }
      const independentHostLayer = Layer.mergeAll(
        admissionOnlyModel,
        Permissions.layerAllowAll,
        Approvals.layerAutoApprove,
        workspaceComponentLayer,
        toolkit.toLayer({
          admit_native: () =>
            Effect.gen(function* () {
              yield* workspaceComponentJournal.bind(binding, "bind:recovery")
              yield* workspaceComponentJournal.admit(intent, "admit:recovery")
              return { admitted: true }
            }).pipe(Effect.orDie),
          inspect_native: () => Effect.die("inspect is not part of recovery admission"),
          native_dispatch: () => Effect.die("agent dispatch is not part of recovery admission"),
        }),
        nativeIndependentToolkit
          .toLayer({
            native_independent: () =>
              Effect.gen(function* () {
                const component = workspaceComponentReader(yield* ToolContext.ToolContext, yield* RunStore.RunStore)
                return yield* makeNativeOperationCoordinator(component, executor).dispatch(intent)
              }).pipe(Effect.orDie),
          })
          .pipe(Layer.provide(ToolContext.layerDefault)),
      )
      const runtime = testRuntime(bucket)
      const runId = yield* Ref.make<string | undefined>(undefined)
      const firstScope = yield* Ref.make<Scope.Scope | undefined>(undefined)
      const first = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Ref.set(firstScope, yield* Effect.scope)
            const host = yield* Host.make({
              agents: { [agent.name]: agent },
              revision: "execution-v2-independent-recovery",
              tools: [nativeIndependentTool],
            }).pipe(Effect.provide(independentHostLayer))
            yield* activate
            const session = yield* host.sessions.create({ id: "session:execution-v2:recovery", agent: agent.name })
            const parent = yield* host.runs.start(session.id, agent, "admit operation")
            yield* drainRuntime
            expect(yield* parent.await).toBe("admit-only")
            const run = yield* host.tools.start(
              nativeIndependentTool,
              { operationId: intent.operationId },
              { parentRunId: parent.id, commandId: "native-recovery" },
            )
            yield* Ref.set(runId, run.id)
            yield* drainRuntime
            yield* Deferred.await(started)
            yield* Deferred.await(hold)
          }).pipe(Effect.provide(runtime)),
        ),
      )
      yield* Deferred.await(started)
      const interruptedRunId = yield* Ref.get(runId)
      expect(interruptedRunId).toBeDefined()
      expect(yield* Ref.get(dispatches)).toBe(1)
      const scope = yield* Ref.get(firstScope)
      if (scope === undefined) return yield* Effect.die("native Tool Runtime scope was not captured")
      yield* Scope.close(scope, Exit.interrupt())
      yield* Fiber.interrupt(first)
      if (interruptedRunId === undefined) return yield* Effect.die("native Tool did not receive a Run identity")

      const unknown: CanonicalResult = {
        _tag: "Unknown",
        operationId: intent.operationId,
        binding,
        reason: "Executor receipt cache was absent after Runtime recovery",
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "execution-v2-independent-recovery",
            tools: [nativeIndependentTool],
          }).pipe(Effect.provide(independentHostLayer))
          yield* activate
          const scheduler = yield* LocalSchedulerModule.LocalScheduler
          const runStore = yield* RunStore.RunStore
          const before = yield* runStore.loadExecution(interruptedRunId)
          const preJournal = yield* runStore.recoveryJournal(interruptedRunId)
          expect(preJournal.operations.map((operation) => operation.status)).toEqual(["running"])
          if (before.ownerId !== undefined)
            yield* runStore.releaseExecution({
              runId: interruptedRunId,
              ownerId: before.ownerId,
              attemptFence: before.attemptFence,
            })
          const drainResult = yield* scheduler.drain({ fuel: 32 })
          expect(drainResult.processed).toBeGreaterThan(0)
          const journal = yield* runStore.recoveryJournal(interruptedRunId)
          expect(journal.operations.map((operation) => operation.status)).toEqual(["unknown"])
          const inspected = yield* host.runs.inspect(interruptedRunId)
          const explanation = yield* host.operator.explain(interruptedRunId)
          expect(inspected.status).toBe("needs-resolution")
          expect(explanation).toMatchObject({ status: "needs-resolution" })
          const obligation = explanation.obligations.find((entry) => entry._tag === "Unknown")
          expect(obligation).toBeDefined()
          if (obligation?._tag !== "Unknown") return yield* Effect.die("fresh Runtime did not retain Unknown Tool operation")
          yield* host.operator.resolveUnknown(
            interruptedRunId,
            obligation.operationId,
            {
              outcome: "succeeded",
              result: { _tag: "Success", result: unknown, encodedResult: unknown },
            },
            "test-operator",
            "resolve-native-recovery",
          )
          yield* drainRuntime
          const recovered = yield* host.tools.get(nativeIndependentTool, interruptedRunId)
          expect(yield* recovered.await).toEqual(unknown)
          expect(yield* Ref.get(dispatches)).toBe(1)
        }).pipe(Effect.provide(runtime)),
      )
    }),
  60_000,
)

it.effect(
  "persists binding and admitted intent in a real Generalist Session component across close/reopen",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const observed = yield* Ref.make<unknown>(undefined)
      const nativeResult = yield* Ref.make<CanonicalResult | undefined>(undefined)
      const dispatches = yield* Ref.make(0)
      const runtime = testRuntime(bucket)
      const sessionId = "session:execution-v2:runtime"
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "execution-v2-build",
          }).pipe(
            Effect.provide(
              Layer.merge(hostLayer(observed, nativeResult, dispatches, "completed", "admit"), workspaceComponentLayer),
            ),
          )
          yield* activate
          const session = yield* host.sessions.create({ id: sessionId, agent: agent.name })
          const run = yield* host.runs.start(session.id, agent, "admit operation")
          yield* drainRuntime
          expect(yield* run.await).toBe("admit")
        }).pipe(Effect.provide(runtime)),
      )
      const first = yield* Ref.get(observed)
      expect(first).toMatchObject({ admitted: { binding } })
      expect(yield* Ref.get(nativeResult)).toMatchObject({ _tag: "Completed", operationId: intent.operationId })
      expect(yield* Ref.get(dispatches)).toBe(1)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "execution-v2-build",
          }).pipe(
            Effect.provide(
              Layer.merge(
                hostLayer(observed, nativeResult, dispatches, "completed", "inspect"),
                workspaceComponentLayer,
              ),
            ),
          )
          yield* activate
          const session = yield* host.sessions.get(sessionId)
          expect(session.id).toBe(sessionId)
          const inspectRun = yield* host.runs.start(session.id, agent, "inspect operation")
          yield* drainRuntime
          yield* inspectRun.await
        }).pipe(Effect.provide(runtime)),
      )
      const second = yield* Ref.get(observed)
      expect(second).toMatchObject({ binding, admitted: [{ operationId: intent.operationId }] })
      expect(yield* Ref.get(dispatches)).toBe(1)
    }),
  60_000,
)

it.effect(
  "retains an effect-before-canonical Unknown Tool result across close/reopen",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const observed = yield* Ref.make<unknown>(undefined)
      const nativeResult = yield* Ref.make<CanonicalResult | undefined>(undefined)
      const dispatches = yield* Ref.make(0)
      const runtime = testRuntime(bucket)
      const sessionId = "session:execution-v2:unknown"
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({ agents: { [agent.name]: agent }, revision: "execution-v2-build" }).pipe(
            Effect.provide(
              Layer.merge(hostLayer(observed, nativeResult, dispatches, "lost", "admit"), workspaceComponentLayer),
            ),
          )
          yield* activate
          const session = yield* host.sessions.create({ id: sessionId, agent: agent.name })
          const run = yield* host.runs.start(session.id, agent, "admit operation")
          yield* drainRuntime
          expect(yield* run.await).toBe("admit")
        }).pipe(Effect.provide(runtime)),
      )
      expect(yield* Ref.get(nativeResult)).toMatchObject({ _tag: "Unknown", operationId: intent.operationId })
      expect(yield* Ref.get(dispatches)).toBe(1)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({ agents: { [agent.name]: agent }, revision: "execution-v2-build" }).pipe(
            Effect.provide(
              Layer.merge(hostLayer(observed, nativeResult, dispatches, "lost", "inspect"), workspaceComponentLayer),
            ),
          )
          yield* activate
          const session = yield* host.sessions.get(sessionId)
          const inspectRun = yield* host.runs.start(session.id, agent, "inspect operation")
          yield* drainRuntime
          yield* inspectRun.await
        }).pipe(Effect.provide(runtime)),
      )
      expect(yield* Ref.get(nativeResult)).toMatchObject({ _tag: "Unknown", operationId: intent.operationId })
      expect(yield* Ref.get(dispatches)).toBe(1)
    }),
  60_000,
)

it.effect(
  "retains an accepted canonical Tool Run result across Runtime close/reopen",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const dispatches = yield* Ref.make(0)
      const result: CanonicalResult = {
        _tag: "Accepted",
        operationId: "operation-tool-run",
        binding,
      }
      const toolLayer = nativeDispatchToolkit.toLayer({
        native_dispatch: (_params) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatches, (count) => count + 1)
            return result
          }),
      })
      const runtime = testRuntime(bucket)
      const runId = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: {},
            revision: "execution-v2-build",
            tools: [nativeDispatchTool],
          }).pipe(Effect.provide(Layer.mergeAll(toolLayer, Permissions.layerAllowAll, Approvals.layerAutoApprove)))
          yield* activate
          const run = yield* host.tools.start(nativeDispatchTool, { operationId: result.operationId })
          yield* drainRuntime
          expect(yield* run.await).toEqual(result)
          return run.id
        }).pipe(Effect.provide(runtime)),
      )
      expect(yield* Ref.get(dispatches)).toBe(1)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host.make({
            agents: {},
            revision: "execution-v2-build",
            tools: [nativeDispatchTool],
          }).pipe(Effect.provide(Layer.mergeAll(toolLayer, Permissions.layerAllowAll, Approvals.layerAutoApprove)))
          yield* activate
          const run = yield* host.tools.get(nativeDispatchTool, runId)
          expect(yield* run.await).toEqual(result)
        }).pipe(Effect.provide(runtime)),
      )
      expect(yield* Ref.get(dispatches)).toBe(1)
    }),
  60_000,
)
