import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { ArtifactStore, Database, Migration, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginHost, PluginUi, SelfExtension } from "../src/index"

const now = Common.TimestampMillis.make(1_234)
const threadId = Ids.ThreadId.make("thread_self_extension_test")

const tempRoot = () => mkdtemp(join(tmpdir(), "rika-self-extension-"))

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const baseLayer = (
  workspaceRoot: string,
  verifier = SelfExtension.fakeVerifier({ status: "passed", exit_code: 0 }),
  timeLayer = timeSequenceLayer(),
  artifactLayer = ArtifactStore.fakeLayer(),
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: `${workspaceRoot}/.rika`,
    default_mode: "smart",
  })
  const supportLayer = Layer.mergeAll(
    configLayer,
    artifactLayer,
    IdGenerator.sequenceLayer(1),
    timeLayer,
    PluginUi.silentLayer,
  )
  return Layer.mergeAll(
    supportLayer,
    SelfExtension.layerFromAdapters({
      workspaceRoot,
      verifier,
      resolveWorkspaceId: () => Effect.succeed(Ids.WorkspaceId.make(workspaceRoot)),
    }).pipe(Layer.provideMerge(supportLayer)),
    PluginHost.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(PluginUi.silentLayer),
      Layer.provideMerge(supportLayer),
    ),
  )
}

const projectedLayer = (workspaceRoot: string) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: `${workspaceRoot}/.rika`,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const supportLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    ThreadProjection.layer,
    ArtifactStore.fakeLayer(),
    IdGenerator.sequenceLayer(1),
    Time.fixedLayer(now),
  )
  return Layer.mergeAll(supportLayer, SelfExtension.layer.pipe(Layer.provideMerge(supportLayer)))
}

const timeSequenceLayer = (start = now) => {
  let next = start
  return Layer.succeed(
    Time.Service,
    Time.Service.of({
      nowMillis: Effect.sync(() => {
        const current = next
        next = Common.TimestampMillis.make(next + 1)
        return current
      }),
    }),
  )
}

