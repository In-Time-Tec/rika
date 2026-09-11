import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import {
  WorkspaceBinding,
  WorkspaceExecutorRunnerFrame,
  WorkspaceExecutorServerFrame,
  type WorkspaceExecutorWebSocketPeer,
} from "@rika/execution"
import type { IdentityPrincipal } from "@rika/identity"
import type { ThreadAuthorityProjection, ThreadExecutionProjection } from "@rika/product-store/product-repository"
import { makeRunnerGateway } from "../../src/executor/runner-gateway"
import type { RunnerConnectionOptions } from "../../src/executor/runner-connection"

const principal: IdentityPrincipal = {
  userId: "user",
  clientId: "client",
  dpopJkt: "public-thumbprint",
  expiresAt: 60_000,
}

const authority: ThreadAuthorityProjection = {
  ownerId: "owner",
  kind: "personal",
  userId: "user",
  organizationId: null,
  membershipId: null,
  createdByUserId: "user",
  executorKind: "runner",
  inheritProjectGrants: false,
  threadRole: null,
  projectRole: null,
}

const row: ThreadExecutionProjection = {
  assignmentId: "assignment",
  workspaceId: "workspace",
  title: "Thread",
  hasTurns: false,
  executorKind: "runner",
  generation: "1",
  lifecycle: "pending",
  executorInstanceId: null,
  providerInstanceId: null,
  checkout: null,
  localRepository: null,
  placement: {
    _tag: "RunnerPlacement",
    deviceId: "device",
    requestingDeviceId: "device",
    checkoutFingerprint: "checkout",
    executorPolicy: { buildId: "build", protocolVersion: 1 },
  },
}

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: "assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace", checkoutFingerprint: "checkout" },
  buildId: "build",
  protocolVersion: 1,
})

const request = () =>
  new Request("https://rika.test/api/v2/threads/thread/executor", {
    headers: { authorization: "DPoP test-access", dpop: "test-proof" },
  })

const unused = () => Effect.die("Unexpected Runner gateway fixture call")

interface FixtureState {
  principal: IdentityPrincipal | undefined
  deviceId: string | undefined
  authority: ThreadAuthorityProjection | undefined
  row: ThreadExecutionProjection | undefined
  validationRow: ThreadExecutionProjection | undefined
  identified: Request[]
  authenticated: number
  executionReads: number
}

const fixture = () => {
  const state: FixtureState = {
    principal,
    deviceId: "device",
    authority,
    row,
    validationRow: undefined,
    identified: [],
    authenticated: 0,
    executionReads: 0,
  }
  const options: RunnerConnectionOptions = {
    environment: "test",
    identity: {
      identify: (incoming) =>
        Effect.sync(() => {
          state.identified.push(incoming)
          return state.principal
        }),
      handle: unused,
      browserSession: unused,
      protectedResourceMetadata: Effect.succeed({}),
    },
    directory: {
      ready: Effect.void,
      account: () =>
        Effect.succeed({
          user: { id: "user", name: "User", email: "user@example.test", image: null, emailVerified: true },
          memberships: [],
        }),
    },
    devices: {
      register: unused,
      discard: unused,
      list: unused,
      revoke: unused,
      revokeAll: unused,
      authenticate: () =>
        Effect.sync(() => {
          state.authenticated += 1
          return state.deviceId
        }),
    },
    product: {
      threadAuthority: () => Effect.sync(() => state.authority),
      threadExecutionContext: () =>
        Effect.sync(() => {
          state.executionReads += 1
          if (state.validationRow !== undefined && state.executionReads === 2) return state.validationRow
          return state.row
        }),
    },
  }
  return { state, options }
}

interface PeerFixture {
  readonly frames: string[]
  readonly closes: Array<{ readonly code: number; readonly reason: string }>
  readonly peer: WorkspaceExecutorWebSocketPeer
}

