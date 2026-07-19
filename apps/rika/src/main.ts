#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, Compaction, ModelRegistry, Response as AiResponse } from "@batonfx/core"
import type { TestModel as TestModelTypes } from "@batonfx/test"
import { anthropic, anthropicClientLayerConfig } from "@batonfx/providers/anthropic"
import {
  OpenAiAccountCredentialError,
  openAi,
  openAiAccount,
  openAiClientLayerConfig,
  type OpenAiAccountCredentials,
} from "@batonfx/providers/openai"
import { FileFinder } from "@ff-labs/fff-node"
import {
  ConfigOperations,
  ContextFileSystem,
  ExtensionOperations,
  Operation,
  OpenAiAuth,
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
import { MediaView, ParallelSearch, ReadWebPage, Runtime as ToolRuntime, ThreadTools } from "@rika/tools"
import { Palette, Session, ViewState } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import type { PathTarget } from "@rika/tui"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
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
  Redacted,
  Ref,
  References,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { Command } from "effect/unstable/cli"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { command, version } from "./command"
import { renderGoodbye } from "./goodbye"
import * as InteractiveController from "./interactive-controller"
import * as Logging from "./logging"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { layer as residentLayer } from "./resident-client-transport"
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
  const signature =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
      ? { mediaType: "image/png", extension: "png" }
      : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? { mediaType: "image/jpeg", extension: "jpg" }
        : bytes.length >= 6 && /^GIF8[79]a$/.test(prefix(0, 6))
          ? { mediaType: "image/gif", extension: "gif" }
          : bytes.length >= 12 && prefix(0, 4) === "RIFF" && prefix(8, 12) === "WEBP"
            ? { mediaType: "image/webp", extension: "webp" }
            : undefined
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
  return editor === "code" || editor.endsWith("/code")
    ? [editor, "--goto", location]
    : editor === "vim" || editor === "nvim" || editor.endsWith("/vim") || editor.endsWith("/nvim")
      ? [editor, ...(line === undefined ? [] : [`+call cursor(${line},${column ?? 1})`]), path]
      : [editor, path]
}

export const editorArguments: {
  (path: string, line?: number, column?: number): (editor: string) => Array<string>
  (editor: string, path: string, line?: number, column?: number): Array<string>
} = Function.dual((args) => args.length >= 2, editorArgumentsImpl)

const defaultOpenArgumentsImpl = (path: string, platform: NodeJS.Platform = process.platform): Array<string> =>
  platform === "darwin"
    ? ["open", path]
    : platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -LiteralPath $args[0]",
          "--",
          path,
        ]
      : ["xdg-open", path]

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
        Effect.flatMap(([info, bytes]) =>
          info.type !== "File" || bytes.byteLength === 0
            ? Effect.fail(
                PromptAttachmentError.make({
                  index,
                  path: part.path,
                  message: `Image attachment is missing or empty: ${part.path}`,
                }),
              )
            : Effect.succeed({ mediaType: imageMediaType(path), bytes }),
        ),
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
): ReturnType<typeof RelayExecutionBackend.layer<typeof ThreadTools.toolkit.tools>> =>
  RelayExecutionBackend.layer({
    ...options,
    additionalToolkit: ThreadTools.toolkit,
    additionalHandlerLayer: ThreadToolHandlers.handlerLayer.pipe(
      Layer.provide(ThreadQuery.layer),
      Layer.provide(Layer.merge(repositoryLayer, turnRepositoryLayer)),
      Layer.catchCause((cause) =>
        Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
      ),
    ),
  })

export const relayBackendLayer: {
  (
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
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
  ): ReturnType<typeof relayBackendLayerImpl>
} = Function.dual(3, relayBackendLayerImpl)

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

const sanitizeChatCompletion = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  if (Array.isArray(record.choices))
    for (const choice of record.choices as Array<Record<string, unknown>>) {
      const message = choice?.message as Record<string, unknown> | undefined
      if (message !== undefined && message.tool_calls === null) delete message.tool_calls
      if (message !== undefined && message.content === undefined) message.content = null
    }
  return value
}

const sanitizedFetchLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transformResponse(client, (effect) =>
      Effect.flatMap(effect, (response) => {
        const contentType = String(response.headers["content-type"] ?? "")
        if (!contentType.includes("application/json")) return Effect.succeed(response)
        return response.text.pipe(
          Effect.map((text) => {
            const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
            if (Option.isNone(decoded)) return response
            const sanitized = Schema.encodeSync(Schema.UnknownFromJsonString)(sanitizeChatCompletion(decoded.value))
            return HttpClientResponse.fromWeb(
              response.request,
              new Response(sanitized, { status: response.status, headers: { "content-type": contentType } }),
            )
          }),
          Effect.orElseSucceed(() => response),
        )
      }),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

const normalizedBaseUrl = (value: string) => {
  const url = new URL(value)
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString().replace(/\/(?=\?|$)/, "")
}

const isNativeOpenAiRoute = (route: ConfigContract.ResolvedModelRoute) =>
  route.providerId === "openai" &&
  route.providerConnection.protocol === "openai" &&
  normalizedBaseUrl(route.providerConnection.baseUrl) ===
    normalizedBaseUrl(ConfigContract.defaults.providers.openai!.baseUrl)

const modelRoutePlanImpl = (route: ConfigContract.ResolvedModelRoute, openAiAccountFingerprint?: string) => {
  const apiKeyEnv = route.providerConnection.apiKeyEnv
  const registrationKey = `sha256:${createHash("sha256")
    .update(
      canonical({
        protocol: route.providerConnection.protocol,
        baseUrl: normalizedBaseUrl(route.providerConnection.baseUrl),
        apiKeyEnv,
        ...(openAiAccountFingerprint === undefined || !isNativeOpenAiRoute(route) ? {} : { openAiAccountFingerprint }),
        model: route.model,
        effort: route.effort,
        fast: route.fast,
        options: route.options,
      }),
    )
    .digest("hex")}`
  return {
    registrationKey,
    selection: { provider: route.providerId, model: route.model, registrationKey },
    compaction: productionCompaction(route),
  }
}

export const modelRoutePlan: {
  (
    openAiAccountFingerprint?: string,
  ): (route: ConfigContract.ResolvedModelRoute) => ReturnType<typeof modelRoutePlanImpl>
  (route: ConfigContract.ResolvedModelRoute, openAiAccountFingerprint?: string): ReturnType<typeof modelRoutePlanImpl>
} = Function.dual((args) => typeof args[0] === "object", modelRoutePlanImpl)

const modeIds = ["low", "medium", "high", "ultra"] as const
const agentIds = ["librarian", "painter", "review", "readThread", "task"] as const

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
  ...agentIds.map((agent) => ConfigContract.resolveAgentRoute(settings, agent)),
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

const executionRoutePinImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
  openAiAccountFingerprint?: string,
): Turn.ExecutionRoutePin => {
  const resolveRole = (role: ConfigContract.Role) => {
    const route = resolveTunedModeRoute(settings, mode, role, tuning)
    const plan = modelRoutePlan(route, openAiAccountFingerprint)
    return {
      role,
      alias: route.alias,
      provider: plan.selection.provider,
      model: plan.selection.model,
      registrationKey: plan.registrationKey,
      providerProtocol: route.providerConnection.protocol,
      providerBaseUrl: normalizedBaseUrl(route.providerConnection.baseUrl),
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { providerApiKeyEnv: route.providerConnection.apiKeyEnv }),
      ...(openAiAccountFingerprint === undefined || !isNativeOpenAiRoute(route) ? {} : { openAiAccountFingerprint }),
      effort: route.effort,
      fast: route.fast,
      requestVariant: plan.registrationKey,
      providerOptions: route.options,
      compaction: route.compaction,
    }
  }
  const resolveAgent = (agent: ConfigContract.AgentId) => {
    const route = ConfigContract.resolveAgentRoute(settings, agent)
    const plan = modelRoutePlan(route, openAiAccountFingerprint)
    return {
      role: agent,
      alias: route.alias,
      provider: plan.selection.provider,
      model: plan.selection.model,
      registrationKey: plan.registrationKey,
      providerProtocol: route.providerConnection.protocol,
      providerBaseUrl: normalizedBaseUrl(route.providerConnection.baseUrl),
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { providerApiKeyEnv: route.providerConnection.apiKeyEnv }),
      ...(openAiAccountFingerprint === undefined || !isNativeOpenAiRoute(route) ? {} : { openAiAccountFingerprint }),
      effort: route.effort,
      fast: route.fast,
      requestVariant: plan.registrationKey,
      providerOptions: route.options,
      compaction: route.compaction,
    }
  }
  const titleRoute = ConfigContract.resolveThreadTitleRoute(settings)
  const titlePlan = modelRoutePlan(titleRoute, openAiAccountFingerprint)
  const summaryRoute = ConfigContract.resolveCompactionSummaryRoute(settings)
  const summaryPlan = modelRoutePlan(summaryRoute, openAiAccountFingerprint)
  return {
    mode,
    title: {
      role: "title",
      alias: titleRoute.alias,
      provider: titlePlan.selection.provider,
      model: titlePlan.selection.model,
      registrationKey: titlePlan.registrationKey,
      providerProtocol: titleRoute.providerConnection.protocol,
      providerBaseUrl: normalizedBaseUrl(titleRoute.providerConnection.baseUrl),
      ...(titleRoute.providerConnection.apiKeyEnv === undefined
        ? {}
        : { providerApiKeyEnv: titleRoute.providerConnection.apiKeyEnv }),
      ...(openAiAccountFingerprint === undefined || !isNativeOpenAiRoute(titleRoute)
        ? {}
        : { openAiAccountFingerprint }),
      effort: titleRoute.effort,
      fast: titleRoute.fast,
      requestVariant: titlePlan.registrationKey,
      providerOptions: titleRoute.options,
      compaction: titleRoute.compaction,
    },
    compactionSummary: {
      role: "compaction",
      alias: summaryRoute.alias,
      provider: summaryPlan.selection.provider,
      model: summaryPlan.selection.model,
      registrationKey: summaryPlan.registrationKey,
      providerProtocol: summaryRoute.providerConnection.protocol,
      providerBaseUrl: normalizedBaseUrl(summaryRoute.providerConnection.baseUrl),
      ...(summaryRoute.providerConnection.apiKeyEnv === undefined
        ? {}
        : { providerApiKeyEnv: summaryRoute.providerConnection.apiKeyEnv }),
      ...(openAiAccountFingerprint === undefined || !isNativeOpenAiRoute(summaryRoute)
        ? {}
        : { openAiAccountFingerprint }),
      effort: summaryRoute.effort,
      fast: summaryRoute.fast,
      requestVariant: summaryPlan.registrationKey,
      providerOptions: summaryRoute.options,
      compaction: summaryRoute.compaction,
    },
    main: resolveRole("main"),
    oracle: resolveRole("oracle"),
    agents: {
      librarian: resolveAgent("librarian"),
      painter: resolveAgent("painter"),
      review: resolveAgent("review"),
      readThread: resolveAgent("readThread"),
      task: resolveAgent("task"),
    },
  }
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
    openAiAccountFingerprint?: string,
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

const credentialForRouteImpl = (
  route: ConfigContract.ResolvedModelRoute,
  providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
) =>
  route.providerConnection.apiKeyEnv === undefined ? undefined : providerCredentials[route.providerConnection.apiKeyEnv]

export const credentialForRoute: {
  (
    providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  ): (route: ConfigContract.ResolvedModelRoute) => Redacted.Redacted<string> | undefined
  (
    route: ConfigContract.ResolvedModelRoute,
    providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  ): Redacted.Redacted<string> | undefined
} = Function.dual(2, credentialForRouteImpl)

export interface OpenAiAccountRegistrationOptions {
  readonly fingerprint: string
  readonly auth: OpenAiAuth.ServiceInterface
}

