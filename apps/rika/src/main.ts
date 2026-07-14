#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Compaction, ModelRegistry } from "@batonfx/core"
import { anthropic, anthropicClientLayerConfig } from "@batonfx/providers/anthropic"
import { openAi, openAiClientLayerConfig } from "@batonfx/providers/openai"
import { FileFinder } from "@ff-labs/fff-node"
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
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ParallelSearch, ReadWebPage, Runtime as ToolRuntime, ThreadTools } from "@rika/tools"
import { ExecutionEvents, Session, ViewState } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import type { PathTarget } from "@rika/tui"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Cause,
  Config,
  Console,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Ref,
  References,
  Schedule,
  Schema,
} from "effect"
import { Command } from "effect/unstable/cli"
import { createHash } from "node:crypto"
import { mkdir, realpath, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative as relativePathFrom, resolve } from "node:path"
import { command, version } from "./command"
import { renderGoodbye } from "./goodbye"
import * as Logging from "./logging"
import { layer as residentLayer, serve as serveResident } from "./resident-transport"

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

const testModelTurnSchema = Schema.Union([
  Schema.Struct({
    parts: Schema.NonEmptyArray(testModelPartSchema),
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    object: Schema.Unknown,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
])

const testModelScriptSchema = Schema.NonEmptyArray(testModelTurnSchema)

export const parseTestModelScript = (json: string) =>
  Effect.try({
    try: () => JSON.parse(json),
    catch: (cause) => new Error(`Invalid RIKA_TEST_MODEL_SCRIPT JSON: ${String(cause)}`),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(testModelScriptSchema)))

export const buildTestModelScript = Effect.fn("Main.buildTestModelScript")(function* (json: string) {
  const script = yield* parseTestModelScript(json)
  const { TestModel } = yield* Effect.promise(() => import("@batonfx/test"))
  return script.map((turn) => {
    const options = turn.delayMs === undefined ? {} : { delay: turn.delayMs }
    if ("object" in turn) return TestModel.object(turn.object, options)
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

export const modelRoutePlan = (route: ConfigContract.ResolvedModelRoute) => {
  const auth =
    route.gateway.auth.type === "none"
      ? { type: "none" }
      : { type: "bearer-env", variable: route.gateway.auth.variable }
  const registrationKey = `sha256:${createHash("sha256")
    .update(
      canonical({
        protocol: route.gateway.protocol,
        baseUrl: normalizedBaseUrl(route.gateway.baseUrl),
        auth,
        model: route.model,
        effort: route.effort,
        fast: route.fast,
        options: route.options,
      }),
    )
    .digest("hex")}`
  return {
    registrationKey,
    selection: { provider: route.gatewayName, model: route.model, registrationKey },
    compaction: productionCompaction(route),
  }
}

export const executionRoutePin = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly reasoningEffort?: string; readonly fastMode?: boolean },
): Turn.ExecutionRoutePin => {
  const resolveRole = (role: ConfigContract.Role) => {
    const configured = settings.modes[mode][role]
    const effort = (tuning?.reasoningEffort ?? configured.effort) as ConfigContract.Effort
    const fast = tuning?.fastMode ?? configured.fast ?? false
    const routedSettings: ConfigContract.Settings = {
      ...settings,
      modes: { ...settings.modes, [mode]: { ...settings.modes[mode], [role]: { ...configured, effort, fast } } },
    }
    const route = ConfigContract.resolveModelRoute(routedSettings, mode, role)
    const plan = modelRoutePlan(route)
    return {
      role,
      alias: route.alias,
      provider: plan.selection.provider,
      model: plan.selection.model,
      registrationKey: plan.registrationKey,
      gatewayProtocol: route.gateway.protocol,
      gatewayBaseUrl: normalizedBaseUrl(route.gateway.baseUrl),
      gatewayAuth: route.gateway.auth.type === "none" ? "none" : `bearer-env:${route.gateway.auth.variable}`,
      effort: route.effort,
      fast: route.fast,
      requestVariant: plan.registrationKey,
      providerOptions: route.options,
      compaction: route.compaction,
    }
  }
  const resolveAgent = (agent: ConfigContract.AgentId) => {
    const route = ConfigContract.resolveAgentRoute(settings, agent)
    const plan = modelRoutePlan(route)
    return {
      role: agent,
      alias: route.alias,
      provider: plan.selection.provider,
      model: plan.selection.model,
      registrationKey: plan.registrationKey,
      gatewayProtocol: route.gateway.protocol,
      gatewayBaseUrl: normalizedBaseUrl(route.gateway.baseUrl),
      gatewayAuth: route.gateway.auth.type === "none" ? "none" : `bearer-env:${route.gateway.auth.variable}`,
      effort: route.effort,
      fast: route.fast,
      requestVariant: plan.registrationKey,
      providerOptions: route.options,
      compaction: route.compaction,
    }
  }
  const summaryRoute = ConfigContract.resolveCompactionSummaryRoute(settings)
  const summaryPlan = modelRoutePlan(summaryRoute)
  return {
    version: 1,
    mode,
    compactionSummary: {
      role: "compaction",
      alias: summaryRoute.alias,
      provider: summaryPlan.selection.provider,
      model: summaryPlan.selection.model,
      registrationKey: summaryPlan.registrationKey,
      gatewayProtocol: summaryRoute.gateway.protocol,
      gatewayBaseUrl: normalizedBaseUrl(summaryRoute.gateway.baseUrl),
      gatewayAuth:
        summaryRoute.gateway.auth.type === "none" ? "none" : `bearer-env:${summaryRoute.gateway.auth.variable}`,
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

export const credentialForRoute = (
  route: ConfigContract.ResolvedModelRoute,
  gatewayCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
) => (route.gateway.auth.type === "none" ? undefined : gatewayCredentials[route.gateway.auth.variable])

const registrationForRoute = (
  route: ConfigContract.ResolvedModelRoute,
  apiKeyConfig: Config.Config<Redacted.Redacted<string>>,
) =>
  route.gateway.protocol === "openai"
    ? openAi({
        model: route.model,
        registrationKey: modelRoutePlan(route).registrationKey,
        config: route.options as NonNullable<Parameters<typeof openAi>[0]["config"]>,
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.gatewayName })),
        Effect.provide(
          openAiClientLayerConfig({
            apiUrl: Config.succeed(route.gateway.baseUrl),
            apiKey: route.gateway.auth.type === "none" ? Config.succeed(undefined) : apiKeyConfig,
          }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
        ),
      )
    : anthropic({
        model: route.model,
        registrationKey: modelRoutePlan(route).registrationKey,
        config: route.options as NonNullable<Parameters<typeof anthropic>[0]["config"]>,
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.gatewayName })),
        Effect.provide(
          anthropicClientLayerConfig({
            apiUrl: Config.succeed(route.gateway.baseUrl),
            apiKey: route.gateway.auth.type === "none" ? Config.succeed(undefined) : apiKeyConfig,
          }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
        ),
      )

const registrationForPinnedRoute = (
  route: Turn.ExecutionModelRoute,
  gatewayCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
) => {
  const credentialVariable = route.gatewayAuth.startsWith("bearer-env:")
    ? route.gatewayAuth.slice("bearer-env:".length)
    : undefined
  const credential = credentialVariable === undefined ? undefined : gatewayCredentials[credentialVariable]
  if (credentialVariable !== undefined && credential === undefined)
    return Effect.fail(new Error(`Missing environment variable ${credentialVariable} for gateway ${route.provider}`))
  const apiKey = Config.succeed(credential)
  return route.gatewayProtocol === "openai"
    ? openAi({
        model: route.model,
        registrationKey: route.registrationKey,
        config: (route.providerOptions ?? {}) as NonNullable<Parameters<typeof openAi>[0]["config"]>,
      }).pipe(
        Effect.map((registration) => ({ ...registration, provider: route.provider })),
        Effect.provide(
          openAiClientLayerConfig({ apiUrl: Config.succeed(route.gatewayBaseUrl), apiKey }).pipe(
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
        Effect.provide(
          anthropicClientLayerConfig({ apiUrl: Config.succeed(route.gatewayBaseUrl), apiKey }).pipe(
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

export const registrationsForRoutes = (
  routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  gatewayCredentials: Readonly<Record<string, Redacted.Redacted<string>>>,
) => {
  return Effect.forEach(distinctModelRoutes(routes), (route) => {
    if (route.gateway.auth.type === "none") return registrationForRoute(route, Config.succeed(Redacted.make("unused")))
    const credential = credentialForRoute(route, gatewayCredentials)
    if (credential === undefined)
      return Effect.fail(
        new Error(`Missing environment variable ${route.gateway.auth.variable} for gateway ${route.gatewayName}`),
      )
    return registrationForRoute(route, Config.succeed(credential))
  })
}

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

export const configuredBackendLayer = (
  filename: string,
  workspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, unknown, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, unknown, never>,
  parallelApiKey?: import("effect").Redacted.Redacted<string>,
  modelRoute?: ConfigContract.ResolvedModelRoute,
  gatewayCredentials: Readonly<Record<string, import("effect").Redacted.Redacted<string>>> = {},
  allModelRoutes?: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  oracleRoute?: ConfigContract.ResolvedModelRoute,
  persistedModelRoutes: ReadonlyArray<Turn.ExecutionModelRoute> = [],
  compactionSummaryRoute?: ConfigContract.ResolvedModelRoute,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(dirname(filename), { recursive: true }))
      const route = modelRoute ?? ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
      const resolvedOracleRoute = oracleRoute ?? route
      const resolvedCompactionSummaryRoute =
        compactionSummaryRoute ?? ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults)
      const routePlan = modelRoutePlan(route)
      const oracleRoutePlan = modelRoutePlan(resolvedOracleRoute)
      const compactionSummaryPlan = modelRoutePlan(resolvedCompactionSummaryRoute)
      const testResponse = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
      const testScript = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
      if (testResponse._tag === "Some" && testScript._tag === "Some") {
        return yield* Effect.fail(new Error("RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set"))
      }
      yield* Effect.logInfo("model.backend.configured").pipe(
        Effect.annotateLogs(
          "rika.model.backend.kind",
          testScript._tag === "Some" ? "test-script" : testResponse._tag === "Some" ? "test-response" : "provider",
        ),
      )
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
        const configuredRegistrations = yield* registrationsForRoutes(
          allModelRoutes ?? [route, resolvedOracleRoute, resolvedCompactionSummaryRoute],
          gatewayCredentials,
        )
        const configuredKeys = new Set(configuredRegistrations.map(registrationTuple))
        const persistedRegistrations = yield* Effect.forEach(
          persistedModelRoutes.filter(
            (candidate, index, all) =>
              candidate.gatewayProtocol !== "test" &&
              !configuredKeys.has(registrationTuple(candidate)) &&
              all.findIndex((other) => registrationTuple(other) === registrationTuple(candidate)) === index,
          ),
          (candidate) => registrationForPinnedRoute(candidate, gatewayCredentials),
        )
        const registrations = [...configuredRegistrations, ...persistedRegistrations]
        if (registrations.length === 0)
          return yield* Effect.fail(new Error("No configured model routes could be registered"))
        registration = registrations[0]!
        additionalRegistrations = registrations.slice(1)
        selection = routePlan.selection
      }
      return relayBackendLayer(
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
          compaction: routePlan.compaction,
          oracleCompaction: oracleRoutePlan.compaction,
          resolveExecutionRoute: (turnId) =>
            TurnRepository.Service.pipe(
              Effect.flatMap((turns) => turns.get(Turn.TurnId.make(turnId))),
              Effect.map((turn) => turn?.executionRoute),
              Effect.provide(turnRepositoryLayer),
              Effect.mapError((cause) => new ExecutionBackend.BackendError({ message: String(cause) })),
            ),
          toolRuntimeLayerForWorkspace: ToolRuntime.layer,
          resolveWorkspace: (durableExecutionId) =>
            Effect.gen(function* () {
              const turnId = RelayExecutionBackend.turnIdFromExecutionId(durableExecutionId)
              if (turnId === undefined)
                return yield* new ExecutionBackend.BackendError({
                  message: `Execution ${durableExecutionId} is not attached to a Rika Turn`,
                })
              const turns = yield* TurnRepository.Service
              const turn = yield* turns.get(Turn.TurnId.make(turnId))
              if (turn === undefined)
                return yield* new ExecutionBackend.BackendError({ message: `Turn ${turnId} does not exist` })
              const threads = yield* ThreadRepository.Service
              const thread = yield* threads.get(turn.threadId)
              if (thread === undefined)
                return yield* new ExecutionBackend.BackendError({ message: `Thread ${turn.threadId} does not exist` })
              return thread.workspace
            }).pipe(
              Effect.provide(Layer.merge(repositoryLayer, turnRepositoryLayer)),
              Effect.mapError((cause) =>
                cause instanceof ExecutionBackend.BackendError
                  ? cause
                  : new ExecutionBackend.BackendError({ message: String(cause) }),
              ),
            ),
          ...(parallelApiKey === undefined ? {} : { parallelApiKey }),
        },
        repositoryLayer,
        turnRepositoryLayer,
      ).pipe(Layer.provide(BunCrypto.layer))
    }),
  )

const lazyBackendLayer = (backendLayer: Layer.Layer<ExecutionBackend.Service, unknown>) =>
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
            Effect.mapError((cause) => new ExecutionBackend.BackendError({ message: String(cause) })),
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
        ensureThreadHost: (threadId, createdAt) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.ensureThreadHost === undefined ? Effect.void : backend.ensureThreadHost(threadId, createdAt),
            ),
          ),
        notifyThreadHost: (threadId, turnId, now) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.notifyThreadHost === undefined ? Effect.void : backend.notifyThreadHost(threadId, turnId, now),
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
    .pipe(Effect.mapError((error) => new ConfigContract.ConfigFileError({ path: filename, message: String(error) })))
  const value = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (error) => new ConfigContract.ConfigFileError({ path: filename, message: `Invalid JSON: ${String(error)}` }),
  })
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
  Effect.catchTag("OperationUnavailable", (error: Operation.OperationUnavailable) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  ),
  Effect.catchTag("InvalidInput", (error: Operation.InvalidInput) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  ),
)

