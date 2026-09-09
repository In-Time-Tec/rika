import * as NativeResult from "@rika/product/native-tool-result"
import { Context, Effect, FileSystem, Layer, Path } from "effect"

import { RunnerGrepError } from "./errors"
import type { GrepParameters } from "./tools"

const maxFileBytes = 1_048_576
const ignoredDirectories = new Set([".git", ".hg", ".svn", "node_modules", ".turbo", "dist", "coverage"])
const ignoredFiles = new Set([".DS_Store"])

const isInside = (root: string, target: string, separator: string): boolean =>
  target === root || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)

const bounded = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= limit) return { text, truncated: false }
  let end = text.length
  while (end > 0 && new TextEncoder().encode(text.slice(0, end)).byteLength > limit) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

const globMatcher = (glob: string | undefined): RegExp | undefined => {
  if (glob === undefined) return undefined
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${escaped}$`)
}

const grepFailure = (kind: RunnerGrepError["kind"], message: string): RunnerGrepError =>
  RunnerGrepError.make({ kind, message })

const readDirectory = (fileSystem: FileSystem.FileSystem, directory: string) =>
  fileSystem
    .readDirectory(directory)
    .pipe(Effect.mapError(() => grepFailure("operation", "Unable to read a workspace directory")))

const readLink = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem
    .readLink(target)
    .pipe(Effect.mapError(() => grepFailure("operation", "Unable to inspect a workspace entry")))

const stat = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem.stat(target).pipe(Effect.mapError(() => grepFailure("not_found", `Workspace path not found: ${target}`)))

const readFile = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem
    .readFileString(target)
    .pipe(Effect.mapError(() => grepFailure("operation", "Unable to read a workspace file")))

interface GrepTraversal {
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly matcher: RegExp
  readonly glob: RegExp | undefined
  readonly matches: Array<string>
  readonly maxResults: number
}

const appendMatches = (traversal: GrepTraversal, content: string, relative: string): void => {
  const lines = content.split("\n")
  for (let index = 0; index < lines.length && traversal.matches.length < traversal.maxResults; index += 1) {
    const line = lines[index]
    if (line !== undefined && traversal.matcher.test(line)) traversal.matches.push(`${relative}:${index + 1}:${line}`)
  }
}

const visitDirectory = (
  traversal: GrepTraversal,
  directory: string,
  relativeDirectory: string,
): Effect.Effect<void, RunnerGrepError> =>
  Effect.gen(function* () {
    if (traversal.matches.length >= traversal.maxResults) return
    const entries = (yield* readDirectory(traversal.fileSystem, directory)).toSorted((left, right) =>
      left.localeCompare(right),
    )
    for (const name of entries) {
      if (traversal.matches.length >= traversal.maxResults || ignoredFiles.has(name)) break
      yield* visitEntry(traversal, directory, relativeDirectory, name)
    }
  })

const visitEntry = (
  traversal: GrepTraversal,
  directory: string,
  relativeDirectory: string,
  name: string,
): Effect.Effect<void, RunnerGrepError> =>
  Effect.gen(function* () {
    const candidate = traversal.path.join(directory, name)
    const relative = relativeDirectory.length === 0 ? name : traversal.path.join(relativeDirectory, name)
    const link = yield* Effect.result(readLink(traversal.fileSystem, candidate))
    if (link._tag === "Success") return
    const info = yield* stat(traversal.fileSystem, candidate)
    if (info.type === "Directory") {
      if (!ignoredDirectories.has(name)) yield* visitDirectory(traversal, candidate, relative)
      return
    }
    if (info.type !== "File" || (traversal.glob !== undefined && !traversal.glob.test(relative))) return
    if (info.size > BigInt(maxFileBytes)) return
    const content = yield* readFile(traversal.fileSystem, candidate)
    appendMatches(traversal, content, relative)
  })

const makeGrep =
  (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    rootReal: string,
  ): ((parameters: GrepParameters) => Effect.Effect<NativeResult.Result, RunnerGrepError>) =>
  (parameters) =>
    Effect.gen(function* () {
      const matcher = yield* Effect.try({
        try: () => new RegExp(parameters.pattern),
        catch: () => grepFailure("operation", "grep pattern is not a valid regular expression"),
      })
      const glob = globMatcher(parameters.glob)
      const matches: Array<string> = []
      const maxResults = parameters.max_results ?? 200
      const traversal: GrepTraversal = { fileSystem, path, matcher, glob, matches, maxResults }
      const realRoot = yield* fileSystem
        .realPath(parameters.path ?? rootReal)
        .pipe(Effect.mapError(() => grepFailure("not_found", "grep path does not exist")))
      if (!isInside(rootReal, realRoot, path.sep))
        return yield* grepFailure("path", "grep path resolves outside the Runner checkout")
      const info = yield* stat(fileSystem, realRoot)
      if (info.type === "Directory") yield* visitDirectory(traversal, realRoot, "")
      else if (info.type === "File") {
        const content = yield* readFile(fileSystem, realRoot)
        const relative = path.relative(rootReal, realRoot)
        appendMatches(traversal, content, relative)
      }
      const raw = matches.join("\n")
      const boundedResult = bounded(raw, NativeResult.maxOutputBytes)
      return {
        text: boundedResult.text,
        truncated: boundedResult.truncated || matches.length >= maxResults,
      }
    })

export interface RunnerGrepService {
  readonly run: (parameters: GrepParameters) => Effect.Effect<NativeResult.Result, RunnerGrepError>
}

export class RunnerGrep extends Context.Service<RunnerGrep, RunnerGrepService>()("@rika/runner-v2/grep/RunnerGrep") {}

export const layer = (checkout: string): Layer.Layer<RunnerGrep, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    RunnerGrep,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const run = (parameters: GrepParameters) =>
        fileSystem.realPath(path.resolve(checkout)).pipe(
          Effect.mapError(() => RunnerGrepError.make({ kind: "not_found", message: "Runner checkout does not exist" })),
          Effect.flatMap((rootReal) =>
            makeGrep(
              fileSystem,
              path,
              rootReal,
            )({
              ...parameters,
              path: path.resolve(rootReal, parameters.path ?? "."),
            }),
          ),
        )
      return { run }
    }),
  )
