#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { OpenAiClient } from "@effect/ai-openai-compat"
import { ModelRegistry } from "@batonfx/core"
import { openAiCompatible } from "@batonfx/providers/openai-compat"
import { openRouter, openRouterClientLayerConfig } from "@batonfx/providers/openrouter"
import { FileFinder } from "@ff-labs/fff-node"
import {
  ConfigOperations,
  ContextFileSystem,
  ExtensionOperations,
  Operation,
  ResolvedContext,
  ThreadQuery,
  ThreadToolHandlers,
} from "@rika/app"
import { ConfigContract, ConfigService } from "@rika/config"
import { McpOAuth, SkillRegistry } from "@rika/extensions"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ParallelSearch, ReadWebPage, Runtime as ToolRuntime, ThreadTools } from "@rika/tools"
import { ExecutionEvents, Session, ViewState } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import type { PathTarget } from "@rika/tui"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Config, Console, Effect, Exit, Fiber, FileSystem, Layer, Path, Redacted, Schedule, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { mkdir, realpath, rm, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative as relativePathFrom, resolve } from "node:path"
import { command, version } from "./command"
import { renderGoodbye } from "./goodbye"

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

export const resolveWorkspacePath = (workspace: string, target: PathTarget): string => {
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

export const resolveWorkspaceFile = async (workspace: string, target: PathTarget): Promise<string> => {
  const root = await realpath(workspace)
  const path = await realpath(resolveWorkspacePath(root, target))
  const relation = relativePathFrom(root, path)
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  )
    throw new Error("Path is outside the workspace")
  if (!(await stat(path)).isFile()) throw new Error("Path is not a file")
  return path
}

export const editorArguments = (editor: string, path: string, line?: number, column?: number): Array<string> => {
  const location = line === undefined ? path : `${path}:${line}${column === undefined ? "" : `:${column}`}`
  return editor === "code" || editor.endsWith("/code")
    ? [editor, "--goto", location]
    : editor === "vim" || editor === "nvim" || editor.endsWith("/vim") || editor.endsWith("/nvim")
      ? [editor, ...(line === undefined ? [] : [`+call cursor(${line},${column ?? 1})`]), path]
      : [editor, path]
}

export const defaultOpenArguments = (path: string, platform: NodeJS.Platform = process.platform): Array<string> =>
  platform === "darwin" ? ["open", path] : platform === "win32" ? ["cmd", "/c", "start", "", path] : ["xdg-open", path]

