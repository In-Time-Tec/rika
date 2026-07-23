#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, Compaction, ModelRegistry, Response as AiResponse } from "@batonfx/core"
import type { TestModel as TestModelTypes } from "@batonfx/test"
import {
  ConfigOperations,
  ContextFileSystem,
  ExtensionOperations,
  Operation,
  ResidentService,
  ResolvedContext,
  ThreadQuery,
  ThreadToolHandlers,
} from "@rika/app"
import { ConfigContract, ConfigService, Models } from "@rika/config"
import { McpOAuth, SkillRegistry } from "@rika/extensions"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ReadWebPage, Runtime as ToolRuntime, ThreadTools, WebSearch, WorkspaceIndex } from "@rika/tools"
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
  Crypto,
  Effect,
  Fiber,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
  Ref,
  References,
  Runtime,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { Command } from "effect/unstable/cli"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import * as BedrockAuthRefresh from "./bedrock-auth-refresh"
import { command, version } from "./command"
import { renderGoodbye } from "./goodbye"
import * as InteractiveController from "./interactive-controller"
import * as Logging from "./logging"
import * as ModelProviderRuntime from "./model-provider-runtime"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { layer as residentLayer } from "./resident-client-transport"
import { maxClientMessageBytes } from "./resident-wire"
import { serve as serveResident } from "./resident-host-transport"
import * as ResidentProcessStartup from "./resident-process-startup"

InteractiveController.installPaletteCommands(Palette.commands as Array<InteractiveController.PaletteCommand>)

const pathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const basename = pathService.basename
const dirname = pathService.dirname
const isAbsolute = pathService.isAbsolute
const join = pathService.join
const relativePathFrom = pathService.relative
const resolve = pathService.resolve
const ignoreSelectionResync = (_threadId: string, _selectionEpoch: number) => {}

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

export const terminalTitleSequence: {
  (title: string, workspace: string): string
  (workspace: string): (title: string) => string
} = Function.dual(
  2,
  (title: string, workspace: string): string =>
    `\u001b]0;${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`,
)

const tuiTraceEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

