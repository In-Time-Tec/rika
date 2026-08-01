import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { containedRelativePath } from "./workspace-boundary"

export interface GlobOptions {
  readonly pageIndex?: number
  readonly pageSize?: number
}

export interface SearchOptions {
  readonly pageSize?: number
}

export interface GrepOptions {
  readonly mode?: "plain" | "regex"
  readonly smartCase?: boolean
  readonly maxMatchesPerFile?: number
  readonly pageSize?: number
  readonly cursor?: string | null
}

export interface PathItem {
  readonly relativePath: string
  readonly fileName: string
}

export interface SearchResult {
  readonly items: ReadonlyArray<PathItem>
  readonly scores: ReadonlyArray<number>
  readonly totalMatched: number
  readonly totalFiles: number
}

export interface GrepMatch {
  readonly relativePath: string
  readonly lineNumber: number
  readonly lineContent: string
}

export interface GrepResult {
  readonly items: ReadonlyArray<GrepMatch>
  readonly totalMatched: number
  readonly totalFilesSearched: number
  readonly totalFiles: number
  readonly filteredFileCount: number
  readonly nextCursor: string | null
  readonly regexFallbackError?: string
}

export const Operation = Schema.Literals(["initialize", "fileSearch", "glob", "grep"])
export type Operation = typeof Operation.Type

export class WorkspaceIndexError extends Schema.TaggedErrorClass<WorkspaceIndexError>()("WorkspaceIndexError", {
  operation: Operation,
  message: Schema.String,
}) {}

export interface Interface {
  readonly fileSearch: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly glob: (pattern: string, options?: GlobOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly grep: (query: string, options?: GrepOptions) => Effect.Effect<GrepResult, WorkspaceIndexError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/workspace-index/Service") {}

const indexError = (operation: Operation, cause: unknown) =>
  WorkspaceIndexError.make({ operation, message: cause instanceof Error ? cause.message : String(cause) })

const ignoreGlobs = ["!**/node_modules/**", "!**/.git/**", "!**/dist/**", "!**/.rika/**"] as const

const ignoreArgs = ignoreGlobs.flatMap((pattern) => ["--glob", pattern])

const pathItem = (relativePath: string): PathItem => ({
  relativePath,
  fileName: relativePath.includes("/") ? relativePath.slice(relativePath.lastIndexOf("/") + 1) : relativePath,
})

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = Array.from({ length: right.length + 1 }, () => 0)
  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1
      current[j + 1] = Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + cost)
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j]!
  }
  return previous[right.length]!
}

const fuzzyScore = (query: string, relativePath: string): number => {
  const normalizedQuery = query.toLowerCase()
  const normalizedPath = relativePath.toLowerCase()
  const fileName = pathItem(normalizedPath).fileName
  if (normalizedPath === normalizedQuery) return 1_000
  if (fileName === normalizedQuery) return 950
  if (normalizedPath.endsWith(normalizedQuery)) return 900
  if (fileName.includes(normalizedQuery)) return 850 - (fileName.length - normalizedQuery.length)
  if (normalizedPath.includes(normalizedQuery)) return 700 - (normalizedPath.length - normalizedQuery.length)
  const pathDistance = levenshtein(normalizedQuery, normalizedPath)
  const nameDistance = levenshtein(normalizedQuery, fileName)
  const basenameQuery = pathItem(normalizedQuery).fileName
  const basenameDistance = levenshtein(basenameQuery, fileName)
  const distance = Math.min(pathDistance, nameDistance, basenameDistance)
  const limit = Math.max(basenameQuery.length, fileName.length, 1)
  if (distance > Math.ceil(limit * 0.5)) return Number.NEGATIVE_INFINITY
  return 500 - distance * 40 - Math.abs(fileName.length - basenameQuery.length)
}

const emptySearch = (totalFiles: number): SearchResult => ({
  items: [],
  scores: [],
  totalMatched: 0,
  totalFiles,
})

const emptyGrep = (totalFiles: number, regexFallbackError?: string): GrepResult => ({
  items: [],
  totalMatched: 0,
  totalFilesSearched: totalFiles,
  totalFiles,
  filteredFileCount: totalFiles,
  nextCursor: null,
  ...(regexFallbackError === undefined ? {} : { regexFallbackError }),
})

const runRg = (operation: Operation, cwd: string, args: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      const result = Bun.spawnSync(["rg", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        code: result.exitCode ?? 1,
      }
    },
    catch: (cause) => indexError(operation, cause),
  })

const listFiles = (operation: Operation, root: string, pattern?: string) =>
  Effect.gen(function* () {
    const args = ["--files", "--color", "never", ...ignoreArgs]
    if (pattern !== undefined && pattern.length > 0 && pattern !== "**/*" && pattern !== "**")
      args.push("--glob", pattern)
    const result = yield* runRg(operation, root, args)
    if (result.code > 1)
      return yield* indexError(operation, result.stderr.trim() || `rg --files exited with code ${result.code}`)
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  })

