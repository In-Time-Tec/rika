import { Effect, FileSystem, Option } from "effect"
import { MaximumArchiveBytes, MaximumArchiveUncompressedBytes } from "../contract"
import { RepositoryInputError, type RepositoryInputMetadata } from "../repository-model"

const headReference = "refs/heads/rika-input"
const packPattern = /^pack-([a-f0-9]{40})\.(idx|pack|rev)$/

const failure = (kind: RepositoryInputError["kind"], message: string) => RepositoryInputError.make({ kind, message })

const names = (directory: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.map((values) => values.toSorted()),
      Effect.mapError(() => failure("archive", "Repository input shape is invalid")),
    ),
  )

const expectedNames = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  actual.length === expected.length && actual.every((name, index) => name === expected[index])

const requireType = Effect.fn("RepositoryInput.requireType")(function* (path: string, expected: "Directory" | "File") {
  const fileSystem = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fileSystem.readLink(path).pipe(Effect.option)))
    return yield* failure("archive", "Repository input links are not allowed")
  const info = yield* fileSystem
    .stat(path)
    .pipe(Effect.mapError(() => failure("archive", "Repository input shape is invalid")))
  if (info.type !== expected) return yield* failure("archive", "Repository input shape is invalid")
  return info
})

const inspectPackDirectory = Effect.fn("RepositoryInput.inspectPackDirectory")(function* (directory: string) {
  const files = yield* names(directory)
  if (files.length < 2 || files.length > 3) return yield* failure("archive", "Repository object pack is invalid")
  let packHash: string | undefined
  const extensions = new Set<string>()
  let totalBytes = 0
  for (const name of files) {
    const match = packPattern.exec(name)
    if (match === null) return yield* failure("archive", "Repository object pack is invalid")
    if (packHash !== undefined && packHash !== match[1])
      return yield* failure("archive", "Repository object pack is invalid")
    packHash = match[1]
    extensions.add(match[2]!)
    const info = yield* requireType(`${directory}/${name}`, "File")
    const size = Number(info.size)
    if (!Number.isSafeInteger(size) || size <= 0 || size > MaximumArchiveBytes)
      return yield* failure("size", "Repository object pack exceeds the allowed size")
    if (size > MaximumArchiveUncompressedBytes - totalBytes)
      return yield* failure("size", "Repository input exceeds the allowed size")
    totalBytes += size
  }
  if (!extensions.has("pack") || !extensions.has("idx"))
    return yield* failure("archive", "Repository object pack is incomplete")
  return files
})

const exactFile = Effect.fn("RepositoryInput.exactFile")(function* (path: string, expected: string) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* requireType(path, "File")
  const value = yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError(() => failure("archive", "Repository input metadata is invalid")))
  if (value !== expected) return yield* failure("archive", "Repository input metadata is invalid")
})

export const inspectRepositorySnapshot = Effect.fn("RepositoryInput.inspectSnapshot")(function* (
  directory: string,
  metadata: RepositoryInputMetadata,
) {
  if (!expectedNames(yield* names(directory), ["HEAD", "objects", "refs", "shallow"]))
    return yield* failure("archive", "Repository input contains unsupported Git metadata")
  yield* requireType(`${directory}/objects`, "Directory")
  yield* requireType(`${directory}/refs`, "Directory")
  if (!expectedNames(yield* names(`${directory}/objects`), ["pack"]))
    return yield* failure("archive", "Repository input contains unsupported object metadata")
  if (!expectedNames(yield* names(`${directory}/refs`), ["heads"]))
    return yield* failure("archive", "Repository input contains unsupported ref metadata")
  yield* requireType(`${directory}/objects/pack`, "Directory")
  yield* requireType(`${directory}/refs/heads`, "Directory")
  if (!expectedNames(yield* names(`${directory}/refs/heads`), ["rika-input"]))
    return yield* failure("archive", "Repository input ref is invalid")
  yield* inspectPackDirectory(`${directory}/objects/pack`)
  yield* exactFile(`${directory}/HEAD`, `ref: ${headReference}\n`)
  yield* exactFile(`${directory}/refs/heads/rika-input`, `${metadata.commitSha}\n`)
  yield* exactFile(`${directory}/shallow`, `${metadata.commitSha}\n`)
})

export const inspectRepositoryArchive = Effect.fn("RepositoryInput.inspectArchive")(function* (
  directory: string,
  metadata: RepositoryInputMetadata,
) {
  if (!expectedNames(yield* names(directory), ["repository"]))
    return yield* failure("archive", "Repository input contains unsupported content")
  yield* inspectRepositorySnapshot(`${directory}/repository`, metadata)
})

export const writeRepositorySnapshot = Effect.fn("RepositoryInput.writeSnapshot")(function* (
  source: string,
  target: string,
  metadata: RepositoryInputMetadata,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const packFiles = yield* inspectPackDirectory(`${source}/objects/pack`)
  yield* fileSystem
    .makeDirectory(`${target}/objects/pack`, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => failure("archive", "Repository input could not be staged")))
  yield* fileSystem
    .makeDirectory(`${target}/refs/heads`, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => failure("archive", "Repository input could not be staged")))
  for (const name of packFiles)
    yield* fileSystem
      .copyFile(`${source}/objects/pack/${name}`, `${target}/objects/pack/${name}`)
      .pipe(Effect.mapError(() => failure("archive", "Repository objects could not be staged")))
  yield* fileSystem
    .writeFileString(`${target}/HEAD`, `ref: ${headReference}\n`, { mode: 0o600 })
    .pipe(Effect.mapError(() => failure("archive", "Repository input metadata could not be staged")))
  yield* fileSystem
    .writeFileString(`${target}/refs/heads/rika-input`, `${metadata.commitSha}\n`, { mode: 0o600 })
    .pipe(Effect.mapError(() => failure("archive", "Repository input metadata could not be staged")))
  yield* fileSystem
    .writeFileString(`${target}/shallow`, `${metadata.commitSha}\n`, { mode: 0o600 })
    .pipe(Effect.mapError(() => failure("archive", "Repository input metadata could not be staged")))
  yield* inspectRepositorySnapshot(target, metadata)
})