export const withClientWorkspace = (input: Operation.Input, workspace: string): Operation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (input._tag === "Mcp" && input.action === "approve")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Doctor" ||
    input._tag === "Thread"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

export const gatewayCredentialsForRoutes = (
  configuredRoutes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  persistedRoutes: ReadonlyArray<Turn.ExecutionModelRoute>,
  initial: Readonly<Record<string, Redacted.Redacted<string>>>,
  readEnvironment: (name: string) => string | undefined,
) => {
  const variables = new Set<string>()
  for (const route of configuredRoutes)
    if (route.gateway.auth.type === "bearer-env") variables.add(route.gateway.auth.variable)
  for (const route of persistedRoutes)
    if (route.gatewayAuth.startsWith("bearer-env:")) variables.add(route.gatewayAuth.slice("bearer-env:".length))
  const credentials: Record<string, Redacted.Redacted<string>> = { ...initial }
  for (const variable of variables) {
    if (credentials[variable] !== undefined) continue
    const value = readEnvironment(variable)
    if (value !== undefined) credentials[variable] = Redacted.make(value)
  }
  return credentials
}

export const persistedModelRoutesForStartup = (turns: ReadonlyArray<Turn.Turn>) =>
  turns.flatMap((turn) =>
    turn.executionRoute === undefined
      ? []
      : [
          turn.executionRoute.main,
          turn.executionRoute.oracle,
          ...(turn.executionRoute.compactionSummary === undefined ? [] : [turn.executionRoute.compactionSummary]),
          ...Object.values(turn.executionRoute.agents ?? {}),
        ],
  )

