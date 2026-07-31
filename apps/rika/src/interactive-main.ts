#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import { ConfigContract, ConfigService } from "@rika/config"
import * as DataRoot from "@rika/config/data-root"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as LocalPath from "@rika/tools/local-path"
import * as WorkspaceIndex from "@rika/tools/workspace-index"
import * as Transcript from "@rika/transcript"
import { Palette, Session, ViewState } from "@rika/tui"
import { create as createTui, probeNativeAsset } from "@rika/tui/adapter"
import type { PathTarget } from "@rika/tui"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Cause,
  Clock,
  Config,
  Console,
  Context,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  PlatformError,
  References,
  Runtime,
  Schema,
  Stream,
} from "effect"
import { Command } from "effect/unstable/cli"
import { command, version } from "./command"
import { renderGoodbye } from "./goodbye"
import * as InteractiveController from "./interactive-controller"
import * as Logging from "./logging"
import { relaunchArguments } from "./relaunch-arguments"
import { layer as residentLayer } from "./resident-client-transport"
import { maxClientMessageBytes } from "./resident-wire"
import * as ResidentProcessStartup from "./resident-process-startup"
import { Format } from "@rika/tui"
import { globalPaths, workspaceDirectory, workspacePaths } from "@rika/config/paths"

InteractiveController.installPaletteCommands(Palette.commands as Array<InteractiveController.PaletteCommand>)

const startupPathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const dirname = startupPathService.dirname
const join = startupPathService.join
const ignoreSelectionResync = (_threadId: string, _selectionEpoch: number) => {}

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

export const terminalTitleSequence: {
  (title: string, workspace: string, workingFrame?: string): string
  (workspace: string): (title: string) => string
} = Function.dual(
  (args) => args.length > 1,
  (title: string, workspace: string, workingFrame?: string): string => {
    const safeWorkingFrame = workingFrame === undefined ? "" : terminalTitleText(workingFrame)
    const prefix = safeWorkingFrame.length === 0 ? "" : `${safeWorkingFrame} `
    return `\u001b]0;${prefix}${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`
  },
)

const tuiTraceEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

