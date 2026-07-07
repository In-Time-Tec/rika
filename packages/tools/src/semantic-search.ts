import { readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const defaultLimit = 8
const maxLimit = 30
const defaultMaxOutputChars = 24_000
const defaultMaxFileBytes = 1_000_000
const snippetRadius = 2

export const SearchMode = Schema.Literals(["hybrid", "semantic"]).annotate({
  identifier: "Rika.Tools.SemanticSearch.SearchMode",
})
export type SearchMode = typeof SearchMode.Type

export const SourceType = Schema.Literals(["code", "docs", "history", "conversation"]).annotate({
  identifier: "Rika.Tools.SemanticSearch.SourceType",
})
export type SourceType = typeof SourceType.Type

export interface SearchInput extends Schema.Schema.Type<typeof SearchInput> {}
export const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  queries: Schema.optionalKey(Schema.Array(Schema.String)),
  mode: Schema.optionalKey(SearchMode),
  source: Schema.optionalKey(Schema.Array(SourceType)),
  file: Schema.optionalKey(Schema.String),
  lines: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int),
  pathPrefix: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  maxOutputChars: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.SemanticSearch.SearchInput" })

export interface StatusInput extends Schema.Schema.Type<typeof StatusInput> {}
export const StatusInput = Schema.Struct({}).annotate({ identifier: "Rika.Tools.SemanticSearch.StatusInput" })

export class SemanticSearchError extends Schema.TaggedErrorClass<SemanticSearchError>()("SemanticSearchError", {
  message: Schema.String,
  code: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Hit {
  readonly id: string
  readonly source: SourceType
  readonly path: string
  readonly language: string
  readonly kind: string
  readonly symbol: string
  readonly startLine: number
  readonly endLine: number
  readonly snippet: string
  readonly score: number
  readonly sources: ReadonlyArray<string>
}

export interface SearchOptions {
  readonly limit: number
  readonly source: ReadonlyArray<SourceType>
  readonly pathPrefix?: string
  readonly language?: string
  readonly maxOutputChars: number
}

export interface SearchResult {
  readonly query: string
  readonly mode: SearchMode
  readonly namespace: string
  readonly hits: ReadonlyArray<Hit>
  readonly candidates: number
  readonly reranked: boolean
  readonly tookMs: number
}

export interface FileHistoryResult {
  readonly file: string
  readonly lines?: string
  readonly namespace: string
  readonly content: string
  readonly tookMs: number
}

export interface Status {
  readonly enabled: boolean
  readonly backend: "semantic-search" | "local" | "fake"
  readonly workspaceRoot: string
  readonly namespace: string
  readonly projectName: string
  readonly degraded: boolean
  readonly degradedReason?: string
  readonly missingConfiguration?: ReadonlyArray<string>
  readonly indexedFiles?: number
  readonly indexedChunks?: number
}

export interface Engine {
  readonly status: Effect.Effect<Status, SemanticSearchError>
  readonly search: (
    mode: SearchMode,
    facets: ReadonlyArray<string>,
    options: SearchOptions,
  ) => Effect.Effect<SearchResult, SemanticSearchError>
  readonly fileHistory: (
    path: string,
    options: { readonly lines?: string; readonly limit: number; readonly maxOutputChars: number },
  ) => Effect.Effect<FileHistoryResult, SemanticSearchError>
  readonly destroy: Effect.Effect<void>
}

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<Common.JsonValue, SemanticSearchError>
  readonly status: (input?: StatusInput) => Effect.Effect<Common.JsonValue, SemanticSearchError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/SemanticSearch") {}

export interface RuntimeOptions {
  readonly workspaceRoot: string
  readonly dataDir: string
  readonly namespace: string
  readonly missingConfiguration: ReadonlyArray<string>
}

export type EngineFactory = (options: RuntimeOptions) => Effect.Effect<Engine, SemanticSearchError>

function localEngineFactory(options: RuntimeOptions): Effect.Effect<Engine, SemanticSearchError> {
  return Effect.succeed(localEngine(options))
}

export const layer: Layer.Layer<Service, never, Config.Service> = layerFromEngineFactory(localEngineFactory)

export function layerFromEngineFactory(factory: EngineFactory): Layer.Layer<Service, never, Config.Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const values = yield* config.get
      const workspaceRoot = resolve(values.workspace_root)
      const dataDir = resolve(values.data_dir, "semantic-search")
      const missingConfiguration = yield* requiredConfiguration(config)
      const namespace = namespaceFor(workspaceRoot)
      const engine = yield* factory({ workspaceRoot, dataDir, namespace, missingConfiguration }).pipe(
        Effect.catch((error) =>
          Effect.succeed(disabledEngine(workspaceRoot, namespace, error.message, missingConfiguration)),
        ),
      )
      yield* Effect.addFinalizer(() => engine.destroy.pipe(Effect.ignore))
      return makeService(engine)
    }),
  )
}

