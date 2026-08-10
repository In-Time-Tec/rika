import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { containedRelativePath } from "../policy/workspace-boundary-policy"
import { RuntimeFilesystem } from "../runtime/coding-tool-runtime-filesystem"

import type { GlobOptions, SearchOptions, GrepOptions, PathItem, SearchResult } from "./workspace-search-options"
import type { GrepMatch, GrepResult } from "./workspace-search-results"
import { Operation } from "./workspace-search-operation"

export class WorkspaceIndexError extends Schema.TaggedErrorClass<WorkspaceIndexError>()("WorkspaceIndexError", {
  operation: Operation,
  message: Schema.String,
}) {}

export interface Interface {
  readonly fileSearch: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly glob: (pattern: string, options?: GlobOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly grep: (query: string, options?: GrepOptions) => Effect.Effect<GrepResult, WorkspaceIndexError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/workspace/workspace-file-search/Service",
) {}

/**
 * Search runs ripgrep, which a machine that installed this product has not necessarily installed.
 * A spawn that cannot find the program reports that rather than the search it was attempting, so a
 * reader is told what is missing instead of that a search went wrong.
 */
const indexError = (operation: Operation, cause: unknown) => {
  /**
   * A spawn failure is a typed object whose own fields carry the account, so stringifying it gave
   * `[object Object]` and the pattern below never matched. Reading the tag and message first is what
   * lets a reader learn the program is missing rather than that a search went wrong.
   */
  const described =
    typeof cause === "object" && cause !== null
      ? [
          "_tag" in cause ? String(cause._tag) : "",
          "message" in cause && typeof cause.message === "string" ? cause.message : "",
          "reason" in cause && typeof cause.reason === "string" ? cause.reason : "",
        ]
          .filter((part) => part.length > 0)
          .join(": ")
      : ""
  const fromObject = described.length > 0 ? described : String(cause)
  const message = cause instanceof Error ? cause.message : fromObject
  const reason = typeof cause === "object" && cause !== null && "reason" in cause ? cause.reason : undefined
  const reasonTag =
    typeof reason === "object" && reason !== null && "_tag" in reason && typeof reason._tag === "string"
      ? reason._tag
      : reason
  return WorkspaceIndexError.make({
    operation,
    /**
     * A spawn that cannot find the program reports it in whatever words its platform uses, and a
     * pattern that misses them left a cell told only that a search failed. Naming the program is
     * what lets a reader install it.
     */
    message:
      reasonTag === "NotFound" || /ENOENT|not found|No such file/i.test(message)
        ? `ripgrep (rg) is not installed or not on PATH: ${message}`
        : message,
  })
}

const ignoredNames = new Set(["node_modules", ".git", "dist", ".rika", ".worktrees"])
const ignoreGlobs = Array.from(ignoredNames, (name) => `!**/${name}/**`)
const ignoreArgs = ignoreGlobs.flatMap((pattern) => ["--glob", pattern])
const missingRipgrep = (error: WorkspaceIndexError): boolean =>
  error.message.startsWith("ripgrep (rg) is not installed or not on PATH:")

const globExpression = (pattern: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === "*") {
      if (pattern[index + 1] !== "*") {
        expression += "[^/]*"
        continue
      }
      index += 1
      if (pattern[index + 1] === "/") {
        index += 1
        expression += "(?:.*/)?"
      } else expression += ".*"
      continue
    }
    if (character === "?") {
      expression += "[^/]"
      continue
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1)
      if (closing >= 0) {
        const content = pattern.slice(index + 1, closing)
        expression += `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`
        index = closing
        continue
      }
    }
    expression += /[\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
  }
  return new RegExp(`${expression}$`)
}

