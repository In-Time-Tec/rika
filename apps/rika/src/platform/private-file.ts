import { Effect, FileSystem } from "effect"

let writeSequence = 0

/**
 * Atomically replaces a user-private file: the parent directory is created 0700, the content is written to a
 * fresh 0600 temporary next to the target, then renamed over it. Readers never observe a partial file.
 */
export const writePrivateFile = Effect.fn("Platform.writePrivateFile")(function* (
  fileSystem: FileSystem.FileSystem,
  target: string,
  content: string,
) {
  const separator = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
  const parent = separator <= 0 ? "." : target.slice(0, separator)
  writeSequence += 1
  const temporary = `${target}.tmp-${process.pid}-${writeSequence}`
  yield* fileSystem
    .makeDirectory(parent, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(temporary, content, { flag: "wx", mode: 0o600 })),
      Effect.andThen(fileSystem.chmod(temporary, 0o600)),
      Effect.andThen(fileSystem.rename(temporary, target)),
      Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
    )
})
