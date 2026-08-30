import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { containedRelativePath } from "../../policy/workspace-boundary"
import { RuntimeFilesystem } from "../../runtime/filesystem"

import type { GlobOptions, SearchOptions, GrepOptions, SearchResult } from "./options"
import type { GrepMatch, GrepResult } from "./results"
import { Operation } from "./operation"
import { Ranking } from "./ranking"

const { fuzzyScore, globExpression, paginatePaths, pathItem } = Ranking

export class WorkspaceIndexError extends Schema.TaggedError<WorkspaceIndexError>()("WorkspaceIndexError", {
  operation: Operation,
  message: Schema.String,
}) {}

export interface Interface {
  readonly fileSearch: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly glob: (pattern: string, options?: GlobOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly grep: (query: string, options?: GrepOptions) => Effect.Effect<GrepResult, WorkspaceIndexError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/workspace/search/file-search/Service",
) {}

/**
 * Search runs ripgrep, which a machine that installed this product has not necessarily installed.
 * A spawn that cannot find the program reports that rather than the search it was attempting, so a
 * reader is told what is missing instead of that a search went wrong.
 */
const ErrorReason = Schema.Struct({ _tag: Schema.String })
const ErrorCause = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.Union([Schema.String, ErrorReason])),
})

const indexError = (operation: Operation, cause: unknown) => {
  /**
   * A spawn failure is a typed object whose own fields carry the account, so stringifying it gave
   * `[object Object]` and the pattern below never matched. Reading the tag and message first is what
   * lets a reader learn the program is missing rather than that a search went wrong.
   */
  const decoded = Schema.decodeUnknownOption(ErrorCause)(cause)
  const details = Option.getOrUndefined(decoded)
  const described = [
    details?._tag ?? "",
    details?.message ?? "",
    Schema.is(Schema.String)(details?.reason) ? details.reason : "",
  ]
    .filter((part) => part.length > 0)
    .join(": ")
  const fromObject = described.length > 0 ? described : String(cause)
  const message = cause instanceof Error ? cause.message : fromObject
  const reasonTag = Schema.is(ErrorReason)(details?.reason) ? details.reason._tag : details?.reason
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

const emptySearch = (totalFiles: number): SearchResult => ({
  items: [],
  scores: [],
  totalMatched: 0,
  totalFiles,
})

const emptyGrep = (totalFiles: number, regexFallbackError?: string): GrepResult => {
  let result: GrepResult = {
    items: [],
    totalMatched: 0,
    totalFilesSearched: totalFiles,
    totalFiles,
    filteredFileCount: totalFiles,
    nextCursor: null,
  }
  if (regexFallbackError !== undefined) result = { ...result, regexFallbackError }
  return result
}

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

interface GrepCollection {
  readonly items: Array<GrepMatch>
  filesSearched: number
  totalMatched: number
  outputBytes: number
  keptBytes: number
}

const compileExpression = (query: string, mode: GrepOptions["mode"]): Effect.Effect<RegExp | undefined, string> =>
  mode === "regex"
    ? Effect.try({ try: () => new RegExp(query), catch: (cause) => String(cause) })
    : Effect.as(Effect.void, undefined)

const collectFileMatches = (
  collection: GrepCollection,
  relativePath: string,
  content: string,
  query: string,
  regularExpression: RegExp | undefined,
  pageSize: number,
  maximum: number,
) => {
  if (content.includes("\0")) return
  let matchesInFile = 0
  for (const [lineIndex, rawLine] of content.split("\n").entries()) {
    const lineContent = rawLine.replace(/\r$/, "")
    if (!(regularExpression === undefined ? lineContent.includes(query) : regularExpression.test(lineContent))) continue
    matchesInFile += 1
    collection.totalMatched += 1
    const match = { relativePath, lineNumber: lineIndex + 1, lineContent }
    const renderedBytes = RuntimeFilesystem.byteLength(`${relativePath}:${lineIndex + 1}:${lineContent}\n`)
    collection.outputBytes += renderedBytes
    if (collection.items.length < pageSize && collection.keptBytes + renderedBytes <= 40_000) {
      collection.items.push(match)
      collection.keptBytes += renderedBytes
    }
    if (matchesInFile >= maximum) break
  }
}

const fallbackGrep = (
  root: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  query: string,
  options?: GrepOptions,
): Effect.Effect<GrepResult, WorkspaceIndexError> =>
  Effect.gen(function* () {
    const mode = options?.mode ?? "plain"
    const compiled = yield* Effect.result(compileExpression(query, mode))
    if (compiled._tag === "Failure") return emptyGrep(0, compiled.failure)
    const regularExpression = compiled.success
    const pageSize = Math.max(1, options?.pageSize ?? 1_000)
    const maxMatchesPerFile = Math.max(1, options?.maxMatchesPerFile ?? 1_000)
    const listed = yield* fallbackFiles("grep", root, fileSystem, path)
    const contained = yield* filterContained("grep", root, path, fileSystem, listed)
    const included =
      options?.include === undefined || options.include.length === 0
        ? contained
        : contained.filter((relativePath) => globExpression(options.include!).test(relativePath))
    const collection: GrepCollection = { items: [], filesSearched: 0, totalMatched: 0, outputBytes: 0, keptBytes: 0 }
    const search = Effect.gen(function* () {
      for (const relativePath of included) {
        const content = yield* fileSystem
          .readFileString(path.join(root, relativePath))
          .pipe(Effect.mapError((cause) => indexError("grep", cause)))
        collection.filesSearched += 1
        collectFileMatches(collection, relativePath, content, query, regularExpression, pageSize, maxMatchesPerFile)
      }
    })
    let deadlineReached = false
    if (options?.deadlineMillis === undefined) yield* search
    else {
      const completed = yield* Effect.timeoutOption(search, `${options.deadlineMillis} millis`)
      deadlineReached = Option.isNone(completed)
    }
    const result: GrepResult & {
      deadlineReached?: boolean
      outputTruncation?: { keptBytes: number; totalBytes: number }
    } = {
      items: collection.items,
      totalMatched: collection.totalMatched,
      totalFilesSearched: collection.filesSearched,
      totalFiles: contained.length,
      filteredFileCount: included.length,
      nextCursor: null,
    }
    if (deadlineReached) result.deadlineReached = true
    if (collection.outputBytes > collection.keptBytes)
      result.outputTruncation = { keptBytes: collection.keptBytes, totalBytes: collection.outputBytes }
    return result
  })

const grepArgs = (query: string, options?: GrepOptions): ReadonlyArray<string> => {
  const args = [
    "--color",
    "never",
    "--no-heading",
    "--line-number",
    "--max-count",
    String(Math.max(1, options?.maxMatchesPerFile ?? 1_000)),
    ...ignoreArgs,
  ]
  if (options?.include !== undefined && options.include.length > 0) args.push("--glob", options.include)
  if ((options?.mode ?? "plain") === "plain") args.push("--fixed-strings")
  args.push("--", query)
  return args
}

const parseGrepMatches = (stdout: string, pageSize: number): ReadonlyArray<GrepMatch> => {
  const parsed: Array<GrepMatch> = []
  for (const line of stdout.split("\n")) {
    const first = line.indexOf(":")
    const second = first < 0 ? -1 : line.indexOf(":", first + 1)
    if (line.length === 0 || first < 0 || second < 0) continue
    const lineNumber = Number(line.slice(first + 1, second))
    if (!Number.isInteger(lineNumber) || lineNumber < 1) continue
    parsed.push({ relativePath: line.slice(0, first), lineNumber, lineContent: line.slice(second + 1) })
    if (parsed.length >= pageSize) break
  }
  return parsed
}

const rgResultError = (
  result: { readonly code: number; readonly stderr: string },
  mode: GrepOptions["mode"],
): WorkspaceIndexError | GrepResult | undefined => {
  if (result.code !== 2 && result.code <= 2) return undefined
  const message = result.stderr.trim()
  if (result.code === 2 && mode === "regex" && /regex parse error|error parsing regex|invalid regex/i.test(message))
    return emptyGrep(0, message || "invalid regular expression")
  return indexError("grep", message || `rg exited with code ${result.code}`)
}

const keepContainedMatches = (
  root: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
  matches: ReadonlyArray<GrepMatch>,
) =>
  Effect.gen(function* () {
    const items: Array<GrepMatch> = []
    for (const match of matches) {
      const contained = yield* containedRelativePath(root, match.relativePath, path, fileSystem).pipe(
        Effect.mapError((cause) => indexError("grep", cause)),
      )
      if (contained) items.push(match)
    }
    return items
  })

const hasCursor = (options?: GrepOptions) => options?.cursor != null && options.cursor.length > 0

const completeGrepOutput = (stdout: string, incomplete: boolean) =>
  incomplete && !stdout.endsWith("\n") ? stdout.slice(0, stdout.lastIndexOf("\n") + 1) : stdout

const makeGrepResult = (
  items: ReadonlyArray<GrepMatch>,
  execution: { readonly stdout: string; readonly stdoutBytes: number; readonly deadlineReached: boolean },
): GrepResult => {
  const result: GrepResult = {
    items,
    totalMatched: items.length,
    totalFilesSearched: items.length,
    totalFiles: items.length,
    filteredFileCount: items.length,
    nextCursor: null,
  }
  if (execution.deadlineReached) Object.assign(result, { deadlineReached: true })
  const keptBytes = RuntimeFilesystem.byteLength(execution.stdout)
  if (execution.stdoutBytes > keptBytes)
    Object.assign(result, { outputTruncation: { keptBytes, totalBytes: execution.stdoutBytes } })
  return result
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
          if (hasCursor(options)) return emptyGrep(0)
          const pageSize = Math.max(1, options?.pageSize ?? 1_000)
          const mode = options?.mode ?? "plain"
          const attempted = yield* Effect.result(
            runRg(spawner, "grep", root, grepArgs(query, options), options?.deadlineMillis),
          )
          if (attempted._tag === "Failure") {
            if (missingRipgrep(attempted.failure)) return yield* fallbackGrep(root, fileSystem, path, query, options)
            return yield* attempted.failure
          }
          const result = attempted.success
          const failure = rgResultError(result, mode)
          if (Schema.is(WorkspaceIndexError)(failure)) return yield* failure
          if (failure !== undefined) return failure
          const outputTruncated = result.stdoutBytes > RuntimeFilesystem.byteLength(result.stdout)
          const completeOutput = completeGrepOutput(result.stdout, result.deadlineReached || outputTruncated)
          const parsed = parseGrepMatches(completeOutput, pageSize)
          const items = yield* keepContainedMatches(root, path, fileSystem, parsed)
          return makeGrepResult(items, result)
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