const traceTuiModelEvent = (seenDeltas: Set<string>, event: Operation.InteractiveEvent) => {
  if (event._tag !== "TranscriptPatched" || !tuiTraceEventTypes.has(event.event.type)) return Effect.void
  const delta = event.event.type.endsWith(".delta")
  const key = `${event.turnId}:${event.event.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo("tui.model.event_applied").pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.event.cursor,
      "rika.event.type": event.event.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.turnId),
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

const fffError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FFF",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const fffGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
    Effect.map((result) => result.items.map((item) => item.relativePath)),
    Effect.mapError((error) => fffError(workspace, error.operation, error)),
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

const resolveWorkspacePathImpl = (workspace: string, target: PathTarget): string => {
  const root = resolve(workspace)
  const path = resolve(root, target.path)
  const relation = relativePathFrom(root, path)
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  )
    throw new Error("Path is outside the workspace")
  return path
}

export const resolveWorkspacePath: {
  (target: PathTarget): (workspace: string) => string
  (workspace: string, target: PathTarget): string
} = Function.dual(2, resolveWorkspacePathImpl)

const resolveWorkspaceFileImpl = Effect.fn("Main.resolveWorkspaceFile")(function* (
  workspace: string,
  target: PathTarget,
) {
  if (target.path.length === 0 || isAbsolute(target.path))
    return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
  const root = yield* realpath(workspace).pipe(
    Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Workspace is unavailable" })),
  )
  const candidate = resolve(root, target.path)
  const lexicalRelation = relativePathFrom(root, candidate)
  if (lexicalRelation === ".." || lexicalRelation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
  const path = yield* realpath(candidate).pipe(
    Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path does not exist" })),
  )
  const relation = relativePathFrom(root, path)
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  )
    return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
  const info = yield* stat(path).pipe(
    Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path is unavailable" })),
  )
  if (info.type !== "File") return yield* WorkspaceFileError.make({ path: target.path, message: "Path is not a file" })
  return path
})

export const resolveWorkspaceFile: {
  (target: PathTarget): (workspace: string) => Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
  (workspace: string, target: PathTarget): Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
} = Function.dual(2, (workspace: string, target: PathTarget) => resolveWorkspaceFileImpl(workspace, target))

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

export class ModelConfigurationError extends Schema.TaggedErrorClass<ModelConfigurationError>()(
  "ModelConfigurationError",
  { message: Schema.String },
) {}

export const validateWebSearchProviders = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const unsupportedIds = RelayExecutionBackend.webSearchFactories(credentials).unsupportedIds
  return unsupportedIds.length === 0
    ? Effect.void
    : ModelConfigurationError.make({
        message: `Unknown web search provider ${unsupportedIds.map((id) => `'${id}'`).join(", ")}`,
      })
}

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()("WorkspaceFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

class ExternalBoundaryError extends Schema.TaggedErrorClass<ExternalBoundaryError>()("ExternalBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

class OperationProductError extends Schema.TaggedErrorClass<OperationProductError>()("OperationError", {
  message: Schema.String,
}) {}

export const maxAttachmentBytes = 5_000_000
const maxPromptPartsBytes = maxClientMessageBytes - 65_536
const attachmentMegabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

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
    const relative = `.rika/pasted/paste-${now()}.png`
    const absolute = `${workspace}/${relative}`
    yield* mkdir(`${workspace}/.rika/pasted`, { recursive: true })
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
  return format === undefined ? undefined : `.rika/pasted/paste-${now()}-${id()}.${format.extension}`
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
    yield* mkdir(`${workspace}/.rika/pasted`, { recursive: true })
    yield* fileSystem.writeFile(`${workspace}/${relative}`, bytes)
    return true
  }).pipe(Effect.orElseSucceed(() => false))

export const persistPastedImage: {
  (relative: string, bytes: Uint8Array): (workspace: string) => ReturnType<typeof persistPastedImageImpl>
  (workspace: string, relative: string, bytes: Uint8Array): ReturnType<typeof persistPastedImageImpl>
} = Function.dual(3, persistPastedImageImpl)

const relayBackendLayerImpl = (
  options: Omit<
    RelayExecutionBackend.LayerOptions<typeof ThreadTools.toolkit.tools>,
    "additionalToolkit" | "additionalHandlerLayer"
  >,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
  transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
): ReturnType<typeof RelayExecutionBackend.layer<typeof ThreadTools.toolkit.tools>> =>
  RelayExecutionBackend.layer({
    ...options,
    additionalToolkit: ThreadTools.toolkit,
    additionalHandlerLayer: ThreadToolHandlers.handlerLayer.pipe(
      Layer.provide(ThreadQuery.layer),
      Layer.provide(Layer.mergeAll(repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer)),
      Layer.catchCause((cause) =>
        Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
      ),
    ),
  })

export const relayBackendLayer: {
  (
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
  ): (
    options: Omit<
      RelayExecutionBackend.LayerOptions<typeof ThreadTools.toolkit.tools>,
      "additionalToolkit" | "additionalHandlerLayer"
    >,
  ) => ReturnType<typeof relayBackendLayerImpl>
  (
    options: Omit<
      RelayExecutionBackend.LayerOptions<typeof ThreadTools.toolkit.tools>,
      "additionalToolkit" | "additionalHandlerLayer"
    >,
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
  ): ReturnType<typeof relayBackendLayerImpl>
} = Function.dual(4, relayBackendLayerImpl)

const testModelPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    params: Schema.Unknown,
    id: Schema.optionalKey(Schema.String),
  }),
])

const testModelUsageSchema = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

const testModelTurnSchema = Schema.Union([
  Schema.Struct({
    parts: Schema.NonEmptyArray(testModelPartSchema),
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    object: Schema.Unknown,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    failure: Schema.String,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
])

const testModelScriptSchema = Schema.NonEmptyArray(testModelTurnSchema)

export const parseTestModelScript = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(testModelScriptSchema))(json)

export const buildTestModelScript: (
  json: string,
) => Effect.Effect<ReadonlyArray<TestModelTypes.Step>, ExternalBoundaryError | Schema.SchemaError> = Effect.fn(
  "Main.buildTestModelScript",
)(function* (json: string) {
  const script = yield* parseTestModelScript(json)
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  return script.map((turn) => {
    const options = {
      ...(turn.delayMs === undefined ? {} : { delay: turn.delayMs }),
      ...(turn.usage === undefined
        ? {}
        : {
            usage: AiResponse.Usage.make({
              inputTokens: {
                uncached: turn.usage.inputTokens,
                total: turn.usage.inputTokens,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: turn.usage.outputTokens,
                text: turn.usage.outputTokens,
                reasoning: undefined,
              },
            }),
          }),
    }
    if ("object" in turn) return TestModel.object(turn.object, options)
    if ("failure" in turn)
      return TestModel.failure(
        AiError.make({
          module: "rika/test-model",
          method: "streamText",
          reason: AiError.UnknownError.make({ description: turn.failure }),
        }),
        options,
      )
    return TestModel.turn(
      turn.parts.map((part) => {
        if (part.type === "text") return TestModel.text(part.text)
        if (part.type === "reasoning") return TestModel.reasoning(part.text)
        return TestModel.toolCall(part.name, part.params, part.id === undefined ? {} : { id: part.id })
      }),
      options,
    )
  })
})

export const makeReloadingTestModel = Effect.fn("Main.makeReloadingTestModel")(function* (path: string) {
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  const load = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const script = yield* fileSystem.readFileString(path)
    return yield* TestModel.make(yield* buildTestModelScript(script))
  })
  const initial = yield* load
  return {
    ...initial,
    registration: {
      ...initial.registration,
      layer: Layer.unwrap(load.pipe(Effect.map((fixture) => fixture.registration.layer))),
    },
  }
})

const modeIds = ["low", "medium", "high", "ultra"] as const
const resolveTunedModeRoute = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  role: ConfigContract.Role,
  tuning?: { readonly fastMode?: boolean },
) => {
  const configured = settings.modes[mode][role]
  const fast = tuning?.fastMode ?? configured.fast ?? false
  const routedSettings: ConfigContract.Settings = {
    ...settings,
    modes: { ...settings.modes, [mode]: { ...settings.modes[mode], [role]: { ...configured, fast } } },
  }
  return ConfigContract.resolveModelRoute(routedSettings, mode, role)
}

const supportingModelRoutes = (settings: ConfigContract.Settings) => [
  ConfigContract.resolveThreadTitleRoute(settings),
  ConfigContract.resolveCompactionSummaryRoute(settings),
]

const modelRoutesForExecutionImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) => [
  resolveTunedModeRoute(settings, mode, "main", tuning),
  resolveTunedModeRoute(settings, mode, "oracle", tuning),
  ...supportingModelRoutes(settings),
]

export const modelRoutesForExecution: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => ReturnType<typeof modelRoutesForExecutionImpl>
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ReturnType<typeof modelRoutesForExecutionImpl>
} = Function.dual((args) => typeof args[0] === "object", modelRoutesForExecutionImpl)

const defaultModelRoutes = (settings: ConfigContract.Settings) => [
  ...modeIds.flatMap((mode) => [
    ConfigContract.resolveModelRoute(settings, mode, "main"),
    ConfigContract.resolveModelRoute(settings, mode, "oracle"),
  ]),
  ...supportingModelRoutes(settings),
]

type PreparedPlan = ModelProviderRuntime.PreparedRoutes["plans"][number]

const executionModelRoute = (
  route: ConfigContract.ResolvedModelRoute,
  plan: PreparedPlan,
  role: Turn.ExecutionModelRoute["role"],
): Turn.ExecutionModelRoute => ({
  role,
  alias: route.alias,
  provider: plan.selection.provider,
  model: plan.selection.model,
  registrationKey: plan.registrationKey,
  providerProtocol: route.providerConnection.protocol,
  providerBaseUrl:
    route.providerConnection.protocol === "amazon-bedrock"
      ? (route.providerConnection.endpoint ?? "bedrock://default")
      : ModelProviderRuntime.normalizedBaseUrl(route.providerConnection.baseUrl),
  ...(route.providerConnection.apiKeyEnv === undefined
    ? {}
    : { providerApiKeyEnv: route.providerConnection.apiKeyEnv }),
  ...(plan.runtime.adapter === "openai-account" && plan.runtime.credentialIdentity !== undefined
    ? { openAiAccountFingerprint: plan.runtime.credentialIdentity }
    : {}),
  providerRuntime: plan.runtime,
  effort: route.effort,
  fast: route.fast,
  requestVariant: plan.registrationKey,
  providerOptions: plan.options,
  compaction: route.compaction,
})

const executionRoutePinFromPreparedImpl = (
  mode: ConfigContract.ModeId,
  prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
): Turn.ExecutionRoutePin => {
  const routes = prepared.routes
  const plans = prepared.plans
  if (routes.length !== 4 || plans.length !== routes.length)
    throw new Error(`Expected four prepared execution routes, received ${routes.length}`)
  return {
    mode,
    main: executionModelRoute(routes[0]!, plans[0]!, "main"),
    oracle: executionModelRoute(routes[1]!, plans[1]!, "oracle"),
    title: executionModelRoute(routes[2]!, plans[2]!, "title"),
    compactionSummary: executionModelRoute(routes[3]!, plans[3]!, "compaction"),
  }
}

export const executionRoutePinFromPrepared: {
  (
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): (mode: ConfigContract.ModeId) => Turn.ExecutionRoutePin
  (
    mode: ConfigContract.ModeId,
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): Turn.ExecutionRoutePin
} = Function.dual(2, executionRoutePinFromPreparedImpl)

const executionRoutePinImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
): Turn.ExecutionRoutePin => {
  const routes = modelRoutesForExecution(settings, mode, tuning)
  return executionRoutePinFromPrepared(mode, {
    routes,
    plans: routes.map((route) => ModelProviderRuntime.modelRoutePlan(route)),
  })
}

export const executionRoutePin: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => Turn.ExecutionRoutePin
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): Turn.ExecutionRoutePin
} = Function.dual((args) => typeof args[0] === "object", executionRoutePinImpl)

export const resolveExecutionRouteForSettings = Effect.fn("Main.resolveExecutionRouteForSettings")(function* (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) {
  return yield* Effect.try({
    try: () => ({
      routes: modelRoutesForExecution(settings, mode, tuning),
      executionRoute: executionRoutePin(settings, mode, tuning),
    }),
    catch: (cause) =>
      Schema.is(ConfigContract.ModelRouteError)(cause)
        ? cause
        : ModelConfigurationError.make({ message: `Could not resolve model route: ${String(cause)}` }),
  })
})

export const productionCompaction = (
  route?: Pick<ConfigContract.ResolvedModelRoute, "compaction">,
): Compaction.DefaultOptions => ({
  contextWindow: route?.compaction.contextWindow ?? Models.defaultCompaction.contextWindow,
  reserveTokens: route?.compaction.reserveTokens ?? Models.defaultCompaction.reserveTokens,
  keepRecentTokens: route?.compaction.keepRecentTokens ?? Models.defaultCompaction.keepRecentTokens,
})

const registrationTuple = (candidate: {
  readonly provider: string
  readonly model: string
  readonly registrationKey?: string
}) => `${candidate.provider}\0${candidate.model}\0${candidate.registrationKey ?? ""}`

export interface PersistedRouteRegistrationFailure {
  readonly route: Turn.ExecutionModelRoute
  readonly message: string
}

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return failure instanceof Error ? failure.message : String(failure)
}

export const executionModelRoutes = (route: Turn.ExecutionRoutePin): ReadonlyArray<Turn.ExecutionModelRoute> => [
  route.main,
  route.oracle,
  ...(route.title === undefined ? [] : [route.title]),
  ...(route.compactionSummary === undefined ? [] : [route.compactionSummary]),
]

export const isLegacyUnavailableExecutionRoute = (route: Turn.ExecutionRoutePin) =>
  executionModelRoutes(route).some((candidate) => candidate.registrationKey === "legacy-unavailable")

const unavailableRouteError = (failure: PersistedRouteRegistrationFailure) =>
  ExecutionBackend.BackendError.make({
    message: `Model route ${failure.route.alias}/${failure.route.effort}${failure.route.fast ? "/fast" : ""} is unavailable: ${failure.message}`,
  })

export const resolveExecutionWorkspace = Effect.fn("Main.resolveExecutionWorkspace")(function* (
  durableExecutionId: string,
  _defaultWorkspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
) {
  const program = Effect.gen(function* () {
    const turnId = RelayExecutionBackend.turnIdFromExecutionId(durableExecutionId)
    const executionWorkspace = RelayExecutionBackend.workspaceFromExecutionId(durableExecutionId)
    if (executionWorkspace !== undefined) return executionWorkspace
    if (turnId === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Execution ${durableExecutionId} is not attached to a Rika Turn`,
      })
    const turns = yield* TurnRepository.Service
    const turn = yield* turns.get(Turn.TurnId.make(turnId))
    if (turn === undefined)
      return yield* ExecutionBackend.BackendError.make({ message: `Turn ${turnId} does not exist` })
    const threads = yield* ThreadRepository.Service
    const thread = yield* threads.get(turn.threadId)
    if (thread === undefined)
      return yield* ExecutionBackend.BackendError.make({ message: `Thread ${turn.threadId} does not exist` })
    return thread.workspace
  })
  return yield* program.pipe(
    provideLayerScoped(Layer.merge(repositoryLayer, turnRepositoryLayer)),
    Effect.mapError((cause) =>
      Schema.is(ExecutionBackend.BackendError)(cause)
        ? cause
        : ExecutionBackend.BackendError.make({ message: String(cause) }),
    ),
  )
})