const openAiAccountRegistration = (auth: OpenAiAuth.ServiceInterface) =>
  auth.status.pipe(
    Effect.flatMap(
      (status): Effect.Effect<OpenAiAccountRegistrationOptions | undefined, ModelConfigurationError> =>
        status._tag === "Present" || status._tag === "RefreshRequired"
          ? Effect.succeed({ fingerprint: status.fingerprint, auth })
          : status._tag === "Unauthenticated"
            ? Effect.sync((): undefined => undefined)
            : Effect.fail(
                ModelConfigurationError.make({
                  message: "OpenAI account credentials are corrupt; run rika auth logout openai, then log in again",
                }),
              ),
    ),
    Effect.mapError((error) =>
      Schema.is(ModelConfigurationError)(error)
        ? error
        : ModelConfigurationError.make({ message: "OpenAI account credentials could not be read" }),
    ),
  )

const openAiAccountRegistrationForRoutesImpl = (
  routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  auth: OpenAiAuth.ServiceInterface,
) =>
  routes.some(isNativeOpenAiRoute)
    ? openAiAccountRegistration(auth)
    : Effect.sync((): OpenAiAccountRegistrationOptions | undefined => undefined)

export const openAiAccountRegistrationForRoutes: {
  (
    auth: OpenAiAuth.ServiceInterface,
  ): (
    routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  ) => ReturnType<typeof openAiAccountRegistrationForRoutesImpl>
  (
    routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
    auth: OpenAiAuth.ServiceInterface,
  ): ReturnType<typeof openAiAccountRegistrationForRoutesImpl>
} = Function.dual(2, openAiAccountRegistrationForRoutesImpl)

const batonAccountCredentials = (
  auth: OpenAiAuth.ServiceInterface,
  expectedFingerprint: string,
): OpenAiAccountCredentials => {
  const adapt = (
    operation: "acquire" | "refreshRejected",
    effect: Effect.Effect<OpenAiAuth.Credential, OpenAiAuth.Error>,
  ) =>
    effect.pipe(
      Effect.filterOrFail(
        (credential) => credential.fingerprint === expectedFingerprint,
        () => OpenAiAccountCredentialError.make({ operation }),
      ),
      Effect.map((credential) => ({
        accessToken: credential.accessToken,
        accountId: Redacted.value(credential.accountId),
        generation: credential.generation,
      })),
      Effect.mapError(() => OpenAiAccountCredentialError.make({ operation })),
    )
  return {
    acquire: adapt("acquire", auth.acquire),
    refreshRejected: (generation) => adapt("refreshRejected", auth.refreshRejected(generation)),
  }
}

export const openAiAccountConfig = (options: Readonly<Record<string, unknown>>) =>
  ({
    ...Object.fromEntries(Object.entries(options).filter(([name]) => name !== "max_output_tokens")),
    store: false,
  }) as NonNullable<Parameters<typeof openAiAccount>[0]["config"]>

const registrationForRoute = (
  route: ConfigContract.ResolvedModelRoute,
  apiKeyConfig: Config.Config<Redacted.Redacted<string>>,
  account?: OpenAiAccountRegistrationOptions,
) =>
  account !== undefined && isNativeOpenAiRoute(route)
    ? openAiAccount({
        model: route.model,
        registrationKey: modelRoutePlan(route, account.fingerprint).registrationKey,
        credentials: batonAccountCredentials(account.auth, account.fingerprint),
        config: openAiAccountConfig(route.options),
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.providerId })),
        provideLayerScoped(sanitizedFetchLayer),
      )
    : route.providerConnection.protocol === "openai"
      ? openAi({
          model: route.model,
          registrationKey: modelRoutePlan(route).registrationKey,
          config: route.options as NonNullable<Parameters<typeof openAi>[0]["config"]>,
        }).pipe(
          Effect.map((registration) => ({ ...registration, provider: route.providerId })),
          provideLayerScoped(
            openAiClientLayerConfig({
              apiUrl: Config.succeed(route.providerConnection.baseUrl),
              apiKey: route.providerConnection.apiKeyEnv === undefined ? Config.succeed(undefined) : apiKeyConfig,
            }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
          ),
        )
      : anthropic({
          model: route.model,
          registrationKey: modelRoutePlan(route).registrationKey,
          config: route.options as NonNullable<Parameters<typeof anthropic>[0]["config"]>,
        }).pipe(
          Effect.map((registration) => ({ ...registration, provider: route.providerId })),
          provideLayerScoped(
            anthropicClientLayerConfig({
              apiUrl: Config.succeed(route.providerConnection.baseUrl),
              apiKey: route.providerConnection.apiKeyEnv === undefined ? Config.succeed(undefined) : apiKeyConfig,
            }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
          ),
        )

const registrationForPinnedRoute = (
  route: Turn.ExecutionModelRoute,
  providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  openAiAuth?: OpenAiAuth.ServiceInterface,
): Effect.Effect<ModelRegistry.Registration, ModelConfigurationError> => {
  if (route.openAiAccountFingerprint !== undefined) {
    if (
      openAiAuth === undefined ||
      route.provider !== "openai" ||
      route.providerProtocol !== "openai" ||
      normalizedBaseUrl(route.providerBaseUrl) !== normalizedBaseUrl(ConfigContract.defaults.providers.openai!.baseUrl)
    )
      return Effect.fail(ModelConfigurationError.make({ message: "Pinned OpenAI account route is unavailable" }))
    return openAiAccount({
      model: route.model,
      registrationKey: route.registrationKey,
      credentials: batonAccountCredentials(openAiAuth, route.openAiAccountFingerprint),
      config: openAiAccountConfig(route.providerOptions ?? {}),
    }).pipe(
      Effect.map((registration) => ({ ...registration, provider: route.provider })),
      provideLayerScoped(sanitizedFetchLayer),
    )
  }
  const credentialVariable = route.providerApiKeyEnv
  const credential = credentialVariable === undefined ? undefined : providerCredentials[credentialVariable]
  if (credentialVariable !== undefined && credential === undefined)
    return Effect.fail(
      ModelConfigurationError.make({
        message: `Missing environment variable ${credentialVariable} for provider ${route.provider}`,
      }),
    )
  const apiKey = Config.succeed(credential)
  return route.providerProtocol === "openai"
    ? openAi({
        model: route.model,
        registrationKey: route.registrationKey,
        config: (route.providerOptions ?? {}) as NonNullable<Parameters<typeof openAi>[0]["config"]>,
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.provider })),
        provideLayerScoped(
          openAiClientLayerConfig({ apiUrl: Config.succeed(route.providerBaseUrl), apiKey }).pipe(
            Layer.provide(sanitizedFetchLayer),
            Layer.orDie,
          ),
        ),
      )
    : anthropic({
        model: route.model,
        registrationKey: route.registrationKey,
        config: (route.providerOptions ?? {}) as NonNullable<Parameters<typeof anthropic>[0]["config"]>,
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.provider })),
        provideLayerScoped(
          anthropicClientLayerConfig({ apiUrl: Config.succeed(route.providerBaseUrl), apiKey }).pipe(
            Layer.provide(sanitizedFetchLayer),
            Layer.orDie,
          ),
        ),
      )
}