const peer = (): PeerFixture => {
  const frames: string[] = []
  const closes: Array<{ readonly code: number; readonly reason: string }> = []
  return {
    frames,
    closes,
    peer: {
      send: (frame) => {
        frames.push(frame)
      },
      close: (code, reason) => {
        closes.push({ code, reason })
      },
    },
  }
}

const testScope = () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    return scope
  })

it.effect("constructs a lazy executor proxy without reading Runner authority or creating a transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const executor = gateway.executor(binding)
      expect(test.state.identified).toEqual([])
      expect(test.state.authenticated).toBe(0)
      expect(test.state.executionReads).toBe(0)
      const failure = yield* executor.receipt("operation").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "RikaExecutionV2ExecutorTransportError", phase: "connection" })
      expect(test.state.identified).toEqual([])
      expect(test.state.authenticated).toBe(0)
      expect(test.state.executionReads).toBe(0)
    }),
  ),
)

it.effect("rejects an unauthorized connection before reserving or creating a transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      test.state.principal = undefined
      const gateway = yield* makeRunnerGateway(test.options)
      const socket = peer()
      const failure = yield* gateway
        .connect({ request: request(), threadId: "thread", peer: socket.peer })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "RikaRunnerConnectionError", kind: "unauthorized" })
      expect(socket.frames).toEqual([])
      expect(socket.closes).toEqual([])
    }),
  ),
)

it.effect("excludes a duplicate live connection for the same assignment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const first = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: first.peer })
      const second = peer()
      const failure = yield* gateway
        .connect({ request: request(), threadId: "thread", peer: second.peer })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "RikaExecutionV2ExecutorFenceError", reason: "assignment" })
      expect(first.closes).toEqual([])
      expect(second.frames).toEqual([])
      expect(second.closes).toEqual([])
    }),
  ),
)

it.effect("rejects a complete binding mismatch before dispatching to the Runner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const socket = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: socket.peer })
      const mismatched = yield* Schema.decodeEffect(WorkspaceBinding)({
        ...binding,
        buildId: "different-build",
      }).pipe(Effect.orDie)
      const failure = yield* gateway.executor(mismatched).receipt("operation").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "RikaExecutionV2ExecutorFenceError", reason: "build" })
      expect(socket.frames).toEqual([])
    }),
  ),
)

it.effect("releases a closed caller scope so the assignment can reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const firstScope = yield* testScope()
      const first = peer()
      yield* gateway
        .connect({ request: request(), threadId: "thread", peer: first.peer })
        .pipe(Scope.provide(firstScope))
      yield* Scope.close(firstScope, Exit.void)
      expect(first.closes).toHaveLength(1)
      const second = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: second.peer })
      expect(second.closes).toEqual([])
    }),
  ),
)

it.effect("cleans up a reservation when authorized transport setup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      test.state.validationRow = { ...row, generation: "2" }
      const gateway = yield* makeRunnerGateway(test.options)
      const failed = peer()
      const failure = yield* gateway
        .connect({ request: request(), threadId: "thread", peer: failed.peer })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "RikaExecutionV2ExecutorFenceError", reason: "assignment" })
      expect(failed.closes).toEqual([])
      test.state.validationRow = undefined
      const recovered = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: recovered.peer })
      expect(recovered.closes).toEqual([])
    }),
  ),
)

it.effect("cleans up an interrupted reserved connection before another connection arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gate = yield* Deferred.make<ThreadExecutionProjection>()
      const entered = yield* Deferred.make<void>()
      let reads = 0
      const options: RunnerConnectionOptions = {
        ...test.options,
        product: {
          ...test.options.product,
          threadExecutionContext: () =>
            Effect.gen(function* () {
              reads += 1
              if (reads === 2) {
                yield* Deferred.succeed(entered, undefined)
                return yield* Deferred.await(gate)
              }
              return row
            }),
        },
      }
      const gateway = yield* makeRunnerGateway(options)
      const callerScope = yield* testScope()
      const pending = yield* Effect.forkChild(
        gateway.connect({ request: request(), threadId: "thread", peer: peer().peer }).pipe(Scope.provide(callerScope)),
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(pending)
      const recovered = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: recovered.peer })
      expect(recovered.closes).toEqual([])
    }),
  ),
)