export const withPinnedRouteRegistration = Effect.fn("Main.withPinnedRouteRegistration")(function* (
  backend: ExecutionBackend.Interface,
  options: {
    readonly registeredRoutes: ReadonlyArray<{
      readonly provider: string
      readonly model: string
      readonly registrationKey?: string
    }>
    readonly unavailable: ReadonlyArray<PersistedRouteRegistrationFailure>
    readonly registerPinnedRoutes: (
      routes: ReadonlyArray<Turn.ExecutionModelRoute>,
    ) => Effect.Effect<ReadonlyArray<ModelRegistry.Registration>, ModelProviderRuntime.RuntimeError>
    readonly resolveLegacyRoute?: (input: ExecutionBackend.StartInput) => Effect.Effect<
      {
        readonly executionRoute: Turn.ExecutionRoutePin
        readonly registrations: ReadonlyArray<ModelRegistry.Registration>
      },
      ExecutionBackend.BackendError
    >
  },
) {
  const admission = yield* Semaphore.make(1)
  const registered = new Set(options.registeredRoutes.map(registrationTuple))
  const unavailable = new Map(options.unavailable.map((failure) => [registrationTuple(failure.route), failure]))
  const backendRegisterModels = backend.registerModels
  const registerModelsUnlocked =
    backendRegisterModels === undefined
      ? undefined
      : (registrations: ReadonlyArray<ModelRegistry.Registration>) =>
          backendRegisterModels(registrations).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const registration of registrations) registered.add(registrationTuple(registration))
              }),
            ),
          )
  const registerModels =
    registerModelsUnlocked === undefined
      ? undefined
      : (registrations: ReadonlyArray<ModelRegistry.Registration>) =>
          admission.withPermits(1)(
            Effect.gen(function* () {
              const missing = registrations.filter((registration) => !registered.has(registrationTuple(registration)))
              if (missing.length > 0) yield* registerModelsUnlocked(missing)
            }),
          )
  const register = (route: Turn.ExecutionRoutePin) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const missing = executionModelRoutes(route).filter(
          (candidate, index, all) =>
            candidate.providerProtocol !== "test" &&
            !registered.has(registrationTuple(candidate)) &&
            all.findIndex((other) => registrationTuple(other) === registrationTuple(candidate)) === index,
        )
        const blocked = missing.map((candidate) => unavailable.get(registrationTuple(candidate))).find(Boolean)
        if (blocked !== undefined) return yield* unavailableRouteError(blocked)
        if (missing.length === 0) return
        if (registerModelsUnlocked === undefined)
          return yield* ExecutionBackend.BackendError.make({
            message: `Model route ${missing[0]!.alias}/${missing[0]!.effort} is unavailable: the backend cannot register models`,
          })
        const registrations = yield* options.registerPinnedRoutes(missing).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(unavailableRouteError({ route: missing[0]!, message: causeMessage(cause) })),
            onSuccess: Effect.succeed,
          }),
        )
        yield* registerModelsUnlocked(registrations)
        for (const candidate of missing) registered.add(registrationTuple(candidate))
      }),
    )
  return ExecutionBackend.Service.of({
    ...backend,
    ...(registerModels === undefined ? {} : { registerModels }),
    start: (input) =>
      Effect.gen(function* () {
        let resolved
        if (isLegacyUnavailableExecutionRoute(input.executionRoute)) {
          if (options.resolveLegacyRoute === undefined)
            return yield* ExecutionBackend.BackendError.make({
              message: `Turn ${input.turnId} uses the legacy unavailable model route and cannot be started`,
            })
          resolved = yield* options.resolveLegacyRoute(input)
        } else {
          resolved = { executionRoute: input.executionRoute, registrations: [] }
        }
        if (resolved.registrations.length > 0) {
          if (registerModels === undefined)
            return yield* ExecutionBackend.BackendError.make({
              message: `Turn ${input.turnId} resolved a model route that the backend cannot register`,
            })
          yield* registerModels(resolved.registrations)
        }
        yield* register(resolved.executionRoute)
        return yield* backend.start({ ...input, executionRoute: resolved.executionRoute })
      }),
  })
})

export interface ConfiguredBackendOptions {
  readonly filename: string
  readonly workspace: string
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>
  readonly transcriptRepositoryLayer: Layer.Layer<
    TranscriptRepository.Service,
    TranscriptRepository.RepositoryError,
    never
  >
  readonly settings?: ConfigContract.Settings
  readonly persistedModelRoutes?: ReadonlyArray<Turn.ExecutionModelRoute>
  readonly webSearchCredentials?: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly resolveLegacyRoute?: (input: ExecutionBackend.StartInput) => Effect.Effect<
    {
      readonly executionRoute: Turn.ExecutionRoutePin
      readonly registrations: ReadonlyArray<ModelRegistry.Registration>
    },
    ExecutionBackend.BackendError
  >
  readonly shellPermission?: ConfigContract.PermissionDecision
  readonly globalSettings?: ConfigContract.SettingsInput
}

