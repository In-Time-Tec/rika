import { Clock, Effect, FileSystem, Function } from "effect"

const schemaChecksumMismatch = "tenetkit/runtime/SchemaChecksumMismatch"

export const isSchemaChecksumMismatch = (cause: unknown): boolean => {
  if (typeof cause === "string") return cause.includes(schemaChecksumMismatch)
  if (typeof cause !== "object" || cause === null) return false
  if (Reflect.get(cause, "_tag") === schemaChecksumMismatch) return true
  const message = Reflect.get(cause, "message")
  return typeof message === "string" && message.includes(schemaChecksumMismatch)
}

const archivedRuntimeNameImpl = (filename: string, at: number): string => `${filename}.incompatible-${at}`

export const archivedRuntimeName: {
  (filename: string, at: number): string
  (at: number): (filename: string) => string
} = Function.dual(2, archivedRuntimeNameImpl)

export const archiveIncompatibleRuntime = (filename: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const archived = archivedRuntimeNameImpl(filename, yield* Clock.currentTimeMillis)
    yield* Effect.forEach(["", "-shm", "-wal"], (suffix) =>
      fileSystem.rename(`${filename}${suffix}`, `${archived}${suffix}`).pipe(Effect.ignore),
    )
    return archived
  })
