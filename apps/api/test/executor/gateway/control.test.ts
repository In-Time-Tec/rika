import { describe, expect, it } from "@effect/vitest"
import type { MachineOutcome } from "@rika/remote-execution/protocol"
import { Clock, DateTime, Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { GatewayTestHarness } from "./fixture"

const {
  encode,
  decode,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  fence,
  access,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

const eventually = <A>(read: () => A | undefined): Effect.Effect<A> => {
  const loop: Effect.Effect<A> = Effect.suspend(() => {
    const value = read()
    return value === undefined ? Effect.yieldNow.pipe(Effect.andThen(loop)) : Effect.succeed(value)
  })
  return loop.pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die("RPC was not sent") }))
}

const connect = Effect.fn("ExecutorGatewayTest.connect")(function* (
  service: ReturnType<typeof controller> = controller(),
) {
  const target = socket()
  const gateway = yield* makeGateway(service)
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
        capabilities: { nativeTools: true, checkpoints: false, pty: false },
        workspaceCapabilities,
        cursors: { command: 0, event: 0, pty: 0 },
        latestCheckpointId: null,
        bootstrapToken: "bootstrap-token",
      },
    }),
  )
  yield* workspaceReady(gateway, target)
  return { gateway, target }
})

const input = (
  operationKey: string,
  request: { readonly _tag: "Read"; readonly path: string } | { readonly _tag: "Bash"; readonly command: string },
) => ({
  assignmentId: "assignment-1",
  operationKey,
  workspaceId: "workspace-1",
  sessionId: "thread-1",
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId: `call-${operationKey}`,
  code: JSON.stringify(request),
  attempt: 0,
  replayPolicy: "provider-idempotent" as const,
  admittedAt: null,
  deadlineAt: "2999-01-01T00:00:00.000Z",
  machineRequest: { _tag: "NativeTool" as const, request },
})

const delivery = (target: ReturnType<typeof socket>, operationKey: string) =>
  eventually(() => {
    const message = target.sent
      .map((value) => decode(value))
      .find((candidate) => candidate._tag === "MachineExecute" && candidate.operationKey === operationKey)
    return message?._tag === "MachineExecute" ? message : undefined
  })

const machineResult = (
  operationKey: string,
  request: Extract<ReturnType<typeof decode>, { readonly _tag: "MachineExecute" }>,
  outcome: MachineOutcome,
) =>
  encode({
    _tag: "MachineResult",
    access,
    operationKey,
    attempt: request.attempt,
    machineId: request.machineId,
    requestDigest: request.requestDigest,
    outcome,
  })