it.effect("keeps a newer registration when an old connection scope finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const oldScope = yield* testScope()
      const oldPeer = peer()
      const old = yield* gateway
        .connect({ request: request(), threadId: "thread", peer: oldPeer.peer })
        .pipe(Scope.provide(oldScope))
      yield* old.disconnected()
      const current = peer()
      yield* gateway.connect({ request: request(), threadId: "thread", peer: current.peer })
      yield* Scope.close(oldScope, Exit.void)
      const duplicate = yield* gateway
        .connect({ request: request(), threadId: "thread", peer: peer().peer })
        .pipe(Effect.flip)
      expect(duplicate).toMatchObject({ _tag: "RikaExecutionV2ExecutorFenceError", reason: "assignment" })
      expect(oldPeer.closes).toHaveLength(1)
      expect(current.closes).toEqual([])
    }),
  ),
)

it.effect("closes owned connections and rejects registrations after the factory scope closes", () =>
  Effect.gen(function* () {
    const test = fixture()
    const factoryScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(factoryScope, Exit.void))
    const gateway = yield* makeRunnerGateway(test.options).pipe(Scope.provide(factoryScope))
    const callerScope = yield* testScope()
    const socket = peer()
    yield* gateway
      .connect({ request: request(), threadId: "thread", peer: socket.peer })
      .pipe(Scope.provide(callerScope))
    yield* Scope.close(factoryScope, Exit.void)
    expect(socket.closes).toHaveLength(1)
    expect(callerScope.state._tag).not.toBe("Closed")
    const futureScope = yield* testScope()
    const future = yield* gateway
      .connect({ request: request(), threadId: "thread", peer: peer().peer })
      .pipe(Scope.provide(futureScope), Effect.flip)
    expect(future).toMatchObject({ _tag: "RikaRunnerConnectionError", kind: "unavailable" })
    const failure = yield* gateway.executor(binding).receipt("operation").pipe(Effect.flip)
    expect(failure).toMatchObject({ _tag: "RikaExecutionV2ExecutorTransportError", phase: "connection" })
  }),
)

it.effect("delegates enrollment, readiness, and a receipt through the live Runner transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const gateway = yield* makeRunnerGateway(test.options)
      const socket = peer()
      const connection = yield* gateway.connect({ request: request(), threadId: "thread", peer: socket.peer })
      const enrollment = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
        _tag: "Enroll",
        binding,
      })
      yield* connection.receive(enrollment)
      expect(yield* connection.ready).toMatchObject({
        workspaceId: "workspace",
        assignmentId: "assignment",
        generation: 1,
        buildId: "build",
        protocolVersion: 1,
      })
      const receipt = yield* Effect.forkChild(gateway.executor(binding).receipt("operation"))
      yield* Effect.yieldNow
      const encoded = socket.frames.at(-1)
      if (encoded === undefined) return yield* Effect.die("Runner transport did not send a receipt request")
      const frame = yield* Schema.decodeEffect(Schema.fromJsonString(WorkspaceExecutorServerFrame))(encoded).pipe(
        Effect.orDie,
      )
      expect(frame).toMatchObject({ _tag: "Request", request: { _tag: "Receipt", operationId: "operation" } })
      if (frame._tag !== "Request" || frame.request._tag !== "Receipt")
        return yield* Effect.die("Runner transport sent an unexpected frame")
      const response = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
        _tag: "Response",
        id: frame.id,
        response: { _tag: "ReceiptResult", evidence: null },
      })
      yield* connection.receive(response)
      expect(yield* Fiber.join(receipt)).toBeUndefined()
      yield* connection.disconnected()
    }),
  ),
)