export interface FakeLayerOptions {
  readonly workspaceRoot?: string
  readonly namespace?: string
  readonly hits?: ReadonlyArray<Hit>
  readonly status?: Partial<Status>
  readonly histories?: Readonly<Record<string, string>>
}

export const fakeLayer = (options: FakeLayerOptions = {}) => Layer.succeed(Service, makeService(fakeEngine(options)))

export const search = Effect.fn("SemanticSearch.search.call")(function* (input: SearchInput) {
  const service = yield* Service
  return yield* service.search(input)
})

export const status = Effect.fn("SemanticSearch.status.call")(function* (input: StatusInput = {}) {
  const service = yield* Service
  return yield* service.status(input)
})

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("semantic_search", {
      description: semanticSearchDescription,
      parameters: SearchInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SemanticSearch.tool.search")(function* (call: Call) {
      const input = yield* decodeSearchInput(call)
      return yield* service.search(input).pipe(Effect.mapError(toRegistryError("semantic_search")))
    }),
  },
  {
    tool: Tool.make("semantic_search_status", {
      description:
        "Report whether semantic_search is enabled, which backend is active, index counts when available, and whether the live backend is the degraded local lexical fallback.",
      parameters: Tool.EmptyParams,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SemanticSearch.tool.status")(function* (call: Call) {
      const input = yield* decodeStatusInput(call)
      return yield* service.status(input).pipe(Effect.mapError(toRegistryError("semantic_search_status")))
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

const makeService = (engine: Engine): Interface =>
  Service.of({
    search: Effect.fn("SemanticSearch.search")(function* (input: SearchInput) {
      const started = Date.now()
      const limit = outputLimit(input.limit, defaultLimit, maxLimit)
      const maxOutputChars = outputLimit(input.maxOutputChars, 2_000, 80_000, defaultMaxOutputChars)
      const currentStatus = yield* engine.status
      const file = normalizedText(input.file)
      if (file !== undefined) {
        const history = yield* engine.fileHistory(file, {
          ...(input.lines === undefined ? {} : { lines: input.lines }),
          limit,
          maxOutputChars,
        })
        return yield* jsonValue({
          type: "semantic_search.history",
          backend: currentStatus.backend,
          enabled: currentStatus.enabled,
          degraded: currentStatus.degraded,
          ...(currentStatus.degradedReason === undefined ? {} : { degraded_reason: currentStatus.degradedReason }),
          file: history.file,
          ...(history.lines === undefined ? {} : { lines: history.lines }),
          namespace: history.namespace,
          content: history.content,
          took_ms: history.tookMs,
        })
      }

      const facets = facetsOf(input)
      if (facets.length === 0) {
        return yield* new SemanticSearchError({
          message: "semantic_search requires query, queries, or file",
          code: "E_MISSING_QUERY",
          retryable: false,
        })
      }

      const mode = input.mode ?? "hybrid"
      const pathPrefix = normalizedText(input.pathPrefix)
      const language = normalizedText(input.language)
      const result = yield* engine.search(mode, facets, {
        limit,
        source: input.source ?? ["code", "docs"],
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        ...(language === undefined ? {} : { language }),
        maxOutputChars,
      })
      const content = formatSearchResult(result, maxOutputChars)
      return yield* jsonValue({
        type: "semantic_search",
        backend: currentStatus.backend,
        enabled: currentStatus.enabled,
        degraded: currentStatus.degraded,
        ...(currentStatus.degradedReason === undefined ? {} : { degraded_reason: currentStatus.degradedReason }),
        ...(currentStatus.missingConfiguration === undefined
          ? {}
          : { missing_configuration: currentStatus.missingConfiguration }),
        query: result.query,
        mode: result.mode,
        namespace: result.namespace,
        hits: result.hits.map(hitToJson),
        returned: result.hits.length,
        candidates: result.candidates,
        reranked: result.reranked,
        took_ms: result.tookMs || Date.now() - started,
        content,
        guidance: searchGuidance,
      })
    }),
    status: Effect.fn("SemanticSearch.status")(function* () {
      const currentStatus = yield* engine.status
      return yield* jsonValue({
        type: "semantic_search_status",
        enabled: currentStatus.enabled,
        backend: currentStatus.backend,
        degraded: currentStatus.degraded,
        ...(currentStatus.degradedReason === undefined ? {} : { degraded_reason: currentStatus.degradedReason }),
        ...(currentStatus.missingConfiguration === undefined
          ? {}
          : { missing_configuration: currentStatus.missingConfiguration }),
        workspace_root: currentStatus.workspaceRoot,
        namespace: currentStatus.namespace,
        project_name: currentStatus.projectName,
        ...(currentStatus.indexedFiles === undefined ? {} : { indexed_files: currentStatus.indexedFiles }),
        ...(currentStatus.indexedChunks === undefined ? {} : { indexed_chunks: currentStatus.indexedChunks }),
        guidance: searchGuidance,
      })
    }),
  })

const localEngine = (options: RuntimeOptions): Engine => {
  const degradedReason =
    "semantic_search is currently backed by local lexical/token overlap search; no live vector backend is wired in this build."

  const makeStatus = (indexedFiles?: number): Status => ({
    enabled: true,
    backend: "local",
    workspaceRoot: options.workspaceRoot,
    namespace: options.namespace,
    projectName: basename(options.workspaceRoot),
    degraded: true,
    degradedReason,
    ...(options.missingConfiguration.length === 0 ? {} : { missingConfiguration: options.missingConfiguration }),
    ...(indexedFiles === undefined ? {} : { indexedFiles, indexedChunks: indexedFiles }),
  })

  return {
    status: Effect.gen(function* () {
      const files = yield* scanWorkspace(options.workspaceRoot)
      return makeStatus(files.length)
    }),
    search: Effect.fn("SemanticSearch.local.search")(function* (
      mode: SearchMode,
      facets: ReadonlyArray<string>,
      searchOptions: SearchOptions,
    ) {
      const started = Date.now()
      const files = yield* scanWorkspace(options.workspaceRoot)
      const hits = yield* rankFiles(options.workspaceRoot, files, mode, facets, searchOptions)
      return {
        query: facets.join(" / "),
        mode,
        namespace: options.namespace,
        hits: hits.slice(0, searchOptions.limit),
        candidates: hits.length,
        reranked: false,
        tookMs: Date.now() - started,
      }
    }),
    fileHistory: Effect.fn("SemanticSearch.local.fileHistory")(function* (
      path: string,
      historyOptions: { readonly lines?: string; readonly limit: number; readonly maxOutputChars: number },
    ) {
      const started = Date.now()
      const cleanPath = yield* assertWorkspacePath(options.workspaceRoot, path, "file")
      const content = yield* gitHistory(options.workspaceRoot, cleanPath, historyOptions)
      return {
        file: cleanPath,
        ...(historyOptions.lines === undefined ? {} : { lines: historyOptions.lines }),
        namespace: options.namespace,
        content,
        tookMs: Date.now() - started,
      }
    }),
    destroy: Effect.void,
  }
}

const disabledEngine = (
  workspaceRoot: string,
  namespace: string,
  reason: string,
  missingConfiguration: ReadonlyArray<string>,
): Engine => {
  const disabledStatus: Status = {
    enabled: false,
    backend: "local",
    workspaceRoot,
    namespace,
    projectName: basename(workspaceRoot),
    degraded: true,
    degradedReason: reason,
    ...(missingConfiguration.length === 0 ? {} : { missingConfiguration }),
  }
  return {
    status: Effect.succeed(disabledStatus),
    search: () =>
      Effect.fail(
        new SemanticSearchError({
          message: reason,
          code: "E_SEMANTIC_SEARCH_DISABLED",
          retryable: false,
        }),
      ),
    fileHistory: () =>
      Effect.fail(
        new SemanticSearchError({
          message: reason,
          code: "E_SEMANTIC_SEARCH_DISABLED",
          retryable: false,
        }),
      ),
    destroy: Effect.void,
  }
}

const fakeEngine = (options: FakeLayerOptions): Engine => {
  const workspaceRoot = options.workspaceRoot ?? "/workspace"
  const namespace = options.namespace ?? "fake_semantic_search"
  const hits = [...(options.hits ?? [])]
  const fakeStatus: Status = {
    enabled: true,
    backend: "fake",
    workspaceRoot,
    namespace,
    projectName: basename(workspaceRoot),
    degraded: false,
    indexedFiles: hits.length,
    indexedChunks: hits.length,
    ...options.status,
  }
  return {
    status: Effect.succeed(fakeStatus),
    search: Effect.fn("SemanticSearch.fake.search")(function* (
      mode: SearchMode,
      facets: ReadonlyArray<string>,
      searchOptions: SearchOptions,
    ) {
      const query = facets.join(" / ")
      const filtered = hits.filter((hit) => hitMatches(hit, query, searchOptions))
      return {
        query,
        mode,
        namespace,
        hits: filtered.slice(0, searchOptions.limit),
        candidates: filtered.length,
        reranked: false,
        tookMs: 0,
      }
    }),
    fileHistory: Effect.fn("SemanticSearch.fake.fileHistory")(function* (
      path: string,
      historyOptions: { readonly lines?: string; readonly limit: number; readonly maxOutputChars: number },
    ) {
      const content = options.histories?.[path] ?? `No git history found for ${path}.`
      return {
        file: path,
        ...(historyOptions.lines === undefined ? {} : { lines: historyOptions.lines }),
        namespace,
        content: capText(content, historyOptions.maxOutputChars).text,
        tookMs: 0,
      }
    }),
    destroy: Effect.void,
  }
}

interface IndexedFile {
  readonly path: string
  readonly language: string
  readonly source: SourceType
  readonly kind: string
  readonly content: string
}

const scanWorkspace = (workspaceRoot: string): Effect.Effect<ReadonlyArray<IndexedFile>, SemanticSearchError> =>
  Effect.gen(function* () {
    const paths = yield* walk(workspaceRoot, workspaceRoot)
    const files: Array<IndexedFile> = []
    for (const filePath of paths) {
      const content = yield* Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: (cause) => fileError("read file", cause),
      }).pipe(Effect.catch(() => Effect.succeed("")))
      if (content.includes("\u0000")) continue
      const relativePath = slashPath(relative(workspaceRoot, filePath))
      files.push({
        path: relativePath,
        language: languageFor(relativePath),
        source: sourceFor(relativePath),
        kind: kindFor(relativePath),
        content,
      })
    }
    return files
  })

const walk = (workspaceRoot: string, directory: string): Effect.Effect<ReadonlyArray<string>, SemanticSearchError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => fileError("walk workspace", cause),
    })
    const paths: Array<string> = []
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !allowedDotPath(entry.name)) continue
      const entryPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (ignoredDirectory(entry.name)) continue
        paths.push(...(yield* walk(workspaceRoot, entryPath)))
      } else if (entry.isFile()) {
        const fileStat = yield* Effect.tryPromise({
          try: () => stat(entryPath),
          catch: (cause) => fileError("stat file", cause),
        })
        if (fileStat.size <= defaultMaxFileBytes && !isOutside(workspaceRoot, entryPath)) paths.push(entryPath)
      }
    }
    return paths
  })