describe("SelfExtension", () => {
  test("does not load or execute plugin files without a SelfExtension trust record", async () => {
    const root = await tempRoot()
    const pluginDirectory = join(root, ".rika", "plugins")
    const marker = join(root, "untrusted-executed")
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(
      join(pluginDirectory, "untrusted.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "executed")
export default function (rika) {
	rika.registerMode({ name: "rush", description: "Untrusted mode" })
}
`,
    )

    const report = await Effect.runPromise(
      PluginHost.Service.pipe(
        Effect.flatMap((host) => host.report),
        Effect.provide(baseLayer(root)),
      ),
    )

    expect(report.loaded).toEqual([])
    expect(report.errors).toMatchObject([
      {
        name: "untrusted",
        path: join(root, ".rika", "plugins", "untrusted.ts"),
        message: "Plugin file has no enabled SelfExtension trust record",
      },
    ])
    expect(await exists(marker)).toBe(false)
  })

  test("generates project-local skills and records an artifact with a diff", async () => {
    const root = await tempRoot()

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const change = yield* SelfExtension.createSkill({
          name: "deploy-helper",
          description: "Help deploy safely",
          instructions: "Run the deployment checklist.",
          thread_id: threadId,
        })
        const stored = yield* ArtifactStore.get(change.artifact_id)
        return { change, stored }
      }).pipe(Effect.provide(baseLayer(root))),
    )

    const skill = await readFile(join(root, ".agents", "skills", "deploy-helper", "SKILL.md"), "utf8")
    expect(skill).toContain("name: deploy-helper")
    expect(skill).toContain("Run the deployment checklist.")
    expect(output.change).toMatchObject({ kind: "skill", action: "create-skill", enabled: true })
    expect(output.change.files).toEqual([
      {
        path: ".agents/skills/deploy-helper/SKILL.md",
        before: null,
        after: skill,
      },
    ])
    expect(Option.getOrUndefined(output.stored)).toMatchObject({
      id: output.change.artifact_id,
      thread_id: threadId,
      kind: "other",
      metadata: { kind: "self-extension", action: "create-skill", enabled: true },
    })
  })

  test("writes generated plugins disabled until verification passes and then loads them", async () => {
    const root = await tempRoot()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.report))
        const created = yield* SelfExtension.createPlugin({
          name: "hello-world",
          description: "Say hello from a generated plugin",
          thread_id: threadId,
        })
        const disabledAfterCreate = yield* Effect.promise(() =>
          exists(join(root, ".rika", "plugins", "hello-world.ts.disabled")),
        )
        const stillDisabled = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const enabled = yield* SelfExtension.enablePlugin({
          name: "hello-world",
          verification_command: "bun test --pass-with-no-tests",
          thread_id: threadId,
        })
        const loaded = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const commands = yield* PluginHost.commands()
        return { before, created, disabledAfterCreate, stillDisabled, enabled, loaded, commands }
      }).pipe(Effect.provide(baseLayer(root))),
    )

    expect(result.before.loaded).toEqual([])
    expect(result.created).toMatchObject({ action: "create-plugin", enabled: false })
    expect(result.stillDisabled.loaded).toEqual([])
    expect(result.stillDisabled.errors).toEqual([])
    expect(result.disabledAfterCreate).toBe(true)

    expect(result.enabled).toMatchObject({ action: "enable-plugin", enabled: true })
    expect(result.enabled.trust.verification).toMatchObject({
      status: "passed",
      command: "bun test --pass-with-no-tests",
    })
    expect(result.enabled.trust.content_hash).toBe(
      SelfExtension.contentHash(await readFile(join(root, ".rika", "plugins", "hello-world.ts"), "utf8")),
    )
    expect(await exists(join(root, ".rika", "plugins", "hello-world.ts"))).toBe(true)
    expect(await exists(join(root, ".rika", "plugins", "hello-world.ts.disabled"))).toBe(false)
    expect(result.loaded.loaded.map((plugin) => plugin.name)).toEqual(["hello-world"])
    expect(result.commands.map((command) => command.name)).toEqual(["hello-world.hello"])
  })

  test("does not trust byte-identical same-path plugins across workspaces", async () => {
    const rootA = await tempRoot()
    const rootB = await tempRoot()
    const artifactLayer = ArtifactStore.fakeLayer()

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({
          name: "shared-name",
          description: "Workspace A plugin",
          thread_id: threadId,
        }).pipe(Effect.provide(baseLayer(rootA, undefined, timeSequenceLayer(), artifactLayer)))
        yield* SelfExtension.enablePlugin({
          name: "shared-name",
          verification_command: "bun test --pass-with-no-tests",
          thread_id: threadId,
        }).pipe(
          Effect.provide(
            baseLayer(rootA, undefined, timeSequenceLayer(Common.TimestampMillis.make(1_300)), artifactLayer),
          ),
        )
        const source = yield* Effect.promise(() => readFile(join(rootA, ".rika", "plugins", "shared-name.ts"), "utf8"))
        yield* Effect.promise(() => mkdir(join(rootB, ".rika", "plugins"), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(rootB, ".rika", "plugins", "shared-name.ts"), source))
        return yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.report)).pipe(
          Effect.provide(
            baseLayer(rootB, undefined, timeSequenceLayer(Common.TimestampMillis.make(1_400)), artifactLayer),
          ),
        )
      }),
    )

    expect(report.loaded).toEqual([])
    expect(report.errors).toMatchObject([
      {
        name: "shared-name",
        path: join(rootB, ".rika", "plugins", "shared-name.ts"),
        message: "Plugin file has no enabled SelfExtension trust record",
      },
    ])
  })

  test("rejects self-extension records for threads in another workspace", async () => {
    const root = await tempRoot()
    const otherThreadId = Ids.ThreadId.make("thread_other_extension_workspace")
    const otherWorkspaceId = Ids.WorkspaceId.make("workspace_other_extension")

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadProjection.apply(threadCreated(otherThreadId, otherWorkspaceId))
        return yield* SelfExtension.createPlugin({
          name: "cross-thread",
          description: "Cross workspace plugin",
          thread_id: otherThreadId,
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(projectedLayer(root))),
    )

    expect(error).toMatchObject({
      operation: "resolveWorkspace",
      message: `Thread ${otherThreadId} belongs to workspace ${otherWorkspaceId}, not ${root}`,
    })
    expect(await exists(join(root, ".rika", "plugins", "cross-thread.ts.disabled"))).toBe(false)
  })

  test("failed verification records the decision and keeps a plugin bypassed", async () => {
    const root = await tempRoot()
    const verifier = SelfExtension.fakeVerifier({ status: "failed", exit_code: 1, stderr: "tests failed" })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "bad-plugin", description: "Broken plugin", thread_id: threadId })
        const enabled = yield* SelfExtension.enablePlugin({
          name: "bad-plugin",
          verification_command: "bun test",
          thread_id: threadId,
        })
        const report = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const stored = yield* ArtifactStore.get(enabled.artifact_id)
        return { enabled, report, stored }
      }).pipe(Effect.provide(baseLayer(root, verifier))),
    )

    expect(result.enabled).toMatchObject({ action: "enable-plugin", enabled: false })
    expect(result.enabled.trust.verification).toMatchObject({ status: "failed", command: "bun test" })
    expect(await exists(join(root, ".rika", "plugins", "bad-plugin.ts"))).toBe(false)
    expect(await exists(join(root, ".rika", "plugins", "bad-plugin.ts.disabled"))).toBe(true)
    expect(result.report).toMatchObject({ loaded: [], errors: [] })
    expect(Option.getOrUndefined(result.stored)).toMatchObject({
      metadata: { kind: "self-extension", action: "enable-plugin", enabled: false },
    })
  })

  test("rejects an enabled plugin whose file content changed after trust was recorded", async () => {
    const root = await tempRoot()
    const marker = join(root, "tampered-executed")

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "tamper-me", description: "Tamper plugin", thread_id: threadId })
        yield* SelfExtension.enablePlugin({
          name: "tamper-me",
          verification_command: "bun test --pass-with-no-tests",
          thread_id: threadId,
        })
        yield* Effect.promise(() =>
          writeFile(
            join(root, ".rika", "plugins", "tamper-me.ts"),
            `await Bun.write(${JSON.stringify(marker)}, "executed")
export default function (rika) {
	rika.registerMode({ name: "rush", description: "Tampered mode" })
}
`,
          ),
        )
        return yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
      }).pipe(Effect.provide(baseLayer(root))),
    )

    expect(report.loaded).toEqual([])
    expect(report.errors).toMatchObject([
      {
        name: "tamper-me",
        path: join(root, ".rika", "plugins", "tamper-me.ts"),
        message: "Plugin content hash does not match the enabled SelfExtension trust record",
      },
    ])
    expect(await exists(marker)).toBe(false)
  })

  test("rejects active plugin files when latest trust records have ambiguous timestamps", async () => {
    const root = await tempRoot()
    const marker = join(root, "ambiguous-executed")
    const layer = baseLayer(root, SelfExtension.fakeVerifier({ status: "passed", exit_code: 0 }), Time.fixedLayer(now))

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "ambiguous", description: "Ambiguous plugin", thread_id: threadId })
        yield* Effect.promise(() =>
          writeFile(
            join(root, ".rika", "plugins", "ambiguous.ts.disabled"),
            `await Bun.write(${JSON.stringify(marker)}, "executed")
export default function (rika) {
	rika.registerMode({ name: "rush", description: "Ambiguous mode" })
}
`,
          ),
        )
        yield* SelfExtension.enablePlugin({
          name: "ambiguous",
          verification_command: "bun test --pass-with-no-tests",
          thread_id: threadId,
        })
        yield* SelfExtension.disablePlugin({
          name: "ambiguous",
          reason: "disabled",
          thread_id: threadId,
        })
        yield* Effect.promise(async () => {
          const disabled = await readFile(join(root, ".rika", "plugins", "ambiguous.ts.disabled"), "utf8")
          await writeFile(join(root, ".rika", "plugins", "ambiguous.ts"), disabled)
        })
        return yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
      }).pipe(Effect.provide(layer)),
    )

    expect(report.loaded).toEqual([])
    expect(report.errors).toMatchObject([
      {
        name: "ambiguous",
        path: join(root, ".rika", "plugins", "ambiguous.ts"),
        message: "Plugin has multiple latest SelfExtension trust records with the same timestamp",
      },
    ])
    expect(await exists(marker)).toBe(false)
  })

  test("rollback disables an enabled plugin without deleting the generated source", async () => {
    const root = await tempRoot()

    const rolledBack = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "toggle-me", description: "Toggle plugin" })
        yield* SelfExtension.enablePlugin({ name: "toggle-me", verification_command: "bun test" })
        return yield* SelfExtension.rollbackPlugin({ name: "toggle-me", reason: "startup failed" })
      }).pipe(Effect.provide(baseLayer(root))),
    )

    expect(rolledBack).toMatchObject({ action: "rollback-plugin", enabled: false })
    expect(rolledBack.trust.reason).toBe("startup failed")
    expect(await exists(join(root, ".rika", "plugins", "toggle-me.ts"))).toBe(false)
    expect(await exists(join(root, ".rika", "plugins", "toggle-me.ts.disabled"))).toBe(true)
  })
})

const threadCreated = (threadIdValue: Ids.ThreadId, workspaceId: Ids.WorkspaceId): Event.ThreadCreated => ({
  id: Ids.EventId.make("event_other_extension_workspace_created"),
  thread_id: threadIdValue,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})
