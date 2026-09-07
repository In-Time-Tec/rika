import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import solidPlugin from "@opentui/solid/bun-plugin"
import { Console, Data, Effect } from "effect"

class BuildFailure extends Data.TaggedError("BuildFailure")<{ readonly message: string }> {}

const build = Effect.gen(function* () {
  const output = `${import.meta.dir}/dist/rika-tui-v2`
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [`${import.meta.dir}/src/main.tsx`],
        target: "bun",
        plugins: [solidPlugin],
        compile: { outfile: output },
        minify: true,
        bytecode: false,
      }),
    catch: (cause) => new BuildFailure({ message: String(cause) }),
  })
  if (!result.success) return yield* new BuildFailure({ message: result.logs.map(String).join("\n") })
  yield* Console.log(`Built ${output}`)
})

BunRuntime.runMain(build)
