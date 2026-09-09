/* oxlint-disable max-lines -- this file keeps the checkout and process acceptance probes together. */

/* oxlint-disable effecttsgo/strict-effect-provide -- the checkout fixture builds a short-lived contextual grep service. */

import * as BunServices from "@effect/platform-bun/BunServices"
import * as NativeResult from "@rika/product/native-tool-result"
import { Effect, FileSystem, Layer } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { RunnerGrep, layer as grepLayer } from "../src/grep"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("grep traverses a real checkout deterministically and bounds oversized output", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-grep-" })
      yield* fileSystem.makeDirectory(`${checkout}/nested`)
      yield* fileSystem.writeFileString(`${checkout}/nested/z.txt`, "needle z\n")
      yield* fileSystem.writeFileString(`${checkout}/a.txt`, "needle a\nother\n")
      yield* fileSystem.writeFileString(`${checkout}/ignored.txt`, "needle ignored\n")
      const runnerGrep = yield* RunnerGrep.pipe(Effect.provide(grepLayer(checkout)))
      const ordered = yield* runnerGrep.run({ pattern: "needle", glob: "*.txt" })
      expect(ordered).toEqual({
        text: "a.txt:1:needle a\nignored.txt:1:needle ignored\nnested/z.txt:1:needle z",
        truncated: false,
      })

      const large = "needle\n".repeat(20_000)
      yield* fileSystem.writeFileString(`${checkout}/large.txt`, large)
      const bounded = yield* runnerGrep.run({ pattern: "needle", path: "large.txt", max_results: 1_000 })
      expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(NativeResult.maxOutputBytes)
      expect(bounded.truncated).toBe(true)
    }),
  ),
)
