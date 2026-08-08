import { Effect, FileSystem, Path } from "effect"

export const canonicalDataRoot = Effect.fn("Config.canonicalDataRoot")(function* (productDatabase: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const productRoot = path.dirname(path.resolve(productDatabase))
  yield* fs.makeDirectory(productRoot, { recursive: true })
  return yield* fs.realPath(productRoot)
})
