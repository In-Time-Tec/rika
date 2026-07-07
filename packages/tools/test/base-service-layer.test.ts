import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@rika/core"
import { Effect } from "effect"
import { BaseServiceLayer } from "../src/index"

describe("BaseServiceLayer", () => {
  test("fails fast on invalid model context window env outside the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-base-layer-invalid-env-"))

    try {
      const result = await runConfig(root, { RIKA_MODEL_CONTEXT_WINDOW: "abc" }, true)

      expect(result).toBeInstanceOf(Config.ConfigError)
      if (!(result instanceof Config.ConfigError)) throw new Error("expected ConfigError")
      expect(result.message).toBe("Invalid RIKA_MODEL_CONTEXT_WINDOW abc")
      expect(result.key).toBe("RIKA_MODEL_CONTEXT_WINDOW")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("builds normally with absent and valid model context window env", async () => {
    const absentRoot = await mkdtemp(join(tmpdir(), "rika-base-layer-absent-env-"))
    const validRoot = await mkdtemp(join(tmpdir(), "rika-base-layer-valid-env-"))

    try {
      const absent = await runConfig(absentRoot, {}, false)
      const valid = await runConfig(validRoot, { RIKA_MODEL_CONTEXT_WINDOW: "123456" }, false)

      expect(absent).toMatchObject({ default_mode: "smart" })
      expect(valid).toMatchObject({ default_mode: "smart" })
    } finally {
      await rm(absentRoot, { recursive: true, force: true })
      await rm(validRoot, { recursive: true, force: true })
    }
  })
})

const runConfig = async (
  root: string,
  envOverrides: Record<string, string | undefined>,
  flip: boolean,
): Promise<Config.Values | Config.ConfigError> => {
  const home = join(root, "home")
  const workspaceRoot = join(root, "workspace")
  await mkdir(home, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })
  const env = {
    HOME: home,
    RIKA_TELEMETRY: "0",
    ...envOverrides,
  }
  const configLayer = Config.layerFromEnv(env, workspaceRoot)
  const serviceLayers = BaseServiceLayer.fromEnv({
    env,
    workspaceRoot,
    configLayer,
    databaseMode: "memory",
  })
  const effect = Config.get().pipe(Effect.provide(serviceLayers.configLayer))
  return flip ? Effect.runPromise(effect.pipe(Effect.flip)) : Effect.runPromise(effect)
}