export const configuredBackendLayer = ({
  filename,
  workspace,
  repositoryLayer,
  turnRepositoryLayer,
  transcriptRepositoryLayer,
  settings = ConfigContract.defaults,
  persistedModelRoutes = [],
  webSearchCredentials = {},
  resolveLegacyRoute,
  shellPermission,
  globalSettings = {},
}: ConfiguredBackendOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* mkdir(dirname(filename), { recursive: true })
      const route = ConfigContract.resolveModelRoute(settings, "medium", "main")
      const resolvedOracleRoute = ConfigContract.resolveModelRoute(settings, "medium", "oracle")
      const resolvedCompactionSummaryRoute = ConfigContract.resolveCompactionSummaryRoute(settings)
      const configuredRoutes = defaultModelRoutes(settings)
      const testResponse = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
      const testScript = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
      const testApprovalTools = yield* Config.option(Config.string("RIKA_TEST_APPROVAL_TOOLS"))
      const testMediaAnalyzerResponse = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE"))
      const testMediaAnalyzerError = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR"))
      const effectiveConfigForWorkspace = (runtimeWorkspace: string) =>
        Effect.gen(function* () {
          const runtimeSettings = yield* loadSettingsFile(`${runtimeWorkspace}/.rika/settings.json`)
          return yield* ConfigService.effective().pipe(
            provideLayerScoped(
              ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: runtimeSettings,
              }),
            ),
          )
        }).pipe(provideLayerScoped(BunServices.layer))
      if (testResponse._tag === "Some" && testScript._tag === "Some") {
        return yield* ModelConfigurationError.make({
          message: "RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set",
        })
      }
      if (testMediaAnalyzerResponse._tag === "Some" && testMediaAnalyzerError._tag === "Some") {
        return yield* ModelConfigurationError.make({
          message: "RIKA_TEST_MEDIA_ANALYZER_RESPONSE and RIKA_TEST_MEDIA_ANALYZER_ERROR cannot both be set",
        })
      }
      let backendKind: "test-script" | "test-response" | "provider"
      if (testScript._tag === "Some") backendKind = "test-script"
      else if (testResponse._tag === "Some") backendKind = "test-response"
      else backendKind = "provider"
      yield* Effect.logInfo("model.backend.configured").pipe(
        Effect.annotateLogs("rika.model.backend.kind", backendKind),
      )
      let registration: ModelRegistry.Registration
      let selection: ModelRegistry.ModelSelection
      let additionalRegistrations: Array<ModelRegistry.Registration> = []
      let unavailablePersistedRoutes: ReadonlyArray<PersistedRouteRegistrationFailure> = []
      let modelVariantPolicy: RelayExecutionBackend.ModelVariantPolicy = "registration-key"
      let providerPlans:
        | {
            readonly routePlan: PreparedPlan
            readonly oracleRoutePlan: PreparedPlan
            readonly compactionSummaryPlan: PreparedPlan
          }
        | undefined
      if (testScript._tag === "Some") {
        const { TestModel } = yield* Effect.tryPromise({
          try: () => import("@batonfx/test"),
          catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
        })
        const fixture = yield* TestModel.make(yield* buildTestModelScript(testScript.value))
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else if (testResponse._tag === "Some") {
        const { TestModel } = yield* Effect.tryPromise({
          try: () => import("@batonfx/test"),
          catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
        })
        const fixture = yield* TestModel.make(Array.from({ length: 4 }, () => TestModel.text(testResponse.value)))
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else {
        const runtime = yield* ModelProviderRuntime.Service
        const prepared = yield* runtime
          .prepare(configuredRoutes)
          .pipe(Effect.mapError((error) => ModelConfigurationError.make({ message: error.message })))
        const configuredKeys = new Set(prepared.registrations.map(registrationTuple))
        const persistedRoutesToRestore = persistedModelRoutes.filter((candidate, index, all) => {
          const tuple = registrationTuple(candidate)
          return !configuredKeys.has(tuple) && all.findIndex((other) => registrationTuple(other) === tuple) === index
        })
        const restored = yield* Effect.forEach(
          persistedRoutesToRestore,
          (persistedRoute) =>
            runtime.restoreOne(persistedRoute).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("model.route.persisted.unavailable").pipe(
                        Effect.annotateLogs({
                          "rika.model.alias": persistedRoute.alias,
                          "rika.model.provider": persistedRoute.provider,
                          "rika.model.name": persistedRoute.model,
                          "rika.model.registration_key": persistedRoute.registrationKey,
                          "rika.failure.kind": failureKind(cause),
                        }),
                        Effect.as({
                          _tag: "Unavailable" as const,
                          route: persistedRoute,
                          message: causeMessage(cause),
                        }),
                      ),
                onSuccess: (value) => Effect.succeed({ _tag: "Registered" as const, registration: value }),
              }),
            ),
          { concurrency: 1 },
        )
        unavailablePersistedRoutes = restored.flatMap((result) => (result._tag === "Unavailable" ? [result] : []))
        const registrations = [
          ...prepared.registrations,
          ...restored.flatMap((result) => (result._tag === "Registered" ? [result.registration] : [])),
        ]
        const planFor = (resolved: ConfigContract.ResolvedModelRoute) => {
          const index = prepared.routes.findIndex(
            (candidate) =>
              candidate.alias === resolved.alias &&
              candidate.effort === resolved.effort &&
              candidate.fast === resolved.fast,
          )
          if (index < 0) throw new Error(`Missing prepared plan for ${resolved.alias}`)
          return prepared.plans[index]!
        }
        const routePlan = planFor(route)
        const oracleRoutePlan = planFor(resolvedOracleRoute)
        const compactionSummaryPlan = planFor(resolvedCompactionSummaryRoute)
        if (registrations.length === 0)
          return yield* ModelConfigurationError.make({ message: "No configured model routes could be registered" })
        registration = registrations[0]!
        additionalRegistrations = registrations.slice(1)
        selection = routePlan.selection
        providerPlans = { routePlan, oracleRoutePlan, compactionSummaryPlan }
      }
      const backendLayer = relayBackendLayer(
        {
          filename,
          workspace,
          registration,
          ...(additionalRegistrations.length === 0 ? {} : { additionalRegistrations }),
          selection,
          oracleSelection:
            testScript._tag === "Some" || testResponse._tag === "Some"
              ? selection
              : providerPlans!.oracleRoutePlan.selection,
          compactionSummarySelection:
            testScript._tag === "Some" || testResponse._tag === "Some"
              ? selection
              : providerPlans!.compactionSummaryPlan.selection,
          modelVariantPolicy,
          ...(shellPermission === undefined
            ? {}
            : {
                permissionPolicy: {
                  rules: [
                    { pattern: "*", level: "allow" },
                    { pattern: "bash", level: shellPermission },
                  ],
                },
              }),
          compaction: providerPlans?.routePlan.compaction ?? productionCompaction(route),
          oracleCompaction: providerPlans?.oracleRoutePlan.compaction ?? productionCompaction(resolvedOracleRoute),
          ...(providerPlans === undefined ? {} : { modelResilience: RelayExecutionBackend.defaultModelResilience }),
          webSearchCredentialsForWorkspace: (runtimeWorkspace) =>
            effectiveConfigForWorkspace(runtimeWorkspace).pipe(
              Effect.flatMap((config) =>
                validateWebSearchProviders(config.environment.webSearchCredentials).pipe(
                  Effect.as(config.environment.webSearchCredentials),
                ),
              ),
              Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
            ),
          toolRuntimeLayerForWorkspace: (runtimeWorkspace) =>
            Layer.unwrap(
              effectiveConfigForWorkspace(runtimeWorkspace).pipe(
                Effect.flatMap((config) => {
                  const credentials = config.environment.webSearchCredentials
                  const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
                  return validateWebSearchProviders(credentials).pipe(
                    Effect.as(
                      ToolRuntime.layerWithProcessRegistry(runtimeWorkspace).pipe(
                        Layer.provide(
                          testMediaAnalyzerResponse._tag === "Some"
                            ? MediaView.analyzerTestLayer(() => Effect.succeed(testMediaAnalyzerResponse.value))
                            : MediaView.analyzerTestLayer(() =>
                                Effect.fail(
                                  MediaView.MediaAnalysisError.make({
                                    message:
                                      testMediaAnalyzerError._tag === "Some"
                                        ? testMediaAnalyzerError.value
                                        : "Media analysis is unavailable",
                                  }),
                                ),
                              ),
                        ),
                        Layer.provide(
                          Layer.merge(
                            WebSearch.factoryLayer(RelayExecutionBackend.webSearchFactories(credentials).factories),
                            ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                          ).pipe(Layer.provide(FetchHttpClient.layer)),
                        ),
                        Layer.provide(BunServices.layer),
                        Layer.catchCause((cause) =>
                          Layer.effectContext(
                            Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) })),
                          ),
                        ),
                      ),
                    ),
                  )
                }),
                Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
              ),
            ),
          resolveWorkspace: (durableExecutionId) =>
            resolveExecutionWorkspace(durableExecutionId, workspace, repositoryLayer, turnRepositoryLayer),
          permissionPolicyForExecution: (durableExecutionId) =>
            Effect.gen(function* () {
              const executionWorkspace = yield* resolveExecutionWorkspace(
                durableExecutionId,
                workspace,
                repositoryLayer,
                turnRepositoryLayer,
              )
              const workspaceSettings = yield* loadSettingsFile(`${executionWorkspace}/.rika/settings.json`)
              const layer = ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: workspaceSettings,
              })
              const config = yield* ConfigService.effective().pipe(provideLayerScoped(layer))
              return {
                rules: [
                  { pattern: "*", level: "allow" as const },
                  {
                    pattern: "bash",
                    level: config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!,
                  },
                ],
              }
            }).pipe(
              provideLayerScoped(BunServices.layer),
              Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
            ),
          ...(testApprovalTools._tag === "Some" && (testScript._tag === "Some" || testResponse._tag === "Some")
            ? { toolNeedsApproval: (name: string) => testApprovalTools.value.split(",").includes(name) }
            : {}),
          webSearchCredentials,
        },
        repositoryLayer,
        turnRepositoryLayer,
        transcriptRepositoryLayer,
      ).pipe(Layer.provide(BunCrypto.layer))
      if (testScript._tag === "Some" || testResponse._tag === "Some") return backendLayer
      return Layer.effect(
        ExecutionBackend.Service,
        ExecutionBackend.Service.pipe(
          Effect.flatMap((backend) =>
            ModelProviderRuntime.Service.pipe(
              Effect.flatMap((runtime) =>
                withPinnedRouteRegistration(backend, {
                  registeredRoutes: [registration, ...additionalRegistrations],
                  unavailable: unavailablePersistedRoutes,
                  registerPinnedRoutes: runtime.restore,
                  ...(resolveLegacyRoute === undefined ? {} : { resolveLegacyRoute }),
                }),
              ),
            ),
          ),
        ),
      ).pipe(Layer.provide(backendLayer))
    }),
  ).pipe(Layer.provide(BunServices.layer))