describe("executor gateway native tools", () => {
  it.effect("executes and durably replays a native tool through MachineExecute", () =>
    Effect.gen(function* () {
      const { gateway, target } = yield* connect()
      const request = input("native-read", { _tag: "Read", path: "README.md" })
      const running = yield* Effect.forkChild(gateway.execute(request))
      const sent = yield* delivery(target, request.operationKey)
      expect(sent.machineId).toMatch(/^[a-f0-9]{64}$/)
      const result = { text: "contents", truncated: false }
      yield* gateway.receive(
        target,
        machineResult(request.operationKey, sent, {
          _tag: "Success",
          value: { _tag: "NativeTool", result },
        }),
      )
      expect(yield* Fiber.join(running)).toMatchObject({ response: { _tag: "Success", result }, outcome: "completed" })
      const sentCount = target.sent.filter((message) => decode(message)._tag === "MachineExecute").length
      expect(yield* gateway.execute(request)).toMatchObject({
        response: { _tag: "Success", result },
        outcome: "completed",
      })
      expect(target.sent.filter((message) => decode(message)._tag === "MachineExecute")).toHaveLength(sentCount)
    }),
  )

  it.effect("scopes machine receipts to the durable outer operation when tool-call ids repeat", () =>
    Effect.gen(function* () {
      const { gateway, target } = yield* connect()
      const firstRequest = {
        ...input("native-collision-a", { _tag: "Read", path: "README.md" }),
        runId: "run-collision-a",
        rootRunId: "run-collision-a",
        toolCallId: "reused-provider-call",
      }
      const secondRequest = {
        ...input("native-collision-b", { _tag: "Read", path: "README.md" }),
        runId: "run-collision-b",
        rootRunId: "run-collision-b",
        toolCallId: "reused-provider-call",
      }
      const first = yield* Effect.forkChild(gateway.execute(firstRequest))
      const second = yield* Effect.forkChild(gateway.execute(secondRequest))
      const firstDelivery = yield* delivery(target, firstRequest.operationKey)
      const secondDelivery = yield* delivery(target, secondRequest.operationKey)
      expect(firstDelivery.machineId).toMatch(/^[a-f0-9]{64}$/)
      expect(secondDelivery.machineId).toMatch(/^[a-f0-9]{64}$/)
      expect(secondDelivery.machineId).not.toBe(firstDelivery.machineId)
      yield* gateway.receive(
        target,
        machineResult(firstRequest.operationKey, firstDelivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: { text: "first", truncated: false } },
        }),
      )
      yield* gateway.receive(
        target,
        machineResult(secondRequest.operationKey, secondDelivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: { text: "second", truncated: false } },
        }),
      )
      expect(yield* Fiber.join(first)).toMatchObject({ outcome: "completed" })
      expect(yield* Fiber.join(second)).toMatchObject({ outcome: "completed" })
    }),
  )

  it.effect("interrupts a native machine through MachineCancel and retains cancellation", () =>
    Effect.gen(function* () {
      const { gateway, target } = yield* connect()
      const request = input("native-cancel", { _tag: "Bash", command: "sleep 30" })
      const running = yield* Effect.forkChild(gateway.execute(request))
      const sent = yield* delivery(target, request.operationKey)
      const cancelling = yield* Effect.forkChild(gateway.cancel(request))
      const cancellation = yield* eventually(() =>
        target.sent
          .map((message) => decode(message))
          .find((message) => message._tag === "MachineCancel" && message.operationKey === request.operationKey),
      )
      if (cancellation._tag !== "MachineCancel") return yield* Effect.die("MachineCancel was not sent")
      expect(cancellation).toMatchObject({ machineId: sent.machineId, requestDigest: sent.requestDigest })
      yield* gateway.receive(target, machineResult(request.operationKey, sent, { _tag: "Cancelled" }))
      expect(yield* Fiber.join(running)).toMatchObject({ outcome: "cancelled" })
      expect(yield* Fiber.join(cancelling)).toMatchObject({ outcome: "cancelled" })
      expect(yield* gateway.cancel(request)).toMatchObject({ outcome: "cancelled" })
    }),
  )

  it.effect("durably settles disconnected cancellation as unknown at the persisted deadline", () =>
    Effect.gen(function* () {
      const { gateway, target } = yield* connect()
      const deadlineAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 1_000))
      const request = { ...input("native-cancel-disconnected", { _tag: "Bash", command: "sleep 30" }), deadlineAt }
      const running = yield* Effect.forkChild(gateway.execute(request))
      yield* delivery(target, request.operationKey)
      yield* gateway.disconnected(target)
      const cancelling = yield* Effect.forkChild(gateway.cancel(request))
      yield* TestClock.adjust("1 second")
      const cancelled = yield* Fiber.join(cancelling)
      expect(cancelled).toMatchObject({
        response: { _tag: "DomainFailure", failure: { kind: "unknown" } },
        outcome: "unknown",
      })
      expect(yield* Fiber.join(running)).toMatchObject({ response: cancelled.response, outcome: cancelled.outcome })
      expect(yield* gateway.cancel(request)).toEqual(cancelled)
    }),
  )

  it.effect("settles cancellation as unknown when a replacement executor owns the live session", () =>
    Effect.gen(function* () {
      const service = controller({
        hello: (hello) =>
          Effect.succeed({
            version: 1,
            fence: hello.fence,
            sessionToken: Redacted.make("session-token"),
            leaseEpoch: 1,
            leaseExpiresAt: 4_102_444_800_000,
            heartbeatIntervalMillis: 20,
            cursor: { sequence: 0, value: "" },
          }),
      })
      const { gateway, target } = yield* connect(service)
      const request = input("native-cancel-replaced", { _tag: "Bash", command: "sleep 30" })
      yield* Effect.forkChild(gateway.execute(request))
      yield* delivery(target, request.operationKey)
      const replacementTarget = socket()
      const replacementFence = {
        ...fence,
        assignmentGeneration: 2,
        executorId: "executor-2",
        processIncarnation: "process-2",
      }
      const replacementAccess = { ...access, fence: replacementFence }
      yield* gateway.receive(
        replacementTarget,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "replacement",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence: replacementFence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, replacementTarget, replacementAccess)
      const cancelled = yield* gateway.cancel(request)
      expect(cancelled).toMatchObject({
        response: { _tag: "DomainFailure", failure: { kind: "unknown" } },
        outcome: "unknown",
      })
      expect(
        replacementTarget.sent.map((message) => decode(message)).filter((message) => message._tag === "MachineCancel"),
      ).toEqual([])
      expect(yield* gateway.cancel(request)).toEqual(cancelled)
    }),
  )

  it.effect("preserves unknown native machine outcomes", () =>
    Effect.gen(function* () {
      const { gateway, target } = yield* connect()
      const request = input("native-unknown", { _tag: "Bash", command: "touch unsafe" })
      const running = yield* Effect.forkChild(gateway.execute(request))
      const sent = yield* delivery(target, request.operationKey)
      yield* gateway.receive(
        target,
        machineResult(request.operationKey, sent, { _tag: "Unknown", message: "delivery was ambiguous" }),
      )
      const result = yield* Fiber.join(running)
      expect(result.outcome).toBe("unknown")
      expect(result.response).toMatchObject({ _tag: "DomainFailure", failure: { kind: "unknown" } })
    }),
  )
})
