import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config, Diagnostics } from "@rika/core"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import {
  FileFinder,
  type DirSearchOptions as NativeDirSearchOptions,
  type DirSearchResult as NativeDirSearchResult,
  type FileFinderApi,
  type GrepCursor,
  type GrepMode as NativeGrepMode,
  type GrepOptions as NativeGrepOptions,
  type GrepResult as NativeGrepResult,
  type HealthCheck as NativeHealthCheck,
  type InitOptions as NativeInitOptions,
  type MixedSearchResult as NativeMixedSearchResult,
  type MultiGrepOptions as NativeMultiGrepOptions,
  type SearchOptions as NativeSearchOptions,
  type SearchResult as NativeSearchResult,
} from "@ff-labs/fff-bun"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import "./fff-bun-globals"

const defaultPageSize = 50
const maxPageSize = 200
const defaultWaitMs = 5_000
const defaultTimeBudgetMs = 500
const defaultMaxFileSize = 10 * 1024 * 1024
const defaultGrepMode: NativeGrepMode = "plain"
const hashLength = 4

interface NativeGlobOptions {
  readonly maxThreads?: number
  readonly currentFile?: string
  readonly pageIndex?: number
  readonly pageSize?: number
}

export interface FileSearchInput extends Schema.Schema.Type<typeof FileSearchInput> {}
export const FileSearchInput = Schema.Struct({
  query: Schema.String,
  page_size: Schema.optionalKey(Schema.Int),
  page_index: Schema.optionalKey(Schema.Int),
  current_file: Schema.optionalKey(Schema.String),
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.FileSearchInput" })

export interface GlobInput extends Schema.Schema.Type<typeof GlobInput> {}
export const GlobInput = Schema.Struct({
  pattern: Schema.String,
  page_size: Schema.optionalKey(Schema.Int),
  page_index: Schema.optionalKey(Schema.Int),
  current_file: Schema.optionalKey(Schema.String),
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.GlobInput" })

export interface DirectorySearchInput extends Schema.Schema.Type<typeof DirectorySearchInput> {}
export const DirectorySearchInput = Schema.Struct({
  query: Schema.String,
  page_size: Schema.optionalKey(Schema.Int),
  page_index: Schema.optionalKey(Schema.Int),
  current_file: Schema.optionalKey(Schema.String),
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.DirectorySearchInput" })

export const GrepMode = Schema.Literals(["plain", "regex", "fuzzy"]).annotate({
  identifier: "Rika.Tools.FffSearch.GrepMode",
})
export type GrepMode = typeof GrepMode.Type

export interface GrepInput extends Schema.Schema.Type<typeof GrepInput> {}
export const GrepInput = Schema.Struct({
  query: Schema.String,
  path: Schema.optionalKey(Schema.String),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  mode: Schema.optionalKey(GrepMode),
  smart_case: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(Schema.Int),
  before_context: Schema.optionalKey(Schema.Int),
  after_context: Schema.optionalKey(Schema.Int),
  page_size: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.Int),
  time_budget_ms: Schema.optionalKey(Schema.Int),
  max_file_size: Schema.optionalKey(Schema.Int),
  max_matches_per_file: Schema.optionalKey(Schema.Int),
  classify_definitions: Schema.optionalKey(Schema.Boolean),
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.GrepInput" })

export interface MultiGrepInput extends Schema.Schema.Type<typeof MultiGrepInput> {}
export const MultiGrepInput = Schema.Struct({
  patterns: Schema.Array(Schema.String),
  constraints: Schema.optionalKey(Schema.String),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  smart_case: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(Schema.Int),
  before_context: Schema.optionalKey(Schema.Int),
  after_context: Schema.optionalKey(Schema.Int),
  page_size: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.Int),
  time_budget_ms: Schema.optionalKey(Schema.Int),
  max_file_size: Schema.optionalKey(Schema.Int),
  max_matches_per_file: Schema.optionalKey(Schema.Int),
  classify_definitions: Schema.optionalKey(Schema.Boolean),
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.MultiGrepInput" })

export interface HealthInput extends Schema.Schema.Type<typeof HealthInput> {}
export const HealthInput = Schema.Struct({
  test_path: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.FffSearch.HealthInput" })

export interface RescanInput extends Schema.Schema.Type<typeof RescanInput> {}
export const RescanInput = Schema.Struct({
  wait_ms: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.FffSearch.RescanInput" })

export class FffSearchError extends Schema.TaggedErrorClass<FffSearchError>()("FffSearchError", {
  message: Schema.String,
  code: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly fileSearch: (input: FileSearchInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly glob: (input: GlobInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly directorySearch: (input: DirectorySearchInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly grep: (input: GrepInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly multiGrep: (input: MultiGrepInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly health: (input: HealthInput) => Effect.Effect<Common.JsonValue, FffSearchError>
  readonly rescan: (input: RescanInput) => Effect.Effect<Common.JsonValue, FffSearchError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/FffSearch") {}

export interface FinderOptions {
  readonly workspaceRoot: string
  readonly dataDir: string
  readonly frecencyDbPath: string
  readonly historyDbPath: string
  readonly aiMode: boolean
}

export interface Finder {
  readonly backend: "fff" | "fallback" | "fake"
  readonly degradedReason?: string
  readonly waitForIndexReady: (timeoutMs: number) => Effect.Effect<boolean, FffSearchError>
  readonly fileSearch: (
    query: string,
    options: NativeSearchOptions,
  ) => Effect.Effect<NativeSearchResult | NativeMixedSearchResult, FffSearchError>
  readonly glob: (pattern: string, options: NativeGlobOptions) => Effect.Effect<NativeSearchResult, FffSearchError>
  readonly directorySearch: (
    query: string,
    options: NativeDirSearchOptions,
  ) => Effect.Effect<NativeDirSearchResult, FffSearchError>
  readonly grep: (query: string, options: NativeGrepOptions) => Effect.Effect<NativeGrepResult, FffSearchError>
  readonly multiGrep: (options: NativeMultiGrepOptions) => Effect.Effect<NativeGrepResult, FffSearchError>
  readonly health: (testPath?: string) => Effect.Effect<NativeHealthCheck | Common.JsonValue, FffSearchError>
  readonly rescan: Effect.Effect<void, FffSearchError>
  readonly destroy: Effect.Effect<void>
}

export type FinderFactory = (options: FinderOptions) => Effect.Effect<Finder, FffSearchError>

export interface LayerOptions {
  readonly fallbackOnNativeError?: boolean
}

export const layer: Layer.Layer<Service, FffSearchError, Config.Service> = layerFromFactory(nativeFinderFactory, {
  fallbackOnNativeError: true,
})

export function layerFromFactory(
  factory: FinderFactory,
  options: LayerOptions = {},
): Layer.Layer<Service, FffSearchError, Config.Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const values = yield* config.get
      const finderOptions = finderOptionsFromConfig(values)
      const finder = yield* factory(finderOptions).pipe(
        Effect.catch((error: FffSearchError) => {
          if (options.fallbackOnNativeError !== true) return Effect.fail(error)
          return fallbackFinderFactory(finderOptions, error.message)
        }),
      )
      yield* Effect.addFinalizer(() => finder.destroy.pipe(Effect.ignore))
      return makeService(finderOptions.workspaceRoot, finder)
    }),
  )
}

export interface FakeFile {
  readonly path: string
  readonly content: string
  readonly git_status?: string
}

export const fakeLayer = (files: ReadonlyArray<FakeFile>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const values = yield* config.get
      const finder = memoryFinder(resolve(values.workspace_root), files, "fake")
      return makeService(resolve(values.workspace_root), finder)
    }),
  )

export const fileSearch = Effect.fn("FffSearch.fileSearch.call")(function* (input: FileSearchInput) {
  const service = yield* Service
  return yield* service.fileSearch(input)
})

export const glob = Effect.fn("FffSearch.glob.call")(function* (input: GlobInput) {
  const service = yield* Service
  return yield* service.glob(input)
})

export const directorySearch = Effect.fn("FffSearch.directorySearch.call")(function* (input: DirectorySearchInput) {
  const service = yield* Service
  return yield* service.directorySearch(input)
})

export const grep = Effect.fn("FffSearch.grep.call")(function* (input: GrepInput) {
  const service = yield* Service
  return yield* service.grep(input)
})

export const multiGrep = Effect.fn("FffSearch.multiGrep.call")(function* (input: MultiGrepInput) {
  const service = yield* Service
  return yield* service.multiGrep(input)
})

export const health = Effect.fn("FffSearch.health.call")(function* (input: HealthInput = {}) {
  const service = yield* Service
  return yield* service.health(input)
})

export const rescan = Effect.fn("FffSearch.rescan.call")(function* (input: RescanInput = {}) {
  const service = yield* Service
  return yield* service.rescan(input)
})

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("fffind", {
      description:
        "Use fff to fuzzy-search repo-relative file paths. Prefer this over shell find/fd/ls for ordinary path discovery; stop after useful results and read/edit the top files.",
      parameters: FileSearchInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.fffind")(function* (call: Call) {
      const input = yield* decodeFileSearchInput(call)
      return yield* service.fileSearch(input).pipe(Effect.mapError(toRegistryError("fffind")))
    }),
  },
  {
    tool: Tool.make("fff_glob", {
      description:
        "Use fff glob filtering for exact path constraints such as **/*.ts. Prefer this over shell glob/fd for file lists.",
      parameters: GlobInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.glob")(function* (call: Call) {
      const input = yield* decodeGlobInput(call)
      return yield* service.glob(input).pipe(Effect.mapError(toRegistryError("fff_glob")))
    }),
  },
  {
    tool: Tool.make("fff_directory_search", {
      description: "Use fff to fuzzy-search directories before narrowing path or grep work.",
      parameters: DirectorySearchInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.directory_search")(function* (call: Call) {
      const input = yield* decodeDirectorySearchInput(call)
      return yield* service.directorySearch(input).pipe(Effect.mapError(toRegistryError("fff_directory_search")))
    }),
  },
  {
    tool: Tool.make("ffgrep", {
      description:
        "Use fff indexed content search. Prefer this over shell rg/grep for ordinary code search; results include file:line hits and hashline anchors when available.",
      parameters: GrepInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.ffgrep")(function* (call: Call) {
      const input = yield* decodeGrepInput(call)
      return yield* service.grep(input).pipe(Effect.mapError(toRegistryError("ffgrep")))
    }),
  },
  {
    tool: Tool.make("fff_multi_grep", {
      description:
        "Use fff multi-pattern OR content search for several literal identifiers in one indexed pass instead of many grep calls.",
      parameters: MultiGrepInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.multi_grep")(function* (call: Call) {
      const input = yield* decodeMultiGrepInput(call)
      return yield* service.multiGrep(input).pipe(Effect.mapError(toRegistryError("fff_multi_grep")))
    }),
  },
  {
    tool: Tool.make("fff_health", {
      description: "Report fff index, watcher, git, frecency, and fallback health for the current workspace.",
      parameters: HealthInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.health")(function* (call: Call) {
      const input = yield* decodeHealthInput(call)
      return yield* service.health(input).pipe(Effect.mapError(toRegistryError("fff_health")))
    }),
  },
  {
    tool: Tool.make("fff_rescan", {
      description: "Ask fff to rescan the workspace after large filesystem changes or if search results look stale.",
      parameters: RescanInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("FffSearch.tool.rescan")(function* (call: Call) {
      const input = yield* decodeRescanInput(call)
      return yield* service.rescan(input).pipe(Effect.mapError(toRegistryError("fff_rescan")))
    }),
  },
]

export const registryLayerFromService: Layer.Layer<ToolRegistry.Service, never, Service> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const service = yield* Service
    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(toolDefinitions(service))))
  }),
)

export const registryLayer: Layer.Layer<ToolRegistry.Service, FffSearchError, Config.Service> =
  registryLayerFromService.pipe(Layer.provideMerge(layer))

export const toolExecutorLayer: Layer.Layer<
  ToolExecutor.Service,
  FffSearchError,
  Config.Service | Diagnostics.Service
> = ToolExecutor.layer.pipe(Layer.provideMerge(registryLayer), Layer.provideMerge(PermissionPolicy.allowLayer))

const makeService = (workspaceRoot: string, finder: Finder): Interface =>
  Service.of({
    fileSearch: Effect.fn("FffSearch.fileSearch")(function* (input: FileSearchInput) {
      yield* waitForIndex(finder, input.wait_ms)
      const result = yield* finder.fileSearch(input.query, searchOptions(input))
      return yield* jsonValue({
        type: "fff.file_search",
        backend: finder.backend,
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        query: input.query,
        ...normalizeFileSearchResult(result, input.page_index ?? 0, input.page_size ?? defaultPageSize),
      })
    }),
    glob: Effect.fn("FffSearch.glob")(function* (input: GlobInput) {
      yield* waitForIndex(finder, input.wait_ms)
      const result = yield* finder.glob(input.pattern, globOptions(input))
      return yield* jsonValue({
        type: "fff.glob",
        backend: finder.backend,
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        pattern: input.pattern,
        ...normalizeFileSearchResult(result, input.page_index ?? 0, input.page_size ?? defaultPageSize),
      })
    }),
    directorySearch: Effect.fn("FffSearch.directorySearch")(function* (input: DirectorySearchInput) {
      yield* waitForIndex(finder, input.wait_ms)
      const result = yield* finder.directorySearch(input.query, directoryOptions(input))
      return yield* jsonValue({
        type: "fff.directory_search",
        backend: finder.backend,
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        query: input.query,
        ...normalizeDirectorySearchResult(result, input.page_index ?? 0, input.page_size ?? defaultPageSize),
      })
    }),
    grep: Effect.fn("FffSearch.grep")(function* (input: GrepInput) {
      yield* waitForIndex(finder, input.wait_ms)
      const query = grepQuery(input)
      const result = yield* finder.grep(query, grepOptions(input))
      const anchored = yield* addAnchors(workspaceRoot, result)
      return yield* jsonValue({
        type: "fff.grep",
        backend: finder.backend,
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        query,
        mode: input.mode ?? "plain",
        ...normalizeGrepResult(anchored),
      })
    }),
    multiGrep: Effect.fn("FffSearch.multiGrep")(function* (input: MultiGrepInput) {
      if (input.patterns.length === 0) {
        return yield* new FffSearchError({
          message: "multi_grep requires at least one pattern",
          code: "E_EMPTY_PATTERNS",
          retryable: false,
        })
      }
      yield* waitForIndex(finder, input.wait_ms)
      const result = yield* finder.multiGrep(multiGrepOptions(input))
      const anchored = yield* addAnchors(workspaceRoot, result)
      return yield* jsonValue({
        type: "fff.multi_grep",
        backend: finder.backend,
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        patterns: input.patterns,
        constraints: constraintsWithExcludes(input.constraints, input.exclude),
        ...normalizeGrepResult(anchored),
      })
    }),
    health: Effect.fn("FffSearch.health")(function* (input: HealthInput) {
      const result = yield* finder.health(input.test_path)
      return yield* jsonValue({
        type: "fff.health",
        backend: finder.backend,
        degraded: finder.backend !== "fff",
        ...(finder.degradedReason === undefined ? {} : { degraded_reason: finder.degradedReason }),
        workspace_root: workspaceRoot,
        health: result,
      })
    }),
    rescan: Effect.fn("FffSearch.rescan")(function* (input: RescanInput) {
      yield* finder.rescan
      yield* waitForIndex(finder, input.wait_ms)
      return yield* jsonValue({
        type: "fff.rescan",
        backend: finder.backend,
        completed: true,
      })
    }),
  })

const finderOptionsFromConfig = (values: Config.Values): FinderOptions => {
  const workspaceRoot = resolve(values.workspace_root)
  const dataDir = resolve(values.data_dir, "fff")
  return {
    workspaceRoot,
    dataDir,
    frecencyDbPath: resolve(dataDir, "frecency.mdb"),
    historyDbPath: resolve(dataDir, "history.mdb"),
    aiMode: true,
  }
}

export function nativeFinderFactory(options: FinderOptions) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(options.dataDir, { recursive: true }),
      catch: (cause) => nativeError("create fff data directory", cause),
    })

    const created = yield* Effect.try({
      try: () => FileFinder.create(nativeInitOptions(options)),
      catch: (cause) => nativeError("create fff finder", cause),
    })
    if (!created.ok) {
      return yield* new FffSearchError({
        message: created.error,
        code: "E_NATIVE_UNAVAILABLE",
        retryable: false,
      })
    }

    return nativeFinder(created.value)
  })
}

const nativeFinder = (finder: FileFinderApi): Finder => ({
  backend: "fff",
  waitForIndexReady: (timeoutMs) => fromPromiseResult(() => finder.waitForIndexReady(timeoutMs), "wait for fff index"),
  fileSearch: (query, options) => fromResult(finder.fileSearch(query, options), "fff file search"),
  glob: (pattern, options) => fromResult(finder.glob(pattern, options), "fff glob"),
  directorySearch: (query, options) => fromResult(finder.directorySearch(query, options), "fff directory search"),
  grep: (query, options) => fromResult(finder.grep(query, options), "fff grep"),
  multiGrep: (options) => fromResult(finder.multiGrep(options), "fff multi grep"),
  health: (testPath) => fromResult(finder.healthCheck(testPath), "fff health"),
  rescan: fromResult(finder.scanFiles(), "fff rescan"),
  destroy: Effect.sync(() => finder.destroy()),
})

const nativeInitOptions = (options: FinderOptions): NativeInitOptions => ({
  basePath: options.workspaceRoot,
  frecencyDbPath: options.frecencyDbPath,
  historyDbPath: options.historyDbPath,
  aiMode: options.aiMode,
  disableMmapCache: false,
  disableContentIndexing: false,
  disableWatch: false,
})

const fallbackFinderFactory = (options: FinderOptions, reason: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(options.dataDir, { recursive: true }),
      catch: (cause) => nativeError("create fallback fff data directory", cause),
    })
    const files = yield* filesFromWorkspace(options.workspaceRoot)
    return memoryFinder(options.workspaceRoot, files, "fallback", reason)
  })