export class PromptAttachmentError extends Schema.TaggedErrorClass<PromptAttachmentError>()("PromptAttachmentError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export const materializePromptParts = (parts: ReadonlyArray<ViewState.PromptPart>, workspace: string) =>
  Effect.tryPromise({
    try: async () => {
      const materialized = await Promise.all(
        parts.map(async (part): Promise<Turn.PromptPart> => {
          if (part.type === "text") return part
          const path = part.path.startsWith("/") ? part.path : `${workspace}/${part.path}`
          const file = Bun.file(path)
          if (!(await file.exists()) || file.size === 0)
            throw new PromptAttachmentError({
              path: part.path,
              message: `Image attachment is missing or empty: ${part.path}`,
            })
          const mediaType = imageMediaType(path)
          if (!mediaType.startsWith("image/"))
            throw new PromptAttachmentError({ path: part.path, message: `Unsupported image attachment: ${part.path}` })
          return {
            type: "image",
            mediaType,
            data: Buffer.from(await file.arrayBuffer()).toString("base64"),
            filename: part.path,
          }
        }),
      )
      return materialized
    },
    catch: (cause) =>
      cause instanceof PromptAttachmentError
        ? cause
        : new PromptAttachmentError({
            path: "unknown",
            message: `Image attachment could not be read: ${String(cause)}`,
          }),
  })

export const initialSubmitAction = (
  prompt: ReadonlyArray<string>,
  mode: ViewState.Mode,
): Extract<Session.Action, { readonly _tag: "Submit" }> | undefined => {
  if (prompt.length === 0) return undefined
  const value = prompt.join(" ")
  return { _tag: "Submit", prompt: value, parts: ViewState.promptParts(value), mode }
}

export const parseChangedFiles = (statusText: string, numstatText: string): ReadonlyArray<ViewState.ChangedFile> => {
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

export const countAddedLines = (bytes: Uint8Array): number => {
  if (bytes.length === 0 || bytes.includes(0)) return 0
  let lines = bytes[bytes.length - 1] === 10 ? 0 : 1
  for (const byte of bytes) if (byte === 10) lines += 1
  return lines
}

export const countAddedLinesFromFile = async (workspace: string, path: string): Promise<number> => {
  const file = await resolveWorkspaceFile(workspace, { path })
  const reader = Bun.file(file).stream().getReader()
  const count = async (lines: number, finalByte: number | undefined): Promise<number> => {
    const next = await reader.read()
    if (next.done) return finalByte === undefined ? 0 : lines + (finalByte === 10 ? 0 : 1)
    let nextLines = lines
    let nextFinalByte = finalByte
    for (const byte of next.value) {
      if (byte === 0) {
        void reader.cancel()
        return 0
      }
      if (byte === 10) nextLines += 1
      nextFinalByte = byte
    }
    return count(nextLines, nextFinalByte)
  }
  return count(0, undefined)
}

export const readChangedFiles = async (workspace: string): Promise<ReadonlyArray<ViewState.ChangedFile>> => {
  const statusProcess = Bun.spawn(["git", "-C", workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const statusText = await new Response(statusProcess.stdout).text()
  if ((await statusProcess.exited) !== 0) return []
  const headProcess = Bun.spawn(["git", "-C", workspace, "rev-parse", "--verify", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const head = (await new Response(headProcess.stdout).text()).trim()
  const base =
    (await headProcess.exited) === 0
      ? head
      : await (async () => {
          const emptyTreeProcess = Bun.spawn(["git", "-C", workspace, "hash-object", "-t", "tree", "/dev/null"], {
            stdout: "pipe",
            stderr: "ignore",
          })
          const emptyTree = (await new Response(emptyTreeProcess.stdout).text()).trim()
          return (await emptyTreeProcess.exited) === 0 ? emptyTree : undefined
        })()
  if (base === undefined) return []
  const numstatProcess = Bun.spawn(["git", "-C", workspace, "diff", "--numstat", "-z", "-M", base], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const numstatText = await new Response(numstatProcess.stdout).text()
  if ((await numstatProcess.exited) !== 0) return []
  const files = [...parseChangedFiles(statusText, numstatText)]
  const countUntracked = async (offset: number): Promise<void> => {
    if (offset >= files.length) return
    const counted = await Promise.all(
      files.slice(offset, offset + 8).map(async (file) => {
        if (file.added !== undefined || !file.status.includes("?")) return file
        try {
          const added = await countAddedLinesFromFile(workspace, file.path)
          return { path: file.path, status: file.status, added, removed: 0 }
        } catch {
          return { path: file.path, status: file.status, added: 0, removed: 0 }
        }
      }),
    )
    files.splice(offset, counted.length, ...counted)
    await countUntracked(offset + 8)
  }
  await countUntracked(0)
  return files
}

type ClipboardPngExtractor = (script: string, path: string) => Promise<number>

const runClipboardPngExtractor: ClipboardPngExtractor = (script, path) =>
  Bun.spawn(["osascript", "-e", script, "--", path], { stdout: "ignore", stderr: "ignore" }).exited

export const pasteClipboardPng = (
  workspace: string,
  now = Date.now,
  extract: ClipboardPngExtractor = runClipboardPngExtractor,
) =>
  Effect.promise(async () => {
    const relative = `.rika/pasted/paste-${now()}.png`
    const absolute = `${workspace}/${relative}`
    await mkdir(`${workspace}/.rika/pasted`, { recursive: true })
    await Bun.write(absolute, new Uint8Array())
    const script = `on run argv\nset pngData to (the clipboard as «class PNGf»)\nset theFile to (POSIX file (item 1 of argv))\nset fh to open for access theFile with write permission\nset eof fh to 0\nwrite pngData to fh\nclose access fh\nend run`
    let extracted = false
    try {
      const exit = await extract(script, absolute)
      const file = Bun.file(absolute)
      extracted = exit === 0 && (await file.exists()) && file.size > 0
      if (extracted) return relative
      return undefined
    } catch {
      return undefined
    } finally {
      if (!extracted) await rm(absolute, { force: true })
    }
  }).pipe(Effect.orElseSucceed(() => undefined))

export const pastedImagePath = (
  bytes: Uint8Array,
  mediaType?: string,
  now = Date.now,
  id = crypto.randomUUID,
): string | undefined => {
  const format = pastedImageFormat(bytes, mediaType)
  return format === undefined ? undefined : `.rika/pasted/paste-${now()}-${id()}.${format.extension}`
}

export const persistPastedImage = (workspace: string, relative: string, bytes: Uint8Array) =>
  Effect.promise(async () => {
    await mkdir(`${workspace}/.rika/pasted`, { recursive: true })
    await Bun.write(`${workspace}/${relative}`, bytes)
    return true
  }).pipe(Effect.orElseSucceed(() => false))

export const relayBackendLayer = (
  options: Omit<
    RelayExecutionBackend.LayerOptions<typeof ThreadTools.toolkit.tools>,
    "additionalToolkit" | "additionalHandlerLayer"
  >,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, unknown, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, unknown, never>,
) =>
  RelayExecutionBackend.layer({
    ...options,
    additionalToolkit: ThreadTools.toolkit,
    additionalHandlerLayer: ThreadToolHandlers.handlerLayer.pipe(
      Layer.provide(ThreadQuery.layer),
      Layer.provide(Layer.merge(repositoryLayer, turnRepositoryLayer)),
    ),
  })

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

const testModelTurnSchema = Schema.Struct({
  parts: Schema.NonEmptyArray(testModelPartSchema),
  delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})

const testModelScriptSchema = Schema.NonEmptyArray(testModelTurnSchema)

export const parseTestModelScript = (json: string) =>
  Effect.try({
    try: () => JSON.parse(json),
    catch: (cause) => new Error(`Invalid RIKA_TEST_MODEL_SCRIPT JSON: ${String(cause)}`),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(testModelScriptSchema)))

export const buildTestModelScript = Effect.fn("Main.buildTestModelScript")(function* (json: string) {
  const script = yield* parseTestModelScript(json)
  const { TestModel } = yield* Effect.promise(() => import("@batonfx/test"))
  return script.map((turn) =>
    TestModel.turn(
      turn.parts.map((part) => {
        if (part.type === "text") return TestModel.text(part.text)
        if (part.type === "reasoning") return TestModel.reasoning(part.text)
        return TestModel.toolCall(part.name, part.params, part.id === undefined ? {} : { id: part.id })
      }),
      turn.delayMs === undefined ? {} : { delay: turn.delayMs },
    ),
  )
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
            try {
              const sanitized = JSON.stringify(sanitizeChatCompletion(JSON.parse(text)))
              return HttpClientResponse.fromWeb(
                response.request,
                new Response(sanitized, { status: response.status, headers: { "content-type": contentType } }),
              )
            } catch {
              return response
            }
          }),
          Effect.orElseSucceed(() => response),
        )
      }),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

const modelRouteKey = (route: { readonly provider: string; readonly model: string; readonly baseUrl?: string }) =>
  JSON.stringify([route.provider, route.model, route.baseUrl ?? null])

const registrationForRoute = (
  route: ConfigContract.ResolvedModelRoute,
  apiKeyConfig: Config.Config<Redacted.Redacted<string>>,
) =>
  route.baseUrl === undefined
    ? openRouter({ model: route.model }).pipe(
        Effect.provide(
          openRouterClientLayerConfig({ apiKey: apiKeyConfig }).pipe(Layer.provide(FetchHttpClient.layer), Layer.orDie),
        ),
      )
    : openAiCompatible({ provider: route.provider, model: route.model, config: { strictJsonSchema: false } }).pipe(
        Effect.provide(OpenAiClient.layer({ apiUrl: route.baseUrl }).pipe(Layer.provide(sanitizedFetchLayer))),
      )

const effortLevels = ["low", "medium", "high", "xhigh"] as const

const modelVariantConfigs = effortLevels.flatMap((effort) => [
  { effort, fast: false },
  { effort, fast: true },
])

const vibeVariantConfig = (effort: string, fast: boolean) =>
  ({
    strictJsonSchema: false,
    reasoning_effort: effort,
    ...(fast ? { service_tier: "priority" } : {}),
  }) as NonNullable<Parameters<typeof openAiCompatible>[0]["config"]>

const openRouterVariantConfig = (effort: string) =>
  ({ reasoning: { effort } }) as NonNullable<Parameters<typeof openRouter>[0]["config"]>

const variantRegistrationsForRoute = (
  route: ConfigContract.ResolvedModelRoute,
  apiKeyConfig: Config.Config<Redacted.Redacted<string>>,
) =>
  Effect.forEach(modelVariantConfigs, ({ effort, fast }) =>
    route.baseUrl === undefined
      ? openRouter({
          model: route.model,
          registrationKey: RelayExecutionBackend.modelVariantKey(effort, fast),
          config: openRouterVariantConfig(effort),
        }).pipe(
          Effect.provide(
            openRouterClientLayerConfig({ apiKey: apiKeyConfig }).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.orDie,
            ),
          ),
        )
      : openAiCompatible({
          provider: route.provider,
          model: route.model,
          registrationKey: RelayExecutionBackend.modelVariantKey(effort, fast),
          config: vibeVariantConfig(effort, fast),
        }).pipe(Effect.provide(OpenAiClient.layer({ apiUrl: route.baseUrl }).pipe(Layer.provide(sanitizedFetchLayer)))),
  )

const registrationsForRoutes = (
  routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  primaryKey: string,
  apiKeyConfig: Config.Config<Redacted.Redacted<string>>,
) => {
  const distinct = routes.filter(
    (route, index, all) => all.findIndex((c) => modelRouteKey(c) === modelRouteKey(route)) === index,
  )
  return Effect.forEach(distinct, (route) =>
    Effect.exit(
      Effect.gen(function* () {
        const base = modelRouteKey(route) === primaryKey ? [] : [yield* registrationForRoute(route, apiKeyConfig)]
        const variants = yield* variantRegistrationsForRoute(route, apiKeyConfig)
        return [...base, ...variants]
      }),
    ),
  ).pipe(Effect.map((exits) => exits.flatMap((exit) => (Exit.isSuccess(exit) ? exit.value : []))))
}

export const configuredBackendLayer = (
  filename: string,
  workspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, unknown, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, unknown, never>,
  parallelApiKey?: import("effect").Redacted.Redacted<string>,
  modelRoute?: ConfigContract.ResolvedModelRoute,
  modelApiKey?: import("effect").Redacted.Redacted<string>,
  allModelRoutes?: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  defaultReasoningEffort?: string,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(dirname(filename), { recursive: true }))
      const provider =
        modelRoute?.provider ?? (yield* Config.string("RIKA_MODEL_PROVIDER").pipe(Config.withDefault("openrouter")))
      const model =
        modelRoute?.model ?? (yield* Config.string("RIKA_MODEL").pipe(Config.withDefault("openai/gpt-5.6-luna")))
      const testResponse = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
      const testScript = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
      if (testResponse._tag === "Some" && testScript._tag === "Some") {
        return yield* Effect.fail(new Error("RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set"))
      }
      let registration: ModelRegistry.Registration
      let selection: ModelRegistry.ModelSelection
      let additionalRegistrations: Array<ModelRegistry.Registration> = []
      let modelVariantPolicy: RelayExecutionBackend.ModelVariantPolicy = "registration-key"
      if (testScript._tag === "Some") {
        const { TestModel } = yield* Effect.promise(() => import("@batonfx/test"))
        const fixture = yield* TestModel.make(yield* buildTestModelScript(testScript.value))
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else if (testResponse._tag === "Some") {
        const { TestModel } = yield* Effect.promise(() => import("@batonfx/test"))
        const fixture = yield* TestModel.make(Array.from({ length: 4 }, () => TestModel.text(testResponse.value)))
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else {
        const apiKeyConfig =
          modelApiKey === undefined
            ? provider === "vibe"
              ? Config.redacted("RIKA_MODEL_API_KEY").pipe(Config.withDefault(Redacted.make("dummy-not-used")))
              : Config.redacted("RIKA_MODEL_API_KEY")
            : Config.succeed(Redacted.value(modelApiKey)).pipe(Config.map(Redacted.make))
        if (provider === "vibe") {
          const baseUrl = modelRoute?.baseUrl ?? (yield* Config.string("RIKA_MODEL_BASE_URL"))
          const clientLayer = OpenAiClient.layer({ apiUrl: baseUrl }).pipe(Layer.provide(sanitizedFetchLayer))
          const primaryKey = modelRouteKey({ provider, model, baseUrl })
          return Layer.unwrap(
            Effect.gen(function* () {
              const compatibleRegistration = yield* openAiCompatible({
                provider,
                model,
                config: { strictJsonSchema: false },
              })
              const vibeRegistrations = yield* registrationsForRoutes(
                allModelRoutes ?? [{ alias: model, provider, model, baseUrl }],
                primaryKey,
                apiKeyConfig,
              )
              return relayBackendLayer(
                {
                  filename,
                  workspace,
                  registration: compatibleRegistration,
                  ...(vibeRegistrations.length === 0 ? {} : { additionalRegistrations: vibeRegistrations }),
                  selection: { provider, model },
                  ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
                  ...(parallelApiKey === undefined ? {} : { parallelApiKey }),
                },
                repositoryLayer,
                turnRepositoryLayer,
              )
            }),
          ).pipe(Layer.provide(clientLayer), Layer.provide(BunCrypto.layer))
        } else {
          registration = yield* openRouter({ model }).pipe(
            Effect.provide(
              openRouterClientLayerConfig({ apiKey: apiKeyConfig }).pipe(
                Layer.provide(FetchHttpClient.layer),
                Layer.orDie,
              ),
            ),
          )
          additionalRegistrations = yield* registrationsForRoutes(
            allModelRoutes ?? [{ alias: model, provider, model }],
            modelRouteKey({ provider, model }),
            apiKeyConfig,
          )
        }
        selection = { provider, model }
      }
      return relayBackendLayer(
        {
          filename,
          workspace,
          registration,
          ...(additionalRegistrations.length === 0 ? {} : { additionalRegistrations }),
          selection,
          modelVariantPolicy,
          ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
          ...(parallelApiKey === undefined ? {} : { parallelApiKey }),
        },
        repositoryLayer,
        turnRepositoryLayer,
      ).pipe(Layer.provide(BunCrypto.layer))
    }),
  )

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => new ConfigContract.ConfigFileError({ path: filename, message: String(error) })))
  const value = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (error) => new ConfigContract.ConfigFileError({ path: filename, message: `Invalid JSON: ${String(error)}` }),
  })
  return ConfigContract.decodeSettingsInput(filename, value)
})