const fallbackFiles = (
  operation: Operation,
  root: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  pattern?: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceIndexError> =>
  Effect.gen(function* () {
    const files: Array<string> = []
    const visited = new Set([root])
    const matches =
      pattern === undefined || pattern.length === 0 || pattern === "**/*" || pattern === "**"
        ? undefined
        : globExpression(pattern)
    const contained = (candidate: string) => {
      const relative = path.relative(root, candidate)
      return candidate === root || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
    }
    const walk = (directory: string): Effect.Effect<void, WorkspaceIndexError> =>
      Effect.gen(function* () {
        const names = (yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => indexError(operation, cause))))
          .filter((name) => !name.startsWith(".") && !ignoredNames.has(name))
          .toSorted((left, right) => left.localeCompare(right))
        for (const name of names) {
          const child = path.join(directory, name)
          const info = yield* fileSystem.stat(child).pipe(Effect.mapError((cause) => indexError(operation, cause)))
          if (info.type === "Directory") {
            const canonical = yield* fileSystem
              .realPath(child)
              .pipe(Effect.mapError((cause) => indexError(operation, cause)))
            if (!contained(canonical) || visited.has(canonical)) continue
            visited.add(canonical)
            yield* walk(child)
            continue
          }
          if (info.type !== "File") continue
          const relative = path.relative(root, child).replaceAll("\\", "/")
          if (matches === undefined || matches.test(relative)) files.push(relative)
        }
      })
    yield* walk(root)
    return files
  })

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

const runRg = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  operation: Operation,
  cwd: string,
  args: ReadonlyArray<string>,
  deadlineMillis?: number,
): Effect.Effect<
  {
    readonly stdout: string
    readonly stderr: string
    readonly stdoutBytes: number
    readonly stderrBytes: number
    readonly code: number
    readonly deadlineReached: boolean
  },
  WorkspaceIndexError
> =>
  Effect.gen(function* () {
    const command = ChildProcess.make("rg", args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const collected = {
      stdout: { text: "", totalBytes: 0 },
      stderr: { text: "", totalBytes: 0 },
    }
    const collect =
      (key: "stdout" | "stderr") =>
      <E>(stream: Stream.Stream<Uint8Array, E>) => {
        const decoder = new TextDecoder()
        const append = (text: string) => {
          const current = collected[key]
          const accepted = RuntimeFilesystem.boundedPrefix(text, 40_000 - RuntimeFilesystem.byteLength(current.text))
          current.text += accepted
        }
        return Stream.runForEach(stream, (bytes) =>
          Effect.sync(() => {
            collected[key].totalBytes += bytes.byteLength
            append(decoder.decode(bytes, { stream: true }))
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => append(decoder.decode()))))
      }
    const awaitExit = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const [, , code] = yield* Effect.all(
          [collect("stdout")(handle.stdout), collect("stderr")(handle.stderr), handle.exitCode],
          { concurrency: 3 },
        )
        return code
      }),
    ).pipe(Effect.mapError((cause) => indexError(operation, cause)))
    const result = (code: number, deadlineReached: boolean) => ({
      stdout: collected.stdout.text,
      stderr: collected.stderr.text,
      stdoutBytes: collected.stdout.totalBytes,
      stderrBytes: collected.stderr.totalBytes,
      code,
      deadlineReached,
    })
    if (deadlineMillis === undefined) return result(yield* awaitExit, false)
    const outcome = yield* Effect.timeoutOption(awaitExit, `${deadlineMillis} millis`)
    return Option.isNone(outcome) ? result(0, true) : result(outcome.value, false)
  })