const memoryFinder = (
  workspaceRoot: string,
  files: ReadonlyArray<FakeFile>,
  backend: Finder["backend"],
  degradedReason?: string,
): Finder => {
  const state = { destroyed: false, files: normalizeFakeFiles(files) }
  return {
    backend,
    ...(degradedReason === undefined ? {} : { degradedReason }),
    waitForIndexReady: () => Effect.succeed(!state.destroyed),
    fileSearch: (query, options) =>
      ensureNotDestroyed(state).pipe(Effect.map(() => memoryFileSearch(state.files, query, options))),
    glob: (pattern, options) =>
      ensureNotDestroyed(state).pipe(Effect.map(() => memoryGlob(state.files, pattern, options))),
    directorySearch: (query, options) =>
      ensureNotDestroyed(state).pipe(Effect.map(() => memoryDirectorySearch(state.files, query, options))),
    grep: (query, options) => ensureNotDestroyed(state).pipe(Effect.map(() => memoryGrep(state.files, query, options))),
    multiGrep: (options) => ensureNotDestroyed(state).pipe(Effect.map(() => memoryMultiGrep(state.files, options))),
    health: () =>
      Effect.succeed({
        version: "fallback",
        workspace_root: workspaceRoot,
        indexed_files: state.files.length,
        destroyed: state.destroyed,
      }),
    rescan: Effect.succeed(undefined),
    destroy: Effect.sync(() => {
      state.destroyed = true
    }),
  }
}

