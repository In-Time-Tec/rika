import { expect, it } from "@effect/vitest"
import { MachineRequest, type AccessWire, type ApiMessage } from "@rika/remote-execution/protocol"
import { Clock, Effect, Fiber, Schema } from "effect"
import { GatewayError, type Socket } from "../../src/executor/gateway"
import { nativeOperationEndpoint, type NativeOperationSession } from "../../src/executor/native-operation-endpoint"

const access = (leaseEpoch: number): AccessWire => ({
  version: 1,
  fence: {
    target: "runner",
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "runner-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch,
  sessionToken: "session-token",
})

const socket = (): Socket => ({ send: () => undefined, close: () => undefined })
const readRequest: MachineRequest = { _tag: "NativeTool", request: { _tag: "Read", path: "README.md" } }
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))
const readRequestDigest = encodeRequest(readRequest)
const success = {
  _tag: "Success" as const,
  value: { _tag: "NativeTool" as const, result: { text: "done", truncated: false } },
}
const identity = {
  assignmentId: "assignment-1",
  operationKey: "operation-1",
  attempt: 0,
  machineId: "machine-1",
}
const request = Effect.map(Clock.currentTimeMillis, (now) => ({
  ...identity,
  request: readRequest,
  deadlineAtMillis: now + 10_000,
}))

const makeEndpoint = (initial: NativeOperationSession, failFirstDelivery = false) => {
  let session: NativeOperationSession | undefined = initial
  let failDelivery = failFirstDelivery
  const sent: Array<ApiMessage> = []
  return nativeOperationEndpoint({
    digest: (value) => Effect.succeed(value),
    encodeRequest,
    session: () => Effect.succeed(session),
    authorize: () => Effect.succeed(true),
    sameAccess: (left, right) => left.leaseEpoch === right.leaseEpoch,
    send: (_session, message) =>
      Effect.try({
        try: () => {
          sent.push(message)
          if (!failDelivery) return
          failDelivery = false
          throw new Error("delivery failed")
        },
        catch: () => GatewayError.make({ kind: "transport", message: "delivery failed" }),
      }),
  }).pipe(
    Effect.map((endpoint) => ({
      endpoint,
      sent,
      replace(next: NativeOperationSession | undefined) {
        session = next
      },
    })),
  )
}

it.effect("deduplicates a stable operation key and returns the same result to every caller", () =>
  Effect.gen(function* () {
    const current = { socket: socket(), access: access(1) }
    const { endpoint, sent } = yield* makeEndpoint(current)
    const input = yield* request
    const first = yield* Effect.forkChild(endpoint.invoke(input))
    yield* Effect.yieldNow
    const duplicate = yield* Effect.forkChild(endpoint.invoke(input))
    yield* Effect.yieldNow
    expect(sent.filter((message) => message._tag === "MachineExecute")).toHaveLength(1)
    yield* endpoint.receive(current, { ...identity, requestDigest: readRequestDigest, outcome: success })
    expect(yield* Effect.all([Fiber.join(first), Fiber.join(duplicate)])).toEqual([success, success])
  }),
)

it.effect("cancels one pending native operation", () =>
  Effect.gen(function* () {
    const current = { socket: socket(), access: access(1) }
    const { endpoint, sent } = yield* makeEndpoint(current)
    const input = yield* request
    const running = yield* Effect.forkChild(endpoint.invoke(input))
    yield* Effect.yieldNow
    const cancelling = yield* Effect.forkChild(endpoint.cancel(input))
    yield* Effect.yieldNow
    expect(sent.map((message) => message._tag)).toEqual(["MachineExecute", "MachineCancel"])
    yield* endpoint.receive(current, {
      ...identity,
      requestDigest: readRequestDigest,
      outcome: { _tag: "Cancelled" },
    })
    expect(yield* Effect.all([Fiber.join(running), Fiber.join(cancelling)])).toEqual([
      { _tag: "Cancelled" },
      { _tag: "Cancelled" },
    ])
  }),
)

it.effect("retains a disconnected operation and settles it once after reconnect", () =>
  Effect.gen(function* () {
    const first = { socket: socket(), access: access(1) }
    const state = yield* makeEndpoint(first)
    const input = yield* request
    const running = yield* Effect.forkChild(state.endpoint.invoke(input))
    yield* Effect.yieldNow
    yield* state.endpoint.disconnected(first.socket)
    state.replace(undefined)
    const replacement = { socket: socket(), access: access(2) }
    state.replace(replacement)
    yield* state.endpoint.reconnected(replacement)
    expect(state.sent.filter((message) => message._tag === "MachineExecute")).toHaveLength(2)
    const result = { ...identity, requestDigest: readRequestDigest, outcome: success }
    yield* state.endpoint.receive(replacement, result)
    yield* state.endpoint.receive(replacement, result)
    expect(yield* Fiber.join(running)).toEqual(success)
  }),
)

it.effect("accepts a pending result after the current session fence is refreshed", () =>
  Effect.gen(function* () {
    const first = { socket: socket(), access: access(1) }
    const state = yield* makeEndpoint(first)
    const input = yield* request
    const running = yield* Effect.forkChild(state.endpoint.invoke(input))
    yield* Effect.yieldNow
    const refreshed = { ...first, access: access(2) }
    state.replace(refreshed)
    yield* state.endpoint.refreshed(refreshed)
    yield* state.endpoint.receive(refreshed, {
      ...identity,
      requestDigest: readRequestDigest,
      outcome: success,
    })
    expect(yield* Fiber.join(running)).toEqual(success)
  }),
)

it.effect("rejects request-digest conflicts for the same operation identity", () =>
  Effect.gen(function* () {
    const current = { socket: socket(), access: access(1) }
    const { endpoint } = yield* makeEndpoint(current)
    const input = yield* request
    const running = yield* Effect.forkChild(endpoint.invoke(input))
    yield* Effect.yieldNow
    const conflict = yield* Effect.flip(
      endpoint.invoke({
        ...input,
        request: { _tag: "NativeTool", request: { _tag: "Read", path: "CONTEXT.md" } },
      }),
    )
    expect(conflict).toMatchObject({ kind: "fenced" })
    yield* endpoint.receive(current, { ...identity, requestDigest: readRequestDigest, outcome: success })
    yield* Fiber.join(running)
  }),
)

it.effect("reports a delivery failure and safely retries the stable operation identity", () =>
  Effect.gen(function* () {
    const current = { socket: socket(), access: access(1) }
    const { endpoint, sent } = yield* makeEndpoint(current, true)
    const input = yield* request
    expect(yield* endpoint.invoke(input).pipe(Effect.flip)).toMatchObject({ kind: "transport" })
    const replay = yield* Effect.forkChild(endpoint.invoke(input))
    yield* Effect.yieldNow
    expect(sent.filter((message) => message._tag === "MachineExecute")).toHaveLength(2)
    yield* endpoint.receive(current, { ...identity, requestDigest: readRequestDigest, outcome: success })
    expect(yield* Fiber.join(replay)).toEqual(success)
  }),
)
