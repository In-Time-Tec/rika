/* oxlint-disable effecttsgo/strict-effect-provide -- this build script is an application composition boundary. */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import solidPlugin from "@opentui/solid/bun-plugin"
import { Console, Data, Effect, FileSystem } from "effect"

class BuildFailure extends Data.TaggedError("BuildFailure")<{ readonly message: string }> {}

const build = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const outputDirectory = `${import.meta.dir}/../dist`
  yield* fileSystem.remove(outputDirectory, { recursive: true, force: true })
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [`${import.meta.dir}/client-main.ts`],
        outdir: outputDirectory,
        target: "bun",
        format: "esm",
        splitting: true,
        plugins: [solidPlugin],
        loader: { ".txt": "text" },
        external: [
          "@opentui/core-darwin-arm64",
          "@opentui/core-darwin-x64",
          "@opentui/core-linux-arm64",
          "@opentui/core-linux-arm64-musl",
          "@opentui/core-linux-x64",
          "@opentui/core-linux-x64-musl",
          "@opentui/core-win32-arm64",
          "@opentui/core-win32-x64",
        ],
      }),
    catch: (cause) => new BuildFailure({ message: String(cause) }),
  })
  if (!result.success) return yield* new BuildFailure({ message: result.logs.map(String).join("\n") })
  yield* Console.log(`Built ${result.outputs.length} CLI modules`)
})

BunRuntime.runMain(build.pipe(Effect.provide(BunFileSystem.layer)))
