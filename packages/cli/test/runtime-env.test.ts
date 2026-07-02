import { describe, expect, test } from "bun:test"
import { SecretRedactor } from "@rika/core"
import { Effect } from "effect"
import { Runtime, RuntimeEnv } from "../src/index"

describe("CLI runtime environment", () => {
  test("maps global settings to Rika model provider env values", async () => {
    const env = await Effect.runPromise(
      RuntimeEnv.envFromSettings({
        api_key: "dummy",
        base_url: "http://127.0.0.1:8317/v1",
      }),
    )

    expect(env).toEqual({
      RIKA_API_KEY: "dummy",
      RIKA_BASE_URL: "http://127.0.0.1:8317/v1",
    })
  })

  test("gives process env precedence over .env.local, and .env.local over global settings", () => {
    const env = RuntimeEnv.mergeEnv({
      globalSettingsEnv: {
        RIKA_API_KEY: "global-key",
        RIKA_BASE_URL: "http://global.test/v1",
      },
      dotEnvLocalEnv: RuntimeEnv.parseDotEnv(`
        RIKA_API_KEY=local-key
        RIKA_BASE_URL=http://local.test/v1
      `),
      processEnv: {
        RIKA_API_KEY: "process-key",
      },
    })

    expect(env.RIKA_API_KEY).toBe("process-key")
    expect(env.RIKA_BASE_URL).toBe("http://local.test/v1")
  })

  test("loads ~/.rika/settings.json and workspace .env.local", async () => {
    const files = new Map([
      ["/home/user/.rika/settings.json", JSON.stringify({ api_key: "global-key", base_url: "http://global.test/v1" })],
      ["/workspace/rika/.env.local", "RIKA_API_KEY=local-key\n"],
    ])
    const system: RuntimeEnv.System = {
      readText: (path) =>
        files.has(path)
          ? Effect.succeed(files.get(path) ?? "")
          : Effect.fail(Object.assign(new Error(`missing ${path}`), { code: "ENOENT" })),
    }

    const env = await Effect.runPromise(
      RuntimeEnv.load({ env: {}, cwd: "/workspace/rika", home: "/home/user", system }),
    )

    expect(env.RIKA_API_KEY).toBe("local-key")
    expect(env.RIKA_BASE_URL).toBe("http://global.test/v1")
  })

  test("builds a redactor layer from runtime env and command tokens", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const apiKey = yield* SecretRedactor.redact("key env-api-key-secret")
        const serverToken = yield* SecretRedactor.redact("token server-command-token")
        return { apiKey, serverToken }
      }).pipe(
        Effect.provide(
          Runtime.secretRedactorLayer({ RIKA_API_KEY: "env-api-key-secret" }, [
            { label: "RIKA_SERVER_TOKEN", value: "server-command-token" },
          ]),
        ),
      ),
    )

    expect(result).toEqual({
      apiKey: "key [REDACTED:RIKA_API_KEY]",
      serverToken: "token [REDACTED:RIKA_SERVER_TOKEN]",
    })
  })
})