export const distinctModelRoutes = (routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>) =>
  routes.filter((route, index, all) => {
    const plan = modelRoutePlan(route)
    return (
      all.findIndex((candidate) => {
        const candidatePlan = modelRoutePlan(candidate)
        return (
          candidatePlan.selection.provider === plan.selection.provider &&
          candidatePlan.selection.model === plan.selection.model &&
          candidatePlan.registrationKey === plan.registrationKey
        )
      }) === index
    )
  })

const registrationsForRoutesImpl = (
  routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  account?: OpenAiAccountRegistrationOptions,
) =>
  Effect.forEach(distinctModelRoutes(routes), (route) => {
    if (route.providerConnection.apiKeyEnv === undefined)
      return registrationForRoute(route, Config.succeed(Redacted.make("unused")), account)
    if (account !== undefined && isNativeOpenAiRoute(route))
      return registrationForRoute(route, Config.succeed(Redacted.make("unused")), account)
    const credential = credentialForRoute(route, providerCredentials)
    if (credential === undefined)
      return Effect.fail(
        ModelConfigurationError.make({
          message: `Missing environment variable ${route.providerConnection.apiKeyEnv} for provider ${route.providerId}`,
        }),
      )
    return registrationForRoute(route, Config.succeed(credential), account)
  })

export const registrationsForRoutes: {
  (
    providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  ): (routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>) => ReturnType<typeof registrationsForRoutesImpl>
  (
    routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
    providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
    account?: OpenAiAccountRegistrationOptions,
  ): ReturnType<typeof registrationsForRoutesImpl>
} = Function.dual((args) => args.length >= 2, registrationsForRoutesImpl)

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
  ...Object.values(route.agents ?? {}),
]

export const isLegacyUnavailableExecutionRoute = (route: Turn.ExecutionRoutePin) =>
  executionModelRoutes(route).some((candidate) => candidate.registrationKey === "legacy-unavailable")

export const registrationsForPersistedRoutes = Effect.fn("Main.registrationsForPersistedRoutes")(function* (
  routes: ReadonlyArray<Turn.ExecutionModelRoute>,
  providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  openAiAuth?: OpenAiAuth.ServiceInterface,
) {
  const results = yield* Effect.forEach(
    routes.filter(
      (candidate, index, all) =>
        candidate.providerProtocol !== "test" &&
        all.findIndex((other) => registrationTuple(other) === registrationTuple(candidate)) === index,
    ),
    (route) =>
      registrationForPinnedRoute(route, providerCredentials, openAiAuth).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("model.route.persisted.unavailable").pipe(
                  Effect.annotateLogs({
                    "rika.model.alias": route.alias,
                    "rika.model.provider": route.provider,
                    "rika.model.name": route.model,
                    "rika.model.registration_key": route.registrationKey,
                    "rika.failure.kind": failureKind(cause),
                  }),
                  Effect.as({ _tag: "Unavailable" as const, route, message: causeMessage(cause) }),
                ),
          onSuccess: (registration) => Effect.succeed({ _tag: "Registered" as const, registration }),
        }),
      ),
    { concurrency: 1 },
  )
  return {
    registrations: results.flatMap((result) => (result._tag === "Registered" ? [result.registration] : [])),
    unavailable: results.flatMap((result) =>
      result._tag === "Unavailable" ? [{ route: result.route, message: result.message }] : [],
    ),
  }
})

const unavailableRouteError = (failure: PersistedRouteRegistrationFailure) =>
  ExecutionBackend.BackendError.make({
    message: `Model route ${failure.route.alias}/${failure.route.effort}${failure.route.fast ? "/fast" : ""} is unavailable: ${failure.message}`,
  })