const listFiles = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  operation: Operation,
  root: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  pattern?: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceIndexError> =>
  Effect.gen(function* () {
    const args = ["--files", "--color", "never", ...ignoreArgs]
    if (pattern !== undefined && pattern.length > 0 && pattern !== "**/*" && pattern !== "**")
      args.push("--glob", pattern)
    const attempted = yield* Effect.result(runRg(spawner, operation, root, args))
    if (attempted._tag === "Failure") {
      if (missingRipgrep(attempted.failure)) return yield* fallbackFiles(operation, root, fileSystem, path, pattern)
      return yield* attempted.failure
    }
    const result = attempted.success
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

const fallbackGrep = (
  root: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  query: string,
  options?: GrepOptions,
): Effect.Effect<GrepResult, WorkspaceIndexError> =>
  Effect.gen(function* () {
    const mode = options?.mode ?? "plain"
    let regularExpression: RegExp | undefined
    if (mode === "regex") {
      const compiled = yield* Effect.result(
        Effect.try({
          try: () => new RegExp(query),
          catch: (cause) => String(cause),
        }),
      )
      if (compiled._tag === "Failure") return emptyGrep(0, compiled.failure)
      regularExpression = compiled.success
    }
    const pageSize = Math.max(1, options?.pageSize ?? 1_000)
    const maxMatchesPerFile = Math.max(1, options?.maxMatchesPerFile ?? 1_000)
    const listed = yield* fallbackFiles("grep", root, fileSystem, path)
    const contained = yield* filterContained("grep", root, path, fileSystem, listed)
    const included =
      options?.include === undefined || options.include.length === 0
        ? contained
        : contained.filter((relativePath) => globExpression(options.include!).test(relativePath))
    const items: Array<GrepMatch> = []
    let filesSearched = 0
    let totalMatched = 0
    let outputBytes = 0
    let keptBytes = 0
    const search = Effect.gen(function* () {
      for (const relativePath of included) {
        const content = yield* fileSystem
          .readFileString(path.join(root, relativePath))
          .pipe(Effect.mapError((cause) => indexError("grep", cause)))
        filesSearched += 1
        if (content.includes("\0")) continue
        let matchesInFile = 0
        const lines = content.split("\n")
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineContent = lines[lineIndex]!.replace(/\r$/, "")
          const matched =
            regularExpression === undefined ? lineContent.includes(query) : regularExpression.test(lineContent)
          if (!matched) continue
          matchesInFile += 1
          totalMatched += 1
          const match = { relativePath, lineNumber: lineIndex + 1, lineContent }
          const renderedBytes = RuntimeFilesystem.byteLength(
            `${match.relativePath}:${match.lineNumber}:${match.lineContent}\n`,
          )
          outputBytes += renderedBytes
          if (items.length < pageSize && keptBytes + renderedBytes <= 40_000) {
            items.push(match)
            keptBytes += renderedBytes
          }
          if (matchesInFile >= maxMatchesPerFile) break
        }
      }
    })
    let deadlineReached = false
    if (options?.deadlineMillis === undefined) yield* search
    else {
      const completed = yield* Effect.timeoutOption(search, `${options.deadlineMillis} millis`)
      deadlineReached = Option.isNone(completed)
    }
    return {
      items,
      totalMatched,
      totalFilesSearched: filesSearched,
      totalFiles: contained.length,
      filteredFileCount: included.length,
      nextCursor: null,
      ...(deadlineReached ? { deadlineReached: true } : {}),
      ...(outputBytes > keptBytes ? { outputTruncation: { keptBytes, totalBytes: outputBytes } } : {}),
    }
  })

const paginatePaths = (relativePaths: ReadonlyArray<string>, options?: GlobOptions | SearchOptions): SearchResult => {
  const pageSize = Math.max(1, options?.pageSize ?? 50)
  const pageIndex = options !== undefined && "pageIndex" in options ? Math.max(0, options.pageIndex ?? 0) : 0
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fileSystem.realPath(workspace).pipe(Effect.mapError((cause) => indexError("initialize", cause)))

    const interface_: Interface = {
      fileSearch: (query, options) =>
        Effect.gen(function* () {
          const listed = yield* listFiles(spawner, "fileSearch", root, fileSystem, path)
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
          const listed = yield* listFiles(spawner, "glob", root, fileSystem, path, pattern)
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
          if (options?.include !== undefined && options.include.length > 0) args.push("--glob", options.include)
          if (mode === "plain") args.push("--fixed-strings")
          args.push("--", query)
          const attempted = yield* Effect.result(runRg(spawner, "grep", root, args, options?.deadlineMillis))
          if (attempted._tag === "Failure") {
            if (missingRipgrep(attempted.failure)) return yield* fallbackGrep(root, fileSystem, path, query, options)
            return yield* attempted.failure
          }
          const result = attempted.success
          if (result.code === 2) {
            const message = result.stderr.trim()
            if (mode === "regex" && /regex parse error|error parsing regex|invalid regex/i.test(message))
              return emptyGrep(0, message || "invalid regular expression")
            return yield* indexError("grep", message || `rg exited with code ${result.code}`)
          }
          if (result.code > 2)
            return yield* indexError("grep", result.stderr.trim() || `rg exited with code ${result.code}`)
          const parsed: Array<GrepMatch> = []
          const lines = result.stdout.split("\n")
          const outputTruncated = result.stdoutBytes > RuntimeFilesystem.byteLength(result.stdout)
          if ((result.deadlineReached || outputTruncated) && !result.stdout.endsWith("\n")) lines.pop()
          for (const line of lines) {
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
            ...(result.deadlineReached ? { deadlineReached: true } : {}),
            ...(outputTruncated
              ? {
                  outputTruncation: {
                    keptBytes: RuntimeFilesystem.byteLength(result.stdout),
                    totalBytes: result.stdoutBytes,
                  },
                }
              : {}),
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