const rankFiles = (
  workspaceRoot: string,
  files: ReadonlyArray<IndexedFile>,
  mode: SearchMode,
  facets: ReadonlyArray<string>,
  options: SearchOptions,
): Effect.Effect<ReadonlyArray<Hit>, SemanticSearchError> =>
  Effect.gen(function* () {
    const query = facets.join(" ")
    const tokens = tokensOf(query)
    const scored: Array<Hit> = []
    const perFile = new Map<string, number>()
    for (const file of files) {
      if (!hitMatchesScope(file, options)) continue
      const match = bestMatch(file, facets, tokens, mode)
      if (match.score <= 0) continue
      const count = perFile.get(file.path) ?? 0
      if (count >= 3) continue
      perFile.set(file.path, count + 1)
      scored.push({
        id: stableId(file.path, match.startLine, query),
        source: file.source,
        path: file.path,
        language: file.language,
        kind: file.kind,
        symbol: symbolNear(file.content, match.startLine),
        startLine: match.startLine,
        endLine: match.endLine,
        snippet: match.snippet,
        score: match.score,
        sources: mode === "hybrid" ? ["text", "path", "semantic-local"] : ["semantic-local"],
      })
    }
    const capped = scored.toSorted((left, right) => right.score - left.score).slice(0, Math.max(options.limit, 1) * 4)
    return yield* addCurrentFileHints(workspaceRoot, capped)
  })

