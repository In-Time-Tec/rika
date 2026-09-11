import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import { workspaceExecutorWebSocketProtocol } from "@rika/execution"
import { workspaceBinding } from "../fixtures/context"
import { runnerFixture } from "../fixtures/runner"

it.live(
  "authenticates the original upgrade once and rejects duplicate and anonymous sockets",
  () =>
    Effect.gen(function* () {
      const { host, runnerIdentity, runnerGateway } = yield* runnerFixture
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(yield* Layer.build(FetchHttpClient.layer)))
      expect(runnerIdentity.requests).toHaveLength(1)
      expect(runnerIdentity.requests[0]?.url).toBe(`${host.url}/api/v2/threads/hosted-runner/executor`)
      expect(yield* runnerGateway.executor(workspaceBinding).receipt("unknown-operation")).toBeUndefined()
      expect(runnerIdentity.requests).toHaveLength(1)
      const anonymous = yield* http.get(`${host.url}/api/v2/threads/hosted-runner/executor`, {
        headers: { upgrade: "websocket", "sec-websocket-protocol": workspaceExecutorWebSocketProtocol },
      })
      expect(anonymous.status).toBe(401)
      const duplicate = yield* http.get(`${host.url}/api/v2/threads/hosted-runner/executor`, {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": workspaceExecutorWebSocketProtocol,
          authorization: "DPoP fixture-runner",
          dpop: "fixture-proof",
        },
      })
      expect(duplicate.status).toBe(409)
      expect(yield* runnerGateway.executor(workspaceBinding).receipt("still-unknown")).toBeUndefined()
      expect(runnerIdentity.requests).toHaveLength(3)
    }),
  60_000,
)

it.live(
  "closes an idle live Runner after device revocation and rejects later RPCs",
  () =>
    Effect.gen(function* () {
      const { runnerIdentity, runnerConnection, runnerGateway } = yield* runnerFixture
      runnerIdentity.state.revoked = true
      yield* runnerConnection.closed.pipe(Effect.timeout("10 seconds"))
      expect(
        (yield* runnerGateway.executor(workspaceBinding).receipt("forbidden-operation").pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(runnerIdentity.requests).toHaveLength(1)
    }),
  60_000,
)

it.live(
  "rejects a changed assignment fence and closes the real socket before dispatch",
  () =>
    Effect.gen(function* () {
      const { runnerIdentity, runnerConnection, runnerGateway, fixture } = yield* runnerFixture
      runnerIdentity.state.generation = "2"
      expect(
        (yield* runnerGateway.executor(workspaceBinding).receipt("stale-operation").pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* runnerConnection.closed.pipe(Effect.timeout("10 seconds"))
      expect(yield* fixture.requests).toEqual([])
    }),
  60_000,
)
