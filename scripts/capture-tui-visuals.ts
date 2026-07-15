import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path } from "effect"
import { captureVisuals } from "../packages/tui/test/visual.capture"

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const approve = Bun.argv.includes("--approve")
  const candidate = yield* approve
    ? fileSystem.makeTempDirectoryScoped({ prefix: "rika-visual-candidate-" })
    : fileSystem.makeTempDirectory({ prefix: "rika-visual-candidate-" })
  yield* Effect.promise(() => captureVisuals(candidate))
  if (approve) {
    const approved = path.join(import.meta.dir, "../packages/tui/test/fixtures/visual")
    yield* fileSystem.remove(approved, { recursive: true, force: true })
    yield* fileSystem.copy(candidate, approved)
    yield* Effect.log(`Approved visual baseline: ${approved}`)
  } else {
    yield* Effect.log(`Captured visual candidate: ${candidate}`)
    yield* Effect.log("Review it, then run with --approve to replace the frozen baseline.")
  }
})

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
