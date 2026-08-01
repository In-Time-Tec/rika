#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as ResidentHandshake from "@rika/product/resident-service-handshake"
import * as ResidentService from "@rika/product/resident-service"
import * as DataRoot from "@rika/configuration/canonical-data-root"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as LocalPath from "@rika/coding-tools/local-path"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import { create as createTui } from "@rika/terminal/opentui-surface"
import type { Model } from "@rika/terminal/terminal-state"
import type { ChangedFile } from "@rika/terminal/terminal-message"
import { promptParts } from "@rika/terminal/terminal-session"
import { commands } from "@rika/terminal/terminal-state-reducer"
import { probeNativeAsset } from "@rika/terminal/opentui-surface"
type ModeRoutes = Model["modeRoutes"]
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
const formatBytes = (bytes: number): string => {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1).replace(/\.0$/, "")} KB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`
}

import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
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
import { command, version } from "../../command"
import * as InteractiveController from "../controller/interactive-controller"
import { interactiveTui } from "./interactive-process-loop"
import * as Logging from "../../logging"
import { relaunchArguments } from "../input/relaunch-input"
import { layer as residentLayer } from "../../resident-client-transport"
import { maxClientMessageBytes } from "../../resident-wire"
import * as ResidentProcessStartup from "../../resident-process-startup"
import { globalPaths, workspaceDirectory, workspacePaths } from "@rika/configuration/configuration-paths"
import { provideLayerScoped } from "./process-layer"

InteractiveController.installPaletteCommands(commands as Array<InteractiveController.PaletteCommand>)

const startupPathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const dirname = startupPathService.dirname
const join = startupPathService.join
export const ignoreSelectionResync = (_threadId: string, _selectionEpoch: number) => {}

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

export const traceTuiModelEvent = (seenDeltas: Set<string>, event: InteractiveEvent.InteractiveEvent) => {
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

export const mkdir = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))
const realpath = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.realPath(path)))
export const rm = (path: string, options?: { readonly force?: boolean }) =>
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

export const workspaceGlob = (workspace: string, pattern: string, maximumFiles: number) =>
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

export const resolveLocalFileImpl = Effect.fn("Main.resolveLocalFile")(function* (
  workspace: string,
  target: PathTarget,
) {
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
const attachmentMegabytes = formatBytes

const materializePromptPartsImpl = (parts: ReadonlyArray<PromptPart>, workspace: string) =>
  Effect.forEach(
    parts,
    (part, index): Effect.Effect<ExecutionRequest.PromptPart, PromptAttachmentError, FileSystem.FileSystem> => {
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
  (workspace: string): (parts: ReadonlyArray<PromptPart>) => ReturnType<typeof materializePromptPartsImpl>
  (parts: ReadonlyArray<PromptPart>, workspace: string): ReturnType<typeof materializePromptPartsImpl>
} = Function.dual(2, materializePromptPartsImpl)

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

export const gitOutput = (arguments_: ReadonlyArray<string>) => {
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

export const childExit = (
  operation: string,
  arguments_: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
) => {
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

export const readChangedFilesEffect = Effect.fn("Main.readChangedFiles")(function* (workspace: string) {
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
    .pipe(
      Effect.mapError((error) =>
        SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({ path: filename, message: String(error) }),
      ),
    )
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
  )
  return SettingsDecoder.Decoder.decodeSettingsInput(filename, value)
})

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

const main = Command.run(command, { version }).pipe(
  Effect.catchTags({
    OperationUnavailable: (error: ProductOperation.OperationUnavailable) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    InvalidInput: (error: ProductOperation.InvalidInput) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  }),
)

const withClientWorkspaceImpl = (input: ProductOperation.Input, workspace: string): ProductOperation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
    input._tag === "Doctor" ||
    input._tag === "Workflow"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

export const withClientWorkspace: {
  (workspace: string): (input: ProductOperation.Input) => ProductOperation.Input
  (input: ProductOperation.Input, workspace: string): ProductOperation.Input
} = Function.dual(2, withClientWorkspaceImpl)

export const interruptTrackedFibers = (fibers: Iterable<Fiber.Fiber<void, never>>) =>
  Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded", discard: true })

export const tuiSignalExitCode = (signal: "SIGINT" | "SIGTERM" | "SIGHUP"): number => {
  if (signal === "SIGINT") return 130
  if (signal === "SIGTERM") return 143
  return 129
}

export const quitStopWorkBound = Duration.seconds(3)

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
  readonly modeRoutes?: (() => ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

export const start = () => {
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
  const paths = resolveProfileDataPaths({
    home,
    hostDataRoot,
    productDatabase: environment.database._tag === "Some" ? environment.database.value : undefined,
    executionDatabase: environment.executionDatabase._tag === "Some" ? environment.executionDatabase.value : undefined,
  })
  const database = paths.database
  const executionDatabase = paths.executionDatabase
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
  let clientModeRoutes: ModeRoutes | undefined
  const clientOwnedInteractiveFunction = interactiveTui({ editor, modeRoutes: () => clientModeRoutes })

  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
              const effectiveConfig = yield* ConfigurationService.effectiveConfiguration().pipe(
                provideLayerScoped(
                  ConfigurationService.memoryConfigurationLayer({
                    global: globalSettings,
                    workspace: workspaceSettings,
                  }),
                ),
              )
              clientModeRoutes = ModelRouteLabel.modeRouteLabels(effectiveConfig.settings) as ModeRoutes
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
                          ProductOperation.OperationUnavailable.make({
                            operation: clientInput._tag,
                            message: "Rika was upgraded; restarting this session",
                          }),
                        ),
                      )
                    let clientKind: ResidentHandshake.Handshake["clientKind"]
                    if (clientInput._tag === "Interactive") clientKind = "interactive"
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
                            Schema.is(ProductOperation.OperationUnavailable)(error)
                              ? error
                              : ProductOperation.OperationUnavailable.make({
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
                    return yield* ProductOperation.OperationUnavailable.make({
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
              Schema.is(ProductOperation.OperationUnavailable)(error)
                ? error
                : ProductOperation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
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
      if (runtimeRestartRequest !== undefined) return onExit(ResidentService.ServiceRuntime.runtimeRestartExitCode)
      Runtime.defaultTeardown(exit, onExit)
    },
  })
}