const traceTuiModelEvent = (seenDeltas: Set<string>, event: Operation.InteractiveEvent) => {
  if (
    event._tag !== "TranscriptProjectionPatched" ||
    event.origin._tag !== "Event" ||
    !tuiTraceEventTypes.has(event.origin.type)
  )
    return Effect.void
  const delta = event.origin.type.endsWith(".delta")
  const key = `${event.rootTurnId}:${event.origin.executionId}:${event.origin.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo("tui.model.event_applied").pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.origin.cursor,
      "rika.event.type": event.origin.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.rootTurnId),
    }),
  )
}

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const mkdir = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))
const realpath = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.realPath(path)))
const rm = (path: string, options?: { readonly force?: boolean }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      options?.force === true ? fileSystem.remove(path).pipe(Effect.ignore) : fileSystem.remove(path),
    ),
  )
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

const workspaceGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
    Effect.map((result) => result.items.map((item) => item.relativePath)),
    Effect.mapError((error) => workspaceGlobError(workspace, error.operation, error)),
  )

const imageMediaType = (path: string) => {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  return "application/octet-stream"
}

export const imagePasteBlockedNotice = (model: Pick<ViewState.Model, "editingTurnId">): string | undefined =>
  model.editingTurnId === undefined ? undefined : "Images cannot be pasted while editing a queued prompt"

const pastedImageFormat = (bytes: Uint8Array, declaredMediaType?: string) => {
  const prefix = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end))
  let signature: { readonly mediaType: string; readonly extension: string } | undefined
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    signature = { mediaType: "image/png", extension: "png" }
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    signature = { mediaType: "image/jpeg", extension: "jpg" }
  else if (bytes.length >= 6 && /^GIF8[79]a$/.test(prefix(0, 6)))
    signature = { mediaType: "image/gif", extension: "gif" }
  else if (bytes.length >= 12 && prefix(0, 4) === "RIFF" && prefix(8, 12) === "WEBP")
    signature = { mediaType: "image/webp", extension: "webp" }
  if (signature === undefined) return undefined
  const mediaType = declaredMediaType?.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === signature.mediaType ? signature : undefined
}

const resolveLocalFileImpl = Effect.fn("Main.resolveLocalFile")(function* (workspace: string, target: PathTarget) {
  if (target.path.length === 0) return yield* WorkspaceFileError.make({ path: target.path, message: "Path is empty" })
  const fileSystem = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(Config.option, Effect.orElseSucceed(Option.none<string>))
  const corrected = yield* LocalPath.resolveExistingPath(
    { exists: (name) => fileSystem.exists(name), readDirectory: (name) => fileSystem.readDirectory(name) },
    target.path,
    { path: pathService, base: workspace, ...(Option.isNone(home) ? {} : { home: home.value }) },
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

export class PromptAttachmentError extends Schema.TaggedErrorClass<PromptAttachmentError>()("PromptAttachmentError", {
  index: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()("WorkspaceFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

class ExternalBoundaryError extends Schema.TaggedErrorClass<ExternalBoundaryError>()("ExternalBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const maxAttachmentBytes = 5_000_000
const maxPromptPartsBytes = maxClientMessageBytes - 65_536
const attachmentMegabytes = Format.formatBytes

const materializePromptPartsImpl = (parts: ReadonlyArray<ViewState.PromptPart>, workspace: string) =>
  Effect.forEach(
    parts,
    (part, index): Effect.Effect<Turn.PromptPart, PromptAttachmentError, FileSystem.FileSystem> => {
      if (part.type === "text") return Effect.succeed(part)
      const path = part.path.startsWith("/") ? part.path : `${workspace}/${part.path}`
      const failure = (cause: unknown) =>
        PromptAttachmentError.make({
          index,
          path: part.path,
          message: `Image attachment could not be read: ${String(cause)}`,
        })
      return FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Effect.all([fileSystem.stat(path), fileSystem.readFile(path)]).pipe(Effect.mapError(failure)),
        ),
        Effect.flatMap(([info, bytes]) => {
          if (info.type !== "File" || bytes.byteLength === 0)
            return Effect.fail(
              PromptAttachmentError.make({
                index,
                path: part.path,
                message: `Image attachment is missing or empty: ${part.path}`,
              }),
            )
          if (bytes.byteLength > maxAttachmentBytes)
            return Effect.fail(
              PromptAttachmentError.make({
                index,
                path: part.path,
                message: `Image attachment is too large (${attachmentMegabytes(bytes.byteLength)}; the limit is ${attachmentMegabytes(maxAttachmentBytes)}): ${part.path}`,
              }),
            )
          return Effect.succeed({ mediaType: imageMediaType(path), bytes })
        }),
        Effect.flatMap(({ mediaType, bytes }) =>
          !mediaType.startsWith("image/")
            ? Effect.fail(
                PromptAttachmentError.make({
                  index,
                  path: part.path,
                  message: `Unsupported image attachment: ${part.path}`,
                }),
              )
            : Effect.succeed({
                type: "image" as const,
                mediaType,
                data: Buffer.from(bytes).toString("base64"),
                filename: part.path,
              }),
        ),
      )
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap((materialized) => {
      const images = materialized.flatMap((part, index) =>
        part.type === "image" ? [{ index, bytes: part.data.length }] : [],
      )
      const total = images.reduce((sum, image) => sum + image.bytes, 0)
      if (total <= maxPromptPartsBytes) return Effect.succeed(materialized)
      const largest = images.reduce((left, right) => (right.bytes > left.bytes ? right : left))
      const largestPart = parts[largest.index]
      return Effect.fail(
        PromptAttachmentError.make({
          index: largest.index,
          path: largestPart !== undefined && largestPart.type === "image" ? largestPart.path : "",
          message: "Image attachments exceed the 16 MiB prompt limit; remove an image and try again",
        }),
      )
    }),
  )

export const materializePromptParts: {
  (workspace: string): (parts: ReadonlyArray<ViewState.PromptPart>) => ReturnType<typeof materializePromptPartsImpl>
  (parts: ReadonlyArray<ViewState.PromptPart>, workspace: string): ReturnType<typeof materializePromptPartsImpl>
} = Function.dual(2, materializePromptPartsImpl)

const initialSubmitActionImpl = (
  prompt: ReadonlyArray<string>,
  mode: ViewState.Mode,
): Extract<Session.Action, { readonly _tag: "Submit" }> | undefined => {
  if (prompt.length === 0) return undefined
  const value = prompt.join(" ")
  return { _tag: "Submit", prompt: value, parts: ViewState.promptParts(value), mode }
}

export const initialSubmitAction: {
  (mode: ViewState.Mode): (prompt: ReadonlyArray<string>) => ReturnType<typeof initialSubmitActionImpl>
  (prompt: ReadonlyArray<string>, mode: ViewState.Mode): ReturnType<typeof initialSubmitActionImpl>
} = Function.dual(2, initialSubmitActionImpl)

const parseChangedFilesImpl = (statusText: string, numstatText: string): ReadonlyArray<ViewState.ChangedFile> => {
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
  const files: Array<ViewState.ChangedFile> = []
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
  (numstatText: string): (statusText: string) => ReadonlyArray<ViewState.ChangedFile>
  (statusText: string, numstatText: string): ReadonlyArray<ViewState.ChangedFile>
} = Function.dual(2, parseChangedFilesImpl)

const gitOutput = (arguments_: ReadonlyArray<string>) => {
  const [executable, ...args] = arguments_
  if (executable === undefined)
    return Effect.fail(ExternalBoundaryError.make({ operation: "run command", message: "Missing command" }))
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(ChildProcess.make(executable, args, { stdout: "pipe", stderr: "ignore" }))
      return yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], { concurrency: 2 })
    }).pipe(
      Effect.mapError((cause) =>
        ExternalBoundaryError.make({ operation: arguments_.join(" "), message: String(cause) }),
      ),
    ),
  )
}

const childExit = (operation: string, arguments_: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => {
  const [executable, ...args] = arguments_
  if (executable === undefined)
    return Effect.fail(ExternalBoundaryError.make({ operation, message: "Missing command" }))
  return Effect.scoped(
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.flatMap((spawner) => spawner.spawn(ChildProcess.make(executable, args, options))),
      Effect.flatMap((child) => child.exitCode),
      Effect.mapError((cause) => ExternalBoundaryError.make({ operation, message: String(cause) })),
    ),
  )
}

const readChangedFilesEffect = Effect.fn("Main.readChangedFiles")(function* (workspace: string) {
  const [statusText, statusExit] = yield* gitOutput([
    "git",
    "-C",
    workspace,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])
  if (statusExit !== 0) return []
  const [headText, headExit] = yield* gitOutput(["git", "-C", workspace, "rev-parse", "--verify", "HEAD"])
  let base = headExit === 0 ? headText.trim() : undefined
  if (base === undefined) {
    const [emptyTree, emptyTreeExit] = yield* gitOutput([
      "git",
      "-C",
      workspace,
      "hash-object",
      "-t",
      "tree",
      "/dev/null",
    ])
    base = emptyTreeExit === 0 ? emptyTree.trim() : undefined
  }
  if (base === undefined) return []
  const [numstatText, numstatExit] = yield* gitOutput(["git", "-C", workspace, "diff", "--numstat", "-z", "-M", base])
  if (numstatExit !== 0) return []
  return parseChangedFiles(statusText, numstatText)
})

export const readChangedFiles = readChangedFilesEffect

const refreshChangedFilesOnImpl = <A, E, R, E2, R2>(
  changes: Stream.Stream<A, E, R>,
  isOpen: () => boolean,
  refresh: Effect.Effect<void, E2, R2>,
) =>
  changes.pipe(
    Stream.debounce("150 millis"),
    Stream.runForEach(() => (isOpen() ? refresh : Effect.void)),
  )

export const refreshChangedFilesOn: {
  <E2, R2>(
    isOpen: () => boolean,
    refresh: Effect.Effect<void, E2, R2>,
  ): <A, E, R>(changes: Stream.Stream<A, E, R>) => Effect.Effect<void, E | E2, R | R2>
  <A, E, R, E2, R2>(
    changes: Stream.Stream<A, E, R>,
    isOpen: () => boolean,
    refresh: Effect.Effect<void, E2, R2>,
  ): Effect.Effect<void, E | E2, R | R2>
} = Function.dual(3, refreshChangedFilesOnImpl)

type ClipboardPngExtractor = (
  script: string,
  path: string,
) => Effect.Effect<number, globalThis.Error, ChildProcessSpawner.ChildProcessSpawner>

const runClipboardPngExtractor: ClipboardPngExtractor = (script, path) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make("osascript", ["-e", script, "--", path], { stdout: "ignore", stderr: "ignore" }),
      )
      return yield* child.exitCode
    }).pipe(
      Effect.mapError((cause) =>
        ExternalBoundaryError.make({ operation: "extract clipboard image", message: String(cause) }),
      ),
    ),
  )

const pasteClipboardPngImpl = (
  workspace: string,
  now = Date.now,
  extract: ClipboardPngExtractor = runClipboardPngExtractor,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const relative = `${workspaceDirectory}/pasted/paste-${now()}.png`
    const absolute = `${workspace}/${relative}`
    yield* mkdir(workspacePaths(workspace).pasted, { recursive: true })
    yield* fileSystem.writeFile(absolute, new Uint8Array())
    const script = `on run argv\nset pngData to (the clipboard as «class PNGf»)\nset theFile to (POSIX file (item 1 of argv))\nset fh to open for access theFile with write permission\nset eof fh to 0\nwrite pngData to fh\nclose access fh\nend run`
    const exit = yield* extract(script, absolute).pipe(Effect.orElseSucceed(() => -1))
    const info = yield* fileSystem.stat(absolute).pipe(Effect.option)
    const extracted = exit === 0 && Option.isSome(info) && info.value.type === "File" && info.value.size > 0
    if (!extracted) yield* rm(absolute, { force: true })
    return extracted ? relative : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

export const pasteClipboardPng: {
  (now?: () => number, extract?: ClipboardPngExtractor): (workspace: string) => ReturnType<typeof pasteClipboardPngImpl>
  (workspace: string, now?: () => number, extract?: ClipboardPngExtractor): ReturnType<typeof pasteClipboardPngImpl>
} = Function.dual((args) => typeof args[0] === "string", pasteClipboardPngImpl)

const pastedImagePathImpl = (
  bytes: Uint8Array,
  mediaType?: string,
  now = Date.now,
  id = crypto.randomUUID,
): string | undefined => {
  const format = pastedImageFormat(bytes, mediaType)
  return format === undefined ? undefined : `${workspaceDirectory}/pasted/paste-${now()}-${id()}.${format.extension}`
}

export const pastedImagePath: {
  (
    mediaType?: string,
    now?: () => number,
    id?: () => `${string}-${string}-${string}-${string}-${string}`,
  ): (bytes: Uint8Array) => string | undefined
  (
    bytes: Uint8Array,
    mediaType?: string,
    now?: () => number,
    id?: () => `${string}-${string}-${string}-${string}-${string}`,
  ): string | undefined
} = Function.dual((args) => args[0] instanceof Uint8Array, pastedImagePathImpl)

const persistPastedImageImpl = (workspace: string, relative: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* mkdir(workspacePaths(workspace).pasted, { recursive: true })
    yield* fileSystem.writeFile(`${workspace}/${relative}`, bytes)
    return true
  }).pipe(Effect.orElseSucceed(() => false))

export const persistPastedImage: {
  (relative: string, bytes: Uint8Array): (workspace: string) => ReturnType<typeof persistPastedImageImpl>
  (workspace: string, relative: string, bytes: Uint8Array): ReturnType<typeof persistPastedImageImpl>
} = Function.dual(3, persistPastedImageImpl)

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => ConfigContract.ConfigFileError.make({ path: filename, message: String(error) })))
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      ConfigContract.ConfigFileError.make({ path: filename, message: `Invalid JSON: ${String(error)}` }),
    ),
  )
  return ConfigContract.decodeSettingsInput(filename, value)
})

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

const main = Command.run(command, { version }).pipe(
  Effect.catchTags({
    OperationUnavailable: (error: Operation.OperationUnavailable) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    InvalidInput: (error: Operation.InvalidInput) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  }),
)

const withClientWorkspaceImpl = (input: Operation.Input, workspace: string): Operation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
    input._tag === "Doctor" ||
    input._tag === "Thread" ||
    input._tag === "Workflow"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

export const withClientWorkspace: {
  (workspace: string): (input: Operation.Input) => Operation.Input
  (input: Operation.Input, workspace: string): Operation.Input
} = Function.dual(2, withClientWorkspaceImpl)

export const interruptTrackedFibers = (fibers: Iterable<Fiber.Fiber<void, never>>) =>
  Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded", discard: true })

export const tuiSignalExitCode = (signal: "SIGINT" | "SIGTERM" | "SIGHUP"): number => {
  if (signal === "SIGINT") return 130
  if (signal === "SIGTERM") return 143
  return 129
}

const quitStopWorkBound = Duration.seconds(3)

const interruptAndClearTrackedFiberImpl = (
  fiber: Fiber.Fiber<void, never>,
  clear: (fiber: Fiber.Fiber<void, never>) => void,
) => Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(() => clear(fiber))))

export const interruptAndClearTrackedFiber: {
  (
    clear: (fiber: Fiber.Fiber<void, never>) => void,
  ): (fiber: Fiber.Fiber<void, never>) => ReturnType<typeof interruptAndClearTrackedFiberImpl>
  (
    fiber: Fiber.Fiber<void, never>,
    clear: (fiber: Fiber.Fiber<void, never>) => void,
  ): ReturnType<typeof interruptAndClearTrackedFiberImpl>
} = Function.dual(2, interruptAndClearTrackedFiberImpl)

const refreshThreadsOnSwitcherOpenImpl = (wasOpen: boolean, isOpen: boolean, initialize: Effect.Effect<void, never>) =>
  !wasOpen && isOpen ? initialize : Effect.void

export const refreshThreadsOnSwitcherOpen: {
  (isOpen: boolean, initialize: Effect.Effect<void, never>): (wasOpen: boolean) => Effect.Effect<void, never>
  (wasOpen: boolean, isOpen: boolean, initialize: Effect.Effect<void, never>): Effect.Effect<void, never>
} = Function.dual(3, refreshThreadsOnSwitcherOpenImpl)

const settleTuiInitializationImpl = <T, E, E2>(
  task: Effect.Effect<T, E, never>,
  isClosed: () => boolean,
  destroy: (value: T) => Effect.Effect<void, E2, never>,
) =>
  task.pipe(
    Effect.flatMap((value) => (!isClosed() ? Effect.succeed(value) : destroy(value).pipe(Effect.as(undefined)))),
  )

export const settleTuiInitialization: {
  <T, E2>(
    isClosed: () => boolean,
    destroy: (value: T) => Effect.Effect<void, E2, never>,
  ): <E>(task: Effect.Effect<T, E, never>) => Effect.Effect<T | undefined, E | E2>
  <T, E, E2>(
    task: Effect.Effect<T, E, never>,
    isClosed: () => boolean,
    destroy: (value: T) => Effect.Effect<void, E2, never>,
  ): Effect.Effect<T | undefined, E | E2>
} = Function.dual(3, settleTuiInitializationImpl)

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeRoutes?: (() => ViewState.ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

export const interactiveTui =
  (options: InteractiveTuiOptions) =>
  (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ): Effect.Effect<void, Operation.OperationUnavailable> =>
    Effect.gen(function* () {
      if (options.makeRenderer === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) return
      const context = yield* Effect.context<never>()
      const fork = Effect.runForkWith(context)
      const resolvedModeRoutes = options.modeRoutes?.()
      return yield* Effect.callback<void, Operation.OperationUnavailable>((resume) => {
        let model = ViewState.initial(input.workspace ?? process.cwd(), input.mode ?? "medium")
        if (resolvedModeRoutes !== undefined) model = ViewState.withModeRoutes(model, resolvedModeRoutes)
        let workingFrame: string | undefined
        const writeTerminalTitle = options.writeTerminalTitle ?? ((sequence: string) => process.stdout.write(sequence))
        const refreshTerminalTitle = () => {
          const threadId = model.currentThreadId
          const title =
            model.currentThreadTitle ??
            (model.threads as ReadonlyArray<ViewState.ThreadItem>).find((thread) => thread.id === threadId)?.title
          if (title !== undefined)
            writeTerminalTitle(terminalTitleSequence(title, model.workspace, model.busy ? workingFrame : undefined))
        }
        let renderer: Effect.Success<ReturnType<typeof createTui>> | undefined
        let initialization: Fiber.Fiber<void, never> | undefined
        let closed = false
        const recoverSession = <R>(
          effect: Effect.Effect<void, Operation.OperationUnavailable, R>,
        ): Effect.Effect<void, never, R> =>
          effect.pipe(
            Effect.catchTag("OperationUnavailable", (error) => (closed ? Effect.void : Effect.logError(error.message))),
          )
        let previewTimer: Fiber.Fiber<void, never> | undefined
        let renderTimer: Fiber.Fiber<void, never> | undefined
        let feedTimer: Fiber.Fiber<void, never> | undefined
        let applyingFeedBatch = false
        let feedPreserveAnchor = false
        let replayTurns = new Map<string, Turn.Turn>()
        let loadedTranscriptEntries: ReadonlyArray<TranscriptRepository.Entry> = []
        let projectionRevisions = new Map<string, number>()
        let liveTranscriptProjections = new Map<string, Transcript.Projection>()
        let projectionStreams = new Map<string, InteractiveController.ProjectionStream>()
        let threadCostUsd: number | undefined
        let transcriptHasOlder = false
        let transcriptHasNewer = false
        let transcriptOldestCursor: TranscriptRepository.PageCursor | undefined
        let transcriptNewestCursor: TranscriptRepository.PageCursor | undefined
        const appliedDeltas = new Set<string>()
        let activeSelectionEpoch = 0
        let submissionSequence = 0
        const fibers = new Set<Fiber.Fiber<void, never>>()
        let selectionFiber: Fiber.Fiber<void, never> | undefined
        let selectionGeneration = 0
        let renderSuppressed = false
        let loadingOlder = false
        let pendingNewer:
          | { readonly threadId: string; readonly selectionEpoch: number; readonly cursor: string }
          | undefined
        const selectionResyncs = new Set<string>()
        let requestSelectionResync = ignoreSelectionResync
        const queueResyncs = new Set<string>()
        const requestQueueResync = (threadId: Thread.ThreadId) => {
          const key = String(threadId)
          if (queueResyncs.has(key)) return
          queueResyncs.add(key)
          fork(session.readQueue(threadId).pipe(Effect.ensuring(Effect.sync(() => queueResyncs.delete(key)))))
        }
        const render = (immediate = false) => {
          if (applyingFeedBatch) return
          if (renderer === undefined || renderSuppressed) return
          if (immediate) {
            if (renderTimer !== undefined) fork(Fiber.interrupt(renderTimer))
            renderTimer = undefined
            renderer.surface.update(model)
            return
          }
          if (renderTimer !== undefined) return
          renderTimer = fork(
            Effect.sleep("16 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  renderTimer = undefined
                  renderer?.surface.update(model)
                }),
              ),
            ),
          )
        }
        const dispatch = (event: Operation.InteractiveEvent) => {
          if (closed) return
          if (
            event._tag === "SelectionLoaded" ||
            event._tag === "TranscriptPagePrepended" ||
            event._tag === "TranscriptPageAppended" ||
            event._tag === "TranscriptProjectionStarted" ||
            event._tag === "TranscriptProjectionPatched" ||
            event._tag === "TranscriptProjectionStopped" ||
            event._tag === "TranscriptProjectionFailed" ||
            event._tag === "TranscriptResyncRequired" ||
            event._tag === "ThreadUsageUpdated" ||
            event._tag === "ThreadRefolding"
          ) {
            const selectionStartedAt = event._tag === "SelectionLoaded" ? performance.now() : undefined
            const previousThreadId = model.currentThreadId
            const previousThreadTitle = model.currentThreadTitle
            const controlled = InteractiveController.update(
              {
                model,
                selectionEpoch: activeSelectionEpoch,
                replayTurns,
                entries: loadedTranscriptEntries,
                revisions: projectionRevisions,
                liveProjections: liveTranscriptProjections,
                projectionStreams,
                ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
                hasOlder: transcriptHasOlder,
                hasNewer: transcriptHasNewer,
                ...(transcriptOldestCursor === undefined ? {} : { oldestCursor: transcriptOldestCursor }),
                ...(transcriptNewestCursor === undefined ? {} : { newestCursor: transcriptNewestCursor }),
              },
              event,
            )
            model = controlled.state.model
            activeSelectionEpoch = controlled.state.selectionEpoch
            replayTurns = new Map(controlled.state.replayTurns)
            loadedTranscriptEntries = controlled.state.entries
            projectionRevisions = new Map(controlled.state.revisions)
            liveTranscriptProjections = new Map(controlled.state.liveProjections)
            projectionStreams = new Map(controlled.state.projectionStreams)
            threadCostUsd = controlled.state.threadCostUsd
            transcriptHasOlder = controlled.state.hasOlder ?? false
            transcriptHasNewer = controlled.state.hasNewer ?? false
            transcriptOldestCursor = controlled.state.oldestCursor
            transcriptNewestCursor = controlled.state.newestCursor
            if (event._tag === "SelectionLoaded") {
              loadingOlder = false
              pendingNewer = undefined
            } else if (
              event._tag === "TranscriptPageAppended" &&
              pendingNewer?.threadId === event.threadId &&
              pendingNewer.selectionEpoch === event.selectionEpoch &&
              pendingNewer.cursor === JSON.stringify(event.requestedAfter)
            )
              pendingNewer = undefined
            if (
              event._tag === "SelectionLoaded" &&
              model.currentThreadId === event.thread.id &&
              (model.currentThreadId !== previousThreadId || model.currentThreadTitle !== previousThreadTitle)
            )
              refreshTerminalTitle()
            if (event._tag === "TranscriptProjectionPatched") fork(traceTuiModelEvent(appliedDeltas, event))
            if (
              (event._tag === "TranscriptResyncRequired" || controlled.resync === true) &&
              model.currentThreadId !== undefined
            )
              requestSelectionResync(model.currentThreadId, event.selectionEpoch)
            if (controlled.preserveAnchor) {
              if (applyingFeedBatch) feedPreserveAnchor = true
              else renderer?.surface.update(model, true)
            } else
              render(
                event._tag === "TranscriptResyncRequired" ||
                  event._tag === "TranscriptProjectionStopped" ||
                  event._tag === "TranscriptProjectionFailed",
              )
            if (selectionStartedAt !== undefined && event._tag === "SelectionLoaded")
              fork(
                (controlled.discarded === true
                  ? Effect.logWarning("tui.selection.discarded")
                  : Effect.logInfo("tui.selection.applied")
                ).pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(event.thread.id),
                    "rika.transcript.page.units": event.entries.length,
                    "rika.duration.ms": Math.round(performance.now() - selectionStartedAt),
                  }),
                ),
              )
            return
          }
          if (event._tag === "QueueUpdated") {
            if (
              event.selectionEpoch === activeSelectionEpoch &&
              (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
            ) {
              const updated = InteractiveController.updateQueue(model, event)
              model = updated.model
              if (updated.resync) requestQueueResync(event.threadId)
            }
          } else if (event._tag === "QueueResyncRequired") {
            if (
              event.selectionEpoch === activeSelectionEpoch &&
              (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
            )
              requestQueueResync(event.threadId)
          } else if (event._tag === "TurnStarted") {
            if (
              event.selectionEpoch === activeSelectionEpoch &&
              (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
            ) {
              const known = replayTurns.get(event.turn.id)
              if (
                known?.status === "completed" ||
                known?.status === "failed" ||
                known?.status === "cancelled" ||
                model.activeTurnId === event.turn.id
              )
                return
              if (model.queue.some((item) => item.id === event.turn.id)) {
                model = InteractiveController.removePromotedTurn(model, event.threadId, event.turn.id)
                fork(session.readQueue(event.threadId))
              }
              replayTurns.set(event.turn.id, event.turn)
              const seed = Transcript.empty(event.turn.id, event.turn.prompt)
              loadedTranscriptEntries = [
                ...loadedTranscriptEntries,
                ...seed.units.map((unit) => ({
                  turn: event.turn,
                  unit,
                  projectionRevision: seed.revision,
                  projectionModelPhase: seed.modelPhase,
                })),
              ]
              model = ViewState.update(model, {
                _tag: "TurnStarted",
                turnId: event.turn.id,
                prompt: event.turn.prompt,
                ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
              })
            }
          } else if (event._tag === "SubmissionAdmitted") {
            if (
              event.selectionEpoch === activeSelectionEpoch &&
              (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
            )
              model = ViewState.update(model, {
                _tag: "SubmissionAdmitted",
                turnId: event.turnId,
                status: event.status,
                ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
              })
          } else if (event._tag === "ThreadsListed") {
            model = ViewState.update(model, {
              _tag: "ThreadsReplaced",
              threads: event.threads.map((thread) => ({
                id: thread.id,
                title: thread.title,
                workspace: thread.workspace,
                pinned: thread.pinned,
                archived: thread.archived,
                status: thread.status,
                unread: thread.unread,
                lastActivityAt: thread.lastActivityAt,
                ...(thread.editTotals === undefined ? {} : { editTotals: thread.editTotals }),
              })),
            })
          } else if (event._tag === "ExecutionControlled") {
            if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
            if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
            if (event.action === "cancelled")
              model = ViewState.update(model, {
                _tag: "ExecutionCancelled",
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                ...(event.agentResponseArrived === undefined
                  ? {}
                  : { agentResponseArrived: event.agentResponseArrived }),
              })
            if (
              event.action === "steered" &&
              event.turnId !== undefined &&
              event.steeringSequence !== undefined &&
              event.steeringText !== undefined
            )
              model = ViewState.update(model, {
                _tag: "SteeringAccepted",
                turnId: event.turnId,
                sequence: event.steeringSequence,
                text: event.steeringText,
              })
          } else if (event._tag === "ExecutionControlFailed") {
            if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
            if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
            if (event.action === "steer" && event.turnId !== undefined && event.steeringText !== undefined)
              model = ViewState.update(model, {
                _tag: "SteeringFailed",
                turnId: event.turnId,
                text: event.steeringText,
                message: event.message,
              })
            if (event.action === "cancel")
              model = ViewState.update(model, {
                _tag: "CancelFailed",
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                message: event.message,
              })
          } else if (event._tag === "ContextDiagnostics") {
            if (event.selectionEpoch !== activeSelectionEpoch) return
            if (model.currentThreadId !== event.threadId) return
            model = ViewState.update(model, {
              _tag: "BlockAdded",
              block: {
                _tag: "Notification",
                title: "Context resolution",
                detail: event.messages.join("\n"),
              },
            })
          } else if (event._tag === "ExecutionFailed") {
            if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
            if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
            model = ViewState.update(model, {
              _tag: "ExecutionFailed",
              ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
              message: event.message,
            })
          } else if (event._tag === "QueueFull") {
            if (event.selectionEpoch !== activeSelectionEpoch) return
            if (model.currentThreadId !== undefined && model.currentThreadId !== event.threadId) return
            model = InteractiveController.updateQueue(model, event).model
          } else if (event._tag === "ShellCompleted") {
            if (model.currentThreadId !== event.threadId) return
            if (event.incognito) model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
            model = ViewState.update(model, { _tag: "ExecutionCompleted" })
          } else if (event._tag === "TitleCostUpdated") {
            if (model.currentThreadId === event.threadId) {
              threadCostUsd = event.threadCostUsd
              model = { ...model, costUsd: event.threadCostUsd }
            }
          } else if (event._tag === "ThreadTitled") {
            model = ViewState.update(model, {
              _tag: "ThreadTitleChanged",
              threadId: event.threadId,
              title: event.title,
            })
            if (model.currentThreadId === event.threadId) refreshTerminalTitle()
          } else if (event._tag === "ThreadActivated") {
            model = ViewState.update(model, {
              _tag: "ThreadActivated",
              threadId: event.threadId,
              title: event.title,
            })
            if (model.currentThreadId === event.threadId) refreshTerminalTitle()
          } else if (event._tag === "ThreadPreviewLoaded") {
            if (model.threadSwitcher.open && ViewState.selectedThreadMetadata(model)?.id === event.threadId)
              model = ViewState.update(model, {
                _tag: "ThreadPreviewLoaded",
                threadId: event.threadId,
                turns: event.turns.map((turn) => ({
                  prompt: turn.prompt,
                  units: turn.units.map((unit) => Schema.decodeUnknownSync(Transcript.Unit)(unit)),
                })),
              })
          } else {
            model = ViewState.update(model, event)
          }
          render(
            event._tag === "ContextDiagnostics" ||
              event._tag === "ExecutionFailed" ||
              event._tag === "QueueFull" ||
              event._tag === "ExecutionControlled",
          )
        }
        const feedBatcher = InteractiveController.makeFeedFrameBatcher<Operation.InteractiveEvent>({
          schedule: (flush) => {
            feedTimer = fork(
              Effect.sleep("16 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    feedTimer = undefined
                    flush()
                  }),
                ),
              ),
            )
          },
          apply: (events) => {
            applyingFeedBatch = true
            try {
              for (const event of events) dispatch(event)
            } finally {
              applyingFeedBatch = false
            }
          },
          render: () => {
            if (renderer !== undefined && !renderSuppressed) renderer.surface.update(model, feedPreserveAnchor)
            feedPreserveAnchor = false
          },
        })
        let closing = false
        let teardownStarted = false
        let terminalPauseCount = 0
        let pendingJobControlPause = false
        let releaseJobControlPause: (() => boolean) | undefined
        const pauseTerminal = () => {
          if (closed) return () => false
          if (terminalPauseCount === 0)
            try {
              renderer?.suspendTerminal()
            } catch (cause) {
              close(1)
              throw cause
            }
          terminalPauseCount += 1
          let released = false
          return () => {
            if (released) return false
            released = true
            terminalPauseCount = Math.max(0, terminalPauseCount - 1)
            if (closed || terminalPauseCount > 0) return false
            try {
              renderer?.resumeTerminal()
            } catch (cause) {
              close(1)
              throw cause
            }
            return true
          }
        }
        const goodbye = () => {
          const threadId = model.currentThreadId
          const threadTitle =
            model.currentThreadTitle ??
            (model.threads as ReadonlyArray<ViewState.ThreadItem>).find((thread) => thread.id === threadId)?.title
          try {
            process.stdout.write(
              renderGoodbye({
                mode: model.mode,
                workspace: model.workspace,
                ...(threadId === undefined ? {} : { threadId }),
                ...(threadTitle === undefined ? {} : { threadTitle }),
              }),
            )
          } catch {
            return
          }
        }
        const teardown = (showGoodbye: boolean) =>
          Effect.suspend(() => {
            if (teardownStarted) return Effect.void
            teardownStarted = true
            return Effect.gen(function* () {
              yield* Effect.logInfo("tui.teardown.started")
              closed = true
              process.off("SIGINT", interrupt)
              process.off("SIGTERM", terminate)
              process.off("SIGHUP", hangup)
              process.off("SIGTSTP", suspend)
              process.off("SIGCONT", continueFromSuspend)
              process.stdin.off("end", hangup)
              process.stdin.off("error", hangup)
              process.stdin.off("close", hangup)
              if (previewTimer !== undefined) yield* Fiber.interrupt(previewTimer)
              previewTimer = undefined
              if (renderTimer !== undefined) yield* Fiber.interrupt(renderTimer)
              renderTimer = undefined
              if (feedTimer !== undefined) yield* Fiber.interrupt(feedTimer)
              feedTimer = undefined
              Logging.settleActiveLogs()
              renderer?.releaseTerminal()
              if (initialization !== undefined) yield* Fiber.await(initialization)
              yield* interruptTrackedFibers([...fibers])
              if (showGoodbye) goodbye()
              yield* Effect.logInfo("tui.teardown.completed")
            })
          })
        const close = (exitCode?: number, showGoodbye = true) => {
          if (closing) return
          closing = true
          if (exitCode !== undefined) process.exitCode = exitCode
          fork(
            session.quit.pipe(
              Effect.timeoutOrElse({
                duration: quitStopWorkBound,
                orElse: () => Effect.logWarning("tui.quit.stop_work.timeout"),
              }),
              Effect.catch((failure) =>
                Effect.logWarning("tui.quit.stop_work.failed").pipe(
                  Effect.annotateLogs("rika.failure.kind", failure._tag),
                ),
              ),
              Effect.andThen(teardown(showGoodbye)),
              Effect.andThen(Effect.sync(() => resume(Effect.void))),
            ),
          )
        }
        const interrupt = () => close(tuiSignalExitCode("SIGINT"))
        const terminate = () => close(tuiSignalExitCode("SIGTERM"))
        const hangup = () => close(tuiSignalExitCode("SIGHUP"), false)
        const suspend = () => {
          if (closed || pendingJobControlPause || releaseJobControlPause !== undefined) return
          if (renderer === undefined) {
            pendingJobControlPause = true
            return
          }
          try {
            releaseJobControlPause = pauseTerminal()
            process.kill(process.pid, "SIGSTOP")
          } catch {
            releaseJobControlPause?.()
            releaseJobControlPause = undefined
            close(1)
          }
        }
        const continueFromSuspend = () => {
          if (pendingJobControlPause) {
            pendingJobControlPause = false
            return
          }
          if (closed || releaseJobControlPause === undefined) return
          const release = releaseJobControlPause
          releaseJobControlPause = undefined
          try {
            if (release()) renderer?.surface.update(model)
          } catch {
            close(1)
          }
        }
        process.once("SIGINT", interrupt)
        process.once("SIGTERM", terminate)
        process.on("SIGHUP", hangup)
        process.stdin.once("end", hangup)
        process.stdin.once("error", hangup)
        process.stdin.once("close", hangup)
        process.on("SIGTSTP", suspend)
        process.on("SIGCONT", continueFromSuspend)
        const submit = (
          prompt: string,
          parts: ReadonlyArray<ViewState.PromptPart>,
          mode: ViewState.Mode,
          tuning?: Session.ModelTuning,
          submissionId?: string,
        ) => {
          const classified = ViewState.classifyPrompt(prompt)
          const effect =
            classified._tag === "Shell"
              ? session.shell(
                  model.currentThreadId === undefined ? undefined : Thread.ThreadId.make(model.currentThreadId),
                  classified.command,
                  classified.incognito,
                )
              : materializePromptParts(parts, model.workspace).pipe(
                  Effect.flatMap((materialized) =>
                    session.submit(classified.prompt, mode, materialized, tuning, submissionId),
                  ),
                  Effect.catchTag("PromptAttachmentError", (failure) =>
                    Effect.sync(() => {
                      let restored: ViewState.Model = {
                        ...model,
                        input: "",
                        cursor: 0,
                        pastedText: [],
                        busy: false,
                        activity: undefined,
                      }
                      for (const [index, part] of parts.entries()) {
                        if (part.type === "image") {
                          if (index !== failure.index)
                            restored = ViewState.update(restored, { _tag: "ImageInserted", path: part.path })
                        } else {
                          restored = {
                            ...restored,
                            input:
                              restored.input.slice(0, restored.cursor) +
                              part.text +
                              restored.input.slice(restored.cursor),
                            cursor: restored.cursor + part.text.length,
                          }
                        }
                      }
                      model = ViewState.update(restored, { _tag: "ExecutionFailed", message: failure.message })
                      renderer?.surface.update(model)
                    }),
                  ),
                )
          const fiber = effect.pipe(provideLayerScoped(BunServices.layer), recoverSession, fork)
          fibers.add(fiber)
          fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
        }
        const run = <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => {
          const fiber = fork(
            effect.pipe(
              provideLayerScoped(BunServices.layer),
              Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
            ),
          )
          fibers.add(fiber)
          fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
        }
        const requestNewerPage = () => {
          const threadId = model.currentThreadId
          if (
            !transcriptHasNewer ||
            pendingNewer !== undefined ||
            transcriptNewestCursor === undefined ||
            threadId === undefined
          )
            return
          const cursor = transcriptNewestCursor
          pendingNewer = { threadId, selectionEpoch: activeSelectionEpoch, cursor: JSON.stringify(cursor) }
          run(
            session.loadNewer(threadId, activeSelectionEpoch, cursor).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  pendingNewer = undefined
                }),
              ),
            ),
          )
        }
        const loadSelected = (effect: Effect.Effect<void, Operation.OperationUnavailable>, generation: number) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (generation !== selectionGeneration) return
              model = ViewState.update(model, { _tag: "ThreadOpenRequested" })
              renderer?.surface.update(model)
              renderSuppressed = true
            })
            yield* effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (generation !== selectionGeneration) return
                  renderSuppressed = false
                  model = ViewState.update(model, { _tag: "ThreadOpenCompleted" })
                  renderer?.surface.update(model)
                }),
              ),
            )
          })
        const startSelection = (select: (epoch: number) => Effect.Effect<void, Operation.OperationUnavailable>) => {
          const generation = (selectionGeneration += 1)
          const previous = selectionFiber
          let selectedFiber: Fiber.Fiber<void, never>
          selectedFiber = fork(
            (previous === undefined ? Effect.void : Fiber.interrupt(previous)).pipe(
              Effect.andThen(recoverSession(loadSelected(select(generation), generation))),
              Effect.ensuring(
                Effect.sync(() => {
                  fibers.delete(selectedFiber)
                  if (selectionFiber === selectedFiber) selectionFiber = undefined
                }),
              ),
            ),
          )
          selectionFiber = selectedFiber
          fibers.add(selectedFiber)
          return selectedFiber
        }
        requestSelectionResync = (threadId, selectionEpoch) => {
          if (selectionEpoch !== activeSelectionEpoch || model.currentThreadId !== threadId) return
          const key = `${threadId}:${selectionEpoch}`
          if (selectionResyncs.has(key)) return
          selectionResyncs.add(key)
          startSelection((epoch) =>
            session
              .selectThread(threadId, epoch)
              .pipe(Effect.ensuring(Effect.sync(() => selectionResyncs.delete(key)))),
          )
        }
        const loadChangedFiles = () =>
          readChangedFilesEffect(model.workspace).pipe(
            Effect.tap((files) =>
              Effect.sync(() => {
                const current = model
                model = ViewState.update(current, { _tag: "ChangedFilesReplaced", files })
                if (model !== current) renderer?.surface.update(model)
              }),
            ),
            Effect.asVoid,
          )
        const watchChangedFiles = FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            refreshChangedFilesOn(fileSystem.watch(model.workspace), () => model.changedFilesOpen, loadChangedFiles()),
          ),
          Effect.catchCause((cause) => Effect.logWarning(`changed-files watcher stopped: ${Cause.pretty(cause)}`)),
        )
        const editComposer = () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem
                if (options.editor === undefined) {
                  renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
                  return
                }
                const relative = `${workspaceDirectory}/compose-${now}.md`
                const file = `${model.workspace}/${relative}`
                yield* mkdir(`${model.workspace}/.rika`, { recursive: true })
                yield* fileSystem.writeFileString(file, ViewState.displayInput(model))
                const resumeTerminal = pauseTerminal()
                yield* childExit("run editor", [options.editor, file], {
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                  detached: false,
                }).pipe(Effect.ensuring(Effect.sync(resumeTerminal)))
                const edited = yield* fileSystem.readFileString(file)
                yield* rm(file, { force: true })
                model = ViewState.update(model, { _tag: "ComposerReplaced", text: edited.replace(/\n$/, "") })
                renderer?.surface.update(model)
              }),
            ),
            Effect.asVoid,
          )
        let openingPath = false
        const openPath = (target: PathTarget) => {
          if (openingPath) return
          openingPath = true
          run(
            resolveLocalFileImpl(model.workspace, target).pipe(
              Effect.matchEffect({
                onFailure: (failure) =>
                  Effect.sync(() => {
                    renderer?.surface.showToast(failure.message, "#e06c75")
                  }),
                onSuccess: (path) =>
                  Effect.gen(function* () {
                    if (options.editor === undefined) {
                      const exit = yield* childExit("open file", defaultOpenArguments(path), {
                        stdin: "ignore",
                        stdout: "ignore",
                        stderr: "ignore",
                      }).pipe(Effect.orElseSucceed(() => -1))
                      if (exit === 0) return
                      renderer?.surface.showToast("Could not open the file in the default application", "#e06c75")
                      return
                    }
                    const resumeTerminal = pauseTerminal()
                    const exit = yield* childExit(
                      "open editor",
                      editorArguments(options.editor, path, target.line, target.column),
                      {
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
                        detached: false,
                      },
                    ).pipe(
                      Effect.orElseSucceed(() => -1),
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (resumeTerminal() && !closed) renderer?.surface.update(model)
                        }),
                      ),
                    )
                    if (exit !== 0)
                      renderer?.surface.showToast("Could not open the file in the configured editor", "#e06c75")
                  }),
              }),
              Effect.asVoid,
              Effect.ensuring(
                Effect.sync(() => {
                  openingPath = false
                }),
              ),
            ),
          )
        }
        const adapter: Session.Adapter = {
          submit,
          quit: () => close(),
          editQueued: (id, prompt) => run(session.editQueued(id, prompt)),
          dequeue: (id) => run(session.dequeue(id)),
          steerQueued: (id, prompt) => run(session.steerQueued(id, prompt)),
          steer: (prompt, turnId) => run(session.steer(prompt, turnId)),
          interruptAndSend: (prompt) => run(session.interruptAndSend(prompt)),
          cancel: () => run(session.cancel),
          selectThread: (id) => {
            startSelection((epoch) => session.selectThread(id, epoch))
          },
        }
        const consumePendingAction = () => {
          const action = model.pendingAction as Session.Action | undefined
          const paletteCommand = InteractiveController.paletteCommand(action)
          if (paletteCommand?._tag === "NewThread") startSelection(() => session.newThread)
          else if (action !== undefined) {
            Session.execute(adapter, action)
          }
          model = ViewState.update(model, { _tag: "PaletteActionConsumed" })
        }
        initialization = fork(
          settleTuiInitialization(
            createTui({
              ...(options.makeRenderer === undefined ? {} : { makeRenderer: options.makeRenderer }),
              workingFrame: (frame) => {
                if (workingFrame === frame) return
                workingFrame = frame
                refreshTerminalTitle()
              },
              openPath,
              scroll: (offset) => {
                model = ViewState.update(model, { _tag: "ScrollMoved", offset })
                if (offset <= 0 && !loadingOlder) {
                  const threadId = model.currentThreadId
                  const before = transcriptOldestCursor
                  if (!transcriptHasOlder || threadId === undefined || before === undefined) return
                  loadingOlder = true
                  run(
                    session
                      .loadOlder(
                        threadId,
                        activeSelectionEpoch,
                        before,
                        loadedTranscriptEntries.map((entry) => entry.unit.key),
                      )
                      .pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            loadingOlder = false
                          }),
                        ),
                      ),
                  )
                }
                if (offset > 0 && !loadingOlder) requestNewerPage()
              },
              scrollGeometry: (offset) => {
                model = ViewState.update(model, { _tag: "ScrollMoved", offset })
              },
              scrollFollow: () => {
                model = ViewState.update(model, { _tag: "ScrollFollowed" })
                requestNewerPage()
              },
              paste: (text) => {
                model = ViewState.update(model, { _tag: "Pasted", text })
                renderer?.surface.update(model)
              },
              expandPaste: (token) => {
                model = ViewState.update(model, { _tag: "PastedTextExpanded", token })
                renderer?.surface.update(model)
              },
              pasteImage: (image) => {
                const blocked = imagePasteBlockedNotice(model)
                if (blocked !== undefined) {
                  renderer?.surface.showToast(blocked)
                  return
                }
                if (image !== undefined) {
                  const path = pastedImagePath(image.bytes, image.mediaType)
                  if (path === undefined) {
                    renderer?.surface.showToast("Pasted image must be a non-empty PNG, JPEG, GIF, or WebP")
                    return
                  }
                  model = ViewState.update(model, { _tag: "ImageInserted", path })
                  renderer?.surface.update(model)
                  run(
                    persistPastedImage(model.workspace, path, image.bytes).pipe(
                      Effect.tap((persisted) =>
                        Effect.sync(() => {
                          if (persisted) return
                          model = ViewState.update(model, { _tag: "ImageRemoved", path })
                          renderer?.surface.update(model)
                          renderer?.surface.showToast("Pasted image could not be saved")
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  )
                  return
                }
                run(
                  pasteClipboardPng(model.workspace).pipe(
                    Effect.tap((path) =>
                      Effect.sync(() => {
                        if (path === undefined) {
                          renderer?.surface.showToast("Clipboard does not contain a supported non-empty PNG image")
                          return
                        }
                        model = ViewState.update(model, { _tag: "ImageInserted", path })
                        renderer?.surface.update(model)
                      }),
                    ),
                    Effect.asVoid,
                  ),
                )
              },
              clickToggle: (unit) => {
                model = ViewState.update(model, { _tag: "DetailToggled", id: unit })
                renderer?.surface.update(model)
              },
              usageToggle: () => {
                model = {
                  ...model,
                  usageDisplay: ViewState.nextUsageDisplay(model.usageDisplay),
                }
                render()
              },
              modeToggle: () => {
                if (model.busy) return
                model = { ...model, mode: ViewState.nextMode(model.mode) }
                render()
              },
              key: (key) => {
                if (key.ctrl && key.name === "c" && !model.busy) {
                  close()
                  return
                }
                if (key.ctrl && key.name === "g") {
                  run(editComposer())
                  return
                }
                const wasChangedFilesOpen = model.changedFilesOpen
                const beforePreviewId = model.threadSwitcher.open
                  ? ViewState.selectedThreadMetadata(model)?.id
                  : undefined
                const submitting = key.name === "return" && !key.shift && !key.ctrl && ViewState.canSubmit(model)
                const submissionId = submitting ? `submission-${++submissionSequence}` : undefined
                const prompt = submitting ? model.input : undefined
                const parts = prompt === undefined ? undefined : ViewState.promptParts(prompt, model.pastedText)
                const submittedPrompt =
                  prompt === undefined ? undefined : ViewState.expandPastedText(prompt, model.pastedText)
                model = ViewState.update(model, { _tag: "KeyPressed", key })
                if (submitting)
                  model = ViewState.update(model, {
                    _tag: "Submitted",
                    ...(submissionId === undefined ? {} : { submissionId }),
                  })
                if (!wasChangedFilesOpen && model.changedFilesOpen)
                  model = ViewState.update(model, { _tag: "ChangedFilesRequested" })
                const afterPreviewId = model.threadSwitcher.open
                  ? ViewState.selectedThreadMetadata(model)?.id
                  : undefined
                if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
                  model = ViewState.update(model, { _tag: "ThreadPreviewRequested" })
                renderer?.surface.update(model)
                if (!wasChangedFilesOpen && model.changedFilesOpen) run(loadChangedFiles())
                if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
                  if (previewTimer !== undefined) fork(Fiber.interrupt(previewTimer))
                  const selectedPreviewTimer = Effect.sleep("120 millis").pipe(
                    Effect.andThen(session.previewThread(afterPreviewId)),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (previewTimer === selectedPreviewTimer) previewTimer = undefined
                      }),
                    ),
                    recoverSession,
                    fork,
                  )
                  previewTimer = selectedPreviewTimer
                }
                if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined)
                  Session.execute(adapter, {
                    _tag: "Submit",
                    prompt: submittedPrompt,
                    parts,
                    mode: model.mode,
                    tuning: { fastMode: model.fastMode },
                    ...(submissionId === undefined ? {} : { submissionId }),
                  })
                const action = model.pendingAction as Session.Action | undefined
                if (action !== undefined) consumePendingAction()
              },
              resize: (width, height) => {
                model = ViewState.update(model, { _tag: "Resized", width, height })
                renderer?.surface.update(model)
              },
              composerResize: (height) => {
                model = ViewState.update(model, { _tag: "ComposerHeightChanged", height })
                renderer?.surface.update(model)
              },
              sidebarResize: (width) => {
                model = ViewState.update(model, { _tag: "SidebarWidthChanged", width })
                renderer?.surface.update(model)
              },
              threadSidebarSelect: (index) => {
                model = ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed", index })
                renderer?.surface.update(model)
                const action = model.pendingAction as Session.Action | undefined
                if (action !== undefined) consumePendingAction()
              },
              threadPreviewScroll: (offset) => {
                model = ViewState.update(model, { _tag: "ThreadPreviewScrolled", offset })
                renderer?.surface.update(model)
              },
            }),
            () => closed,
            (created) => Effect.sync(() => created.releaseTerminal()),
          ).pipe(
            Effect.tap((created) =>
              Effect.sync(() => {
                if (created === undefined) return
                renderer = created
                if (closed) {
                  created.releaseTerminal()
                  return
                }
                if (pendingJobControlPause) {
                  pendingJobControlPause = false
                  suspend()
                }
                model = ViewState.update(model, { _tag: "FilesRequested" })
                created.surface.update(model)
                run(Effect.logInfo("tui.renderer.started"))
                if (closed) return
                run(session.events(feedBatcher.offer))
                run(watchChangedFiles)
                run(
                  workspaceGlob(model.workspace, "**/*", 10_000).pipe(
                    Effect.tap((files) =>
                      Effect.sync(() => {
                        model = ViewState.update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                        created.surface.update(model)
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        model = ViewState.update(model, { _tag: "FilesFailed", message: error.message })
                        created.surface.update(model)
                      }).pipe(Effect.andThen(Effect.logWarning(`workspace file index failed: ${error.message}`))),
                    ),
                    Effect.asVoid,
                  ),
                )
                run(
                  gitOutput(["git", "-C", model.workspace, "symbolic-ref", "--short", "HEAD"]).pipe(
                    Effect.tap(([text, exit]) =>
                      Effect.sync(() => {
                        const branch = text.trim()
                        if (exit === 0 && branch.length > 0 && branch !== "HEAD") {
                          model = ViewState.update(model, { _tag: "BranchDetected", branch })
                          created.surface.update(model)
                        }
                      }),
                    ),
                    Effect.asVoid,
                  ),
                )
                const startInitialSelection = () => {
                  if (input.threadId === undefined) return Effect.void
                  return Effect.sync(() =>
                    startSelection((epoch) => session.selectThread(input.threadId!, epoch)),
                  ).pipe(Effect.flatMap(Fiber.join))
                }
                run(
                  startInitialSelection().pipe(
                    Effect.andThen(
                      initialSubmitAction(input.prompt, model.mode) === undefined
                        ? Effect.void
                        : Effect.sync(() => {
                            Session.execute(adapter, initialSubmitAction(input.prompt, model.mode)!)
                          }),
                    ),
                  ),
                )
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (closed) return
                resume(
                  Effect.logError("tui.renderer.failed").pipe(
                    Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                    Effect.andThen(
                      Effect.fail(
                        Operation.OperationUnavailable.make({
                          operation: "Interactive",
                          message: Cause.pretty(cause),
                        }),
                      ),
                    ),
                  ),
                )
              }),
            ),
            Effect.asVoid,
          ),
        )
        return teardown(false)
      })
    })

const start = () => {
  const nativeProbe = Effect.runSync(Config.option(Config.string("RIKA_INTERNAL_OPENTUI_NATIVE_PROBE")))
  if (Option.contains(nativeProbe, "1")) {
    Effect.runSync(Console.log(probeNativeAsset()))
    process.exit(0)
  }
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      executionDatabase: Config.option(Config.string("RIKA_EXECUTION_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
      residentHost: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_HOST")),
      runtimeRestarted: Config.option(Config.string("RIKA_INTERNAL_RUNTIME_RESTARTED")),
      restartThread: Config.option(Config.string("RIKA_INTERNAL_RESTART_THREAD")),
      launcherExecutable: Config.option(Config.string("RIKA_INTERNAL_LAUNCHER_EXECUTABLE")),
      launchArguments: Config.option(Config.string("RIKA_INTERNAL_LAUNCH_ARGUMENTS")),
      runtimeRestartAttempt: Config.option(Config.string("RIKA_INTERNAL_RUNTIME_RESTART_ATTEMPT")),
    }),
  )
  const runtimeRestarted = environment.runtimeRestarted._tag === "Some" && environment.runtimeRestarted.value === "1"
  const restartThreadId = environment.restartThread._tag === "Some" ? environment.restartThread.value : undefined
  let runtimeRestartRequest: { readonly threadId?: string } | undefined
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  let database: string
  let executionDatabase: string
  if (hostDataRoot === undefined) {
    database = environment.database._tag === "Some" ? environment.database.value : `${defaultDataRoot}/rika.db`
    executionDatabase =
      environment.executionDatabase._tag === "Some"
        ? environment.executionDatabase.value
        : `${defaultDataRoot}/execution.db`
  } else {
    database = join(hostDataRoot, "rika.db")
    executionDatabase = join(hostDataRoot, "execution.db")
  }
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
  const residentRuntime = import.meta.path.startsWith("/$bunfs/")
    ? { executable: join(dirname(process.execPath), ".rika-resident"), arguments: [] }
    : { executable: process.execPath, arguments: [join(import.meta.dir, "resident-main.ts")] }
  let clientModeRoutes: ViewState.ModeRoutes | undefined
  const clientOwnedInteractiveFunction = interactiveTui({ editor, modeRoutes: () => clientModeRoutes })

  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
              const effectiveConfig = yield* ConfigService.effective().pipe(
                provideLayerScoped(ConfigService.memoryLayer({ global: globalSettings, workspace: workspaceSettings })),
              )
              clientModeRoutes = ConfigContract.modeRouteLabels(effectiveConfig.settings) as ViewState.ModeRoutes
              return yield* program.pipe(
                Effect.provideService(
                  References.MinimumLogLevel,
                  Logging.minimumLevel(effectiveConfig.settings.logging.level),
                ),
              )
            }),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("process.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
          ),
          Effect.ensuring(Effect.logInfo("process.stopped")),
          Effect.annotateLogs({
            "rika.process.role": role,
            "rika.process.instance": `${startedAt}-${process.pid}`,
            "rika.process.pid": process.pid,
            "rika.version": version,
          }),
        ),
      ),
      provideLayerScoped(
        Layer.merge(
          Logging.layer({ dataRoot, role, version }).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    )
  const dispatcherLayer = Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const resident = yield* ResidentService.Service
      return Operation.Service.of({
        run: Effect.fn("Operation.dispatch")((input) =>
          DataRoot.canonicalDataRoot(database, executionDatabase).pipe(
            Effect.flatMap((dataRoot) =>
              observedProgram(
                "client",
                dataRoot,
                Effect.scoped(
                  Effect.gen(function* () {
                    const workspaceInput = withClientWorkspace(input, process.cwd())
                    const clientInput =
                      workspaceInput._tag === "Interactive" && restartThreadId !== undefined
                        ? { ...workspaceInput, threadId: restartThreadId, last: false }
                        : workspaceInput
                    const requestRuntimeRestart = (error: ResidentService.ResidentRestartRequired) =>
                      Effect.sync(() => {
                        runtimeRestartRequest = error.threadId === undefined ? {} : { threadId: error.threadId }
                      }).pipe(
                        Effect.andThen(ResidentProcessStartup.signalRuntimeRestart(error.threadId).pipe(Effect.ignore)),
                        Effect.andThen(
                          Operation.OperationUnavailable.make({
                            operation: clientInput._tag,
                            message: "Rika was upgraded; restarting this session",
                          }),
                        ),
                      )
                    let clientKind: ResidentService.Handshake["clientKind"]
                    if (clientInput._tag === "Interactive") clientKind = "interactive"
                    else if (clientInput._tag === "Thread") clientKind = "thread-continue"
                    else if (clientInput._tag === "Run") clientKind = "run"
                    else if (clientInput._tag === "Review") clientKind = "review"
                    else if (clientInput._tag === "Workflow") clientKind = "workflow"
                    else clientKind = "product"
                    const connected = yield* Effect.result(
                      resident
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          ...(runtimeRestarted ? { allowSupersede: false } : {}),
                          clientKind,
                          startHost: () =>
                            ResidentProcessStartup.spawn({
                              executable: residentRuntime.executable,
                              arguments: residentRuntime.arguments,
                              environment: {
                                RIKA_INTERNAL_RESIDENT_HOST: "1",
                                RIKA_INTERNAL_RESIDENT_PROFILE: "default",
                                RIKA_INTERNAL_RESIDENT_DATA_ROOT: dataRoot,
                                ...(environment.residentGrace._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_GRACE: environment.residentGrace.value }),
                                ...(environment.residentStartupHold._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: environment.residentStartupHold.value }),
                                ...(environment.testModelResponse._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_RESPONSE: environment.testModelResponse.value }),
                                ...(environment.testModelScript._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_SCRIPT: environment.testModelScript.value }),
                                ...(environment.testMediaAnalyzerResponse._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_RESPONSE: environment.testMediaAnalyzerResponse.value }),
                                ...(environment.testMediaAnalyzerError._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_ERROR: environment.testMediaAnalyzerError.value }),
                              },
                            }).pipe(Effect.tap(() => Effect.logInfo("resident.spawned"))),
                        })
                        .pipe(provideLayerScoped(Layer.merge(BunServices.layer, BunCrypto.layer))),
                    )
                    if (connected._tag === "Success") {
                      const connection = connected.success
                      yield* Effect.logInfo("resident.connected")
                      yield* connection
                        .run(clientInput, {
                          stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                          stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                          ...(clientInput._tag === "Interactive"
                            ? { interactive: clientOwnedInteractiveFunction }
                            : {}),
                        })
                        .pipe(
                          Effect.tapError((error) =>
                            Schema.is(ResidentService.ResidentRestartRequired)(error)
                              ? Effect.sync(() => {
                                  runtimeRestartRequest =
                                    error.threadId === undefined ? {} : { threadId: error.threadId }
                                }).pipe(
                                  Effect.andThen(
                                    ResidentProcessStartup.signalRuntimeRestart(error.threadId).pipe(Effect.ignore),
                                  ),
                                )
                              : Effect.void,
                          ),
                          Effect.mapError((error) =>
                            Schema.is(Operation.OperationUnavailable)(error)
                              ? error
                              : Operation.OperationUnavailable.make({
                                  operation: clientInput._tag,
                                  message: Schema.is(ResidentService.ResidentRestartRequired)(error)
                                    ? "Rika was upgraded; restarting this session"
                                    : error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
                    if (Schema.is(ResidentService.ResidentRestartRequired)(connected.failure))
                      return yield* requestRuntimeRestart(connected.failure)
                    return yield* Operation.OperationUnavailable.make({
                      operation: clientInput._tag,
                      message: connected.failure.message,
                    })
                  }),
                ).pipe(
                  Effect.tap(() => Effect.logInfo("operation.completed")),
                  Effect.tapError(() => Effect.logError("operation.failed")),
                  Effect.annotateLogs("rika.operation", input._tag),
                ),
              ),
            ),
            provideLayerScoped(BunServices.layer),
            Effect.mapError((error) =>
              Schema.is(Operation.OperationUnavailable)(error)
                ? error
                : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
            ),
          ),
        ),
      })
    }),
  )
  const clientProgram = main.pipe(
    provideLayerScoped(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        FetchHttpClient.layer,
        dispatcherLayer.pipe(Layer.provide(residentLayer)),
      ),
    ),
  )
  BunRuntime.runMain(clientProgram, {
    teardown: (exit, onExit) => {
      if (runtimeRestartRequest !== undefined && environment.launcherExecutable._tag === "Some") {
        const attempt =
          environment.runtimeRestartAttempt._tag === "Some" ? Number(environment.runtimeRestartAttempt.value) : 0
        if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 3) {
          Effect.runSync(Console.error("Rika could not finish upgrading. Reinstall Rika, then run it again."))
          return onExit(2)
        }
        let arguments_: ReadonlyArray<string> = relaunchArguments()
        if (environment.launchArguments._tag === "Some")
          try {
            const decoded = JSON.parse(environment.launchArguments.value)
            if (Array.isArray(decoded) && decoded.every((item) => typeof item === "string")) arguments_ = decoded
          } catch {}
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        inherited.RIKA_INTERNAL_RUNTIME_RESTARTED = "1"
        inherited.RIKA_INTERNAL_RUNTIME_RESTART_ATTEMPT = String(attempt + 1)
        if (runtimeRestartRequest.threadId === undefined) delete inherited.RIKA_INTERNAL_RESTART_THREAD
        else inherited.RIKA_INTERNAL_RESTART_THREAD = runtimeRestartRequest.threadId
        delete inherited.RIKA_INTERNAL_LAUNCHER_EXECUTABLE
        delete inherited.RIKA_INTERNAL_LAUNCH_ARGUMENTS
        try {
          const execve = process.execve
          if (execve === undefined) throw new Error("process image replacement is unavailable")
          execve(environment.launcherExecutable.value, [environment.launcherExecutable.value, ...arguments_], inherited)
        } catch (cause) {
          Effect.runSync(Console.error(`Rika could not restart after upgrading: ${String(cause)}`))
          return onExit(2)
        }
      }
      if (runtimeRestartRequest !== undefined) return onExit(ResidentService.runtimeRestartExitCode)
      Runtime.defaultTeardown(exit, onExit)
    },
  })
}

if (import.meta.main) start()
