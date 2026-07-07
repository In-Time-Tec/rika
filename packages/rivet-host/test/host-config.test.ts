import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HostConfig } from "../src/index"

describe("HostConfig", () => {
  test("defaults to a local Rivet engine endpoint", async () => {
    const host = await Effect.runPromise(HostConfig.resolveOptions({}, {}))

    expect(host).toEqual({
      mode: "local",
      endpoint: "http://127.0.0.1:6420",
      no_welcome: true,
    })
    expect(HostConfig.toRegistryOptions(host)).toEqual({
      endpoint: "http://127.0.0.1:6420",
      noWelcome: true,
    })
  })

  test("resolves remote endpoint, token, namespace, and runner version from env", async () => {
    const host = await Effect.runPromise(
      HostConfig.resolveOptions(
        {},
        {
          RIKA_RIVET_HOST: "remote",
          RIKA_RIVET_ENDPOINT: "https://rivet.example.com",
          RIKA_RIVET_TOKEN: "secret",
          RIKA_RIVET_NAMESPACE: "team",
          RIVET_RUNNER_VERSION: "build-123",
        },
      ),
    )

    expect(host).toEqual({
      mode: "remote",
      endpoint: "https://rivet.example.com",
      token: "secret",
      namespace: "team",
      no_welcome: true,
      runner_version: "build-123",
    })
    expect(HostConfig.toClientOptions(host)).toEqual({
      endpoint: "https://rivet.example.com",
      token: "secret",
      namespace: "team",
    })
  })

  test("parses no-welcome through the shared boolean env set", async () => {
    const host = await Effect.runPromise(HostConfig.resolveOptions({}, { RIKA_RIVET_NO_WELCOME: "disabled" }))

    expect(host.no_welcome).toBe(false)
  })

  test("requires an explicit endpoint in remote mode", async () => {
    const error = await Effect.runPromise(
      HostConfig.resolveOptions({}, { RIKA_RIVET_HOST: "remote" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ key: "RIKA_RIVET_ENDPOINT" })
  })
})
