import { it } from "@effect/vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { expect } from "vitest"
import { WorkspaceBinding } from "@rika/execution"
import { makeRunnerGateway } from "../../src/executor/runner-gateway"
import { makeRunnerRequestHandler } from "../../src/executor/http"
import { runnerIdentityFixture } from "../fixtures/runner-identity"
import { workspaceBinding } from "../fixtures/context"

const request = (threadId = "hosted-runner") =>
  new Request(`https://rika.test/api/v2/threads/${threadId}/executor/binding`, {
    headers: { authorization: "DPoP fixture-runner", dpop: "fixture-proof" },
  })

it.effect("returns the persisted binding without acquiring a socket or execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const incoming = request()
      const response = yield* makeRunnerRequestHandler(gateway)(incoming)
      if (response === undefined) return yield* Effect.die("Expected the Runner binding route")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const binding = yield* Effect.tryPromise(() => response.text()).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(WorkspaceBinding))),
      )
      expect(binding).toEqual(workspaceBinding)
      expect(identity.requests).toEqual([incoming])
      expect(identity.requests[0]).toBe(incoming)
      expect((yield* gateway.executor(binding).receipt("no-execution").pipe(Effect.result))._tag).toBe("Failure")
    }),
  ),
)

it.effect("requires current device authority for binding reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const handle = makeRunnerRequestHandler(gateway)
      const anonymous = request()
      anonymous.headers.delete("authorization")
      expect((yield* handle(anonymous))?.status).toBe(401)
      expect((yield* handle(request("another-thread")))?.status).toBe(403)
      identity.state.revoked = true
      expect((yield* handle(request()))?.status).toBe(401)
    }),
  ),
)

it.effect("ignores unrelated routes and rejects malformed Thread identities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const gateway = yield* makeRunnerGateway(identity.options)
      const handle = makeRunnerRequestHandler(gateway)
      expect(yield* handle(new Request("https://rika.test/api/v2/threads"))).toBeUndefined()
      expect(yield* handle(new Request(request(), { method: "POST" }))).toBeUndefined()
      expect((yield* handle(request("%ZZ")))?.status).toBe(400)
      expect((yield* handle(request("a".repeat(513))))?.status).toBe(400)
      expect(identity.requests).toEqual([])
    }),
  ),
)

it.effect("rejects binding reads after the Gateway owner closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* runnerIdentityFixture
      const owner = yield* Scope.make()
      const gateway = yield* makeRunnerGateway(identity.options).pipe(Scope.provide(owner))
      yield* Scope.close(owner, Exit.void)
      expect((yield* makeRunnerRequestHandler(gateway)(request()))?.status).toBe(503)
      expect(identity.requests).toEqual([])
    }),
  ),
)