const addCurrentFileHints = (workspaceRoot: string, hits: ReadonlyArray<Hit>) =>
  Effect.gen(function* () {
    const enriched: Array<Hit> = []
    for (const hit of hits) {
      const absolute = resolve(workspaceRoot, hit.path)
      const exists = yield* Effect.tryPromise({
        try: () => stat(absolute),
        catch: (cause) => fileError("stat search hit", cause),
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      enriched.push(exists ? hit : { ...hit, sources: [...hit.sources, "index-only"] })
    }
    return enriched
  })

const bestMatch = (
  file: IndexedFile,
  facets: ReadonlyArray<string>,
  tokens: ReadonlyArray<string>,
  mode: SearchMode,
): { readonly score: number; readonly startLine: number; readonly endLine: number; readonly snippet: string } => {
  const lines = file.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  let best = { score: pathScore(file.path, facets, tokens, mode), line: 0 }
  for (const [index, line] of lines.entries()) {
    const score = lineScore(line, facets, tokens, mode) + pathScore(file.path, facets, tokens, mode) * 0.25
    if (score > best.score) best = { score, line: index }
  }
  const start = Math.max(0, best.line - snippetRadius)
  const end = Math.min(lines.length - 1, best.line + snippetRadius)
  const snippet = lines
    .slice(start, end + 1)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n")
  return { score: best.score, startLine: start + 1, endLine: end + 1, snippet }
}

const hitMatches = (hit: Hit, query: string, options: SearchOptions) => {
  if (options.pathPrefix !== undefined && !hit.path.startsWith(slashPath(options.pathPrefix))) return false
  if (options.language !== undefined && hit.language !== options.language.toLowerCase()) return false
  if (options.source.length > 0 && !options.source.includes(hit.source)) return false
  const haystack = `${hit.path}\n${hit.symbol}\n${hit.snippet}`.toLowerCase()
  const tokens = tokensOf(query)
  return tokens.length === 0 || tokens.some((token) => haystack.includes(token))
}

const hitMatchesScope = (file: IndexedFile, options: SearchOptions) => {
  if (options.pathPrefix !== undefined && !file.path.startsWith(slashPath(options.pathPrefix))) return false
  if (options.language !== undefined && file.language !== options.language.toLowerCase()) return false
  if (options.source.length > 0 && !options.source.includes(file.source)) return false
  return true
}

const pathScore = (path: string, facets: ReadonlyArray<string>, tokens: ReadonlyArray<string>, mode: SearchMode) => {
  const lowerPath = path.toLowerCase()
  let score = 0
  for (const facet of facets) {
    const lowerFacet = facet.toLowerCase()
    if (lowerFacet.length > 0 && lowerPath.includes(lowerFacet)) score += mode === "hybrid" ? 30 : 12
  }
  for (const token of tokens) {
    if (lowerPath.includes(token)) score += mode === "hybrid" ? 8 : 4
  }
  return score
}

const lineScore = (line: string, facets: ReadonlyArray<string>, tokens: ReadonlyArray<string>, mode: SearchMode) => {
  const lowerLine = line.toLowerCase()
  let score = 0
  for (const facet of facets) {
    const lowerFacet = facet.toLowerCase()
    if (lowerFacet.length > 0 && lowerLine.includes(lowerFacet)) score += mode === "hybrid" ? 40 : 16
  }
  for (const token of tokens) {
    if (lowerLine.includes(token)) score += mode === "hybrid" ? 10 : 5
  }
  return score
}

const gitHistory = (
  workspaceRoot: string,
  path: string,
  options: { readonly lines?: string; readonly limit: number; readonly maxOutputChars: number },
): Effect.Effect<string, SemanticSearchError> =>
  Effect.gen(function* () {
    const isRepo = yield* runGit(workspaceRoot, ["rev-parse", "--git-dir"], options.maxOutputChars).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    )
    if (!isRepo) return "This workspace is not a git repository."
    const range = parseLines(options.lines)
    const args = range
      ? ["log", `-L${range.start},${range.end}:${path}`, "-n", String(options.limit), "--date=short"]
      : [
          "log",
          "--follow",
          "-p",
          "-M",
          "-n",
          String(options.limit),
          "--date=short",
          "--pretty=format:%n=== commit %h — %ad — %an ===%n%s%n%b",
          "--",
          path,
        ]
    const output = yield* runGit(workspaceRoot, args, options.maxOutputChars).pipe(
      Effect.catch((error) => Effect.succeed(`git history failed: ${error.message}`)),
    )
    const trimmed = output.trim()
    if (trimmed.length === 0) return `No git history found for ${path}. It may be untracked or new.`
    const header = `Git history for ${path}${range ? ` (lines ${range.start}-${range.end})` : ""} — historical diffs and messages, newest first. The current file on disk is the source of truth.\n`
    return `${header}\n${trimmed}`
  })

const runGit = (workspaceRoot: string, args: ReadonlyArray<string>, maxOutputChars: number) =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(["git", ...args], { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      if (exitCode !== 0) throw new Error(stderr.trim() || `git exited with code ${exitCode}`)
      return capText(stdout, maxOutputChars).text
    },
    catch: (cause) =>
      new SemanticSearchError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: "E_GIT_HISTORY_FAILED",
        retryable: false,
      }),
  })