interface MemoryState {
  readonly files: ReadonlyArray<MemoryFile>
  destroyed: boolean
}

interface MemoryFile {
  readonly path: string
  readonly name: string
  readonly content: string
  readonly size: number
  readonly modified: number
  readonly gitStatus: string
}

const normalizeFakeFiles = (files: ReadonlyArray<FakeFile>): ReadonlyArray<MemoryFile> =>
  files.map((file) => ({
    path: slashPath(file.path),
    name: basename(file.path),
    content: file.content,
    size: new TextEncoder().encode(file.content).byteLength,
    modified: 0,
    gitStatus: file.git_status ?? "clean",
  }))

const filesFromWorkspace = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const paths = yield* walkWorkspace(workspaceRoot, workspaceRoot)
    const files: Array<FakeFile> = []
    for (const filePath of paths) {
      const content = yield* Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: (cause) => nativeError("fallback file read", cause),
      }).pipe(Effect.catch(() => Effect.succeed("")))
      if (content.includes("\u0000")) continue
      files.push({ path: slashPath(relative(workspaceRoot, filePath)), content })
    }
    return files
  })

const walkWorkspace = (
  workspaceRoot: string,
  directory: string,
): Effect.Effect<ReadonlyArray<string>, FffSearchError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => nativeError("fallback workspace walk", cause),
    })
    const paths: Array<string> = []
    for (const entry of entries) {
      if (ignoredDirectory(entry.name)) continue
      const entryPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        paths.push(...(yield* walkWorkspace(workspaceRoot, entryPath)))
      } else if (entry.isFile()) {
        const fileStat = yield* Effect.tryPromise({
          try: () => stat(entryPath),
          catch: (cause) => nativeError("fallback file stat", cause),
        })
        if (fileStat.size <= defaultMaxFileSize && !isOutside(workspaceRoot, entryPath)) paths.push(entryPath)
      }
    }
    return paths
  })

