import { Effect, FileSystem, Path } from "effect"

const digestOf = (parts: ReadonlyArray<string>) => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) hasher.update(part)
  return hasher.digest("hex")
}

// A directory digest covers every file path and every byte of content, so any rebuilt dist,
// added file, or removed file changes the digest. Timestamps and modes are deliberately excluded
// because `bun pm pack` normalizes them, which keeps a re-pack of unchanged sources identical.
export const directoryDigest = Effect.fn("Upstream.directoryDigest")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fileSystem.readDirectory(directory, { recursive: true })
  const files: Array<string> = []
  for (const entry of entries.toSorted()) {
    const info = yield* fileSystem.stat(path.join(directory, entry))
    if (info.type === "File") files.push(entry.replaceAll("\\", "/"))
  }
  const parts: Array<string> = []
  for (const file of files.toSorted()) {
    const bytes = yield* fileSystem.readFile(path.join(directory, file))
    parts.push(file, "\0", new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), "\n")
  }
  return digestOf(parts)
})

export const fileDigest = Effect.fn("Upstream.fileDigest")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return new Bun.CryptoHasher("sha256").update(yield* fileSystem.readFile(file)).digest("hex")
})