const requiredConfiguration = (config: Config.Interface) =>
  Effect.gen(function* () {
    yield* config.get
    return []
  })

const assertWorkspacePath = (workspaceRoot: string, path: string, label: string) =>
  Effect.try({
    try: () => {
      const clean = path.trim().replace(/^@/, "").replace(/^\.\//, "")
      if (clean.length === 0) throw new Error(`${label} is required`)
      if (clean.startsWith("-")) throw new Error(`${label} must be a path, not an option: ${path}`)
      const absolute = isAbsolute(clean) ? resolve(clean) : resolve(workspaceRoot, clean)
      if (isOutside(workspaceRoot, absolute)) throw new Error(`${label} must stay inside the workspace root: ${path}`)
      return slashPath(relative(workspaceRoot, absolute))
    },
    catch: (cause) =>
      new SemanticSearchError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: "E_PATH_OUTSIDE_WORKSPACE",
        retryable: false,
      }),
  })

const parseLines = (lines: string | undefined): { readonly start: number; readonly end: number } | undefined => {
  if (lines === undefined) return undefined
  const range = /^\s*(\d+)\s*[-:,]\s*(\d+)\s*$/.exec(lines)
  if (range !== null) return { start: Number(range[1]), end: Number(range[2]) }
  const single = /^\s*(\d+)\s*$/.exec(lines)
  if (single === null) return undefined
  const line = Number(single[1])
  return { start: Math.max(1, line - 5), end: line + 5 }
}