const ignoredDirectory = (name: string) =>
  name === ".git" || name === "node_modules" || name === "dist" || name === "build" || name === ".turbo"

const ensureNotDestroyed = (state: MemoryState): Effect.Effect<void, FffSearchError> => {
  if (state.destroyed) {
    return Effect.fail(
      new FffSearchError({ message: "fff finder has been destroyed", code: "E_DESTROYED", retryable: false }),
    )
  }
  return Effect.void
}

const memoryFileSearch = (
  files: ReadonlyArray<MemoryFile>,
  query: string,
  options: NativeSearchOptions,
): NativeSearchResult => {
  const page = paginate(
    files.filter((file) => fuzzyIncludes(file.path, query)),
    options.pageIndex,
    options.pageSize,
  )
  return {
    items: page.items.map(memoryFileItem),
    scores: page.items.map((file) => memoryScore(file.path, query)),
    totalMatched: page.total,
    totalFiles: files.length,
  }
}

const memoryGlob = (
  files: ReadonlyArray<MemoryFile>,
  pattern: string,
  options: NativeGlobOptions,
): NativeSearchResult => {
  const matcher = globMatcher(pattern)
  const page = paginate(
    files.filter((file) => matcher.test(file.path)),
    options.pageIndex,
    options.pageSize,
  )
  return {
    items: page.items.map(memoryFileItem),
    scores: page.items.map((file) => memoryScore(file.path, pattern)),
    totalMatched: page.total,
    totalFiles: files.length,
  }
}