export const lazyBackendLayer = (
  backendLayer: Layer.Layer<ExecutionBackend.Service, Layer.Error<ReturnType<typeof configuredBackendLayer>>>,
) =>
  Layer.effect(
    ExecutionBackend.Service,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const active = yield* Ref.make<ExecutionBackend.Interface | undefined>(undefined)
      const promoter = yield* Ref.make<ExecutionBackend.TurnPromoter | undefined>(undefined)
      const load = yield* Effect.cached(
        Effect.forkIn(
          Layer.buildWithScope(backendLayer, scope).pipe(
            Effect.map((context) => Context.get(context, ExecutionBackend.Service)),
            Effect.tap((backend) => Ref.set(active, backend)),
            Effect.tap((backend) =>
              Ref.get(promoter).pipe(
                Effect.flatMap((registered) =>
                  registered === undefined || backend.registerTurnPromoter === undefined
                    ? Effect.void
                    : backend.registerTurnPromoter(registered),
                ),
              ),
            ),
            Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: String(cause) })),
          ),
          scope,
        ).pipe(Effect.flatMap(Fiber.join), Effect.uninterruptible),
      )
      return ExecutionBackend.Service.of({
        registerModels: (registrations) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.registerModels === undefined ? Effect.void : backend.registerModels(registrations),
            ),
          ),
        invokeChild: (input) => load.pipe(Effect.flatMap((backend) => backend.invokeChild(input))),
        createFanOut: (input) => load.pipe(Effect.flatMap((backend) => backend.createFanOut(input))),
        inspectFanOut: (fanOutId) => load.pipe(Effect.flatMap((backend) => backend.inspectFanOut(fanOutId))),
        cancelFanOut: (fanOutId, cancelledAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelFanOut(fanOutId, cancelledAt, reason))),
        registerWorkflows: () => load.pipe(Effect.flatMap((backend) => backend.registerWorkflows())),
        startWorkflow: (name, runId, revision, ownerTurnId, workflowWorkspace) =>
          load.pipe(
            Effect.flatMap((backend) => backend.startWorkflow(name, runId, revision, ownerTurnId, workflowWorkspace)),
          ),
        inspectWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.inspectWorkflow(runId, ownerTurnId, workflowWorkspace))),
        cancelWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelWorkflow(runId, ownerTurnId, workflowWorkspace))),
        wakeThreadHost: (wake) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.wakeThreadHost === undefined ? Effect.void : backend.wakeThreadHost(wake),
            ),
          ),
        registerTurnPromoter: (registered) =>
          Ref.set(promoter, registered).pipe(
            Effect.andThen(Ref.get(active)),
            Effect.flatMap((backend) =>
              backend?.registerTurnPromoter === undefined ? Effect.void : backend.registerTurnPromoter(registered),
            ),
          ),
        start: (input) => load.pipe(Effect.flatMap((backend) => backend.start(input))),
        follow: (turnId, afterCursor, onEvent, reference, eventScope) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.follow === undefined
                ? backend.replay(turnId, afterCursor, reference)
                : backend.follow(turnId, afterCursor, onEvent, reference, eventScope),
            ),
          ),
        replay: (turnId, afterCursor, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.replay(turnId, afterCursor, reference))),
        pageEvents: (turnId, direction, cursor, limit, reference) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.pageEvents === undefined
                ? backend
                    .replay(turnId, cursor, reference)
                    .pipe(Effect.map((result) => ({ events: result.events, hasMore: false })))
                : backend.pageEvents(turnId, direction, cursor, limit, reference),
            ),
          ),
        cancel: (turnId, cancelledAt, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.cancel(turnId, cancelledAt, reference))),
        inspect: (turnId, reference) => load.pipe(Effect.flatMap((backend) => backend.inspect(turnId, reference))),
        steer: (turnId, text, createdAt, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.steer(turnId, text, createdAt, reference))),
        listApprovals: (turnId, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.listApprovals(turnId, reference))),
        resolveToolApproval: (waitId, approved, resolvedAt, comment) =>
          load.pipe(Effect.flatMap((backend) => backend.resolveToolApproval(waitId, approved, resolvedAt, comment))),
        resolvePermission: (waitId, answer, resolvedAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.resolvePermission(waitId, answer, resolvedAt, reason))),
      })
    }),
  )

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
  if (input._tag === "Mcp" && input.action === "approve")
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

export const persistedModelRoutesForStartup = (turns: ReadonlyArray<Turn.Turn>) =>
  turns.flatMap((turn) => executionModelRoutes(turn.executionRoute))

const persistedExecutionRouteRow = Schema.Struct({ execution_route_json: Schema.String })
const persistedExecutionRouteJson = Schema.fromJsonString(Turn.ExecutionRoutePin)

