import { describe, expect, test } from "bun:test"
import * as ServerEndpoint from "@rika/server/server-endpoint"
import { Effect } from "effect"
import { makeDiscoverRikaReadyData } from "./rika-endpoint"

const endpoint: ServerEndpoint.ServerEndpoint = {
  identity: "canonical-identity",
  canonicalDataRoot: "/private/rika",
  port: 23_456,
  url: "ws://127.0.0.1:23456/server",
  tokenPath: "/private/rika/server.token",
  startupPath: "/private/rika/server-canonical-identity.startup",
}

const publication: ServerEndpoint.ServerPublication = {
  port: endpoint.port,
  pid: 123,
  tokenPath: endpoint.tokenPath,
  version: "0.3.17",
  protocolVersion: 8,
}

describe("desktop Rika endpoint mapping", () => {
  test("returns only the renderer connection descriptor", () => {
    const discover = makeDiscoverRikaReadyData(() => Effect.succeed({ endpoint, token: "secret", publication }))
    const ready = Effect.runSync(discover({ profile: "default", dataRoot: "/private/rika" }))

    expect(ready).toEqual({
      url: endpoint.url,
      token: "secret",
      identity: endpoint.identity,
    })
    expect(Object.keys(ready).sort()).toEqual(["identity", "token", "url"])
    for (const forbidden of ["dataRoot", "tokenPath", "pid", "port", "version", "protocolVersion"])
      expect(forbidden in ready).toBe(false)
  })

  test("preserves typed discovery failures", () => {
    const failure = ServerEndpoint.ServerPublicationError.make({
      reason: "unsafe",
      message: "Server publication is unsafe",
    })
    const discover = makeDiscoverRikaReadyData(() => Effect.fail(failure))

    expect(Effect.runSync(Effect.flip(discover({ profile: "default", dataRoot: "/private/rika" })))).toBe(failure)
  })
})
