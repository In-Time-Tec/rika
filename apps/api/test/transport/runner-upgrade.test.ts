import { it } from "@effect/vitest"
import { Deferred, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import {
  WorkspaceExecutorRunnerFrame,
  workspaceExecutorWebSocketProtocol,
  defaultWorkspaceExecutorTransportLimits,
} from "@rika/execution"
import { makeRunnerGateway } from "../../src/executor/runner-gateway"
import { prepareRunnerUpgrade, runnerThreadPath } from "../../src/transport/runner-upgrade"
import { workspaceBinding } from "../fixtures/context"
import { runnerIdentityFixture } from "../fixtures/runner-identity"

const request = () =>
  new Request("https://rika.test/api/v2/threads/hosted-runner/executor", {
    headers: {
      authorization: "DPoP fixture-runner",
      dpop: "fixture-proof",
      "sec-websocket-protocol": workspaceExecutorWebSocketProtocol,
    },
  })

test("matches only the Runner endpoint and decodes the Thread without changing the request", () => {
  expect(runnerThreadPath(request())).toBe("hosted-runner")
  expect(runnerThreadPath(new Request("https://rika.test/api/v2/threads/a%2Fb/executor"))).toBe("a/b")
  expect(runnerThreadPath(new Request("https://rika.test/api/v2/threads/%ZZ/executor"))).toBeUndefined()
  expect(runnerThreadPath(new Request("https://rika.test/api/v2/threads/thread/runtime"))).toBeUndefined()
  expect(runnerThreadPath(new Request(request(), { method: "POST" }))).toBeUndefined()
})

it.effect("rejects a missing protocol and anonymous request before a socket is opened", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const incompatible = new Request(request())
      incompatible.headers.delete("sec-websocket-protocol")
      const protocol = yield* prepareRunnerUpgrade({ request: incompatible, threadId: "hosted-runner", gateway })
      expect(protocol).toBeInstanceOf(Response)
      if (!(protocol instanceof Response)) return yield* Effect.die("Expected protocol rejection")
      expect(protocol.status).toBe(426)
      expect(identity.requests).toEqual([])
      const anonymous = new Request(request())
      anonymous.headers.delete("authorization")
      const denied = yield* prepareRunnerUpgrade({ request: anonymous, threadId: "hosted-runner", gateway })
      expect(denied).toBeInstanceOf(Response)
      if (!(denied instanceof Response)) return yield* Effect.die("Expected authentication rejection")
      expect(denied.status).toBe(401)
      expect(identity.requests).toEqual([anonymous])
    }),
  ),
)

it.effect("authenticates once before opening and handles the first enrollment frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const incoming = request()
      const prepared = yield* prepareRunnerUpgrade({ request: incoming, threadId: "hosted-runner", gateway })
      if (prepared instanceof Response) return yield* Effect.die("Expected an authorized Runner")
      yield* Effect.addFinalizer(() => prepared.close)
      expect(identity.requests).toEqual([incoming])
      expect(identity.requests[0]).toBe(incoming)
      const sent: string[] = []
      const closed: number[] = []
      yield* prepared.opened({
        send: (frame) => {
          sent.push(frame)
        },
        close: (code) => {
          closed.push(code)
        },
      })
      yield* prepared.receive(
        yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
          _tag: "Enroll",
          binding: workspaceBinding,
        }),
      )
      yield* prepared.connection.ready
      expect(sent).toHaveLength(1)
      expect(identity.requests).toHaveLength(1)
      const duplicate = yield* prepareRunnerUpgrade({ request: request(), threadId: "hosted-runner", gateway })
      if (!(duplicate instanceof Response)) return yield* Effect.die("Expected duplicate rejection")
      expect(duplicate.status).toBe(409)
      yield* prepared.close
      expect(closed).toEqual([1000])
      const replacement = yield* prepareRunnerUpgrade({ request: request(), threadId: "hosted-runner", gateway })
      if (replacement instanceof Response) return yield* Effect.die("Expected reconnection after closure")
      yield* replacement.close
    }),
  ),
)

it.effect("closes a socket when authorization expires between preparation and opening", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const prepared = yield* prepareRunnerUpgrade({ request: request(), threadId: "hosted-runner", gateway })
      if (prepared instanceof Response) return yield* Effect.die("Expected an authorized Runner")
      yield* Effect.addFinalizer(() => prepared.close)
      identity.state.revoked = true
      yield* TestClock.adjust("5 seconds")
      const closed: number[] = []
      yield* prepared.opened({
        send: () => undefined,
        close: (code) => {
          closed.push(code)
        },
      })
      expect(closed).toEqual([1008])
      expect((yield* prepared.connection.ready.pipe(Effect.result))._tag).toBe("Failure")
      expect(identity.requests).toHaveLength(1)
    }),
  ),
)

it.effect("expires an authorized socket that never enrolls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const prepared = yield* prepareRunnerUpgrade({ request: request(), threadId: "hosted-runner", gateway })
      if (prepared instanceof Response) return yield* Effect.die("Expected an authorized Runner")
      yield* Effect.addFinalizer(() => prepared.close)
      const closed: number[] = []
      yield* prepared.opened({
        send: () => undefined,
        close: (code) => {
          closed.push(code)
        },
      })
      yield* TestClock.adjust("10 seconds")
      expect(closed).toEqual([1000])
      expect((yield* prepared.connection.ready.pipe(Effect.result))._tag).toBe("Failure")
    }),
  ),
)

it.effect("bounds incoming frames while authority checks are suspended", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gate = yield* Deferred.make<void>()
      let blocked = false
      let checks = 0
      const gateway = yield* makeRunnerGateway({
        ...identity.options,
        product: {
          ...identity.options.product,
          threadAuthority: (userId, threadId) =>
            Effect.gen(function* () {
              checks += 1
              if (blocked) yield* Deferred.await(gate)
              return yield* identity.options.product.threadAuthority(userId, threadId)
            }),
        },
      })
      const prepared = yield* prepareRunnerUpgrade({ request: request(), threadId: "hosted-runner", gateway })
      if (prepared instanceof Response) return yield* Effect.die("Expected an authorized Runner")
      yield* Effect.addFinalizer(() => prepared.close)
      const closed: number[] = []
      yield* prepared.opened({
        send: () => undefined,
        close: (code) => {
          closed.push(code)
        },
      })
      const before = checks
      blocked = true
      const frame = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
        _tag: "Enroll",
        binding: workspaceBinding,
      })
      for (let index = 0; index <= defaultWorkspaceExecutorTransportLimits.maxInFlightRpcs; index += 1)
        yield* prepared.receive(frame)
      expect(closed).toEqual([1000])
      expect(checks - before).toBeLessThanOrEqual(defaultWorkspaceExecutorTransportLimits.maxInFlightRpcs)
      const rejected = checks
      yield* prepared.receive(frame)
      expect(checks).toBe(rejected)
    }),
  ),
)