const memoryDirectorySearch = (
  files: ReadonlyArray<MemoryFile>,
  query: string,
  options: NativeDirSearchOptions,
): NativeDirSearchResult => {
  const directories = [...new Set(files.map((file) => slashPath(dirname(file.path))).filter((path) => path !== "."))]
  const page = paginate(
    directories.filter((path) => fuzzyIncludes(path, query)).map((path) => ({ path })),
    options.pageIndex,
    options.pageSize,
  )
  return {
    items: page.items.map((item) => ({
      relativePath: `${item.path}/`,
      dirName: `${basename(item.path)}/`,
      maxAccessFrecency: 0,
    })),
    scores: page.items.map((item) => memoryScore(item.path, query)),
    totalMatched: page.total,
    totalDirs: directories.length,
  }
}

const memoryGrep = (files: ReadonlyArray<MemoryFile>, query: string, options: NativeGrepOptions): NativeGrepResult => {
  const parsed = parseMemoryGrepQuery(query)
  const eligible =
    parsed.constraints.length === 0 ? files : files.filter((file) => matchesConstraints(file.path, parsed.constraints))
  const matches = grepMatches(eligible, [parsed.pattern], options)
  return memoryGrepResult(files.length, eligible.length, matches, options)
}

const memoryMultiGrep = (files: ReadonlyArray<MemoryFile>, options: NativeMultiGrepOptions): NativeGrepResult => {
  const constraints = options.constraints === undefined ? [] : options.constraints.split(/\s+/).filter(Boolean)
  const eligible = constraints.length === 0 ? files : files.filter((file) => matchesConstraints(file.path, constraints))
  const matches = grepMatches(eligible, options.patterns, options)
  return memoryGrepResult(files.length, eligible.length, matches, options)
}

const grepMatches = (
  files: ReadonlyArray<MemoryFile>,
  patterns: ReadonlyArray<string>,
  options: NativeGrepOptions | NativeMultiGrepOptions,
) => {
  const matches: Array<NativeGrepResult["items"][number]> = []
  const smartCase = options.smartCase ?? true
  const mode = "mode" in options ? options.mode : "plain"
  for (const file of files) {
    const lines = file.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    let fileMatches = 0
    for (const [lineIndex, lineContent] of lines.entries()) {
      const ranges = matchRanges(lineContent, patterns, mode ?? "plain", smartCase)
      if (ranges.length === 0) continue
      fileMatches += 1
      if (fileMatches > (options.maxMatchesPerFile ?? 200)) break
      matches.push({
        relativePath: file.path,
        fileName: file.name,
        gitStatus: file.gitStatus,
        size: file.size,
        modified: file.modified,
        isBinary: false,
        totalFrecencyScore: 0,
        accessFrecencyScore: 0,
        modificationFrecencyScore: 0,
        lineNumber: lineIndex + 1,
        col: ranges[0]?.[0] ?? 0,
        byteOffset: 0,
        lineContent,
        matchRanges: ranges,
        contextBefore: contextLines(lines, lineIndex, -(options.beforeContext ?? 0)),
        contextAfter: contextLines(lines, lineIndex, options.afterContext ?? 0),
        ...(options.classifyDefinitions === true
          ? { isDefinition: definitionPattern.test(lineContent.trimStart()) }
          : {}),
      })
    }
  }
  return matches
}

const memoryGrepResult = (
  totalFiles: number,
  filteredFileCount: number,
  matches: ReadonlyArray<NativeGrepResult["items"][number]>,
  options: NativeGrepOptions | NativeMultiGrepOptions,
): NativeGrepResult => {
  const offset = options.cursor?._offset ?? 0
  const pageSize = clamp(options.pageSize ?? defaultPageSize, 1, maxPageSize)
  const items = matches.slice(offset, offset + pageSize)
  const nextOffset = offset + items.length
  return {
    items: [...items],
    totalMatched: items.length,
    totalFilesSearched: filteredFileCount,
    totalFiles,
    filteredFileCount,
    nextCursor: nextOffset < matches.length ? cursorFromOffset(nextOffset) : null,
  }
}

const searchOptions = (input: FileSearchInput): NativeSearchOptions => ({
  pageIndex: Math.max(0, input.page_index ?? 0),
  pageSize: clamp(input.page_size ?? defaultPageSize, 1, maxPageSize),
  ...(input.current_file === undefined ? {} : { currentFile: input.current_file }),
})

const globOptions = (input: GlobInput): NativeGlobOptions => ({
  pageIndex: Math.max(0, input.page_index ?? 0),
  pageSize: clamp(input.page_size ?? defaultPageSize, 1, maxPageSize),
  ...(input.current_file === undefined ? {} : { currentFile: input.current_file }),
})

const directoryOptions = (input: DirectorySearchInput): NativeDirSearchOptions => ({
  pageIndex: Math.max(0, input.page_index ?? 0),
  pageSize: clamp(input.page_size ?? defaultPageSize, 1, maxPageSize),
  ...(input.current_file === undefined ? {} : { currentFile: input.current_file }),
})

const grepOptions = (input: GrepInput): NativeGrepOptions => ({
  mode: input.mode ?? defaultGrepMode,
  smartCase: input.smart_case ?? true,
  pageSize: clamp(input.page_size ?? defaultPageSize, 1, maxPageSize),
  timeBudgetMs: clamp(input.time_budget_ms ?? defaultTimeBudgetMs, 0, 60_000),
  maxFileSize: clamp(input.max_file_size ?? defaultMaxFileSize, 1, 100 * 1024 * 1024),
  maxMatchesPerFile: clamp(input.max_matches_per_file ?? 200, 1, 1_000),
  beforeContext: clamp(input.before_context ?? input.context ?? 0, 0, 20),
  afterContext: clamp(input.after_context ?? input.context ?? 0, 0, 20),
  classifyDefinitions: input.classify_definitions ?? true,
  ...(input.cursor === undefined ? {} : { cursor: cursorFromOffset(Math.max(0, input.cursor)) }),
})