const formatSearchResult = (result: SearchResult, maxOutputChars: number) => {
  const lines = result.hits.flatMap((hit, index) => [
    `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine} (${hit.language}, score ${hit.score.toFixed(1)}, ${hit.sources.join("+")})`,
    hit.snippet,
  ])
  const body =
    lines.length === 0
      ? "No semantic_search hits found. Try ffgrep for exact text or broaden pathPrefix/language."
      : lines.join("\n\n")
  const suffix = `\n\n[semantic_search: ${result.candidates} candidates · ${result.reranked ? "reranked" : "fused"} · ${result.tookMs}ms · namespace=${result.namespace}]`
  return capText(`${body}${suffix}`, maxOutputChars).text
}

const hitToJson = (hit: Hit) => ({
  id: hit.id,
  source: hit.source,
  path: hit.path,
  language: hit.language,
  kind: hit.kind,
  symbol: hit.symbol,
  start_line: hit.startLine,
  end_line: hit.endLine,
  snippet: hit.snippet,
  score: hit.score,
  sources: [...hit.sources],
})

const facetsOf = (input: SearchInput): ReadonlyArray<string> => {
  const queries = (input.queries ?? []).map((query) => query.trim()).filter(Boolean)
  if (queries.length > 0) return queries.slice(0, 5)
  const query = normalizedText(input.query)
  return query === undefined ? [] : [query]
}

