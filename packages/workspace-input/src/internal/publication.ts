import { Effect, FileSystem, Option } from "effect"
import { WorkspaceArchiveError } from "../contract"

const failure = (message: string) => WorkspaceArchiveError.make({ kind: "archive", message })

export const inspectLinks = Effect.fn("WorkspaceInput.inspectLinks")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem
    .realPath(directory)
    .pipe(Effect.mapError(() => failure("Workspace filesystem operation failed")))
  const prefix = root.endsWith("/") ? root : `${root}/`
  const visited = new Set([root])
  const walk: (current: string) => Effect.Effect<void, WorkspaceArchiveError> = Effect.fn(
    "WorkspaceInput.inspectLinks.walk",
  )(function* (current: string) {
    const names = yield* fileSystem
      .readDirectory(current)
      .pipe(Effect.mapError(() => failure("Workspace archive contains an invalid directory")))
    for (const name of names) {
      const path = `${current}/${name}`
      const resolved = yield* fileSystem
        .realPath(path)
        .pipe(Effect.mapError(() => failure("Workspace archive contains an invalid link")))
      if (resolved !== root && !resolved.startsWith(prefix))
        return yield* failure("Workspace archive link escapes the Workspace")
      const info = yield* fileSystem
        .stat(path)
        .pipe(Effect.mapError(() => failure("Workspace archive contains an invalid entry")))
      if (info.type !== "Directory" || visited.has(resolved)) continue
      visited.add(resolved)
      yield* walk(path)
    }
  })
  yield* walk(directory)
})

export const replaceWorkspace = Effect.fn("WorkspaceInput.replaceWorkspace")(function* (
  workspace: string,
  staged: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem
    .makeDirectory(workspace, { recursive: true })
    .pipe(Effect.mapError(() => failure("Workspace could not be prepared for restoration")))
  const current = yield* fileSystem
    .readDirectory(workspace)
    .pipe(Effect.mapError(() => failure("Workspace could not be prepared for restoration")))
  for (const name of current) {
    if (name === ".git") continue
    yield* fileSystem
      .remove(`${workspace}/${name}`, { recursive: true, force: true })
      .pipe(Effect.mapError(() => failure("Workspace could not be prepared for restoration")))
  }
  const copy: (source: string, target: string) => Effect.Effect<void, WorkspaceArchiveError> = Effect.fn(
    "WorkspaceInput.replaceWorkspace.copy",
  )(function* (source: string, target: string) {
    const link = yield* fileSystem.readLink(source).pipe(Effect.option)
    if (Option.isSome(link)) {
      yield* fileSystem
        .symlink(link.value, target)
        .pipe(Effect.mapError(() => failure("Workspace archive link could not be restored")))
      return
    }
    const info = yield* fileSystem
      .stat(source)
      .pipe(Effect.mapError(() => failure("Workspace archive entry could not be restored")))
    if (info.type === "File") {
      yield* fileSystem
        .copyFile(source, target)
        .pipe(Effect.mapError(() => failure("Workspace archive file could not be restored")))
      yield* fileSystem
        .chmod(target, info.mode & 0o777)
        .pipe(Effect.mapError(() => failure("Workspace archive permissions could not be restored")))
      return
    }
    if (info.type !== "Directory") return yield* failure("Workspace archive contains an unsupported entry")
    yield* fileSystem
      .makeDirectory(target)
      .pipe(Effect.mapError(() => failure("Workspace archive directory could not be restored")))
    const names = yield* fileSystem
      .readDirectory(source)
      .pipe(Effect.mapError(() => failure("Workspace archive directory could not be restored")))
    for (const name of names) yield* copy(`${source}/${name}`, `${target}/${name}`)
    yield* fileSystem
      .chmod(target, info.mode & 0o777)
      .pipe(Effect.mapError(() => failure("Workspace archive permissions could not be restored")))
  })
  const incoming = yield* fileSystem
    .readDirectory(staged)
    .pipe(Effect.mapError(() => failure("Workspace archive staging directory could not be read")))
  for (const name of incoming) {
    if (name === ".git") return yield* failure("Workspace archive contains a forbidden path")
    yield* copy(`${staged}/${name}`, `${workspace}/${name}`)
  }
})