export const canonicalDatabaseRoot = async (productDatabase: string, relayDatabase: string) => {
  if (basename(productDatabase) !== "rika.db" || basename(relayDatabase) !== "relay.db")
    throw new Error("RIKA_DATABASE and RIKA_RELAY_DATABASE must name rika.db and relay.db in one data directory")
  const productRoot = dirname(resolve(productDatabase))
  const relayRoot = dirname(resolve(relayDatabase))
  await Promise.all([mkdir(productRoot, { recursive: true }), mkdir(relayRoot, { recursive: true })])
  const [canonicalProductRoot, canonicalRelayRoot] = await Promise.all([realpath(productRoot), realpath(relayRoot)])
  if (canonicalProductRoot !== canonicalRelayRoot)
    throw new Error("RIKA_DATABASE and RIKA_RELAY_DATABASE must use one data directory")
  return canonicalProductRoot
}

export const interruptTrackedFibers = (fibers: Iterable<Fiber.Fiber<void, never>>) =>
  Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded", discard: true })

export const interruptAndClearTrackedFiber = (
  fiber: Fiber.Fiber<void, never>,
  clear: (fiber: Fiber.Fiber<void, never>) => void,
) => Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(() => clear(fiber))))

export const refreshThreadsOnSwitcherOpen = (
  wasOpen: boolean,
  isOpen: boolean,
  initialize: Effect.Effect<void, never>,
) => (!wasOpen && isOpen ? initialize : Effect.void)

