import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import { WorkspaceBinding } from "@rika/execution"
import { makeRunnerClient } from "@rika/client/runner"
import { makeFetchTransport } from "@rika/client/product"
import { workspaceBinding } from "../fixtures/context"
import { runnerFixture } from "../fixtures/runner"

it.live(
  "serves authenticated binding discovery through the real API without a Run",
  () =>
    Effect.gen(function* () {
      const { host, runnerIdentity, fixture } = yield* runnerFixture
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(yield* Layer.build(FetchHttpClient.layer)))
      const url = `${host.url}/api/v2/threads/hosted-runner/executor/binding`
      const response = yield* http.get(url, {
        headers: { authorization: "DPoP fixture-runner", dpop: "fixture-proof" },
      })
      expect(response.status).toBe(200)
      const binding = yield* response.text.pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(WorkspaceBinding))),
      )
      expect(binding).toEqual(workspaceBinding)
      expect(runnerIdentity.requests).toHaveLength(2)
      expect(runnerIdentity.requests[1]?.url).toBe(url)
      const runnerClient = makeRunnerClient({
        baseUrl: host.url,
        transport: makeFetchTransport(globalThis.fetch),
        requestHeaders: () => Effect.succeed({ authorization: "DPoP fixture-runner", dpop: "fixture-proof" }),
      })
      expect(yield* runnerClient.binding("hosted-runner")).toEqual(workspaceBinding)
      expect(runnerIdentity.requests).toHaveLength(3)
      expect(runnerIdentity.requests[2]?.url).toBe(url)
      expect(yield* fixture.requests).toEqual([])
    }),
  60_000,
)
