import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, IdGenerator, Settings, Time } from "@rika/core"
import { Database, Migration, OrbStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { OrbActivity, SandboxClient, SandboxClientFake } from "../src/index"

const createdAt = Common.TimestampMillis.make(2_030_000_000_000)
const firstTouchAt = Common.TimestampMillis.make(2_030_000_001_000)
const secondTouchAt = Common.TimestampMillis.make(2_030_000_030_999)
const thirdTouchAt = Common.TimestampMillis.make(2_030_000_031_000)
const threadId = Ids.ThreadId.make("thread_orb_activity")
const projectId = Ids.ProjectId.make("project_orb_activity")
const orbId = Ids.OrbId.make("orb_1")

describe("OrbActivity", () => {
  test("refreshes sandbox timeout at most once per throttle window while recording local activity", async () => {
    const sandbox = SandboxClientFake.makeState()

    const record = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        yield* OrbActivity.touch(orbId)
        yield* OrbActivity.touch(orbId)
        yield* OrbActivity.touch(orbId)
        return yield* OrbStore.get(orbId)
      }).pipe(Effect.provide(makeLayer(sandbox))),
    )

    expect(sandbox.calls.setTimeout).toEqual([
      { sandboxId: "sandbox_orb_activity", timeoutMs: 420_000 },
      { sandboxId: "sandbox_orb_activity", timeoutMs: 420_000 },
    ])
    expect(record?.last_active_at).toBe(thirdTouchAt)
  })

  test("uses settings idle timeout when env does not override", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-activity-settings-"))
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(join(workspace, ".rika", "settings.json"), JSON.stringify({ "orb.idleTimeoutSeconds": 123 }))
    const sandbox = SandboxClientFake.makeState()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* createRunningOrb()
          return yield* OrbActivity.touch(orbId)
        }).pipe(
          Effect.provide(makeLayer(sandbox, SandboxClientFake.layer(sandbox), { env: {}, workspaceRoot: workspace })),
        ),
      )

      expect(sandbox.calls.setTimeout).toEqual([{ sandboxId: "sandbox_orb_activity", timeoutMs: 123_000 }])
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("refreshes sandbox timeout at most once when concurrent touches race", async () => {
    const sandbox = SandboxClientFake.makeState()
    const entered = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())

    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        const touches = yield* Effect.all([OrbActivity.touch(orbId), OrbActivity.touch(orbId)], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(touches)
        return sandbox.calls.setTimeout
      }).pipe(Effect.provide(makeLayer(sandbox, delayedSetTimeoutLayer(sandbox, entered, release)))),
    )

    expect(calls).toEqual([{ sandboxId: "sandbox_orb_activity", timeoutMs: 420_000 }])
  })

  test("release evicts refresh state for the orb", async () => {
    const sandbox = SandboxClientFake.makeState()

    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        yield* OrbActivity.touch(orbId)
        yield* OrbActivity.release(orbId)
        yield* OrbActivity.touch(orbId)
        return sandbox.calls.setTimeout
      }).pipe(Effect.provide(makeLayer(sandbox))),
    )

    expect(calls).toEqual([
      { sandboxId: "sandbox_orb_activity", timeoutMs: 420_000 },
      { sandboxId: "sandbox_orb_activity", timeoutMs: 420_000 },
    ])
  })

  test("touch that read running before terminal release does not refresh the killed orb", async () => {
    const sandbox = SandboxClientFake.makeState()
    const touchReadRunning = Effect.runSync(Deferred.make<void>())
    const allowTouchAfterRelease = Effect.runSync(Deferred.make<void>())

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        const touchFiber = yield* OrbActivity.touch(orbId).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(touchReadRunning)
        yield* OrbStore.setStatus(orbId, "killed")
        yield* OrbActivity.release(orbId)
        yield* Deferred.succeed(allowTouchAfterRelease, undefined)
        const touchResult = yield* Fiber.join(touchFiber)
        const stored = yield* OrbStore.get(orbId)
        return { stored, touchResult }
      }).pipe(
        Effect.provide(
          makeLayer(sandbox, SandboxClientFake.layer(sandbox), {
            wrapOrbStore: staleFirstGetOrbStore(touchReadRunning, allowTouchAfterRelease),
          }),
        ),
      ),
    )

    expect(result.touchResult._tag).toBe("Success")
    expect(result.stored).toMatchObject({ status: "killed" })
    expect(sandbox.calls.setTimeout).toEqual([])
  })

  test("fails when a cached orb is no longer running", async () => {
    const sandbox = SandboxClientFake.makeState()

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createPausedOrb()
        return yield* OrbActivity.touch(orbId).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(sandbox))),
    )

    expect(error).toBeInstanceOf(OrbActivity.OrbActivityError)
    expect(error.message).toContain("paused")
  })
})

const createRunningOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_orb_activity")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb-activity.rika.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const createPausedOrb = () =>
  Effect.gen(function* () {
    yield* createRunningOrb()
    yield* OrbStore.setStatus(orbId, "paused")
  })

const makeLayer = (
  sandbox: SandboxClientFake.State,
  sandboxLayer = SandboxClientFake.layer(sandbox),
  options: {
    readonly env?: Record<string, string | undefined>
    readonly workspaceRoot?: string
    readonly wrapOrbStore?: (base: OrbStore.Interface) => Effect.Effect<OrbStore.Interface>
  } = {},
) => {
  const root = options.workspaceRoot ?? "/workspace/rika-orb-activity"
  const env = options.env ?? { RIKA_ORB_IDLE_TIMEOUT: "420" }
  const configLayer = Config.layerFromValues(
    {
      workspace_root: root,
      data_dir: "/workspace/rika-orb-activity/.rika",
      default_mode: "smart",
    },
    env,
  )
  const settingsLayer = Settings.layerFromEnv(env, root)
  const databaseLayer = Database.memoryLayer
  const timeLayer = timeSequenceLayer([
    createdAt,
    createdAt,
    firstTouchAt,
    firstTouchAt,
    secondTouchAt,
    secondTouchAt,
    thirdTouchAt,
    thirdTouchAt,
  ])
  const idLayer = IdGenerator.sequenceLayer(1)
  const baseOrbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const wrapOrbStore = options.wrapOrbStore
  const orbStoreLayer =
    wrapOrbStore === undefined
      ? baseOrbStoreLayer
      : Layer.effect(
          OrbStore.Service,
          Effect.gen(function* () {
            const base = yield* OrbStore.Service
            return OrbStore.Service.of(yield* wrapOrbStore(base))
          }),
        ).pipe(Layer.provide(baseOrbStoreLayer))
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(timeLayer),
  )
  return Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    idLayer,
    orbStoreLayer,
    sandboxLayer,
    settingsLayer,
    activityLayer,
  )
}

const staleFirstGetOrbStore =
  (touchReadRunning: Deferred.Deferred<void>, allowTouchAfterRelease: Deferred.Deferred<void>) =>
  (base: OrbStore.Interface): Effect.Effect<OrbStore.Interface> =>
    Effect.gen(function* () {
      const delayed = yield* Ref.make(false)
      return {
        ...base,
        get: (requestedOrbId) =>
          Effect.gen(function* () {
            const shouldDelay = yield* Ref.modify(
              delayed,
              (seen) => [!seen && requestedOrbId === orbId, seen || requestedOrbId === orbId] as const,
            )
            const record = yield* base.get(requestedOrbId)
            if (shouldDelay && record?.status === "running") {
              yield* Deferred.succeed(touchReadRunning, undefined)
              yield* Deferred.await(allowTouchAfterRelease)
            }
            return record
          }),
      }
    })

const delayedSetTimeoutLayer = (
  state: SandboxClientFake.State,
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Layer.succeed(
    SandboxClient.Service,
    SandboxClient.Service.of({
      create: () => Effect.never,
      exec: () => Stream.never,
      writeFile: () => Effect.never,
      readFile: () => Effect.never,
      hostUrl: () => Effect.never,
      pause: () => Effect.never,
      resume: () => Effect.never,
      kill: () => Effect.never,
      setTimeout: (sandboxId, timeoutMs) =>
        Effect.gen(function* () {
          state.calls.setTimeout.push({ sandboxId, timeoutMs })
          if (state.calls.setTimeout.length === 1) yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      list: () => Effect.never,
      templateExists: () => Effect.never,
    }),
  )

const timeSequenceLayer = (times: ReadonlyArray<Common.TimestampMillis>) => {
  let index = 0
  return Layer.succeed(
    Time.Service,
    Time.Service.of({
      nowMillis: Effect.sync(() => {
        const value = times[Math.min(index, times.length - 1)] ?? createdAt
        index += 1
        return value
      }),
    }),
  )
}