const normalizedText = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

const tokensOf = (query: string): ReadonlyArray<string> => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 2),
  ),
]

const symbolNear = (content: string, lineNumber: number) => {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  for (let index = Math.max(0, lineNumber - 1); index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line === undefined) continue
    const match = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/.exec(
      line,
    )
    if (match !== null) return match[1] ?? ""
  }
  return ""
}

const kindFor = (path: string) => {
  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path)) return "test"
  if (/\.(md|mdx|txt|rst)$/.test(path)) return "docs"
  if (/\.(json|ya?ml|toml|ini|env|config\.[cm]?[jt]s)$/.test(path)) return "config"
  return "code"
}

const sourceFor = (path: string): SourceType => (kindFor(path) === "docs" ? "docs" : "code")

const languageFor = (path: string) => {
  const extension = extname(path).toLowerCase()
  return languageByExtension[extension] ?? (extension.replace(/^\./, "") || "text")
}

const languageByExtension: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
}

const ignoredDirectory = (name: string) =>
  name === ".git" ||
  name === "node_modules" ||
  name === "dist" ||
  name === "build" ||
  name === ".turbo" ||
  name === "coverage" ||
  name === ".next" ||
  name === ".cache"

const allowedDotPath = (name: string) => name === ".agents" || name === ".amp" || name === ".config"

