import { Effect, FileSystem, Path } from "effect"

export const canonicalDataRoot = Effect.fn("Config.canonicalDataRoot")(function* (
  productDatabase: string,
  executionDatabase: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const productRoot = path.dirname(path.resolve(productDatabase))
  const executionRoot = path.dirname(path.resolve(executionDatabase))
  yield* Effect.all(
    [fs.makeDirectory(productRoot, { recursive: true }), fs.makeDirectory(executionRoot, { recursive: true })],
    { concurrency: 2 },
  )
  const [canonicalProductRoot, canonicalExecutionRoot] = yield* Effect.all(
    [fs.realPath(productRoot), fs.realPath(executionRoot)],
    { concurrency: 2 },
  )
  if (canonicalProductRoot !== canonicalExecutionRoot)
    return yield* Effect.die("RIKA_DATABASE and RIKA_EXECUTION_DATABASE must use one data directory")
  return canonicalProductRoot
})
