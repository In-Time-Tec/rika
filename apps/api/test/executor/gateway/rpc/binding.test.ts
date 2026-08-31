import { describe, expect, it } from "@effect/vitest"
import * as MachineBindings from "@rika/kernel/machine-bindings"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import { NestedOperation, ToolContext } from "generalist"
import { HostBindings } from "generalist/repl"
import { Context, Deferred, Effect, Fiber, Layer, Logger } from "effect"
import { GatewayTestHarness } from "../fixture"

const {
  encode,
  decode,
  encodeUnknown,
  bindingRequestDigest,
  milestone,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  bindingAuthority,
  fence,
  access,
  cellIdentity,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: binding-authority", () => {
  it.effect("runs binding cleanup before an interrupted receive fiber exits", () =>
    Effect.gen(function* () {
      const invocationStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const cleanupCompleted = yield* Deferred.make<void>()
      const signal = yield* Effect.abortSignal
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.succeed(true),
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-interrupted-binding",
          }),
        ),
        Context.add(
          NestedOperation.Operations,
          NestedOperation.Operations.of({ run: (_request, operation) => operation }),
        ),
      )
      const registry = HostBindings.HostBindings.of({
        descriptors: [{ module: "workspace", operations: ["read"] }],
        resolve: () => Effect.die("unused"),
        invoke: () =>
          Deferred.succeed(invocationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
                Effect.andThen(Deferred.succeed(cleanupCompleted, undefined)),
              ),
            ),
          ),
      })
      const authority = bindingAuthority(registry, context, "d".repeat(64))
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-interrupted-binding",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "wait for binding",
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "read",
        input: { path: "README.md" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const receiving = yield* Effect.forkChild(
        gateway.receive(
          target,
          encode({
            _tag: "BindingInvoke",
            access,
            operationKey: "operation-interrupted-binding",
            attempt: 0,
            callId: "operation-interrupted-binding:binding:0",
            requestDigest: bindingRequestDigest(request),
            request,
          }),
        ),
      )
      yield* Deferred.await(invocationStarted)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(receiving))
      yield* Deferred.await(cleanupStarted)
      expect(receiving.pollUnsafe()).toBeUndefined()
      expect(interrupting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Deferred.await(cleanupCompleted)
      yield* Fiber.join(interrupting)
      expect(receiving.pollUnsafe()).toBeDefined()
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([])
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("runs canonical nested bindings under captured API authority and deduplicates replays", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      const nestedRequests: Array<{
        readonly kind: string
        readonly replayPolicy: string
        readonly approval: NestedOperation.Request["approval"]
      }> = []
      const signal = yield* Effect.abortSignal
      const machineContext = yield* Layer.build(MachineBindings.layer({ execute: () => Effect.die("unused") }))
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.succeed(true),
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-bindings",
          }),
        ),
        Context.add(
          NestedOperation.Operations,
          NestedOperation.Operations.of({
            run: (request) => {
              nestedRequests.push({
                kind: request.kind,
                replayPolicy: request.replayPolicy,
                approval: request.approval,
              })
              return NestedOperation.Suspended.make({
                token: "approval-token",
                operationKey: "operation-bindings",
                ordinal: 0,
                capability: request.approval?.capability ?? "unknown",
              })
            },
          }),
        ),
        Context.merge(machineContext),
      )
      const registry = yield* HostBindings.make([WorkspaceBinding.module]).pipe(Effect.provideContext(context))
      const authority = bindingAuthority(registry, context, "b".repeat(64))
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-bindings",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: 'await rika.workspace.write({ path: "a", content: "b" })',
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "write",
        input: { path: "private-tool-input", content: "private-tool-input-secret" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const invoke = {
        _tag: "BindingInvoke" as const,
        access,
        operationKey: "operation-bindings",
        attempt: 0,
        callId: "operation-bindings:binding:0",
        requestDigest: bindingRequestDigest(request),
        request,
      }
      yield* observed(gateway.receive(target, encode(invoke)))
      yield* observed(gateway.receive(target, encode(invoke)))
      const results = target.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")
      expect(results).toHaveLength(2)
      expect(results[0]?.outcome).toEqual({ _tag: "Suspend", token: "approval-token" })
      expect(nestedRequests).toHaveLength(1)
      expect(nestedRequests[0]).toMatchObject({
        kind: "rika.tool.workspace.write",
        replayPolicy: "never",
        approval: {
          capability: "workspace.write",
          request: {
            policy: { id: "hosted-tool-policy", version: 1 },
            operation: { module: "workspace", name: "write" },
            workspace: "workspace-1",
          },
        },
      })

      const missing = { ...request, operation: "missing" }
      yield* observed(
        gateway.receive(
          target,
          encode({
            ...invoke,
            callId: "operation-bindings:binding:1",
            requestDigest: bindingRequestDigest(missing),
            request: missing,
          }),
        ),
      )
      const rejected = target.sent.map((value) => decode(value)).findLast((message) => message._tag === "BindingResult")
      expect(rejected?._tag === "BindingResult" && rejected.outcome).toEqual({
        _tag: "Unknown",
        message: "Tool admission could not durably record its decision",
      })
      const renderedObservability = encodeUnknown(observability)
      const bindingCorrelation = {
        "rika.thread.id": "thread-1",
        "rika.turn.id": "turn-1",
        "rika.run.id": "run-1",
        "rika.operation.id": "operation-bindings",
        "rika.cell.id": "call-1",
      }
      expect(milestone(observability, "hosted.binding_send.success").map((record) => record.annotations)).toEqual([
        {
          ...bindingCorrelation,
          "rika.binding.id": "operation-bindings:binding:0",
          "rika.hosted.stage": "binding_send",
          "rika.hosted.outcome": "success",
        },
        {
          ...bindingCorrelation,
          "rika.binding.id": "operation-bindings:binding:1",
          "rika.hosted.stage": "binding_send",
          "rika.hosted.outcome": "success",
        },
      ])
      expect(milestone(observability, "hosted.binding_terminal.success")[0]?.annotations).toMatchObject({
        ...bindingCorrelation,
        "rika.binding.id": "operation-bindings:binding:0",
        "rika.hosted.stage": "binding_terminal",
        "rika.hosted.outcome": "success",
      })
      expect(milestone(observability, "hosted.binding_terminal.unknown")[0]?.annotations).toMatchObject({
        ...bindingCorrelation,
        "rika.binding.id": "operation-bindings:binding:1",
        "rika.hosted.stage": "binding_terminal",
        "rika.hosted.outcome": "unknown",
      })
      expect(renderedObservability).not.toContain("hosted.binding.")
      expect(renderedObservability).not.toContain("assignment-1")
      expect(renderedObservability).not.toContain(access.fence.instanceId)
      expect(renderedObservability).not.toContain("private-tool-input")
      expect(renderedObservability).not.toContain("private-tool-input-secret")
      expect(renderedObservability).not.toContain("approval-token")

      const conflicting = { ...request, input: { path: "a", content: "different" } }
      yield* gateway.receive(
        target,
        encode({
          ...invoke,
          requestDigest: bindingRequestDigest(conflicting),
          request: conflicting,
        }),
      )
      expect(target.closed).toContainEqual([1008, "fenced"])
      yield* Fiber.interrupt(running)
    }),
  )
})