const multiGrepOptions = (input: MultiGrepInput): NativeMultiGrepOptions => {
  const constraints = constraintsWithExcludes(input.constraints, input.exclude)
  return {
    patterns: [...input.patterns],
    ...(constraints === undefined ? {} : { constraints }),
    smartCase: input.smart_case ?? true,
    pageSize: clamp(input.page_size ?? defaultPageSize, 1, maxPageSize),
    timeBudgetMs: clamp(input.time_budget_ms ?? defaultTimeBudgetMs, 0, 60_000),
    maxFileSize: clamp(input.max_file_size ?? defaultMaxFileSize, 1, 100 * 1024 * 1024),
    maxMatchesPerFile: clamp(input.max_matches_per_file ?? 200, 1, 1_000),
    beforeContext: clamp(input.before_context ?? input.context ?? 0, 0, 20),
    afterContext: clamp(input.after_context ?? input.context ?? 0, 0, 20),
    classifyDefinitions: input.classify_definitions ?? true,
    ...(input.cursor === undefined ? {} : { cursor: cursorFromOffset(Math.max(0, input.cursor)) }),
  }
}

const grepQuery = (input: GrepInput) => {
  const constraints = constraintsWithExcludes(input.path, input.exclude)
  return constraints === undefined ? input.query : `${constraints} ${input.query}`
}

const constraintsWithExcludes = (constraint: string | undefined, excludes: ReadonlyArray<string> | undefined) => {
  const values = [constraint, ...(excludes ?? []).map((exclude) => (exclude.startsWith("!") ? exclude : `!${exclude}`))]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => value.trim())
  return values.length === 0 ? undefined : values.join(" ")
}

const waitForIndex = (finder: Finder, waitMs: number | undefined) =>
  Effect.gen(function* () {
    const timeoutMs = clamp(waitMs ?? defaultWaitMs, 0, 60_000)
    if (timeoutMs === 0) return
    const ready = yield* finder.waitForIndexReady(timeoutMs)
    if (!ready) {
      yield* new FffSearchError({
        message: `fff index was not ready after ${timeoutMs}ms`,
        code: "E_SCAN_TIMEOUT",
        retryable: true,
      })
    }
  })

const normalizeFileSearchResult = (
  result: NativeSearchResult | NativeMixedSearchResult,
  pageIndex: number,
  pageSize: number,
) => {
  if ("totalDirs" in result) {
    return {
      items: result.items.map((entry, index) =>
        entry.type === "file"
          ? { type: "file", ...fileItemToJson(entry.item, result.scores[index]) }
          : { type: "directory", ...directoryItemToJson(entry.item, result.scores[index]) },
      ),
      total_matched: result.totalMatched,
      total_files: result.totalFiles,
      total_directories: result.totalDirs,
      page: pageInfo(pageIndex, pageSize, result.totalMatched),
      ...(result.location === undefined ? {} : { location: result.location }),
      content: result.items
        .map((entry) => (entry.type === "file" ? entry.item.relativePath : `${entry.item.relativePath}/`))
        .join("\n"),
    }
  }
  return {
    items: result.items.map((item, index) => fileItemToJson(item, result.scores[index])),
    total_matched: result.totalMatched,
    total_files: result.totalFiles,
    page: pageInfo(pageIndex, pageSize, result.totalMatched),
    ...(result.location === undefined ? {} : { location: result.location }),
    content: result.items.map((item) => item.relativePath).join("\n"),
  }
}

const normalizeDirectorySearchResult = (result: NativeDirSearchResult, pageIndex: number, pageSize: number) => ({
  items: result.items.map((item, index) => directoryItemToJson(item, result.scores[index])),
  total_matched: result.totalMatched,
  total_directories: result.totalDirs,
  page: pageInfo(pageIndex, pageSize, result.totalMatched),
  content: result.items.map((item) => item.relativePath).join("\n"),
})

type AnchoredGrepMatch = NativeGrepResult["items"][number] & {
  readonly hashlineAnchor?: string
}

interface AnchoredGrepResult extends Omit<NativeGrepResult, "items"> {
  readonly items: ReadonlyArray<AnchoredGrepMatch>
}

const normalizeGrepResult = (result: AnchoredGrepResult) => ({
  matches: result.items.map(grepMatchToJson),
  total_matched: result.totalMatched,
  total_files_searched: result.totalFilesSearched,
  total_files: result.totalFiles,
  filtered_file_count: result.filteredFileCount,
  next_cursor: result.nextCursor?._offset ?? null,
  ...(result.regexFallbackError === undefined ? {} : { regex_fallback_error: result.regexFallbackError }),
  content: result.items.map(formatGrepLine).join("\n"),
})

const fileItemToJson = (
  item: NativeSearchResult["items"][number],
  score: NativeSearchResult["scores"][number] | undefined,
) => ({
  path: item.relativePath,
  name: item.fileName,
  size_bytes: item.size,
  modified_unix_seconds: item.modified,
  git_status: item.gitStatus,
  frecency: {
    access: item.accessFrecencyScore,
    modification: item.modificationFrecencyScore,
    total: item.totalFrecencyScore,
  },
  ...(score === undefined ? {} : { score: scoreToJson(score) }),
})

