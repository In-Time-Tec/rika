import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Path, Ref, type Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { configFileChanged, stateOf, watchConfigFileForRestart } from "../src/server/process/server-config-reload"

const debounceMilliseconds = 50

const provideLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const withDirectory = (
  run: (directory: string) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
    const directory = yield* fileSystem.makeTempDirectory({ directory: temporaryDirectory, prefix: "rika-config-" })
    try {
      yield* run(directory)
    } finally {
      yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)
    }
  })

const startWatcher = (filename: string) =>
  Effect.gen(function* () {
    const restarts = yield* Ref.make(0)
    yield* Effect.forkScoped(
      watchConfigFileForRestart({
        filename,
        debounceMilliseconds,
        onRestart: Ref.update(restarts, (count) => count + 1),
      }),
    )
    return restarts
  })

const restartCount = (restarts: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    while ((yield* Ref.get(restarts)) === 0) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (now - started > 5_000) return yield* Effect.die("watcher did not restart within ceiling")
      yield* Effect.sleep("20 millis")
    }
    return yield* Ref.get(restarts)
  })

const settle = () => Effect.sleep("200 millis")

describe("config file change detection", () => {
  it("compares content hashes across missing and present states", () => {
    expect(configFileChanged({ _tag: "missing" }, { _tag: "missing" })).toBe(false)
    expect(configFileChanged({ _tag: "missing" }, stateOf("{}"))).toBe(true)
    expect(configFileChanged(stateOf("{}"), { _tag: "missing" })).toBe(true)
    expect(configFileChanged(stateOf("{}"), stateOf("{}"))).toBe(false)
    expect(configFileChanged(stateOf("{}"), stateOf("{ }"))).toBe(true)
  })
})

describe("config file reload watcher", () => {
  it.live("restarts once when settings content changes and stays quiet for identical content", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = path.join(directory, "settings.json")
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"info"}}')
        const restarts = yield* startWatcher(filename)
        yield* settle()
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"debug"}}')
        expect(yield* restartCount(restarts)).toBe(1)
        yield* settle()
        expect(yield* Ref.get(restarts)).toBe(1)
      }),
    ).pipe(provideLayer),
  )

  it.live("does not restart when only a no-op write lands", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = path.join(directory, "settings.json")
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"info"}}')
        const restarts = yield* startWatcher(filename)
        yield* settle()
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"info"}}')
        yield* settle()
        expect(yield* Ref.get(restarts)).toBe(0)
      }),
    ).pipe(provideLayer),
  )

  it.live("does not restart on invalid content and restarts once the file becomes valid", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = path.join(directory, "settings.json")
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"info"}}')
        const restarts = yield* startWatcher(filename)
        yield* settle()
        yield* fileSystem.writeFileString(filename, "{ not valid json")
        yield* settle()
        expect(yield* Ref.get(restarts)).toBe(0)
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"error"}}')
        expect(yield* restartCount(restarts)).toBe(1)
      }),
    ).pipe(provideLayer),
  )

  it.live("restarts when a missing settings file is created", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = path.join(directory, "settings.json")
        const restarts = yield* startWatcher(filename)
        yield* settle()
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"debug"}}')
        expect(yield* restartCount(restarts)).toBe(1)
      }),
    ).pipe(provideLayer),
  )

  it.live("restarts once across a burst of rapid writes", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = path.join(directory, "settings.json")
        yield* fileSystem.writeFileString(filename, '{"logging":{"level":"info"}}')
        const restarts = yield* startWatcher(filename)
        yield* settle()
        for (const level of ["debug", "warning", "error", "debug"]) {
          yield* fileSystem.writeFileString(filename, `{"logging":{"level":"${level}"}}`)
          yield* Effect.sleep("10 millis")
        }
        expect(yield* restartCount(restarts)).toBe(1)
      }),
    ).pipe(provideLayer),
  )
})