const fileError = (operation: string, cause: unknown) =>
  new SemanticSearchError({
    message: `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    code: "E_FILE_IO",
    retryable: false,
  })

const namespaceFor = (workspaceRoot: string) => `rika_semantic_${stableId(workspaceRoot, 0, "namespace").slice(0, 16)}`

const stableId = (path: string, line: number, query: string) => Bun.hash(`${path}:${line}:${query}`).toString(36)

const slashPath = (path: string) => path.split(sep).join("/")

const isOutside = (workspaceRoot: string, path: string) => {
  const rel = relative(workspaceRoot, resolve(path))
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

const outputLimit = (value: number | undefined, min: number, max: number, fallback = min) => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

const capText = (text: string, maxChars: number) =>
  text.length <= maxChars
    ? { text, truncated: false }
    : { text: `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters)`, truncated: true }

const decodeSearchInput = (call: Call) => decodeToolInput(SearchInput, call)
const decodeStatusInput = (call: Call) => decodeToolInput(StatusInput, call)

const decodeToolInput = <A>(schema: Schema.ConstraintDecoder<A>, call: Call) => {
  const decoded = Schema.decodeUnknownOption(schema)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return new ToolRegistry.ToolRegistryError({
    message: `${call.name} input did not match the tool schema`,
    name: call.name,
    retryable: false,
  })
}

const jsonValue = (value: unknown) =>
  Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => {
        const text = JSON.stringify(value)
        if (text === undefined) throw new Error("JSON.stringify returned undefined")
        return JSON.parse(text)
      },
      catch: (cause) =>
        new SemanticSearchError({
          message: cause instanceof Error ? cause.message : "Tool output was not JSON serializable",
          code: "E_JSON_OUTPUT",
          retryable: false,
        }),
    })
    const decoded = Schema.decodeUnknownOption(Common.JsonValue)(normalized)
    if (Option.isSome(decoded)) return decoded.value
    return yield* new SemanticSearchError({
      message: "Tool output was not JSON serializable",
      code: "E_JSON_OUTPUT",
      retryable: false,
    })
  })

const toRegistryError = (name: string) => (error: SemanticSearchError) =>
  new ToolRegistry.ToolRegistryError({
    message: error.message,
    name,
    retryable: error.retryable ?? false,
    details: {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  })

const semanticSearchDescription =
  "Search the project with the local lexical/token-overlap backend in one call — the primary way to find code, trace a concept, behavior, feature, or data flow across files, and answer 'where is X' or 'how does X work' without running many grep and read calls. Returns ranked snippets with repository-relative file path and line range, so you can read or edit the right location directly. Prefer it over broad grep/read for discovery, then use exact tools to verify concrete matches.\n\n" +
  "Config options (all optional):\n" +
  "- query: a single natural-language or symbol query.\n" +
  "- queries: 2-5 DISTINCT facets to retrieve and merge in one parallel call (use for multi-faceted tasks instead of several searches; never pass paraphrases).\n" +
  "- mode: 'hybrid' (default — path/text token matching, best for an exact symbol/string) or 'semantic' (same local lexical backend with semantic-style scoring weights).\n" +
  "- pathPrefix / language: scope to a directory prefix or language.\n" +
  "- limit: max snippets to return (default 8).\n" +
  "- source: force ['history'] (git commits) or ['conversation'] (past sessions). By default results are live code; for clearly historical 'why/when did this change' questions use file plus optional lines to get git diffs.\n\n" +
  "Use ffgrep for raw exhaustive regex sweeps, fffind for exact file path lookup, ast_grep_outline for structural navigation after candidate files are known, and read/edit for hashline-backed file changes."

const searchGuidance = {
  use_semantic_search_for:
    "Discovery by behavior, concept, feature, or data flow; use queries[] for 2-5 distinct facets in one call.",
  use_fff_for: "Exact path lookup, raw regex/literal grep, exhaustive sweeps, or suspected stale semantic results.",
  use_ast_grep_outline_for: "Structural navigation after candidate files/directories are known and before broad reads.",
  use_hashline_for: "Reading and editing concrete files once the target path/range is known.",
}