const directoryItemToJson = (
  item: NativeDirSearchResult["items"][number],
  score: NativeDirSearchResult["scores"][number] | undefined,
) => ({
  path: item.relativePath,
  name: item.dirName,
  max_access_frecency: item.maxAccessFrecency,
  ...(score === undefined ? {} : { score: scoreToJson(score) }),
})

const grepMatchToJson = (match: AnchoredGrepMatch) => ({
  path: match.relativePath,
  name: match.fileName,
  line_number: match.lineNumber,
  column: match.col,
  line_content: match.lineContent,
  match_ranges: match.matchRanges,
  context_before: match.contextBefore ?? [],
  context_after: match.contextAfter ?? [],
  is_definition: match.isDefinition ?? false,
  ...(match.hashlineAnchor === undefined
    ? {}
    : { anchor: match.hashlineAnchor, hashline: `${match.hashlineAnchor}|${match.lineContent}` }),
  file: {
    git_status: match.gitStatus,
    size_bytes: match.size,
    modified_unix_seconds: match.modified,
    is_binary: match.isBinary,
    frecency: {
      access: match.accessFrecencyScore,
      modification: match.modificationFrecencyScore,
      total: match.totalFrecencyScore,
    },
  },
})

const scoreToJson = (score: NativeSearchResult["scores"][number]) => ({
  total: score.total,
  base: score.baseScore,
  filename_bonus: score.filenameBonus,
  special_filename_bonus: score.specialFilenameBonus,
  frecency_boost: score.frecencyBoost,
  distance_penalty: score.distancePenalty,
  current_file_penalty: score.currentFilePenalty,
  combo_match_boost: score.comboMatchBoost,
  exact_match: score.exactMatch,
  match_type: score.matchType,
})

const pageInfo = (pageIndex: number, pageSize: number, totalMatched: number) => ({
  index: Math.max(0, pageIndex),
  size: clamp(pageSize, 1, maxPageSize),
  has_more: (Math.max(0, pageIndex) + 1) * clamp(pageSize, 1, maxPageSize) < totalMatched,
})

const formatGrepLine = (match: AnchoredGrepMatch) => {
  const prefix = match.hashlineAnchor === undefined ? `${match.relativePath}:${match.lineNumber}` : match.hashlineAnchor
  return `${match.relativePath}:${prefix}|${match.lineContent}`
}

const addAnchors = (workspaceRoot: string, result: NativeGrepResult) =>
  Effect.gen(function* () {
    const items: Array<AnchoredGrepMatch> = []
    for (const match of result.items) {
      const anchor = yield* anchorForMatch(workspaceRoot, match).pipe(Effect.catch(() => Effect.succeed(undefined)))
      items.push(anchor === undefined ? match : { ...match, hashlineAnchor: anchor })
    }
    return { ...result, items }
  })

const anchorForMatch = (workspaceRoot: string, match: NativeGrepResult["items"][number]) =>
  Effect.gen(function* () {
    const path = resolve(workspaceRoot, match.relativePath)
    if (isOutside(workspaceRoot, path)) return undefined
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new FffSearchError({
          message: cause instanceof Error ? cause.message : String(cause),
          code: "E_ANCHOR_READ_FAILED",
          retryable: false,
        }),
    })
    const lines = text
      .replace(/^\uFEFF/, "")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
    const content = lines[match.lineNumber - 1]
    if (content === undefined) return undefined
    const occurrence = lines.slice(0, match.lineNumber - 1).filter((line) => line === content).length
    return `${match.lineNumber}:${hashLine(content, match.lineNumber, occurrence, 0)}`
  })

const hashLine = (content: string, line: number, occurrence: number, salt: number) =>
  createHash("sha256").update(`${line}\0${occurrence}\0${salt}\0${content}`).digest("base64url").slice(0, hashLength)

const aliasField = (call: Call, from: string, to: string): Call => {
  const input = call.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return call
  const entries = Object.entries(input)
  const source = entries.find(([key]) => key === from)
  if (source === undefined || typeof source[1] !== "string" || entries.some(([key]) => key === to)) return call
  const decoded = Schema.decodeUnknownOption(Common.JsonValue)(Object.fromEntries([...entries, [to, source[1]]]))
  if (Option.isNone(decoded)) return call
  return { ...call, input: decoded.value }
}

const decodeFileSearchInput = (call: Call) => decodeToolInput(FileSearchInput, aliasField(call, "pattern", "query"))
const decodeGlobInput = (call: Call) => decodeToolInput(GlobInput, aliasField(call, "query", "pattern"))
const decodeDirectorySearchInput = (call: Call) =>
  decodeToolInput(DirectorySearchInput, aliasField(call, "pattern", "query"))
const decodeGrepInput = (call: Call) => decodeToolInput(GrepInput, aliasField(call, "pattern", "query"))
const decodeMultiGrepInput = (call: Call) => decodeToolInput(MultiGrepInput, call)
const decodeHealthInput = (call: Call) => decodeToolInput(HealthInput, call)
const decodeRescanInput = (call: Call) => decodeToolInput(RescanInput, call)

const decodeToolInput = <A>(schema: Schema.ConstraintDecoder<A>, call: Call) => {
  const decoded = Schema.decodeUnknownOption(schema)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return new ToolRegistry.ToolRegistryError({
    message: `${call.name} input did not match the tool schema`,
    name: call.name,
    retryable: false,
  })
}

const toRegistryError = (name: string) => (error: FffSearchError) =>
  new ToolRegistry.ToolRegistryError({
    message: error.message,
    name,
    retryable: error.retryable ?? false,
    details: {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  })

interface NativeResult<A> {
  readonly ok: boolean
  readonly value?: A
  readonly error?: string
}

const fromResult = <A>(result: NativeResult<A>, operation: string) => {
  if (result.ok && result.value !== undefined) return Effect.succeed(result.value)
  return new FffSearchError({
    message: result.error ?? `${operation} failed`,
    code: "E_FFF_OPERATION_FAILED",
    retryable: true,
  })
}

const fromPromiseResult = <A>(operation: () => Promise<NativeResult<A>>, name: string) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => nativeError(name, cause),
  }).pipe(Effect.flatMap((result) => fromResult(result, name)))

