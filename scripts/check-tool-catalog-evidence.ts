import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer } from "effect"
import * as Catalog from "../packages/tools/src/tool-catalog"

const evidence = {
  find_files: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  grep: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  create_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  edit_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  apply_patch: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  shell: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  shell_command_status: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  git_status: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  web_search: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_web_page: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  view_media: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  find_thread: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_thread: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  oracle: "packages/app/test/specialty-transcripts.test.ts",
  librarian: "packages/app/test/specialty-transcripts.test.ts",
  painter: "packages/app/test/specialty-transcripts.test.ts",
  task: "packages/app/test/specialty-transcripts.test.ts",
} as const

class CatalogEvidenceError extends Data.TaggedError("CatalogEvidenceError")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const catalogNames = Catalog.definitions.map(({ name }) => name).toSorted()
  const evidenceNames = Object.keys(evidence).toSorted()
  const missing = catalogNames.filter((name) => !evidenceNames.includes(name))
  const unknown = evidenceNames.filter((name) => !catalogNames.includes(name))
  if (missing.length > 0 || unknown.length > 0) {
    return yield* new CatalogEvidenceError({
      message: `Catalog evidence mismatch: missing=${missing.join(",")} unknown=${unknown.join(",")}`,
    })
  }
  const matrices = [...new Set(Object.values(evidence))]
  const missingFiles = yield* Effect.filter(matrices, (file) =>
    fileSystem.exists(file).pipe(Effect.map((exists) => !exists)),
  )
  if (missingFiles.length > 0)
    return yield* new CatalogEvidenceError({ message: `Missing catalog evidence files: ${missingFiles.join(",")}` })
  yield* Effect.log(`Catalog evidence complete: ${catalogNames.length} entries across ${matrices.length} matrices`)
})

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