const main = Command.run(command, { version }).pipe(
  Effect.catchTag("OperationUnavailable", (error: Operation.OperationUnavailable) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  ),
  Effect.catchTag("InvalidInput", (error: Operation.InvalidInput) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  ),
)

if (import.meta.main) {
  const database = process.env.RIKA_DATABASE ?? `${process.env.HOME ?? process.cwd()}/.rika/rika.db`
  const relayDatabase = process.env.RIKA_RELAY_DATABASE ?? `${process.env.HOME ?? process.cwd()}/.rika/relay.db`
  const globalConfig = `${process.env.HOME ?? process.cwd()}/.config/rika/settings.json`
  const workspaceConfig = `${process.cwd()}/.rika/settings.json`
  const extensionLayer = Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: `${process.env.HOME ?? process.cwd()}/.config/rika/skills`,
      workspaceRoot: `${process.cwd()}/.rika/skills`,
      configPath: `${process.cwd()}/.rika/mcp.json`,
      trustPath: `${process.env.HOME ?? process.cwd()}/.config/rika/mcp-trust.json`,
      generationsPath: `${process.cwd()}/.rika/extensions.json`,
    }),
    SkillRegistry.fileSystemLayer,
    McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostLayer),
      Layer.provide(McpOAuth.tokenStoreLayer(`${process.env.HOME ?? process.cwd()}/.config/rika/mcp-oauth.json`)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
  const editor = process.env.VISUAL ?? process.env.EDITOR
  const productDatabase = Layer.unwrap(
    Effect.promise(async () => {
      await Promise.all([
        mkdir(dirname(database), { recursive: true }),
        mkdir(dirname(relayDatabase), { recursive: true }),
      ])
      return Database.layer(database)
    }),
  )
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabase), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const resolvedContextLayer = ResolvedContext.layer.pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  const operationLayer = Layer.unwrap(
    Effect.gen(function* () {
      const globalSettings = yield* loadSettingsFile(globalConfig)
      const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
      const applicationConfigLayer = ConfigService.liveEnvironmentLayer({
        global: globalSettings,
        workspace: workspaceSettings,
      })
      const effectiveConfig = yield* ConfigService.effective().pipe(Effect.provide(applicationConfigLayer))
      const parallelApiKey = effectiveConfig.environment.parallelApiKey
      const allModelRoutes = (["low", "medium", "high", "ultra"] as const).map((mode) =>
        ConfigContract.resolveModelRoute(effectiveConfig.settings, mode),
      )
      const backendLayerForMode = (mode: "low" | "medium" | "high" | "ultra") =>
        configuredBackendLayer(
          relayDatabase,
          process.cwd(),
          repositoryLayer,
          turnRepositoryLayer,
          parallelApiKey,
          ConfigContract.resolveModelRoute(effectiveConfig.settings, mode),
          effectiveConfig.environment.modelApiKey,
          allModelRoutes,
          effectiveConfig.settings.modes[mode].reasoning,
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
                .pipe(Effect.mapError((error) => new ConfigOperations.AdapterError({ message: String(error) }))),
            edit: (filename) =>
              Effect.scoped(
                Effect.gen(function* () {
                  if (editor === undefined)
                    return yield* new ConfigOperations.AdapterError({
                      message: "Set VISUAL or EDITOR to edit configuration",
                    })
                  yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
                  if (!(yield* fileSystem.exists(filename))) yield* fileSystem.writeFileString(filename, "{}\n")
                  const handle = yield* spawner.spawn(ChildProcess.make(editor, [filename]))
                  const code = yield* handle.exitCode
                  if (Number(code) !== 0)
                    return yield* new ConfigOperations.AdapterError({ message: `Editor exited with status ${code}` })
                }),
              ).pipe(
                Effect.mapError((error) =>
                  error instanceof ConfigOperations.AdapterError
                    ? error
                    : new ConfigOperations.AdapterError({ message: String(error) }),
                ),
              ),
          })
        }),
      )
      return Operation.productLayer({
        repositoryLayer,
        turnRepositoryLayer,
        resolvedContextLayer,
        backendLayer: backendLayerForMode("medium"),
        backendLayerForMode,
        toolRuntimeLayer: (workspace) =>
          ToolRuntime.layer(workspace).pipe(
            Layer.provide(
              MediaView.analyzerTestLayer(() =>
                Effect.fail(new MediaView.MediaAnalysisError({ message: "Media analysis is unavailable" })),
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
        shellPermission: effectiveConfig.settings.permissions.shell === "allow" ? "allow" : "ask",
        makeThreadId: Effect.sync(() => Thread.ThreadId.make(crypto.randomUUID())),
        makeTurnId: Effect.sync(() => Turn.TurnId.make(crypto.randomUUID())),
        configOperations: {
          layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(Layer.provide(BunServices.layer)),
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
        },
        extensionOperations: { layer: extensionLayer },
        interactive: (input, session) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<never>()
            const fork = Effect.runForkWith(context)
            return yield* Effect.callback<void, Operation.OperationUnavailable>((resume) => {
              let model = ViewState.initial(process.cwd(), input.mode ?? "medium")
              let renderer: Awaited<ReturnType<typeof createTui>> | undefined
              let closed = false
              let previewTimer: ReturnType<typeof setTimeout> | undefined
              let renderTimer: ReturnType<typeof setTimeout> | undefined
              let replayTurns = new Map<string, Turn.Turn>()
              const fibers = new Set<Fiber.Fiber<void, never>>()
              let followFiber: Fiber.Fiber<void, never> | undefined
              let renderSuppressed = false
              const render = (immediate = false) => {
                if (renderer === undefined || renderSuppressed) return
                if (immediate) {
                  if (renderTimer !== undefined) clearTimeout(renderTimer)
                  renderTimer = undefined
                  renderer.surface.update(model)
                  return
                }
                if (renderTimer !== undefined) return
                renderTimer = setTimeout(() => {
                  renderTimer = undefined
                  renderer?.surface.update(model)
                }, 50)
              }
              const dispatch = (event: Operation.InteractiveEvent) => {
                if (closed) return
                if (event._tag === "QueueChanged") {
                  if (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
                    model = ViewState.replaceQueue(
                      model,
                      event.turns
                        .filter((turn) => turn.status === "queued")
                        .map((turn) => {
                          const attachments = turn.promptParts
                            ?.filter((part) => part.type === "image")
                            .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
                          if (attachments === undefined || attachments.length === 0)
                            return { id: turn.id, prompt: turn.prompt }
                          return { id: turn.id, prompt: turn.prompt, attachments }
                        }),
                    )
                } else if (event._tag === "TurnStarted") {
                  if (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
                    model = ViewState.update(model, {
                      _tag: "TurnStarted",
                      turnId: event.turn.id,
                      prompt: event.turn.prompt,
                    })
                } else if (event._tag === "ThreadsListed") {
                  model = ViewState.update(model, {
                    _tag: "ThreadsReplaced",
                    threads: event.threads.map((thread) => ({
                      id: thread.id,
                      title: thread.title,
                      workspace: thread.workspace,
                      archived: thread.archived,
                      updatedAt: thread.updatedAt,
                      active: false,
                      unread: false,
                    })),
                  })
                } else if (event._tag === "ThreadSelected") {
                  replayTurns = new Map(event.turns.map((turn) => [turn.id, turn]))
                  const activeTurn = event.turns.find(
                    (turn) => turn.status === "accepted" || turn.status === "running" || turn.status === "waiting",
                  )
                  model = {
                    ...model,
                    entries: [],
                    blocks: [],
                    items: [],
                    seenEventIds: [],
                    seenExecutionEventKeys: [],
                    eventCursor: undefined,
                    activeTurnId: activeTurn?.id,
                    busy: activeTurn !== undefined,
                    busyStatus: activeTurn === undefined ? undefined : "Working",
                    currentThreadId: String(event.thread.id),
                    currentThreadTitle: event.thread.title,
                    selectedThread: Math.max(
                      0,
                      (model.threads as ReadonlyArray<ViewState.ThreadItem>).findIndex(
                        (thread) => thread.id === event.thread.id,
                      ),
                    ),
                    threadPreview: ViewState.idle,
                  }
                } else if (event._tag === "ExecutionReplayed") {
                  if (model.currentThreadId !== event.threadId) return
                  const turn = replayTurns.get(event.result.turnId)
                  model =
                    turn === undefined
                      ? ExecutionEvents.project(model, event.result.events)
                      : ExecutionEvents.projectTurn(model, turn.id, turn.prompt, event.result.events)
                } else if (event._tag === "ExecutionEventReceived") {
                  if (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
                    model = ExecutionEvents.project(model, [{ ...event.event, turnId: event.turnId }])
                } else if (event._tag === "ExecutionControlled") {
                  if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
                  if (event.action === "cancelled" && model.busy)
                    model = ViewState.update(model, {
                      _tag: "ExecutionCancelled",
                      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                    })
                } else if (event._tag === "ExecutionFailed") {
                  if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
                  model = ViewState.update(model, {
                    _tag: "ExecutionFailed",
                    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                    message: event.message,
                  })
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
                } else if (event._tag === "ShellCompleted") {
                  model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
                } else if (event._tag === "ThreadTitled") {
                  const workspaceLabel = model.workspace.replace(/^\/Users\/[^/]+/, "~")
                  process.stdout.write(`]0;${event.title} - rika - ${workspaceLabel}`)
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
                  event._tag === "ExecutionFailed" ||
                    event._tag === "ExecutionControlled" ||
                    (event._tag === "ExecutionEventReceived" &&
                      (event.event.type === "execution.completed" ||
                        event.event.type === "execution.failed" ||
                        event.event.type === "execution.cancelled" ||
                        event.event.type === "permission.ask.requested" ||
                        event.event.type === "tool.approval.requested")),
                )
              }
              let closing = false
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
              const close = (exitCode?: number) => {
                if (closing) return
                closing = true
                closed = true
                if (exitCode !== undefined) process.exitCode = exitCode
                process.off("SIGINT", interrupt)
                process.off("SIGTERM", close)
                if (previewTimer !== undefined) clearTimeout(previewTimer)
                previewTimer = undefined
                if (renderTimer !== undefined) clearTimeout(renderTimer)
                renderTimer = undefined
                for (const fiber of fibers) fork(Fiber.interrupt(fiber))
                const finish = () => {
                  goodbye()
                  resume(Effect.void)
                  setTimeout(() => process.exit(process.exitCode ?? 0), 250)
                }
                if (renderer !== undefined) {
                  renderer.surface.destroy()
                  renderer.renderer.stop()
                  renderer.renderer.idle().finally(() => {
                    renderer?.renderer.destroy()
                    finish()
                  })
                  return
                }
                finish()
              }
              const interrupt = () => close(130)
              process.once("SIGINT", interrupt)
              process.once("SIGTERM", close)
              const submit = (
                prompt: string,
                parts: ReadonlyArray<ViewState.PromptPart>,
                mode: ViewState.Mode,
                tuning?: Session.ModelTuning,
              ) => {
                const classified = ViewState.classifyPrompt(prompt)
                const draft = { input: model.input, cursor: model.cursor, pastedText: model.pastedText }
                const effect =
                  classified._tag === "Shell"
                    ? session.shell(classified.command, classified.incognito, dispatch)
                    : materializePromptParts(parts, model.workspace).pipe(
                        Effect.flatMap((materialized) =>
                          session.submit(classified.prompt, dispatch, mode, materialized, tuning),
                        ),
                        Effect.catchTag("PromptAttachmentError", (failure) =>
                          Effect.sync(() => {
                            model = ViewState.update(
                              { ...model, ...draft, busy: false, busyStatus: undefined },
                              { _tag: "ExecutionFailed", message: failure.message },
                            )
                            renderer?.surface.update(model)
                          }),
                        ),
                      )
                const fiber = fork(effect)
                fibers.add(fiber)
                fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
              }
              const run = (effect: Effect.Effect<void, never>) => {
                const fiber = fork(effect)
                fibers.add(fiber)
                fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
              }
              const loadSelected = (effect: Effect.Effect<void, never>) =>
                Effect.gen(function* () {
                  if (followFiber !== undefined) {
                    yield* Fiber.interrupt(followFiber)
                    fibers.delete(followFiber)
                  }
                  yield* Effect.sync(() => {
                    model = ViewState.update(model, { _tag: "ThreadOpenRequested" })
                    renderer?.surface.update(model)
                    renderSuppressed = true
                  })
                  yield* effect.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        renderSuppressed = false
                        model = ViewState.update(model, { _tag: "ThreadOpenCompleted" })
                        renderer?.surface.update(model)
                      }),
                    ),
                  )
                  const selectedFollowFiber = fork(session.followSelected(dispatch))
                  followFiber = selectedFollowFiber
                  fibers.add(selectedFollowFiber)
                  fork(
                    Fiber.await(selectedFollowFiber).pipe(
                      Effect.tap(() => Effect.sync(() => fibers.delete(selectedFollowFiber))),
                    ),
                  )
                })
              const loadChangedFiles = () =>
                Effect.promise(async () => {
                  const files = await readChangedFiles(model.workspace)
                  model = ViewState.update(model, { _tag: "ChangedFilesReplaced", files })
                  renderer?.surface.update(model)
                }).pipe(Effect.asVoid)
              const watchChangedFiles = Effect.suspend(() =>
                model.changedFilesOpen ? loadChangedFiles() : Effect.void,
              ).pipe(Effect.repeat({ schedule: Schedule.spaced("1 second") }), Effect.asVoid)
              const editComposer = () =>
                Effect.promise(async () => {
                  if (editor === undefined) {
                    renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
                    return
                  }
                  const relative = `.rika/compose-${Date.now()}.md`
                  const file = `${model.workspace}/${relative}`
                  await mkdir(`${model.workspace}/.rika`, { recursive: true })
                  await Bun.write(file, ViewState.displayInput(model))
                  renderer?.renderer.suspend()
                  try {
                    await Bun.spawn([editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
                  } finally {
                    renderer?.renderer.resume()
                  }
                  const edited = await Bun.file(file).text()
                  await rm(file, { force: true })
                  model = ViewState.update(model, { _tag: "ComposerReplaced", text: edited.replace(/\n$/, "") })
                  renderer?.surface.update(model)
                }).pipe(Effect.asVoid)
              const openPath = (target: PathTarget) =>
                run(
                  Effect.promise(async () => {
                    let path: string
                    try {
                      path = await resolveWorkspaceFile(model.workspace, target)
                    } catch {
                      renderer?.surface.showToast("Refusing to open a path outside the workspace", "#e06c75")
                      return
                    }
                    if (editor === undefined) {
                      try {
                        const exit = await Bun.spawn(defaultOpenArguments(path), {
                          stdin: "ignore",
                          stdout: "ignore",
                          stderr: "ignore",
                        }).exited
                        if (exit === 0) return
                      } catch {}
                      renderer?.surface.showToast("Could not open the file in the default application", "#e06c75")
                      return
                    }
                    renderer?.renderer.suspend()
                    try {
                      await Bun.spawn(editorArguments(editor, path, target.line, target.column), {
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
                      }).exited
                    } finally {
                      renderer?.renderer.resume()
                      renderer?.surface.update(model)
                    }
                  }).pipe(Effect.asVoid),
                )
              const adapter: Session.Adapter = {
                submit,
                editQueued: (id, prompt) => run(session.editQueued(id, prompt, dispatch)),
                dequeue: (id) => run(session.dequeue(id, dispatch)),
                steerQueued: (id, prompt) => run(session.steerQueued(id, prompt, dispatch)),
                steer: (prompt) => run(session.steer(prompt, dispatch)),
                interruptAndSend: (prompt) => run(session.interruptAndSend(prompt, dispatch)),
                cancel: () => run(session.cancel(dispatch)),
                decidePermission: (id, kind, decision) => run(session.resolvePermission(id, kind, decision, dispatch)),
                selectThread: (id) => run(loadSelected(session.selectThread(id, dispatch))),
                replay: (cursor) => {
                  const turnId = model.activeTurnId
                  if (turnId !== undefined) run(session.replay(turnId, cursor, dispatch))
                },
              }
              createTui({
                openPath,
                scroll: (offset) => {
                  model = ViewState.update(model, { _tag: "ScrollMoved", offset })
                  renderer?.surface.update(model)
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
                    close(130)
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
                  if (key.alt && key.name === "d")
                    renderer?.surface.showToast(`Reasoning effort: ${model.reasoningEffort}`, "#58a6ff")
                  if (!wasChangedFilesOpen && model.changedFilesOpen) run(loadChangedFiles())
                  if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
                    if (previewTimer !== undefined) clearTimeout(previewTimer)
                    previewTimer = setTimeout(() => run(session.previewThread(afterPreviewId, dispatch)), 120)
                  }
                  if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined)
                    Session.execute(adapter, {
                      _tag: "Submit",
                      prompt: submittedPrompt,
                      parts,
                      mode: model.mode,
                      tuning: { reasoningEffort: model.reasoningEffort, fastMode: model.fastMode },
                    })
                  const action = model.pendingAction as Session.Action | undefined
                  if (action !== undefined) {
                    Session.execute(adapter, action)
                    model = ViewState.update(model, { _tag: "PaletteActionConsumed" })
                  }
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
              })
                .then((created) => {
                  renderer = created
                  model = ViewState.update(model, { _tag: "FilesRequested" })
                  created.surface.update(model)
                  created.renderer.start()
                  run(watchChangedFiles)
                  run(
                    Effect.promise(async () => {
                      const gitListing = Bun.spawn(
                        ["git", "-C", model.workspace, "ls-files", "--cached", "--others", "--exclude-standard"],
                        { stdout: "pipe", stderr: "ignore" },
                      )
                      const gitText = await new Response(gitListing.stdout).text()
                      if ((await gitListing.exited) === 0) {
                        const files = gitText.split("\n").filter((line) => line.length > 0)
                        if (files.length > 0) {
                          model = ViewState.update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                          created.surface.update(model)
                          return
                        }
                      }
                      let initialized: ReturnType<typeof FileFinder.create> | undefined
                      try {
                        initialized = FileFinder.create({ basePath: model.workspace, aiMode: true })
                      } catch {
                        initialized = undefined
                      }
                      if (initialized?.ok !== true) {
                        const files: Array<string> = []
                        for await (const file of new Bun.Glob("**/*").scan({ cwd: model.workspace, onlyFiles: true }))
                          if (!file.startsWith(".git/") && !file.startsWith("node_modules/")) files.push(file)
                        model = ViewState.update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                        created.surface.update(model)
                        return
                      }
                      try {
                        await initialized.value.waitForScan(10_000)
                        const result = initialized.value.glob("**/*", { pageSize: 10_000 })
                        if (!result.ok) throw new Error(result.error)
                        model = ViewState.update(model, {
                          _tag: "FilesReplaced",
                          files: result.value.items.map((item) => item.relativePath),
                        })
                        created.surface.update(model)
                      } finally {
                        initialized.value.destroy()
                      }
                    }).pipe(Effect.asVoid),
                  )
                  run(
                    Effect.promise(async () => {
                      const proc = Bun.spawn(["git", "-C", model.workspace, "symbolic-ref", "--short", "HEAD"], {
                        stdout: "pipe",
                        stderr: "ignore",
                      })
                      const branch = (await new Response(proc.stdout).text()).trim()
                      if ((await proc.exited) === 0 && branch.length > 0 && branch !== "HEAD") {
                        model = ViewState.update(model, { _tag: "BranchDetected", branch })
                        created.surface.update(model)
                      }
                    }).pipe(Effect.asVoid),
                  )
                  run(
                    session.initialize(dispatch).pipe(
                      Effect.andThen(
                        input.last === true
                          ? loadSelected(session.reopenThread(dispatch))
                          : input.threadId === undefined
                            ? Effect.void
                            : loadSelected(session.selectThread(input.threadId, dispatch)),
                      ),
                      Effect.andThen(
                        initialSubmitAction(input.prompt, model.mode) === undefined
                          ? Effect.void
                          : Effect.sync(() => {
                              Session.execute(adapter, initialSubmitAction(input.prompt, model.mode)!)
                            }),
                      ),
                    ),
                  )
                })
                .catch((cause) =>
                  resume(
                    Effect.fail(
                      new Operation.OperationUnavailable({ operation: "Interactive", message: String(cause) }),
                    ),
                  ),
                )
            })
          }),
      })
    }),
  )
  const dispatcherLayer = Layer.succeed(
    Operation.Service,
    Operation.Service.of({
      run: Effect.fn("Operation.dispatch")((input) =>
        Effect.gen(function* () {
          const operation = yield* Operation.Service
          yield* operation.run(input)
        }).pipe(
          Effect.provide(
            operationLayer.pipe(
              Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
              Layer.orDie,
            ),
          ),
        ),
      ),
    }),
  )
  BunRuntime.runMain(
    main.pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer, dispatcherLayer)),
    ),
  )
}
