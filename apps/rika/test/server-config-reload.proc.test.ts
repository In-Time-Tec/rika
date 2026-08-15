import { afterEach, describe, expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import { makeRoot, run, waitUntil } from "./server-transport-runtime"
import { cleanRoot, readText } from "./server-transport-files"
import { alive, attachedEffect, start } from "./server-transport-process"
import { killTrackedHosts } from "./server-process-exit"

afterEach(() => killTrackedHosts())

const hostAcquisitions = (root: string) =>
  Effect.map(readText(`${root}/owner-acquisitions.log`), (text) => text.split("\n").filter((line) => line.length > 0))

const writeSettings = (filename: string, content: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.writeFileString(filename, content)
  })

const watchEnvironment = (settings: string) => ({
  environment: {
    RIKA_TEST_SERVER_CONFIG_WATCH: settings,
    RIKA_TEST_SERVER_CONFIG_RELOAD_DEBOUNCE: "50",
  },
})

describe("server config change restart", () => {
  test(
    "drains the host when the settings file changes and a fresh host serves the next client",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const path = yield* Path.Path
            const settings = path.join(root, "global-settings.json")
            yield* writeSettings(settings, '{"logging":{"level":"info"}}')
            const first = yield* start(root, 350, 0, false, 1_024, 0, false, undefined, 0, watchEnvironment(settings))
            const firstEvent = yield* attachedEffect(first)
            const firstHost = firstEvent.hostPid!
            expect(yield* hostAcquisitions(root)).toEqual([String(firstHost)])

            yield* writeSettings(settings, '{"logging":{"level":"debug"}}')

            yield* waitUntil(Effect.sync(() => !alive(firstHost)), 10_000)

            const second = yield* start(root, 350, 0, false, 1_024, 0, false, undefined, 0, watchEnvironment(settings))
            const secondEvent = yield* attachedEffect(second)
            const replacementHost = secondEvent.hostPid!
            expect(replacementHost).not.toBe(firstHost)
            expect(alive(replacementHost)).toBe(true)
            expect(yield* hostAcquisitions(root)).toEqual([String(firstHost), String(replacementHost)])
            yield* second.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    20_000,
  )

  test(
    "keeps the host alive when the edited settings file is invalid",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const path = yield* Path.Path
            const settings = path.join(root, "global-settings.json")
            yield* writeSettings(settings, '{"logging":{"level":"info"}}')
            const client = yield* start(root, 350, 0, false, 1_024, 0, false, undefined, 0, watchEnvironment(settings))
            const event = yield* attachedEffect(client)
            const host = event.hostPid!

            yield* writeSettings(settings, "{ not valid json")
            yield* Effect.sleep("1 second")
            expect(alive(host)).toBe(true)
            expect(yield* hostAcquisitions(root)).toEqual([String(host)])

            yield* writeSettings(settings, '{"logging":{"level":"error"}}')
            yield* waitUntil(Effect.sync(() => !alive(host)), 10_000)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    20_000,
  )
})
