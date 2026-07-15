import { Data, Effect, FileSystem, Layer } from "effect"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"

const required = [
  "AGENTS.md",
  "CONTEXT.md",
  "PLAN.md",
  "PRODUCT.md",
  "README.md",
  "SPEC.md",
  "TODO.md",
  "docs/features/FEATURES.md",
  "docs/reference/V1_BASELINE.md",
  "docs/reference/PHASE_1_API_PROOF.md",
  "docs/spec/13-cli.md",
] as const

class DocumentationCheckError extends Data.TaggedError("DocumentationCheckError")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const missing = yield* Effect.filter(required, (path) =>
    fileSystem.exists(path).pipe(Effect.map((exists) => !exists)),
  )
  if (missing.length > 0)
    return yield* new DocumentationCheckError({ message: `Missing documentation: ${missing.join(", ")}` })
})

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