const filterContained = (
  operation: Operation,
  root: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
  relativePaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const kept: Array<string> = []
    for (const relativePath of relativePaths) {
      if (
        yield* containedRelativePath(root, relativePath, path, fileSystem).pipe(
          Effect.mapError((cause) => indexError(operation, cause)),
        )
      )
        kept.push(relativePath)
    }
    return kept
  })

const paginatePaths = (relativePaths: ReadonlyArray<string>, options?: GlobOptions | SearchOptions): SearchResult => {
  const pageSize = Math.max(
    1,
    options !== undefined && "pageSize" in options && options.pageSize !== undefined ? options.pageSize : 50,
  )
  const pageIndex =
    options !== undefined && "pageIndex" in options && options.pageIndex !== undefined
      ? Math.max(0, options.pageIndex)
      : 0
  const start = pageIndex * pageSize
  const page = relativePaths.slice(start, start + pageSize)
  const items = page.map(pathItem)
  return {
    items,
    scores: items.map(() => 1),
    totalMatched: relativePaths.length,
    totalFiles: relativePaths.length,
  }
}

const makeService = (workspace: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fileSystem.realPath(workspace).pipe(Effect.mapError((cause) => indexError("initialize", cause)))

    const interface_: Interface = {
      fileSearch: (query, options) =>
        Effect.gen(function* () {
          const listed = yield* listFiles("fileSearch", root)
          const relativePaths = yield* filterContained("fileSearch", root, path, fileSystem, listed)
          const ranked = relativePaths
            .map((relativePath) => ({ relativePath, score: fuzzyScore(query, relativePath) }))
            .filter((entry) => Number.isFinite(entry.score))
            .toSorted((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
          if (ranked.length === 0) return emptySearch(relativePaths.length)
          const pageSize = Math.max(1, options?.pageSize ?? 20)
          const page = ranked.slice(0, pageSize)
          return {
            items: page.map((entry) => pathItem(entry.relativePath)),
            scores: page.map((entry) => entry.score),
            totalMatched: ranked.length,
            totalFiles: relativePaths.length,
          }
        }),
      glob: (pattern, options) =>
        Effect.gen(function* () {
          const listed = yield* listFiles("glob", root, pattern)
          const relativePaths = (yield* filterContained("glob", root, path, fileSystem, listed)).toSorted(
            (left, right) => left.localeCompare(right),
          )
          return paginatePaths(relativePaths, options)
        }),
      grep: (query, options) =>
        Effect.gen(function* () {
          if (options?.cursor !== undefined && options.cursor !== null && options.cursor.length > 0) return emptyGrep(0)
          const pageSize = Math.max(1, options?.pageSize ?? 1_000)
          const maxMatchesPerFile = Math.max(1, options?.maxMatchesPerFile ?? 1_000)
          const mode = options?.mode ?? "plain"
          const args = [
            "--color",
            "never",
            "--no-heading",
            "--line-number",
            "--max-count",
            String(maxMatchesPerFile),
            ...ignoreArgs,
          ]
          if (mode === "plain") args.push("--fixed-strings")
          args.push("--", query)
          const result = yield* runRg("grep", root, args)
          if (result.code === 2) {
            const message = result.stderr.trim()
            if (mode === "regex" && /regex parse error|error parsing regex|invalid regex/i.test(message))
              return emptyGrep(0, message || "invalid regular expression")
            return yield* indexError("grep", message || `rg exited with code ${result.code}`)
          }
          if (result.code > 2)
            return yield* indexError("grep", result.stderr.trim() || `rg exited with code ${result.code}`)
          const parsed: Array<GrepMatch> = []
          for (const line of result.stdout.split("\n")) {
            if (line.length === 0) continue
            const first = line.indexOf(":")
            const second = first < 0 ? -1 : line.indexOf(":", first + 1)
            if (first < 0 || second < 0) continue
            const relativePath = line.slice(0, first)
            const lineNumber = Number(line.slice(first + 1, second))
            if (!Number.isInteger(lineNumber) || lineNumber < 1) continue
            parsed.push({
              relativePath,
              lineNumber,
              lineContent: line.slice(second + 1),
            })
            if (parsed.length >= pageSize) break
          }
          const items: Array<GrepMatch> = []
          for (const match of parsed) {
            if (
              yield* containedRelativePath(root, match.relativePath, path, fileSystem).pipe(
                Effect.mapError((cause) => indexError("grep", cause)),
              )
            )
              items.push(match)
          }
          return {
            items,
            totalMatched: items.length,
            totalFilesSearched: items.length,
            totalFiles: items.length,
            filteredFileCount: items.length,
            nextCursor: null,
          }
        }),
    }
    return interface_
  })

export const layer = (workspace: string) => Layer.effect(Service, Effect.map(makeService(workspace), Service.of))

export const globOnce = (request: {
  readonly workspace: string
  readonly pattern: string
  readonly options?: GlobOptions
}) => Effect.flatMap(makeService(request.workspace), (index) => index.glob(request.pattern, request.options))

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
