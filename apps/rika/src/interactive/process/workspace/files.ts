import * as LocalPath from "@rika/coding-tools/local-path"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import type { ChangedFile } from "@rika/terminal/terminal-state"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import { Config, Effect, FileSystem, Function, Option, Path, PlatformError, Schema } from "effect"

const mkdirImpl = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))
export const mkdir: {
  (options?: { readonly recursive?: boolean }): (path: string) => ReturnType<typeof mkdirImpl>
  (path: string, options?: { readonly recursive?: boolean }): ReturnType<typeof mkdirImpl>
} = Function.dual((args) => Schema.is(Schema.String)(args[0]), mkdirImpl)
const realpath = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.realPath(path)))
const rmImpl = (path: string, options?: { readonly force?: boolean }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      options?.force === true ? fileSystem.remove(path).pipe(Effect.ignore) : fileSystem.remove(path),
    ),
  )
export const rm: {
  (options?: { readonly force?: boolean }): (path: string) => ReturnType<typeof rmImpl>
  (path: string, options?: { readonly force?: boolean }): ReturnType<typeof rmImpl>
} = Function.dual((args) => Schema.is(Schema.String)(args[0]), rmImpl)
const stat = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.stat(path)))

const workspaceGlobError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "WorkspaceIndex",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()("WorkspaceFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const workspaceGlobImpl = (workspace: string, pattern: string, maximumFiles: number) =>
  WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
    Effect.map((result) => result.items.map((item) => item.relativePath)),
    Effect.mapError((error) => workspaceGlobError(workspace, error.operation, error)),
  )
export const workspaceGlob: {
  (pattern: string, maximumFiles: number): (workspace: string) => ReturnType<typeof workspaceGlobImpl>
  (workspace: string, pattern: string, maximumFiles: number): ReturnType<typeof workspaceGlobImpl>
} = Function.dual(3, workspaceGlobImpl)

export const resolveLocalFileImpl = Effect.fn("Main.resolveLocalFile")(function* (
  workspace: string,
  target: PathTarget,
) {
  if (target.path.length === 0) return yield* WorkspaceFileError.make({ path: target.path, message: "Path is empty" })
  const fileSystem = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(Config.option, Effect.orElseSucceed(Option.none<string>))
  const resolutionOptions = { path: pathService, base: workspace }
  if (Option.isSome(home)) Object.assign(resolutionOptions, { home: home.value })
  const corrected = yield* LocalPath.resolveExistingPath(
    { exists: (name) => fileSystem.exists(name), readDirectory: (name) => fileSystem.readDirectory(name) },
    target.path,
    resolutionOptions,
  ).pipe(Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path does not exist" })))
  const path = yield* realpath(corrected).pipe(
    Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path does not exist" })),
  )
  const info = yield* stat(path).pipe(
    Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path is unavailable" })),
  )
  if (info.type !== "File") return yield* WorkspaceFileError.make({ path: target.path, message: "Path is not a file" })
  return path
})

export const resolveLocalFile: {
  (target: PathTarget): (workspace: string) => Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
  (workspace: string, target: PathTarget): Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
} = Function.dual(2, (workspace: string, target: PathTarget) => resolveLocalFileImpl(workspace, target))

const editorArgumentsImpl = (editor: string, path: string, line?: number, column?: number): Array<string> => {
  const location = line === undefined ? path : `${path}:${line}${column === undefined ? "" : `:${column}`}`
  if (editor === "code" || editor.endsWith("/code")) return [editor, "--goto", location]
  if (editor === "vim" || editor === "nvim" || editor.endsWith("/vim") || editor.endsWith("/nvim"))
    return [editor, ...(line === undefined ? [] : [`+call cursor(${line},${column ?? 1})`]), path]
  return [editor, path]
}

export const editorArguments: {
  (path: string, line?: number, column?: number): (editor: string) => Array<string>
  (editor: string, path: string, line?: number, column?: number): Array<string>
} = Function.dual((args) => args.length >= 2, editorArgumentsImpl)

const defaultOpenArgumentsImpl = (path: string, platform: NodeJS.Platform = process.platform): Array<string> => {
  if (platform === "darwin") return ["open", path]
  if (platform === "win32")
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process -LiteralPath $args[0]",
      "--",
      path,
    ]
  return ["xdg-open", path]
}

export const defaultOpenArguments: {
  (platform?: NodeJS.Platform): (path: string) => Array<string>
  (path: string, platform?: NodeJS.Platform): Array<string>
} = Function.dual((args) => args.length >= 1, defaultOpenArgumentsImpl)

const parseChangedFilesImpl = (statusText: string, numstatText: string): ReadonlyArray<ChangedFile> => {
  const counts = new Map<string, { added: number; removed: number }>()
  const numstatRecords = numstatText.split("\0")
  for (let index = 0; index < numstatRecords.length - 1; index += 1) {
    const record = numstatRecords[index]!
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    const added = record.slice(0, firstTab)
    const removed = record.slice(firstTab + 1, secondTab)
    const inlinePath = record.slice(secondTab + 1)
    const path = inlinePath.length > 0 ? inlinePath : numstatRecords[(index += 2)]!
    counts.set(path, {
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
    })
  }
  const files: Array<ChangedFile> = []
  const statusRecords = statusText.split("\0")
  for (let index = 0; index < statusRecords.length - 1; index += 1) {
    const record = statusRecords[index]!
    const status = record.slice(0, 2).trim()
    const path = record.slice(3)
    if (status.includes("R") || status.includes("C")) index += 1
    const count = counts.get(path)
    files.push(count === undefined ? { path, status } : { path, status, added: count.added, removed: count.removed })
  }
  return files
}

export const parseChangedFiles: {
  (numstatText: string): (statusText: string) => ReadonlyArray<ChangedFile>
  (statusText: string, numstatText: string): ReadonlyArray<ChangedFile>
} = Function.dual(2, parseChangedFilesImpl)