export const resolveExecutionWorkspace = Effect.fn("Main.resolveExecutionWorkspace")(function* (
  durableExecutionId: string,
  defaultWorkspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
) {
  const program = Effect.gen(function* () {
    const turnId = RelayExecutionBackend.turnIdFromExecutionId(durableExecutionId)
    if (turnId === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Execution ${durableExecutionId} is not attached to a Rika Turn`,
      })
    if (turnId.startsWith("title:")) return defaultWorkspace
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
    readonly providerCredentials: Readonly<Record<string, Redacted.Redacted<string>>>
    readonly openAiAuth?: OpenAiAuth.ServiceInterface
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
          admission.withPermits(1)(registerModelsUnlocked(registrations))
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
        const registrations = yield* Effect.forEach(
          missing,
          (candidate) =>
            registrationForPinnedRoute(candidate, options.providerCredentials, options.openAiAuth).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.fail(unavailableRouteError({ route: candidate, message: causeMessage(cause) })),
                onSuccess: Effect.succeed,
              }),
            ),
          { concurrency: 1 },
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
        const resolved = isLegacyUnavailableExecutionRoute(input.executionRoute)
          ? options.resolveLegacyRoute === undefined
            ? yield* ExecutionBackend.BackendError.make({
                message: `Turn ${input.turnId} uses the legacy unavailable model route and cannot be started`,
              })
            : yield* options.resolveLegacyRoute(input)
          : { executionRoute: input.executionRoute, registrations: [] }
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

const configuredBackendLayerImpl = (
  filename: string,
  workspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
  parallelApiKey?: import("effect").Redacted.Redacted<string>,
  modelRoute?: ConfigContract.ResolvedModelRoute,
  providerCredentials: Readonly<Record<string, import("effect").Redacted.Redacted<string>>> = {},
  allModelRoutes?: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  oracleRoute?: ConfigContract.ResolvedModelRoute,
  persistedModelRoutes: ReadonlyArray<Turn.ExecutionModelRoute> = [],
  compactionSummaryRoute?: ConfigContract.ResolvedModelRoute,
  resolveLegacyRoute?: (input: ExecutionBackend.StartInput) => Effect.Effect<
    {
      readonly executionRoute: Turn.ExecutionRoutePin
      readonly registrations: ReadonlyArray<ModelRegistry.Registration>
    },
    ExecutionBackend.BackendError
  >,
  shellPermission?: ConfigContract.PermissionDecision,
  openAiAuth?: OpenAiAuth.ServiceInterface,
): Layer.Layer<
  Layer.Success<ReturnType<typeof relayBackendLayer>>,
  Layer.Error<ReturnType<typeof relayBackendLayer>> | Config.ConfigError | Error | Schema.SchemaError,
  never
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* mkdir(dirname(filename), { recursive: true })
      const route = modelRoute ?? ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
      const resolvedOracleRoute = oracleRoute ?? route
      const resolvedCompactionSummaryRoute =
        compactionSummaryRoute ?? ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults)
      const configuredRoutes = allModelRoutes ?? [route, resolvedOracleRoute, resolvedCompactionSummaryRoute]
      const testResponse = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
      const testScript = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
      const testApprovalTools = yield* Config.option(Config.string("RIKA_TEST_APPROVAL_TOOLS"))
      const testMediaAnalyzerResponse = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE"))
      const testMediaAnalyzerError = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR"))
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
      const account =
        openAiAuth !== undefined && testResponse._tag === "None" && testScript._tag === "None"
          ? yield* openAiAccountRegistrationForRoutes(configuredRoutes, openAiAuth)
          : undefined
      const routePlan = modelRoutePlan(route, account?.fingerprint)
      const oracleRoutePlan = modelRoutePlan(resolvedOracleRoute, account?.fingerprint)
      const compactionSummaryPlan = modelRoutePlan(resolvedCompactionSummaryRoute, account?.fingerprint)
      yield* Effect.logInfo("model.backend.configured").pipe(
        Effect.annotateLogs(
          "rika.model.backend.kind",
          testScript._tag === "Some" ? "test-script" : testResponse._tag === "Some" ? "test-response" : "provider",
        ),
      )
      let registration: ModelRegistry.Registration
      let selection: ModelRegistry.ModelSelection
      let additionalRegistrations: Array<ModelRegistry.Registration> = []
      let unavailablePersistedRoutes: ReadonlyArray<PersistedRouteRegistrationFailure> = []
      let modelVariantPolicy: RelayExecutionBackend.ModelVariantPolicy = "registration-key"
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
        const configuredRegistrations = yield* registrationsForRoutes(configuredRoutes, providerCredentials, account)
        const configuredKeys = new Set(configuredRegistrations.map(registrationTuple))
        const persistedRegistrationState = yield* registrationsForPersistedRoutes(
          persistedModelRoutes.filter((candidate) => !configuredKeys.has(registrationTuple(candidate))),
          providerCredentials,
          openAiAuth,
        )
        const registrations = [...configuredRegistrations, ...persistedRegistrationState.registrations]
        unavailablePersistedRoutes = persistedRegistrationState.unavailable
        if (registrations.length === 0)
          return yield* ModelConfigurationError.make({ message: "No configured model routes could be registered" })
        registration = registrations[0]!
        additionalRegistrations = registrations.slice(1)
        selection = routePlan.selection
      }
      const backendLayer = relayBackendLayer(
        {
          filename,
          workspace,
          registration,
          ...(additionalRegistrations.length === 0 ? {} : { additionalRegistrations }),
          selection,
          oracleSelection:
            testScript._tag === "Some" || testResponse._tag === "Some" ? selection : oracleRoutePlan.selection,
          compactionSummarySelection:
            testScript._tag === "Some" || testResponse._tag === "Some" ? selection : compactionSummaryPlan.selection,
          modelVariantPolicy,
          ...(shellPermission === undefined
            ? {}
            : {
                permissionPolicy: {
                  rules: [
                    { pattern: "*", level: "allow" },
                    { pattern: "shell", level: shellPermission },
                  ],
                },
              }),
          compaction: routePlan.compaction,
          oracleCompaction: oracleRoutePlan.compaction,
          toolRuntimeLayerForWorkspace: (runtimeWorkspace) =>
            ToolRuntime.layer(runtimeWorkspace).pipe(
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
                  ParallelSearch.layer(parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }),
                  ReadWebPage.layer(parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }),
                ).pipe(Layer.provide(FetchHttpClient.layer)),
              ),
              Layer.provide(BunServices.layer),
              Layer.catchCause((cause) =>
                Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
              ),
            ),
          resolveWorkspace: (durableExecutionId) =>
            resolveExecutionWorkspace(durableExecutionId, workspace, repositoryLayer, turnRepositoryLayer),
          ...(testApprovalTools._tag === "Some" && (testScript._tag === "Some" || testResponse._tag === "Some")
            ? { toolNeedsApproval: (name: string) => testApprovalTools.value.split(",").includes(name) }
            : {}),
          ...(parallelApiKey === undefined ? {} : { parallelApiKey }),
        },
        repositoryLayer,
        turnRepositoryLayer,
      ).pipe(Layer.provide(BunCrypto.layer))
      if (testScript._tag === "Some" || testResponse._tag === "Some") return backendLayer
      return Layer.effect(
        ExecutionBackend.Service,
        ExecutionBackend.Service.pipe(
          Effect.flatMap((backend) =>
            withPinnedRouteRegistration(backend, {
              registeredRoutes: [registration, ...additionalRegistrations],
              unavailable: unavailablePersistedRoutes,
              providerCredentials,
              ...(openAiAuth === undefined ? {} : { openAiAuth }),
              ...(resolveLegacyRoute === undefined ? {} : { resolveLegacyRoute }),
            }),
          ),
        ),
      ).pipe(Layer.provide(backendLayer))
    }),
  ).pipe(Layer.provide(BunServices.layer))

export const configuredBackendLayer: {
  (
    workspace: string,
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    parallelApiKey?: import("effect").Redacted.Redacted<string>,
    modelRoute?: ConfigContract.ResolvedModelRoute,
    providerCredentials?: Readonly<Record<string, import("effect").Redacted.Redacted<string>>>,
    allModelRoutes?: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
    oracleRoute?: ConfigContract.ResolvedModelRoute,
    persistedModelRoutes?: ReadonlyArray<Turn.ExecutionModelRoute>,
    compactionSummaryRoute?: ConfigContract.ResolvedModelRoute,
    resolveLegacyRoute?: Parameters<typeof configuredBackendLayerImpl>[11],
    shellPermission?: Parameters<typeof configuredBackendLayerImpl>[12],
    openAiAuth?: Parameters<typeof configuredBackendLayerImpl>[13],
  ): (filename: string) => ReturnType<typeof configuredBackendLayerImpl>
  (
    filename: string,
    workspace: string,
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    parallelApiKey?: import("effect").Redacted.Redacted<string>,
    modelRoute?: ConfigContract.ResolvedModelRoute,
    providerCredentials?: Readonly<Record<string, import("effect").Redacted.Redacted<string>>>,
    allModelRoutes?: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
    oracleRoute?: ConfigContract.ResolvedModelRoute,
    persistedModelRoutes?: ReadonlyArray<Turn.ExecutionModelRoute>,
    compactionSummaryRoute?: ConfigContract.ResolvedModelRoute,
    resolveLegacyRoute?: Parameters<typeof configuredBackendLayerImpl>[11],
    shellPermission?: Parameters<typeof configuredBackendLayerImpl>[12],
    openAiAuth?: Parameters<typeof configuredBackendLayerImpl>[13],
  ): ReturnType<typeof configuredBackendLayerImpl>
} = Function.dual((args) => args.length >= 4, configuredBackendLayerImpl)

const lazyBackendLayer = (
  backendLayer: Layer.Layer<ExecutionBackend.Service, Layer.Error<ReturnType<typeof configuredBackendLayerImpl>>>,
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
        startWorkflow: (name, runId, revision) =>
          load.pipe(Effect.flatMap((backend) => backend.startWorkflow(name, runId, revision))),
        inspectWorkflow: (runId) => load.pipe(Effect.flatMap((backend) => backend.inspectWorkflow(runId))),
        cancelWorkflow: (runId) => load.pipe(Effect.flatMap((backend) => backend.cancelWorkflow(runId))),
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
        follow: (turnId, afterCursor, onEvent) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.follow === undefined
                ? backend.replay(turnId, afterCursor)
                : backend.follow(turnId, afterCursor, onEvent),
            ),
          ),
        replay: (turnId, afterCursor) => load.pipe(Effect.flatMap((backend) => backend.replay(turnId, afterCursor))),
        cancel: (turnId, cancelledAt) => load.pipe(Effect.flatMap((backend) => backend.cancel(turnId, cancelledAt))),
        inspect: (turnId) => load.pipe(Effect.flatMap((backend) => backend.inspect(turnId))),
        steer: (turnId, text, createdAt) =>
          load.pipe(Effect.flatMap((backend) => backend.steer(turnId, text, createdAt))),
        listApprovals: (turnId) => load.pipe(Effect.flatMap((backend) => backend.listApprovals(turnId))),
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
    input._tag === "Thread"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

export const withClientWorkspace: {
  (workspace: string): (input: Operation.Input) => Operation.Input
  (input: Operation.Input, workspace: string): Operation.Input
} = Function.dual(2, withClientWorkspaceImpl)

const providerCredentialsForRoutesImpl = (
  configuredRoutes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  persistedRoutes: ReadonlyArray<Turn.ExecutionModelRoute>,
  initial: Readonly<Record<string, Redacted.Redacted<string>>>,
  readEnvironment: (name: string) => string | undefined,
) => {
  const variables = new Set<string>()
  for (const route of configuredRoutes)
    if (route.providerConnection.apiKeyEnv !== undefined) variables.add(route.providerConnection.apiKeyEnv)
  for (const route of persistedRoutes) if (route.providerApiKeyEnv !== undefined) variables.add(route.providerApiKeyEnv)
  const credentials: Record<string, Redacted.Redacted<string>> = { ...initial }
  for (const variable of variables) {
    if (credentials[variable] !== undefined) continue
    const value = readEnvironment(variable)
    if (value !== undefined) credentials[variable] = Redacted.make(value)
  }
  return credentials
}

export const providerCredentialsForRoutes: {
  (
    persistedRoutes: ReadonlyArray<Turn.ExecutionModelRoute>,
    initial: Readonly<Record<string, Redacted.Redacted<string>>>,
    readEnvironment: (name: string) => string | undefined,
  ): (configuredRoutes: ReadonlyArray<ConfigContract.ResolvedModelRoute>) => Record<string, Redacted.Redacted<string>>
  (
    configuredRoutes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
    persistedRoutes: ReadonlyArray<Turn.ExecutionModelRoute>,
    initial: Readonly<Record<string, Redacted.Redacted<string>>>,
    readEnvironment: (name: string) => string | undefined,
  ): Record<string, Redacted.Redacted<string>>
} = Function.dual(4, providerCredentialsForRoutesImpl)

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

if (import.meta.main) {
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
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  const database =
    hostDataRoot === undefined
      ? environment.database._tag === "Some"
        ? environment.database.value
        : `${defaultDataRoot}/rika.db`
      : join(hostDataRoot, "rika.db")
  const relayDatabase =
    hostDataRoot === undefined
      ? environment.relayDatabase._tag === "Some"
        ? environment.relayDatabase.value
        : `${defaultDataRoot}/relay.db`
      : join(hostDataRoot, "relay.db")
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
        const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({ global: globalSettings, workspace: settings })
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
  const editor =
    environment.visual._tag === "Some"
      ? environment.visual.value
      : environment.editor._tag === "Some"
        ? environment.editor.value
        : undefined
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
  const resolvedContextLayer = ResolvedContext.layer.pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  const clientOwnedInteractiveFunction = (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ): Effect.Effect<void, Operation.OperationUnavailable> =>
    Effect.gen(function* () {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return
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
        let threadCostUsd = 0
        const appliedDeltas = new Set<string>()
        let activeSelectionEpoch = 0
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
            event._tag === "TranscriptPagePrepended" ||
            event._tag === "TranscriptPatched" ||
            event._tag === "TranscriptResyncRequired"
          ) {
            const controlled = InteractiveController.update(
              {
                model,
                selectionEpoch: activeSelectionEpoch,
                replayTurns,
                entries: loadedTranscriptEntries,
                revisions: projectionRevisions,
                projections: transcriptProjections,
                threadCostUsd,
              },
              event,
            )
            model = controlled.state.model
            activeSelectionEpoch = controlled.state.selectionEpoch
            replayTurns = new Map(controlled.state.replayTurns)
            loadedTranscriptEntries = controlled.state.entries
            projectionRevisions = new Map(controlled.state.revisions)
            transcriptProjections = new Map(controlled.state.projections)
            threadCostUsd = controlled.state.threadCostUsd
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
              })
            }
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
            if (event.action === "cancelled" && model.busy)
              model = ViewState.update(model, {
                _tag: "ExecutionCancelled",
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
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
            model = { ...model, costUsd: event.globalCostUsd }
            if (model.currentThreadId === event.threadId) threadCostUsd = event.threadCostUsd
          } else if (event._tag === "ThreadTitled") {
            if (model.currentThreadId === event.threadId) {
              const workspaceLabel = model.workspace.replace(/^\/Users\/[^/]+/, "~")
              process.stdout.write(`]0;${event.title} - rika - ${workspaceLabel}`)
            }
            model = ViewState.update(model, {
              _tag: "ThreadTitleChanged",
              threadId: event.threadId,
              title: event.title,
            })
          } else if (event._tag === "ThreadActivated") {
            model = ViewState.update(model, {
              _tag: "ThreadActivated",
              threadId: event.threadId,
              title: event.title,
            })
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
        ) => {
          const classified = ViewState.classifyPrompt(prompt)
          const effect =
            classified._tag === "Shell"
              ? session.shell(classified.command, classified.incognito)
              : materializePromptParts(parts, model.workspace).pipe(
                  Effect.flatMap((materialized) => session.submit(classified.prompt, mode, materialized, tuning)),
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
                if (editor === undefined) {
                  renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
                  return
                }
                const relative = `.rika/compose-${now}.md`
                const file = `${model.workspace}/${relative}`
                yield* mkdir(`${model.workspace}/.rika`, { recursive: true })
                yield* fileSystem.writeFileString(file, ViewState.displayInput(model))
                const resumeTerminal = pauseTerminal()
                yield* childExit("run editor", [editor, file], {
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
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
                    if (editor === undefined) {
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
                      editorArguments(editor, path, target.line, target.column),
                      {
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
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
          steer: (prompt) => run(session.steer(prompt)),
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
              openPath,
              scroll: (offset) => {
                model = ViewState.update(model, { _tag: "ScrollMoved", offset })
                renderer?.surface.update(model)
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
                renderer?.surface.update(model)
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
                const prompt = submitting ? model.input : undefined
                const parts = prompt === undefined ? undefined : ViewState.promptParts(prompt, model.pastedText)
                const submittedPrompt =
                  prompt === undefined ? undefined : ViewState.expandPastedText(prompt, model.pastedText)
                model = ViewState.update(model, { _tag: "KeyPressed", key })
                if (submitting) model = ViewState.update(model, { _tag: "Submitted" })
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
                  Effect.gen(function* () {
                    const [gitText, gitExit] = yield* gitOutput([
                      "git",
                      "-C",
                      model.workspace,
                      "ls-files",
                      "--cached",
                      "--others",
                      "--exclude-standard",
                      "-z",
                    ])
                    if (gitExit === 0) {
                      const files = gitText.split("\0").filter((line) => line.length > 0)
                      if (files.length > 0) {
                        model = ViewState.update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                        created.surface.update(model)
                        return
                      }
                    }
                    const initialized = yield* Effect.try({
                      try: () => FileFinder.create({ basePath: model.workspace, aiMode: true }),
                      catch: (cause) =>
                        ExternalBoundaryError.make({ operation: "create file finder", message: String(cause) }),
                    }).pipe(Effect.orElseSucceed(() => undefined))
                    if (initialized?.ok !== true) {
                      const files = yield* Effect.tryPromise({
                        try: () =>
                          Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: model.workspace, onlyFiles: true })),
                        catch: (cause) =>
                          ExternalBoundaryError.make({ operation: "scan workspace files", message: String(cause) }),
                      })
                      model = ViewState.update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                      created.surface.update(model)
                      return
                    }
                    yield* Effect.tryPromise({
                      try: () => initialized.value.waitForScan(10_000),
                      catch: (cause) =>
                        ExternalBoundaryError.make({ operation: "scan file index", message: String(cause) }),
                    }).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          const result = initialized.value.glob("**/*", { pageSize: 10_000 })
                          if (!result.ok) throw new Error(result.error)
                          model = ViewState.update(model, {
                            _tag: "FilesReplaced",
                            files: result.value.items.map((item) => item.relativePath),
                          })
                          created.surface.update(model)
                        }),
                      ),
                      Effect.ensuring(Effect.sync(() => initialized.value.destroy())),
                    )
                  }).pipe(Effect.asVoid),
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
                run(
                  (input.last === true
                    ? Effect.sync(() => startSelection((epoch) => session.reopenThread(epoch))).pipe(
                        Effect.flatMap(Fiber.join),
                      )
                    : input.threadId === undefined
                      ? Effect.void
                      : Effect.sync(() => startSelection((epoch) => session.selectThread(input.threadId!, epoch))).pipe(
                          Effect.flatMap(Fiber.join),
                        )
                  ).pipe(
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
          global: globalSettings,
          workspace: workspaceSettings,
        })
        const effectiveConfig = yield* ConfigService.effective().pipe(provideLayerScoped(applicationConfigLayer))
        const openAiAuth = Context.get(yield* Layer.build(openAiAuthLayer), OpenAiAuth.Service)
        const testModelConfigured =
          environment.testModelResponse._tag === "Some" || environment.testModelScript._tag === "Some"
        const workspaceExecutionRoutePlan = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
            const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({
              global: globalSettings,
              workspace: settings,
            })
            const resolvedWorkspaceConfig = yield* ConfigService.effective().pipe(
              provideLayerScoped(workspaceConfigLayer),
            )
            const routes = modelRoutesForExecution(resolvedWorkspaceConfig.settings, mode, tuning)
            const account = testModelConfigured
              ? undefined
              : yield* openAiAccountRegistrationForRoutes(routes, openAiAuth)
            const resolvedRoute = {
              routes,
              executionRoute: executionRoutePin(resolvedWorkspaceConfig.settings, mode, tuning, account?.fingerprint),
            }
            return {
              ...resolvedRoute,
              providerCredentials: resolvedWorkspaceConfig.environment.providerCredentials,
              account,
            }
          }).pipe(provideLayerScoped(BunServices.layer))
        const resolveWorkspaceExecutionRoute = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const resolvedRoute = yield* workspaceExecutionRoutePlan(mode, tuning, workspace)
            if (!testModelConfigured) {
              const registrations = yield* registrationsForRoutes(
                resolvedRoute.routes,
                resolvedRoute.providerCredentials,
                resolvedRoute.account,
              )
              const backend = yield* ExecutionBackend.Service
              if (backend.registerModels !== undefined) yield* backend.registerModels(registrations)
            }
            return resolvedRoute.executionRoute
          })
        const parallelApiKey = effectiveConfig.environment.parallelApiKey
        const allModelRoutes = defaultModelRoutes(effectiveConfig.settings)
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
        const credentialNames = [
          ...allModelRoutes.flatMap((route) =>
            route.providerConnection.apiKeyEnv === undefined ? [] : [route.providerConnection.apiKeyEnv],
          ),
          ...persistedModelRoutes.flatMap((route) =>
            route.providerApiKeyEnv === undefined ? [] : [route.providerApiKeyEnv],
          ),
        ]
        const environmentCredentials = Object.fromEntries(
          yield* Effect.forEach(credentialNames, (name) =>
            Config.option(Config.string(name)).pipe(
              Effect.map((value) => [name, value._tag === "Some" ? value.value : undefined] as const),
            ),
          ),
        )
        const providerCredentials = providerCredentialsForRoutes(
          allModelRoutes,
          persistedModelRoutes,
          effectiveConfig.environment.providerCredentials,
          (name) => environmentCredentials[name],
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
            const registrations = testModelConfigured
              ? []
              : yield* registrationsForRoutes(resolved.routes, resolved.providerCredentials, resolved.account)
            return { executionRoute: resolved.executionRoute, registrations }
          }).pipe(
            provideLayerScoped(repositories),
            Effect.mapError((error) =>
              Schema.is(ExecutionBackend.BackendError)(error)
                ? error
                : ExecutionBackend.BackendError.make({ message: String(error) }),
            ),
          )
        const backendLayer = configuredBackendLayer(
          relayDatabase,
          process.cwd(),
          repositories,
          repositories,
          parallelApiKey,
          ConfigContract.resolveModelRoute(effectiveConfig.settings, "medium", "main"),
          providerCredentials,
          allModelRoutes,
          ConfigContract.resolveModelRoute(effectiveConfig.settings, "medium", "oracle"),
          persistedModelRoutes,
          ConfigContract.resolveCompactionSummaryRoute(effectiveConfig.settings),
          resolveLegacyRoute,
          effectiveConfig.settings.permissions.shell,
          openAiAuth,
        ).pipe(Layer.provide(BunServices.layer), Layer.provide(BunCrypto.layer))
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
            ToolRuntime.layer(workspace).pipe(
              Layer.provide(
                MediaView.analyzerTestLayer(() =>
                  Effect.fail(MediaView.MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
                ),
              ),
              Layer.provide(
                Layer.merge(
                  ParallelSearch.layer(parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }),
                  ReadWebPage.layer(parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }),
                ).pipe(Layer.provide(FetchHttpClient.layer)),
              ),
              Layer.provide(BunServices.layer),
            ),
          defaultWorkspace: process.cwd(),
          shellPermission: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
              const layer = ConfigService.liveEnvironmentLayer({ global: globalSettings, workspace: settings })
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
                    ConfigService.liveEnvironmentLayer({ global: globalSettings, workspace: settings }),
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
            Layer.buildWithScope(
              operationLayer(interactive).pipe(
                Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
              ),
              scope,
            ).pipe(Effect.map((context) => Context.get(context, Operation.Service))),
          )
          return Operation.Service.of({
            run: (input) =>
              input._tag === "Auth"
                ? Effect.scoped(Operation.runAuth(input, authOperations, process.cwd()))
                : loadProduct.pipe(
                    Effect.flatMap((service) => service.run(input)),
                    Effect.mapError((error) =>
                      Schema.is(Operation.OperationUnavailable)(error)
                        ? error
                        : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
                    ),
                  ),
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
                    const clientInput = withClientWorkspace(input, process.cwd())
                    const connected = yield* Effect.result(
                      resident
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          clientKind:
                            clientInput._tag === "Interactive"
                              ? "interactive"
                              : clientInput._tag === "Thread"
                                ? "thread-continue"
                                : clientInput._tag === "Run"
                                  ? "run"
                                  : clientInput._tag === "Review"
                                    ? "review"
                                    : clientInput._tag === "Workflow"
                                      ? "workflow"
                                      : "product",
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
                          Effect.mapError((error) =>
                            Schema.is(Operation.OperationUnavailable)(error)
                              ? error
                              : Operation.OperationUnavailable.make({
                                  operation: clientInput._tag,
                                  message: error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
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
              environment.residentGrace._tag === "Some" ? environment.residentGrace.value : "500",
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
  else BunRuntime.runMain(clientProgram)
}
