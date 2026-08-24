import * as BunServices from "@effect/platform-bun/BunServices"
import { it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Option, Path } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import {
  containsCompleteFrame,
  measureStartup,
  percentile,
  processTreeRss,
  runWithCleanup,
  scriptArguments,
  StartupTimeoutError,
} from "../../../scripts/benchmark/packaged-startup"

const fixture = fileURLToPath(new URL("fixtures/complete-frame.sh", import.meta.url))
const packagedBinary = Effect.runSync(Config.option(Config.string("RIKA_PACKAGED_BINARY"))).pipe(Option.getOrUndefined)
const rejectForeignTask = (error: Error) => () => Effect.runPromise(Effect.fail(error))
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Layer.buildWithScope(BunServices.layer, scope)
      return yield* Effect.provide(effect, context)
    }),
  )

test("requires an ordered synchronized-output begin and end pair", () => {
  expect(containsCompleteFrame("\u001b[?2026lnoise")).toBe(false)
  expect(containsCompleteFrame("\u001b[?2026h\u001b[?2026l")).toBe(false)
  expect(containsCompleteFrame("\u001b[?2026h\u001b[?2026l\u001b[?2026hpayload\u001b[?2026l")).toBe(true)
  expect(containsCompleteFrame("\u001b[?2026lnoise\u001b[?2026hpayload\u001b[?2026l")).toBe(true)
})

test("builds Linux and macOS script argv without interpolating the BSD executable", () => {
  const executable = "/tmp/a binary's name"
  expect(scriptArguments(executable, [], "darwin")).toEqual(["script", "-q", "/dev/null", executable])
  expect(scriptArguments(executable, [], "linux")).toEqual([
    "script",
    "-qfec",
    `exec '/tmp/a binary'"'"'s name'`,
    "/dev/null",
  ])
  expect(() => scriptArguments(executable, [], "win32")).toThrow("PTY probes are unsupported on win32")
})

it.effect("preserves a primary diagnostic and attaches cleanup failure as its cause", () =>
  Effect.gen(function* () {
    const primary = new StartupTimeoutError("primary timeout")
    const cleanup = new Error("cleanup failed")
    yield* Effect.tryPromise(() =>
      expect(runWithCleanup(rejectForeignTask(primary), rejectForeignTask(cleanup))).rejects.toBe(primary),
    )
    expect(primary.cause).toBe(cleanup)
  }),
)

test("keeps nearest-rank percentile math for 30 and 50 percent", () => {
  expect(percentile([50, 10, 40, 20, 30], 0.3)).toBe(20)
  expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30)
})

test("rejects invalid percentile inputs", () => {
  expect(() => percentile([], 0.5)).toThrow("must not be empty")
  expect(() => percentile([1, Number.NaN], 0.5)).toThrow("must be finite")
  expect(() => percentile([1], Number.POSITIVE_INFINITY)).toThrow("ratio must be finite")
  expect(() => percentile([1], -0.01)).toThrow("between 0 and 1")
  expect(() => percentile([1], 1.01)).toThrow("between 0 and 1")
})

test("sums every resident process below the packaged executable wrapper", () => {
  expect(
    processTreeRss(10, [
      { pid: 11, parent: 10, rssKilobytes: 100 },
      { pid: 12, parent: 11, rssKilobytes: 20 },
      { pid: 13, parent: 10, rssKilobytes: 30 },
      { pid: 99, parent: 1, rssKilobytes: 900 },
    ]),
  ).toBe(150)
})

it.effect("records complete frames from an executable path containing spaces", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika startup " })
      const spacedFixture = path.join(directory, "complete frame.sh")
      yield* fileSystem.copyFile(fixture, spacedFixture)
      yield* fileSystem.chmod(spacedFixture, 0o755)
      const measurement = yield* Effect.tryPromise(() => measureStartup(spacedFixture, 3))
      const values = measurement.samples.map(({ milliseconds }) => milliseconds).toSorted((left, right) => left - right)
      expect(measurement.samples.map(({ sample }) => sample)).toEqual([1, 2, 3])
      expect(measurement.summary).toEqual({ min: values[0], p50: values[1], p95: values[2], max: values[2] })
      expect(measurement.samples.every(({ rssKilobytes }) => rssKilobytes > 0)).toBe(true)
      expect(measurement.rssKilobytes.p50).toBeGreaterThan(0)
    }),
  ),
)

it.effect("reports timeout distinctly and completes cleanup before returning", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.chmod(fixture, 0o755)
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-startup-cleanup-" })
      const lock = path.join(directory, "lock")
      const result = path.join(directory, "result")
      const environment = {
        RIKA_BENCHMARK_FIXTURE_MODE: "timeout",
        RIKA_BENCHMARK_FIXTURE_LOCK: lock,
        RIKA_BENCHMARK_FIXTURE_RESULT: result,
      }
      yield* Effect.tryPromise(() =>
        expect(measureStartup(fixture, 1, 50, environment)).rejects.toBeInstanceOf(StartupTimeoutError),
      )
      yield* Effect.tryPromise(() =>
        expect(measureStartup(fixture, 1, 50, environment)).rejects.toBeInstanceOf(StartupTimeoutError),
      )
      expect(yield* fileSystem.exists(result)).toBe(false)
    }),
  ),
)

it.effect("kills a SIGTERM-ignoring descendant before starting the next sample", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.chmod(fixture, 0o755)
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-startup-descendant-" })
      const lock = path.join(directory, "lock")
      const result = path.join(directory, "result")
      const zombieAwareFixture = path.join(directory, "complete-frame.sh")
      const fixtureSource = yield* fileSystem.readFileString(fixture)
      yield* fileSystem.writeFileString(
        zombieAwareFixture,
        fixtureSource.replace(
          'if kill -0 "$previous_pid" 2>/dev/null; then',
          'if kill -0 "$previous_pid" 2>/dev/null && test "$(ps -o ppid= -p "$previous_pid" | tr -d " ")" != "1"; then',
        ),
      )
      yield* fileSystem.chmod(zombieAwareFixture, 0o755)
      yield* Effect.tryPromise(() =>
        measureStartup(zombieAwareFixture, 2, 5_000, {
          RIKA_BENCHMARK_FIXTURE_MODE: "stubborn-descendant",
          RIKA_BENCHMARK_FIXTURE_LOCK: lock,
          RIKA_BENCHMARK_FIXTURE_RESULT: result,
        }),
      )
      expect(yield* fileSystem.readFileString(result)).toBe("started\nstarted\n")
    }),
  ),
)

describe.skipIf(packagedBinary === undefined)("explicit packaged artifact", () => {
  it.effect("starts a real extracted binary", () =>
    Effect.gen(function* () {
      const measurement = yield* Effect.tryPromise(() => measureStartup(packagedBinary!, 1))
      expect(measurement.samples).toHaveLength(1)
    }),
  )
})