const nativeError = (operation: string, cause: unknown) =>
  new FffSearchError({
    message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    code: "E_NATIVE_UNAVAILABLE",
    retryable: false,
  })

const jsonValue = (value: unknown) =>
  Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => {
        const text = JSON.stringify(value)
        if (text === undefined) throw new Error("JSON.stringify returned undefined")
        return JSON.parse(text)
      },
      catch: (cause) =>
        new FffSearchError({
          message: cause instanceof Error ? cause.message : "Tool output was not JSON serializable",
          code: "E_JSON_OUTPUT",
          retryable: false,
        }),
    })
    const decoded = Schema.decodeUnknownOption(Common.JsonValue)(normalized)
    if (Option.isSome(decoded)) return decoded.value
    return yield* new FffSearchError({
      message: "Tool output was not JSON serializable",
      code: "E_JSON_OUTPUT",
      retryable: false,
    })
  })

const cursorFromOffset = (offset: number): GrepCursor => ({ __brand: "GrepCursor", _offset: offset })

const parseMemoryGrepQuery = (query: string) => {
  const parts = query.split(/\s+/).filter(Boolean)
  const constraints = parts.filter((part) => looksLikeConstraint(part))
  const patternParts = parts.filter((part) => !looksLikeConstraint(part))
  if (patternParts.length === 0) return { constraints: [], pattern: query }
  return { constraints, pattern: patternParts.join(" ") || query }
}

const looksLikeConstraint = (value: string) =>
  value.startsWith("!") ||
  value.includes("*") ||
  value.includes("/") ||
  value.startsWith("/") ||
  /^[\w.-]+\.[A-Za-z0-9]+$/.test(value)

const matchesConstraints = (path: string, constraints: ReadonlyArray<string>) =>
  constraints.every((constraint) => {
    if (constraint.startsWith("!")) return !matchesOneConstraint(path, constraint.slice(1))
    return matchesOneConstraint(path, constraint)
  })

const matchesOneConstraint = (path: string, constraint: string) => {
  if (constraint.includes("*")) return globMatcher(constraint).test(path)
  const normalized = constraint.replace(/^\//, "")
  return path.startsWith(normalized) || path.includes(normalized)
}

const matchRanges = (
  line: string,
  patterns: ReadonlyArray<string>,
  mode: NativeGrepMode,
  smartCase: boolean,
): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const pattern of patterns) {
    if (pattern.length === 0) continue
    if (mode === "regex") {
      try {
        const flags = smartCase && pattern.toLowerCase() === pattern ? "i" : ""
        const match = new RegExp(pattern, flags).exec(line)
        if (match?.index !== undefined) ranges.push([match.index, match.index + match[0].length])
      } catch {
        ranges.push(...literalRanges(line, pattern, smartCase))
      }
    } else {
      ranges.push(...literalRanges(line, pattern, smartCase))
    }
  }
  return ranges
}

const literalRanges = (line: string, pattern: string, smartCase: boolean): Array<[number, number]> => {
  const haystack = smartCase && pattern.toLowerCase() === pattern ? line.toLowerCase() : line
  const needle = smartCase && pattern.toLowerCase() === pattern ? pattern.toLowerCase() : pattern
  const index = haystack.indexOf(needle)
  return index < 0 ? [] : [[index, index + pattern.length]]
}

const contextLines = (lines: ReadonlyArray<string>, index: number, count: number) => {
  if (count === 0) return []
  if (count < 0) return lines.slice(Math.max(0, index + count), index)
  return lines.slice(index + 1, index + 1 + count)
}

const globMatcher = (pattern: string) => {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "§DOUBLE_STAR§")
    .replaceAll("*", "[^/]*")
    .replaceAll("§DOUBLE_STAR§", ".*")
  return new RegExp(`^${source}$`)
}

const paginate = <A>(items: ReadonlyArray<A>, pageIndex = 0, pageSize = defaultPageSize) => {
  const size = clamp(pageSize, 1, maxPageSize)
  const start = Math.max(0, pageIndex) * size
  return { items: items.slice(start, start + size), total: items.length }
}

const memoryFileItem = (file: MemoryFile): NativeSearchResult["items"][number] => ({
  relativePath: file.path,
  fileName: file.name,
  size: file.size,
  modified: file.modified,
  accessFrecencyScore: 0,
  modificationFrecencyScore: 0,
  totalFrecencyScore: 0,
  gitStatus: file.gitStatus,
})

const memoryScore = (path: string, query: string): NativeSearchResult["scores"][number] => ({
  total: fuzzyIncludes(path, query) ? 1 : 0,
  baseScore: fuzzyIncludes(path, query) ? 1 : 0,
  filenameBonus: basename(path).toLowerCase().includes(query.toLowerCase()) ? 1 : 0,
  specialFilenameBonus: 0,
  frecencyBoost: 0,
  distancePenalty: 0,
  currentFilePenalty: 0,
  comboMatchBoost: 0,
  exactMatch: path === query,
  matchType: path === query ? "exact" : "fallback",
})

const fuzzyIncludes = (value: string, query: string) => {
  const normalizedValue = value.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => normalizedValue.includes(part))
}

const slashPath = (path: string) => path.replaceAll("\\", "/")

const isOutside = (workspaceRoot: string, path: string) => {
  const relativePath = relative(workspaceRoot, path)
  return relativePath.startsWith("..") || relativePath === ".."
}

const definitionPattern = /^(?:export\s+)?(?:class|function|const|let|var|interface|type|enum|def|fn|struct|impl)\b/

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