export const settleTuiInitialization = async <T>(
  task: Promise<T>,
  isClosed: () => boolean,
  destroy: (value: T) => Promise<void>,
) => {
  const value = await task
  if (!isClosed()) return value
  await destroy(value)
  return undefined
}

if (import.meta.main) {
  const hostDataRoot = process.env.RIKA_INTERNAL_RESIDENT_DATA_ROOT
  const defaultDataRoot = `${process.env.HOME ?? process.cwd()}/.rika`
  const database =
    hostDataRoot === undefined
      ? (process.env.RIKA_DATABASE ?? `${defaultDataRoot}/rika.db`)
      : join(hostDataRoot, "rika.db")
  const relayDatabase =
    hostDataRoot === undefined
      ? (process.env.RIKA_RELAY_DATABASE ?? `${defaultDataRoot}/relay.db`)
      : join(hostDataRoot, "relay.db")
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
        let renderer: Awaited<ReturnType<typeof createTui>> | undefined
        let initialization: Promise<void> | undefined
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
        const teardown = (showGoodbye: boolean) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("tui.teardown.started")
            closed = true
            process.off("SIGINT", interrupt)
            process.off("SIGTERM", close)
            if (previewTimer !== undefined) clearTimeout(previewTimer)
            previewTimer = undefined
            if (renderTimer !== undefined) clearTimeout(renderTimer)
            renderTimer = undefined
            renderer?.releaseTerminal()
            if (initialization !== undefined)
              yield* Effect.promise(() => initialization!).pipe(Effect.catch(() => Effect.void))
            yield* interruptTrackedFibers([...fibers])
            if (showGoodbye) goodbye()
            yield* Effect.logInfo("tui.teardown.completed")
          })
        const close = (exitCode?: number) => {
          if (closing) return
          closing = true
          if (exitCode !== undefined) process.exitCode = exitCode
          fork(teardown(true).pipe(Effect.andThen(Effect.sync(() => resume(Effect.void)))))
        }
        const interrupt = () => close(130)
        process.once("SIGINT", interrupt)
        process.once("SIGTERM", close)
        const startSelectedFollow = () => {
          if (followFiber !== undefined) return
          const selectedFollowFiber = fork(session.followSelected(dispatch))
          followFiber = selectedFollowFiber
          fibers.add(selectedFollowFiber)
          fork(
            Fiber.await(selectedFollowFiber).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  fibers.delete(selectedFollowFiber)
                  if (followFiber === selectedFollowFiber) followFiber = undefined
                }),
              ),
            ),
          )
        }
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
                    session
                      .submit(classified.prompt, dispatch, mode, materialized, tuning)
                      .pipe(Effect.tap(() => Effect.sync(startSelectedFollow))),
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
              const interruptedFiber = followFiber
              yield* interruptAndClearTrackedFiber(interruptedFiber, (fiber) => {
                fibers.delete(fiber)
                if (followFiber === fiber) followFiber = undefined
              })
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
            yield* Effect.sync(startSelectedFollow)
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
            renderer?.suspendTerminal()
            try {
              await Bun.spawn([editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
            } finally {
              renderer?.resumeTerminal()
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
              renderer?.suspendTerminal()
              try {
                await Bun.spawn(editorArguments(editor, path, target.line, target.column), {
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                }).exited
              } finally {
                renderer?.resumeTerminal()
                if (!closed) renderer?.surface.update(model)
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
        initialization = settleTuiInitialization(
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
              const wasThreadSwitcherOpen = model.threadSwitcher.open
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
              const afterPreviewId = model.threadSwitcher.open ? ViewState.selectedThreadMetadata(model)?.id : undefined
              if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
                model = ViewState.update(model, { _tag: "ThreadPreviewRequested" })
              renderer?.surface.update(model)
              run(
                refreshThreadsOnSwitcherOpen(
                  wasThreadSwitcherOpen,
                  model.threadSwitcher.open,
                  session.initialize(dispatch),
                ),
              )
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
          }),
          () => closed,
          async (created) => {
            created.releaseTerminal()
          },
        )
          .then((created) => {
            if (created === undefined) return
            renderer = created
            if (closed) {
              created.releaseTerminal()
              return
            }
            model = ViewState.update(model, { _tag: "FilesRequested" })
            created.surface.update(model)
            created.renderer.start()
            run(Effect.logInfo("tui.renderer.started"))
            if (closed) return
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
          .catch((cause) => {
            if (closed) return
            resume(
              Effect.logError("tui.renderer.failed").pipe(
                Effect.annotateLogs("rika.failure.kind", cause instanceof Error ? cause.name : typeof cause),
                Effect.andThen(
                  Effect.fail(new Operation.OperationUnavailable({ operation: "Interactive", message: String(cause) })),
                ),
              ),
            )
          })
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
        const effectiveConfig = yield* ConfigService.effective().pipe(Effect.provide(applicationConfigLayer))
        const testModelConfigured =
          process.env.RIKA_TEST_MODEL_RESPONSE !== undefined || process.env.RIKA_TEST_MODEL_SCRIPT !== undefined
        const resolveWorkspaceExecutionRoute = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly reasoningEffort?: string; readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
            const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({
              global: globalSettings,
              workspace: settings,
            })
            const resolvedWorkspaceConfig = yield* ConfigService.effective().pipe(Effect.provide(workspaceConfigLayer))
            const routes = (["low", "medium", "high", "ultra"] as const).flatMap((candidate) => [
              ConfigContract.resolveModelRoute(resolvedWorkspaceConfig.settings, candidate, "main"),
              ConfigContract.resolveModelRoute(resolvedWorkspaceConfig.settings, candidate, "oracle"),
            ])
            routes.push(
              ConfigContract.resolveCompactionSummaryRoute(resolvedWorkspaceConfig.settings),
              ...(["librarian", "painter", "review", "readThread", "task"] as const).map((agent) =>
                ConfigContract.resolveAgentRoute(resolvedWorkspaceConfig.settings, agent),
              ),
            )
            if (!testModelConfigured) {
              const registrations = yield* registrationsForRoutes(
                routes,
                resolvedWorkspaceConfig.environment.gatewayCredentials,
              )
              const backend = yield* ExecutionBackend.Service
              if (backend.registerModels !== undefined) yield* backend.registerModels(registrations)
            }
            return executionRoutePin(resolvedWorkspaceConfig.settings, mode, tuning)
          }).pipe(Effect.provide(BunServices.layer))
        const parallelApiKey = effectiveConfig.environment.parallelApiKey
        const allModelRoutes = (["low", "medium", "high", "ultra"] as const).flatMap((mode) => [
          ConfigContract.resolveModelRoute(effectiveConfig.settings, mode, "main"),
          ConfigContract.resolveModelRoute(effectiveConfig.settings, mode, "oracle"),
        ])
        allModelRoutes.push(
          ConfigContract.resolveCompactionSummaryRoute(effectiveConfig.settings),
          ...(["librarian", "painter", "review", "readThread", "task"] as const).map((agent) =>
            ConfigContract.resolveAgentRoute(effectiveConfig.settings, agent),
          ),
        )
        const repositories = Layer.succeedContext(yield* Layer.build(Layer.merge(repositoryLayer, turnRepositoryLayer)))
        const persistedModelRoutes = yield* TurnRepository.Service.pipe(
          Effect.flatMap((turns) => turns.listNonterminal()),
          Effect.map(persistedModelRoutesForStartup),
          Effect.provide(repositories),
        )
        const gatewayCredentials = gatewayCredentialsForRoutes(
          allModelRoutes,
          persistedModelRoutes,
          effectiveConfig.environment.gatewayCredentials,
          (name) => process.env[name],
        )
        const backendLayer = configuredBackendLayer(
          relayDatabase,
          process.cwd(),
          repositories,
          repositories,
          parallelApiKey,
          ConfigContract.resolveModelRoute(effectiveConfig.settings, "medium", "main"),
          gatewayCredentials,
          allModelRoutes,
          ConfigContract.resolveModelRoute(effectiveConfig.settings, "medium", "oracle"),
          persistedModelRoutes,
          ConfigContract.resolveCompactionSummaryRoute(effectiveConfig.settings),
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
        const product = Operation.productLayer({
          repositoryLayer: repositories,
          turnRepositoryLayer: repositories,
          resolvedContextLayer,
          backendLayer: lazyBackendLayer(backendLayer),
          resolveExecutionRoute: resolveWorkspaceExecutionRoute,
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
          shellPermission: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
              const layer = ConfigService.liveEnvironmentLayer({ global: globalSettings, workspace: settings })
              const config = yield* ConfigService.effective().pipe(Effect.provide(layer))
              return config.settings.permissions.shell === "allow" ? "allow" : "ask"
            }).pipe(Effect.provide(BunServices.layer), Effect.orDie),
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
            forWorkspace: (workspace) =>
              Effect.gen(function* () {
                const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
                return {
                  layer: Layer.merge(
                    configAdapter,
                    ConfigService.liveEnvironmentLayer({ global: globalSettings, workspace: settings }),
                  ).pipe(Layer.provide(BunServices.layer)),
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
              }).pipe(Effect.provide(BunServices.layer)),
          },
          extensionOperations: { layer: extensionLayer },
          interactive: injectedInteractive,
        })
        return product
      }),
    )
  const residentOwner = (
    interactive: Parameters<NonNullable<Parameters<ResidentService.Interface["getOrCreate"]>[0]["owner"]>>[0],
  ) =>
    Layer.build(
      operationLayer(interactive).pipe(
        Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        Layer.orDie,
      ),
    ).pipe(
      Effect.map((context) => Context.get(context, Operation.Service)),
      Effect.tapCause((cause) =>
        Effect.logError("resident.owner.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
      ),
      Effect.mapError(
        (cause) =>
          new ResidentService.ResidentServiceError({
            reason: "transport-failed",
            message: String(cause),
          }),
      ),
    )
  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Effect.logInfo("process.started").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const globalSettings = yield* loadSettingsFile(globalConfig)
          const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
          const effectiveConfig = yield* ConfigService.effective().pipe(
            Effect.provide(ConfigService.memoryLayer({ global: globalSettings, workspace: workspaceSettings })),
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
        Effect.logError("process.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
      ),
      Effect.ensuring(Effect.logInfo("process.stopped")),
      Effect.annotateLogs({
        "rika.process.role": role,
        "rika.process.instance": `${Date.now()}-${process.pid}`,
        "rika.process.pid": process.pid,
        "rika.version": version,
      }),
      Effect.provide(Logging.layer({ dataRoot, role, version })),
      Effect.provide(BunServices.layer),
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
                          clientVersion: version,
                          startHost: () =>
                            Effect.gen(function* () {
                              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
                              const handle = yield* spawner.spawn(
                                ChildProcess.make(process.execPath, [import.meta.path], {
                                  detached: true,
                                  stdin: "ignore",
                                  stdout: "ignore",
                                  stderr: "ignore",
                                  extendEnv: true,
                                  env: {
                                    RIKA_INTERNAL_RESIDENT_HOST: "1",
                                    RIKA_INTERNAL_RESIDENT_PROFILE: "default",
                                    RIKA_INTERNAL_RESIDENT_DATA_ROOT: dataRoot,
                                    ...(process.env.RIKA_TEST_MODEL_RESPONSE === undefined
                                      ? {}
                                      : { RIKA_TEST_MODEL_RESPONSE: process.env.RIKA_TEST_MODEL_RESPONSE }),
                                    ...(process.env.RIKA_TEST_MODEL_SCRIPT === undefined
                                      ? {}
                                      : { RIKA_TEST_MODEL_SCRIPT: process.env.RIKA_TEST_MODEL_SCRIPT }),
                                  },
                                }),
                              )
                              yield* handle.unref
                              yield* Effect.logInfo("resident.spawned")
                            }).pipe(
                              Effect.mapError((cause) =>
                                cause instanceof ResidentService.ResidentServiceError
                                  ? cause
                                  : new ResidentService.ResidentServiceError({
                                      reason: "transport-failed",
                                      message: String(cause),
                                    }),
                              ),
                            ),
                        })
                        .pipe(Effect.provide(Layer.merge(BunServices.layer, BunCrypto.layer))),
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
                            error instanceof Operation.OperationUnavailable
                              ? error
                              : new Operation.OperationUnavailable({
                                  operation: clientInput._tag,
                                  message: error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
                    return yield* new Operation.OperationUnavailable({
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
            Effect.provide(BunServices.layer),
          ),
        ),
      })
    }),
  )
  const clientProgram = main.pipe(
    Effect.provide(
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
            profile: process.env.RIKA_INTERNAL_RESIDENT_PROFILE ?? "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(process.env.RIKA_INTERNAL_RESIDENT_GRACE ?? "500"),
            owner: residentOwner,
          }),
        ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)))
  if (process.env.RIKA_INTERNAL_RESIDENT_HOST === "1")
    BunRuntime.runMain(observedProgram("resident", hostDataRoot ?? defaultDataRoot, hostProgram))
  else BunRuntime.runMain(clientProgram)
}
