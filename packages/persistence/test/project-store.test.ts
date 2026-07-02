import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, Migration, ProjectStore } from "../src/index"

const now = Common.TimestampMillis.make(1_980_000_001_000)
const projectId = Ids.ProjectId.make("project_1")

const timeLayer = Time.fixedLayer(now)
const idLayer = IdGenerator.sequenceLayer(1)

describe("ProjectStore", () => {
  test("creates, fetches, and lists projects without exposing secret values", async () => {
    const dataDir = await makeDataDir()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/x/y",
          env: { FOO: "bar" },
        })
        const byId = yield* ProjectStore.get(projectId)
        const byName = yield* ProjectStore.getByName("demo")
        const byRepoOrigin = yield* ProjectStore.getByRepoOrigin("https://github.com/x/y")
        const listed = yield* ProjectStore.list()
        return { created, byId, byName, byRepoOrigin, listed }
      }).pipe(Effect.provide(makeLayer(dataDir))),
    )

    const expected = {
      project_id: projectId,
      name: "demo",
      repo_origin: "https://github.com/x/y",
      default_branch: "main",
      template_id: null,
      env: { FOO: "bar" },
      secret_names: [],
      created_at: now,
      updated_at: now,
    }
    expect(result.created).toEqual(expected)
    expect(result.byId).toEqual(expected)
    expect(result.byName).toEqual(expected)
    expect(result.byRepoOrigin).toEqual(expected)
    expect(result.listed).toEqual([expected])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("sets and unsets environment variables", async () => {
    const dataDir = await makeDataDir()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/x/y",
          env: { FOO: "bar" },
        })
        const withToken = yield* ProjectStore.setEnv(created.project_id, "TOKEN", "abc")
        const withoutFoo = yield* ProjectStore.unsetEnv(created.project_id, "FOO")
        return { withToken, withoutFoo }
      }).pipe(Effect.provide(makeLayer(dataDir))),
    )

    expect(result.withToken.env).toEqual({ FOO: "bar", TOKEN: "abc" })
    expect(result.withoutFoo.env).toEqual({ TOKEN: "abc" })
    expect(result.withoutFoo.updated_at).toBe(now)
    await rm(dataDir, { force: true, recursive: true })
  })

  test("stores secret values outside project reads with private file permissions", async () => {
    const dataDir = await makeDataDir()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/x/y",
        })
        const withSecret = yield* ProjectStore.setSecret(created.project_id, "TOKEN", "s3cret")
        const publicRead = yield* ProjectStore.getByName("demo")
        const secrets = yield* ProjectStore.secretsForProvision(created.project_id)
        const mode =
          (yield* Effect.tryPromise(() => stat(join(dataDir, "secrets", `${created.project_id}.json`)))).mode & 0o777
        const withoutSecret = yield* ProjectStore.unsetSecret(created.project_id, "TOKEN")
        const emptySecrets = yield* ProjectStore.secretsForProvision(created.project_id)
        return { withSecret, publicRead, secrets, mode, withoutSecret, emptySecrets }
      }).pipe(Effect.provide(makeLayer(dataDir))),
    )

    expect(result.withSecret.secret_names).toEqual(["TOKEN"])
    expect(result.publicRead?.secret_names).toEqual(["TOKEN"])
    expect(result.publicRead).not.toHaveProperty("TOKEN")
    expect(result.secrets).toEqual({ TOKEN: "s3cret" })
    expect(result.mode).toBe(0o600)
    expect(result.withoutSecret.secret_names).toEqual([])
    expect(result.emptySecrets).toEqual({})
    await rm(dataDir, { force: true, recursive: true })
  })

  test("preserves secret names when environment variables change", async () => {
    const dataDir = await makeDataDir()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/x/y",
        })
        yield* ProjectStore.setSecret(created.project_id, "TOKEN", "s3cret")
        const withEnv = yield* ProjectStore.setEnv(created.project_id, "FOO", "bar")
        const withoutEnv = yield* ProjectStore.unsetEnv(created.project_id, "FOO")
        return { withEnv, withoutEnv }
      }).pipe(Effect.provide(makeLayer(dataDir))),
    )

    expect(result.withEnv.secret_names).toEqual(["TOKEN"])
    expect(result.withoutEnv.secret_names).toEqual(["TOKEN"])
    await rm(dataDir, { force: true, recursive: true })
  })
})

const makeDataDir = () => mkdtemp(join(tmpdir(), "rika-project-store-"))

const makeLayer = (dataDir: string) => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-project-store-test",
    data_dir: dataDir,
    default_mode: "smart",
  })
  const storeLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(Database.memoryLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  return Layer.mergeAll(configLayer, Database.memoryLayer, Migration.layer, timeLayer, idLayer, storeLayer)
}