export const persistedTitleModelRoutesForStartup = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT execution_route_json FROM rika_turns`
  const routes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(persistedExecutionRouteRow)(row).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeUnknownEffect(persistedExecutionRouteJson)(decoded.execution_route_json),
      ),
    ),
  )
  return routes.flatMap((route) => (route.title === undefined ? [] : [route.title]))
}).pipe(Effect.withSpan("Main.persistedTitleModelRoutesForStartup"))

const canonicalDatabaseRootImpl = Effect.fn("Main.canonicalDatabaseRoot")(function* (
  productDatabase: string,
  relayDatabase: string,
) {
  if (basename(productDatabase) !== "rika.db" || basename(relayDatabase) !== "relay.db")
    return yield* ExternalBoundaryError.make({
      operation: "canonicalize database root",
      message: "RIKA_DATABASE and RIKA_RELAY_DATABASE must name rika.db and relay.db in one data directory",
    })
  const productRoot = dirname(resolve(productDatabase))
  const relayRoot = dirname(resolve(relayDatabase))
  yield* Effect.all([mkdir(productRoot, { recursive: true }), mkdir(relayRoot, { recursive: true })], {
    concurrency: 2,
  })
  const [canonicalProductRoot, canonicalRelayRoot] = yield* Effect.all([realpath(productRoot), realpath(relayRoot)], {
    concurrency: 2,
  })
  if (canonicalProductRoot !== canonicalRelayRoot)
    return yield* ExternalBoundaryError.make({
      operation: "canonicalize database root",
      message: "RIKA_DATABASE and RIKA_RELAY_DATABASE must use one data directory",
    })
  return canonicalProductRoot
})

export const canonicalDatabaseRoot: {
  (relayDatabase: string): (productDatabase: string) => ReturnType<typeof canonicalDatabaseRootImpl>
  (productDatabase: string, relayDatabase: string): ReturnType<typeof canonicalDatabaseRootImpl>
} = Function.dual(2, canonicalDatabaseRootImpl)

export const interruptTrackedFibers = (fibers: Iterable<Fiber.Fiber<void, never>>) =>
  Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded", discard: true })

export const tuiSignalExitCode = (signal: "SIGINT" | "SIGTERM"): number => (signal === "SIGINT" ? 130 : 143)

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
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
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
      return yield* Effect.callback<void, Operation.OperationUnavailable>((resume) => {
        let model = ViewState.initial(input.workspace ?? process.cwd(), input.mode ?? "medium")
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
        let transcriptProjections = new Map<string, Transcript.Projection>()
        let attachedChildRevisions: ReadonlyMap<string, number> | undefined
        let threadCostUsd: number | undefined
        const appliedDeltas = new Set<string>()
        let activeSelectionEpoch = 0
        let submissionSequence = 0
        const fibers = new Set<Fiber.Fiber<void, never>>()
        let selectionFiber: Fiber.Fiber<void, never> | undefined
        let selectionGeneration = 0
        let renderSuppressed = false
        let loadingOlder = false
        const selectionResyncs = new Set<string>()
        let requestSelectionResync = ignoreSelectionResync
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
            event._tag === "TranscriptReplaced" ||
            event._tag === "TranscriptPagePrepended" ||
            event._tag === "TranscriptPatched" ||
            event._tag === "TranscriptResyncRequired" ||
            event._tag === "ThreadUsageUpdated"
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
                projections: transcriptProjections,
                ...(attachedChildRevisions === undefined ? {} : { attachedChildRevisions }),
                ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
              },
              event,
            )
            model = controlled.state.model
            activeSelectionEpoch = controlled.state.selectionEpoch
            replayTurns = new Map(controlled.state.replayTurns)
            loadedTranscriptEntries = controlled.state.entries
            projectionRevisions = new Map(controlled.state.revisions)
            transcriptProjections = new Map(controlled.state.projections)
            attachedChildRevisions = controlled.state.attachedChildRevisions
            threadCostUsd = controlled.state.threadCostUsd
            if (
              event._tag === "SelectionLoaded" &&
              model.currentThreadId === event.thread.id &&
              (model.currentThreadId !== previousThreadId || model.currentThreadTitle !== previousThreadTitle)
            )
              process.stdout.write(terminalTitleSequence(event.thread.title, model.workspace))
            if (event._tag === "TranscriptPatched" && event.event.type === "steering.delivered") {
              const rawSequences = event.event.data?.message_sequences
              const sequences = Array.isArray(rawSequences)
                ? rawSequences.filter((value): value is number => typeof value === "number")
                : []
              if (sequences.length > 0)
                model = ViewState.update(model, { _tag: "SteeringDelivered", turnId: event.turnId, sequences })
            }
            if (event._tag === "TranscriptPatched") fork(traceTuiModelEvent(appliedDeltas, event))
            if (event._tag === "TranscriptResyncRequired" && model.currentThreadId !== undefined)
              requestSelectionResync(model.currentThreadId, event.selectionEpoch)
            if (controlled.preserveAnchor) {
              if (applyingFeedBatch) feedPreserveAnchor = true
              else renderer?.surface.update(model, true)
            } else
              render(
                event._tag === "TranscriptResyncRequired" ||
                  (event._tag === "TranscriptPatched" &&
                    (event.event.type === "execution.completed" ||
                      event.event.type === "execution.failed" ||
                      event.event.type === "execution.cancelled" ||
                      event.event.type === "permission.ask.requested" ||
                      event.event.type === "tool.approval.requested")),
              )
            if (selectionStartedAt !== undefined && event._tag === "SelectionLoaded")
              fork(
                Effect.logInfo("tui.selection.applied").pipe(
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
              if (updated.resync) requestSelectionResync(event.threadId, event.selectionEpoch)
            }
          } else if (event._tag === "QueueResyncRequired") {
            if (
              event.selectionEpoch === activeSelectionEpoch &&
              (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
            )
              requestSelectionResync(event.threadId, event.selectionEpoch)
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
              transcriptProjections.set(event.turn.id, Transcript.empty(event.turn.id, event.turn.prompt))
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
          } else if (event._tag === "ShellPermissionRequested") {
            model = ViewState.update(model, {
              _tag: "BlockAdded",
              block: {
                _tag: "Permission",
                id: event.id,
                kind: "permission",
                title: "Run shell command",
                detail: event.command,
                status: "pending",
              },
            })
          } else if (event._tag === "ShellPermissionCancelled") {
            model = ViewState.update(model, { _tag: "PermissionCancelled", id: event.id })
          } else if (event._tag === "ShellCompleted") {
            model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
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
            if (model.currentThreadId === event.threadId)
              process.stdout.write(terminalTitleSequence(event.title, model.workspace))
          } else if (event._tag === "ThreadActivated") {
            model = ViewState.update(model, {
              _tag: "ThreadActivated",
              threadId: event.threadId,
              title: event.title,
            })
            if (model.currentThreadId === event.threadId)
              process.stdout.write(terminalTitleSequence(event.title, model.workspace))
          } else if (event._tag === "ThreadPreviewLoaded") {
            if (model.threadSwitcher.open && ViewState.selectedThreadMetadata(model)?.id === event.threadId)
              model = ViewState.update(model, {
                _tag: "ThreadPreviewLoaded",
                threadId: event.threadId,
                turns: event.turns,
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
          lane: (event) =>
            event._tag === "TranscriptPatched" ? `${String(event.threadId)}:${String(event.turnId)}` : undefined,
          urgent: InteractiveController.isUrgentFeedEvent,
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
          process.stdout.write(
            renderGoodbye({
              mode: model.mode,
              workspace: model.workspace,
              ...(threadId === undefined ? {} : { threadId }),
              ...(threadTitle === undefined ? {} : { threadTitle }),
            }),
          )
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
              process.off("SIGTSTP", suspend)
              process.off("SIGCONT", continueFromSuspend)
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
        const close = (exitCode?: number) => {
          if (closing) return
          closing = true
          if (exitCode !== undefined) process.exitCode = exitCode
          fork(teardown(true).pipe(Effect.andThen(Effect.sync(() => resume(Effect.void)))))
        }
        const interrupt = () => close(tuiSignalExitCode("SIGINT"))
        const terminate = () => close(tuiSignalExitCode("SIGTERM"))
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
              ? session.shell(classified.command, classified.incognito)
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
                const relative = `.rika/compose-${now}.md`
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
            resolveWorkspaceFileImpl(model.workspace, target).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  Effect.sync(() => {
                    renderer?.surface.showToast("Refusing to open a path outside the workspace", "#e06c75")
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
          decidePermission: (id, kind, decision) => run(session.resolvePermission(id, kind, decision)),
          selectThread: (id) => {
            startSelection((epoch) => session.selectThread(id, epoch))
          },
        }
        const consumePendingAction = () => {
          const action = model.pendingAction
          const paletteCommand = InteractiveController.paletteCommand(action)
          if (paletteCommand?._tag === "NewThread") startSelection(() => session.newThread)
          else if (action !== undefined) Session.execute(adapter, action as Session.Action)
          model = ViewState.update(model, { _tag: "PaletteActionConsumed" })
        }
        initialization = fork(
          settleTuiInitialization(
            createTui({
              ...(options.makeRenderer === undefined ? {} : { makeRenderer: options.makeRenderer }),
              openPath,
              scroll: (offset) => {
                model = ViewState.update(model, { _tag: "ScrollMoved", offset })
                if (offset <= 0 && !loadingOlder) {
                  loadingOlder = true
                  run(
                    session.loadOlder.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          loadingOlder = false
                        }),
                      ),
                    ),
                  )
                }
              },
              scrollGeometry: (offset) => {
                model = ViewState.update(model, { _tag: "ScrollMoved", offset })
              },
              scrollFollow: () => {
                model = ViewState.update(model, { _tag: "ScrollFollowed" })
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
                  usageDisplay: model.usageDisplay === "tokens" ? "cost" : "tokens",
                }
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
                  fffGlob(model.workspace, "**/*", 10_000).pipe(
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
                  if (input.last === true)
                    return Effect.sync(() => startSelection((epoch) => session.reopenThread(epoch))).pipe(
                      Effect.flatMap(Fiber.join),
                    )
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

if (import.meta.main) {
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
      relayDatabase: Config.option(Config.string("RIKA_RELAY_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
      residentHost: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_HOST")),
      runtimeRestarted: Config.option(Config.string("RIKA_INTERNAL_RUNTIME_RESTARTED")),
      restartThread: Config.option(Config.string("RIKA_INTERNAL_RESTART_THREAD")),
    }),
  )
  const runtimeRestarted = environment.runtimeRestarted._tag === "Some" && environment.runtimeRestarted.value === "1"
  const restartThreadId = environment.restartThread._tag === "Some" ? environment.restartThread.value : undefined
  let runtimeRestartRequested = false
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  let database: string
  let relayDatabase: string
  if (hostDataRoot === undefined) {
    database = environment.database._tag === "Some" ? environment.database.value : `${defaultDataRoot}/rika.db`
    relayDatabase =
      environment.relayDatabase._tag === "Some" ? environment.relayDatabase.value : `${defaultDataRoot}/relay.db`
  } else {
    database = join(hostDataRoot, "rika.db")
    relayDatabase = join(hostDataRoot, "relay.db")
  }
  const globalConfig = `${home}/.config/rika/settings.json`
  const workspaceConfig = `${process.cwd()}/.rika/settings.json`
  const extensionLayer = Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: `${home}/.config/rika/skills`,
      workspaceRoot: `${process.cwd()}/.rika/skills`,
      configPath: `${process.cwd()}/.rika/mcp.json`,
      trustPath: `${home}/.config/rika/mcp-trust.json`,
      generationsPath: `${process.cwd()}/.rika/extensions.json`,
    }),
    SkillRegistry.fileSystemLayer,
    McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostLayer),
      Layer.provide(McpOAuth.tokenStoreLayer(`${home}/.config/rika/mcp-oauth.json`)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
  const profile = environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default"
  const profileIdentity = createHash("sha256").update(profile).digest("hex")
  const openAiAuthLayer = OpenAiAuthAdapter.layer.pipe(
    Layer.provide(
      OpenAiCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openai.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )
  const authOperations: Operation.AuthOperationOptions = {
    layer: openAiAuthLayer,
    assertOpenAiDirect: (workspace) =>
      Effect.gen(function* () {
        const globalSettings = yield* loadSettingsFile(globalConfig)
        const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
        const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({
          webProviders: WebSearch.providerRegistry,
          global: globalSettings,
          workspace: settings,
        })
        const resolved = yield* ConfigService.effective().pipe(provideLayerScoped(workspaceConfigLayer))
        if (resolved.settings.providers.openai?.baseUrl !== ConfigContract.defaults.providers.openai?.baseUrl) {
          return yield* OperationProductError.make({
            message:
              "OpenAI account login cannot be used while providers.openai.baseUrl is customized; remove the override first",
          })
        }
      }).pipe(
        provideLayerScoped(BunServices.layer),
        Effect.mapError((error) =>
          Schema.is(OperationProductError)(error) ? error : OperationProductError.make({ message: String(error) }),
        ),
      ),
  }
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
  const productDatabase = Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.all(
        [mkdir(dirname(database), { recursive: true }), mkdir(dirname(relayDatabase), { recursive: true })],
        { concurrency: 2 },
      )
      return Database.layer(database)
    }),
  )
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabase), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadSummaryRepositoryLayer = ThreadSummaryRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const resolvedContextLayer = ResolvedContext.layer(fffGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  const clientOwnedInteractiveFunction = interactiveTui({ editor })

  const operationLayer = (
    injectedInteractive: (
      input: ResidentService.InteractiveInput,
      session: Operation.InteractiveSession,
    ) => Effect.Effect<void, Operation.OperationUnavailable>,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const globalSettings = yield* loadSettingsFile(globalConfig)
        const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
        const applicationConfigLayer = ConfigService.liveEnvironmentLayer({
          webProviders: WebSearch.providerRegistry,
          global: globalSettings,
          workspace: workspaceSettings,
        })
        const effectiveConfig = yield* ConfigService.effective().pipe(provideLayerScoped(applicationConfigLayer))
        const testModelConfigured =
          environment.testModelResponse._tag === "Some" || environment.testModelScript._tag === "Some"
        const providerRuntimeContext = yield* Layer.build(
          testModelConfigured
            ? ModelProviderRuntime.bypassLayer
            : ModelProviderRuntime.Service.layer.pipe(
                Layer.provide(openAiAuthLayer),
                Layer.provide(BedrockAuthRefresh.liveLayer),
              ),
        )
        const modelProviders = Context.get(providerRuntimeContext, ModelProviderRuntime.Service)
        const effectiveConfigForWorkspace = (workspace: string) =>
          Effect.gen(function* () {
            const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
            return yield* ConfigService.effective().pipe(
              provideLayerScoped(
                ConfigService.liveEnvironmentLayer({
                  webProviders: WebSearch.providerRegistry,
                  global: globalSettings,
                  workspace: settings,
                }),
              ),
            )
          }).pipe(provideLayerScoped(BunServices.layer))
        const workspaceExecutionRoutePlan = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const resolvedWorkspaceConfig = yield* effectiveConfigForWorkspace(workspace)
            const routes = modelRoutesForExecution(resolvedWorkspaceConfig.settings, mode, tuning)
            if (testModelConfigured)
              return {
                routes,
                executionRoute: executionRoutePin(resolvedWorkspaceConfig.settings, mode, tuning),
                registrations: [],
              }
            const prepared = yield* modelProviders.prepare(routes)
            return {
              routes,
              executionRoute: executionRoutePinFromPrepared(mode, prepared),
              registrations: prepared.registrations,
            }
          }).pipe(provideLayerScoped(BunServices.layer))
        const resolveWorkspaceExecutionRoute = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const resolvedRoute = yield* workspaceExecutionRoutePlan(mode, tuning, workspace)
            if (resolvedRoute.registrations.length > 0) {
              const backend = yield* ExecutionBackend.Service
              if (backend.registerModels !== undefined) yield* backend.registerModels(resolvedRoute.registrations)
            }
            return resolvedRoute.executionRoute
          })
        const webSearchCredentials = effectiveConfig.environment.webSearchCredentials
        const repositories = Layer.succeedContext(
          yield* Layer.build(
            Layer.mergeAll(
              repositoryLayer,
              turnRepositoryLayer,
              threadSummaryRepositoryLayer,
              transcriptRepositoryLayer,
            ),
          ),
        )
        const persistedTitleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(
          provideLayerScoped(productDatabase.pipe(Layer.provide(BunServices.layer))),
        )
        const persistedModelRoutes = yield* TurnRepository.Service.pipe(
          Effect.flatMap((turns) => turns.listNonterminal),
          Effect.map((turns) => [...persistedModelRoutesForStartup(turns), ...persistedTitleRoutes]),
          provideLayerScoped(repositories),
        )
        const resolveLegacyRoute = (input: ExecutionBackend.StartInput) =>
          Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const thread = yield* threads.get(Thread.ThreadId.make(input.threadId))
            if (thread === undefined)
              return yield* ExecutionBackend.BackendError.make({
                message: `Thread ${input.threadId} does not exist for legacy route resolution`,
              })
            const resolved = yield* workspaceExecutionRoutePlan("medium", undefined, thread.workspace)
            return { executionRoute: resolved.executionRoute, registrations: resolved.registrations }
          }).pipe(
            provideLayerScoped(repositories),
            Effect.mapError((error) =>
              Schema.is(ExecutionBackend.BackendError)(error)
                ? error
                : ExecutionBackend.BackendError.make({ message: String(error) }),
            ),
          )
        const backendLayer = configuredBackendLayer({
          filename: relayDatabase,
          workspace: process.cwd(),
          repositoryLayer: repositories,
          turnRepositoryLayer: repositories,
          transcriptRepositoryLayer: repositories,
          settings: effectiveConfig.settings,
          persistedModelRoutes,
          webSearchCredentials,
          resolveLegacyRoute,
          ...(effectiveConfig.settings.permissions.shell === undefined
            ? {}
            : { shellPermission: effectiveConfig.settings.permissions.shell }),
          globalSettings,
        }).pipe(
          Layer.provide(Layer.succeedContext(providerRuntimeContext)),
          Layer.provide(BunServices.layer),
          Layer.provide(BunCrypto.layer),
        )
        const configAdapter = Layer.effect(
          ConfigOperations.Adapter,
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            return ConfigOperations.Adapter.of({
              exists: (filename) =>
                fileSystem
                  .exists(filename)
                  .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: String(error) }))),
              edit: (filename) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    if (editor === undefined)
                      return yield* ConfigOperations.AdapterError.make({
                        message: "Set VISUAL or EDITOR to edit configuration",
                      })
                    yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
                    if (!(yield* fileSystem.exists(filename))) yield* fileSystem.writeFileString(filename, "{}\n")
                    const handle = yield* spawner.spawn(ChildProcess.make(editor, [filename]))
                    const code = yield* handle.exitCode
                    if (Number(code) !== 0)
                      return yield* ConfigOperations.AdapterError.make({ message: `Editor exited with status ${code}` })
                  }),
                ).pipe(
                  Effect.mapError((error) =>
                    Schema.is(ConfigOperations.AdapterError)(error)
                      ? error
                      : ConfigOperations.AdapterError.make({ message: String(error) }),
                  ),
                ),
            })
          }),
        )
        const product = Operation.productLayer({
          repositoryLayer: repositories,
          turnRepositoryLayer: repositories,
          threadSummaryRepositoryLayer: repositories,
          transcriptRepositoryLayer: repositories,
          resolvedContextLayer,
          backendLayer: lazyBackendLayer(backendLayer).pipe(
            Layer.catchCause((cause) =>
              Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
            ),
          ),
          resolveExecutionRoute: (...arguments_) =>
            resolveWorkspaceExecutionRoute(...arguments_).pipe(
              Effect.mapError((error) =>
                OperationProductError.make({
                  message: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          toolRuntimeLayer: (workspace) =>
            Layer.unwrap(
              effectiveConfigForWorkspace(workspace).pipe(
                Effect.map((config) => {
                  const credentials = config.environment.webSearchCredentials
                  const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
                  return ToolRuntime.layer(workspace).pipe(
                    Layer.provide(
                      MediaView.analyzerTestLayer(() =>
                        Effect.fail(MediaView.MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
                      ),
                    ),
                    Layer.provide(
                      Layer.merge(
                        WebSearch.factoryLayer(RelayExecutionBackend.webSearchFactories(credentials).factories),
                        ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                      ).pipe(Layer.provide(FetchHttpClient.layer)),
                    ),
                    Layer.provide(BunServices.layer),
                  )
                }),
              ),
            ).pipe(Layer.orDie),
          defaultWorkspace: process.cwd(),
          shellPermission: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
              const layer = ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: settings,
              })
              const config = yield* ConfigService.effective().pipe(provideLayerScoped(layer))
              return config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!
            }).pipe(provideLayerScoped(BunServices.layer), Effect.orDie),
          makeThreadId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Thread.ThreadId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
          makeTurnId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Turn.TurnId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
          configOperations: {
            layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(
              Layer.provide(BunServices.layer),
              Layer.catchCause((cause) =>
                Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
              ),
            ),
            options: {
              globalConfigPath: globalConfig,
              workspaceConfigPath: workspaceConfig,
              productDatabasePath: database,
              relayDatabasePath: relayDatabase,
              upstream: [
                { name: "baton", present: true },
                { name: "relay", present: true },
              ],
            },
            forWorkspace: (workspace) =>
              Effect.gen(function* () {
                const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
                return {
                  layer: Layer.merge(
                    configAdapter,
                    ConfigService.liveEnvironmentLayer({
                      webProviders: WebSearch.providerRegistry,
                      global: globalSettings,
                      workspace: settings,
                    }),
                  ).pipe(
                    Layer.provide(BunServices.layer),
                    Layer.catchCause((cause) =>
                      Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
                    ),
                  ),
                  options: {
                    globalConfigPath: globalConfig,
                    workspaceConfigPath: `${workspace}/.rika/settings.json`,
                    productDatabasePath: database,
                    relayDatabasePath: relayDatabase,
                    upstream: [
                      { name: "baton", present: true },
                      { name: "relay", present: true },
                    ],
                  },
                }
              }).pipe(
                provideLayerScoped(BunServices.layer),
                Effect.mapError((error) => OperationProductError.make({ message: String(error) })),
              ),
          },
          extensionOperations: { layer: extensionLayer },
          authOperations,
          interactive: injectedInteractive,
        })
        return product
      }),
    )
  const residentOwner: ResidentService.Owner = (interactive) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const loadProduct = yield* Effect.cached(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((startedAt) =>
                Layer.buildWithScope(
                  operationLayer(interactive).pipe(
                    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
                  ),
                  scope,
                ).pipe(
                  Effect.map((context) => Context.get(context, Operation.Service)),
                  Effect.tap(() =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((completedAt) =>
                        Effect.logInfo("resident.product.loaded").pipe(
                          Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
          return Operation.Service.of({
            run: (input) => {
              if (input._tag === "Auth") return Effect.scoped(Operation.runAuth(input, authOperations, process.cwd()))
              return loadProduct.pipe(
                Effect.flatMap((service) => service.run(input)),
                Effect.mapError((error) =>
                  Schema.is(Operation.OperationUnavailable)(error)
                    ? error
                    : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
                ),
              )
            },
          })
        }),
      ),
    )
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
          Logging.resolveDataRoot(database, relayDatabase).pipe(
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
                        runtimeRestartRequested = true
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
                              executable: process.execPath,
                              arguments: [import.meta.path],
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
                                  runtimeRestartRequested = true
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
  const hostProgram =
    hostDataRoot === undefined
      ? Effect.die("Resident host data root is unavailable")
      : Effect.scoped(
          serveResident({
            profile: environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(
              environment.residentGrace._tag === "Some" ? environment.residentGrace.value : "900000",
            ),
            startupHoldMilliseconds: Number(
              environment.residentStartupHold._tag === "Some" ? environment.residentStartupHold.value : "10000",
            ),
            onReady: ResidentProcessStartup.signalReady,
            owner: residentOwner,
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            const failure = Cause.squash(cause)
            const message =
              failure !== null && typeof failure === "object" && "message" in failure
                ? String(failure.message)
                : String(failure)
            return ResidentProcessStartup.signalFailure(message).pipe(Effect.ignore)
          }),
          provideLayerScoped(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        )
  if (environment.residentHost._tag === "Some" && environment.residentHost.value === "1")
    BunRuntime.runMain(observedProgram("resident", hostDataRoot ?? defaultDataRoot, hostProgram))
  else
    BunRuntime.runMain(clientProgram, {
      teardown: (exit, onExit) => {
        if (runtimeRestartRequested) return onExit(ResidentService.runtimeRestartExitCode)
        Runtime.defaultTeardown(exit, onExit)
      },
    })
}
