import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { IdentityRuntimeError, type IdentityPrincipal } from "@rika/identity"
import { WorkspaceExecutorRunnerFrame } from "@rika/execution"
import type { ThreadAuthorityProjection, ThreadExecutionProjection } from "@rika/product-store/product-repository"
import {
  authorizeRunnerConnection,
  makeRunnerExecutorConnection,
  type RunnerConnectionOptions,
} from "../../src/executor/runner-connection"

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
const unused = () => Effect.die("Unexpected Runner authorization fixture call")
const request = () =>
  new Request("https://rika.test/api/v2/threads/thread/executor", {
    headers: { authorization: "DPoP test-access", dpop: "test-proof" },
  })
interface FixtureState {
  principal: IdentityPrincipal | undefined
  deviceId: string | undefined
  authority: ThreadAuthorityProjection | undefined
  row: ThreadExecutionProjection | undefined
  identified: Request[]
}
const fixture = () => {
  const state: FixtureState = { principal, deviceId: "device", authority, row, identified: [] }
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
      authenticate: () => Effect.sync(() => state.deviceId),
    },
    product: {
      threadAuthority: () => Effect.sync(() => state.authority),
      threadExecutionContext: () => Effect.sync(() => state.row),
    },
  }
  return { state, options }
}

it.effect("binds the original authenticated request to the exact Runner device and persisted policy", () =>
  Effect.gen(function* () {
    const test = fixture()
    const incoming = request()
    const authorized = yield* authorizeRunnerConnection(incoming, "thread", test.options)
    expect(test.state.identified).toEqual([incoming])
    expect(test.state.identified[0]).toBe(incoming)
    expect(authorized.binding.workspaceBinding).toMatchObject({
      generation: 1,
      buildId: "build",
      protocolVersion: 1,
      placement: { _tag: "Runner", checkoutFingerprint: "checkout" },
    })
    yield* authorized.validate
    expect(test.state.identified).toHaveLength(1)
  }),
)

it.effect("rejects anonymous, browser-only, unbound, and expired credentials", () =>
  Effect.gen(function* () {
    const cases: (IdentityPrincipal | undefined)[] = [
      undefined,
      { userId: "user" },
      { userId: "user", clientId: "client", dpopJkt: "public-thumbprint" },
      { ...principal, expiresAt: 0 },
    ]
    for (const identity of cases) {
      const test = fixture()
      test.state.principal = identity
      expect((yield* authorizeRunnerConnection(request(), "thread", test.options).pipe(Effect.flip)).kind).toBe(
        "unauthorized",
      )
    }
    const unbound = fixture()
    unbound.state.deviceId = undefined
    expect((yield* authorizeRunnerConnection(request(), "thread", unbound.options).pipe(Effect.flip)).kind).toBe(
      "unauthorized",
    )
    const invalid = fixture()
    expect(
      (yield* authorizeRunnerConnection(request(), "thread", {
        ...invalid.options,
        identity: { ...invalid.options.identity, identify: () => IdentityRuntimeError.make({ kind: "invalid" }) },
      }).pipe(Effect.flip)).kind,
    ).toBe("unauthorized")
  }),
)

it.effect("rejects foreign creators, wrong devices, Box targets, and revoked Organization membership", () =>
  Effect.gen(function* () {
    for (const changed of [
      { ...authority, createdByUserId: "someone-else" },
      { ...authority, userId: "someone-else" },
      { ...authority, executorKind: "orb" as const },
      { ...authority, kind: "organization", userId: null, organizationId: "organization", membershipId: null },
    ]) {
      const test = fixture()
      test.state.authority = changed
      expect((yield* authorizeRunnerConnection(request(), "thread", test.options).pipe(Effect.flip)).kind).toBe(
        "forbidden",
      )
    }
    const device = fixture()
    device.state.deviceId = "another-device"
    expect((yield* authorizeRunnerConnection(request(), "thread", device.options).pipe(Effect.flip)).kind).toBe(
      "forbidden",
    )
    const member = fixture()
    member.state.authority = {
      ...authority,
      kind: "organization",
      userId: null,
      organizationId: "organization",
      membershipId: "member",
    }
    yield* authorizeRunnerConnection(request(), "thread", member.options)
  }),
)

it.effect("rechecks expiry, revocation, and every persisted fence before accepting more work", () =>
  Effect.gen(function* () {
    for (const generation of ["2", "0"]) {
      const test = fixture()
      const authorized = yield* authorizeRunnerConnection(request(), "thread", test.options)
      test.state.row = { ...row, generation }
      expect((yield* authorized.validate.pipe(Effect.flip)).kind).toBe("forbidden")
    }
    const revoked = fixture()
    const authorized = yield* authorizeRunnerConnection(request(), "thread", revoked.options)
    revoked.state.deviceId = undefined
    expect((yield* authorized.validate.pipe(Effect.flip)).kind).toBe("unauthorized")
    const expired = fixture()
    const expiring = yield* authorizeRunnerConnection(request(), "thread", expired.options)
    yield* TestClock.adjust("60 seconds")
    expect((yield* expiring.validate.pipe(Effect.flip)).kind).toBe("unauthorized")
  }),
)

it.effect("closes an idle executor connection on revocation and rejects subsequent RPCs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const sent: string[] = []
      const closed: number[] = []
      const connection = yield* makeRunnerExecutorConnection({
        request: request(),
        threadId: "thread",
        options: test.options,
        peer: {
          send: (frame) => {
            sent.push(frame)
          },
          close: (code) => {
            closed.push(code)
          },
        },
      })
      const frame = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
        _tag: "Enroll",
        binding: connection.executor.binding,
      })
      yield* connection.receive(frame)
      yield* connection.ready
      expect(sent).toHaveLength(1)
      test.state.deviceId = undefined
      yield* TestClock.adjust("5 seconds")
      expect(closed.length).toBeGreaterThan(0)
      const failure = yield* connection.executor.receipt("operation").pipe(Effect.flip)
      expect(failure._tag).toBe("RikaExecutionV2ExecutorFenceError")
      expect(sent).toHaveLength(1)
      yield* connection.disconnected()
    }),
  ),
)
