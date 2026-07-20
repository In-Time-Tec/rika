import { Context, Data, Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as WebSearchService from "./web-search"
import { Service as ReadWebPageService } from "./read-web-page"
import * as ProcessRegistry from "./process-registry"
import * as MediaView from "./media-view"
import * as ToolPolicy from "./tool-policy"
import { unifiedDiff } from "./unified-diff"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const boundedDiff = (patch: string | undefined): { readonly diff?: string } =>
  patch === undefined ? {} : { diff: patch }

export const FindFiles = Schema.Struct({ _tag: Schema.tag("FindFiles"), query: Schema.String })
export const Grep = Schema.Struct({ _tag: Schema.tag("Grep"), pattern: Schema.String, regex: Schema.Boolean })
export const Read = Schema.Struct({
  _tag: Schema.tag("Read"),
  path: Schema.String,
  readRange: Schema.optionalKey(Schema.Array(Schema.Finite).check(Schema.isLengthBetween(2, 2))),
})
export const Write = Schema.Struct({
  _tag: Schema.tag("Write"),
  path: Schema.String,
  content: Schema.String,
})
export const Edit = Schema.Struct({
  _tag: Schema.tag("Edit"),
  path: Schema.String,
  oldStr: Schema.String,
  newStr: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
})
export const Bash = Schema.Struct({
  _tag: Schema.tag("Bash"),
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeoutMillis: Schema.optionalKey(NonNegativeInt),
})
export const Shell = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(NonNegativeInt),
})
export const ShellCommandStatus = Schema.Struct({
  _tag: Schema.tag("ShellCommandStatus"),
  processId: Schema.String,
  waitMillis: Schema.optionalKey(NonNegativeInt),
})
export const GitStatus = Schema.Struct({ _tag: Schema.tag("GitStatus") })
export const WebSearch = Schema.Struct({
  _tag: Schema.tag("WebSearch"),
  objective: WebSearchService.Objective,
  searchQueries: WebSearchService.SearchQueries,
  kind: Schema.optionalKey(WebSearchService.Capability),
  strategy: Schema.optionalKey(WebSearchService.Strategy),
  githubSearchType: Schema.optionalKey(WebSearchService.GithubSearchType),
})
export const ReadWebPage = Schema.Struct({
  _tag: Schema.tag("ReadWebPage"),
  url: Schema.String,
  objective: Schema.optionalKey(Schema.String),
  fullContent: Schema.optionalKey(Schema.Boolean),
  forceRefetch: Schema.optionalKey(Schema.Boolean),
})
export const ViewMedia = Schema.Struct({ _tag: Schema.tag("ViewMedia"), path: Schema.String })

export const Request = Schema.Union([
  FindFiles,
  Grep,
  Read,
  Write,
  Edit,
  Bash,
  Shell,
  ShellCommandStatus,
  GitStatus,
  WebSearch,
  ReadWebPage,
  ViewMedia,
])
export type Request = typeof Request.Type
export const Result = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  artifact: Schema.optionalKey(MediaView.Artifact),
})
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  outcome: Schema.Literals(["known", "unknown"]),
}) {}

const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ToolError"),
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  outcome: Schema.Literals(["known", "unknown"]),
})

const tool = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: Parameters,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: Result,
    failure: ToolFailure,
    failureMode: "return",
  })

export const findFilesTool = tool("find_files", "List workspace files whose paths contain a query", {
  query: Schema.String,
})
export const grepTool = tool("grep", "Search UTF-8 workspace files for text or a regular expression", {
  pattern: Schema.String,
  regex: Schema.Boolean,
})
export const readTool = tool("read", "Read a file with stable line numbers, optionally selecting an inclusive range", {
  path: Schema.String,
  read_range: Schema.optionalKey(Schema.Array(Schema.Finite).check(Schema.isLengthBetween(2, 2))),
})
export const writeTool = tool("write", "Create or overwrite a UTF-8 file, creating parent directories as needed", {
  path: Schema.String,
  content: Schema.String,
})
export const editTool = tool("edit", "Replace exact text in an existing file and return a diff", {
  path: Schema.String,
  old_str: Schema.String,
  new_str: Schema.String,
  replace_all: Schema.optionalKey(Schema.Boolean),
})
export const bashTool = tool(
  "bash",
  "Run a shell command in the workspace and return a process id if it outlives the wait",
  {
    command: Schema.String,
    workdir: Schema.optionalKey(Schema.String),
    timeout_ms: Schema.optionalKey(NonNegativeInt),
  },
)
export const shellCommandStatusTool = tool(
  "shell_command_status",
  "Return only new output from a running command without restarting it",
  {
    processId: Schema.String,
    waitMillis: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  },
)
export const gitStatusTool = tool("git_status", "Inspect concise Git working-tree status", {
  refresh: Schema.optionalKey(Schema.Boolean),
})
export const webSearchTool = tool(
  "web_search",
  "Search across configured sources. Use code for semantic examples and github for exact GitHub search.",
  {
    objective: WebSearchService.Objective,
    searchQueries: WebSearchService.SearchQueries,
    kind: Schema.optionalKey(WebSearchService.Capability),
    strategy: Schema.optionalKey(WebSearchService.Strategy),
    githubSearchType: Schema.optionalKey(WebSearchService.GithubSearchType),
  },
)
export const readWebPageTool = tool(
  "read_web_page",
  "Read a public HTTP(S) page as readable Markdown, optionally selecting objective-relevant excerpts",
  {
    url: Schema.String,
    objective: Schema.optionalKey(Schema.String),
    fullContent: Schema.optionalKey(Schema.Boolean),
    forceRefetch: Schema.optionalKey(Schema.Boolean),
  },
)
export const viewMediaTool = tool("view_media", "Inspect a workspace image or analyze a PDF, audio, or video file", {
  path: Schema.String,
})

export const toolkit = Toolkit.make(
  findFilesTool,
  grepTool,
  readTool,
  writeTool,
  editTool,
  bashTool,
  shellCommandStatusTool,
  gitStatusTool,
  webSearchTool,
  readWebPageTool,
  viewMediaTool,
)

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, ToolError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/tool-runtime/Service") {}

export const handlerLayer = toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* Service
    return {
      find_files: ({ query }) => runtime.run({ _tag: "FindFiles", query }),
      grep: ({ pattern, regex }) => runtime.run({ _tag: "Grep", pattern, regex }),
      read: ({ path, read_range }) =>
        runtime.run({
          _tag: "Read",
          path,
          ...(read_range === undefined ? {} : { readRange: read_range }),
        }),
      write: ({ path, content }) => runtime.run({ _tag: "Write", path, content }),
      edit: ({ path, old_str, new_str, replace_all }) =>
        runtime.run({
          _tag: "Edit",
          path,
          oldStr: old_str,
          newStr: new_str,
          ...(replace_all === undefined ? {} : { replaceAll: replace_all }),
        }),
      bash: ({ command, workdir, timeout_ms }) =>
        runtime.run({
          _tag: "Bash",
          command,
          ...(workdir === undefined ? {} : { workdir }),
          ...(timeout_ms === undefined ? {} : { timeoutMillis: timeout_ms }),
        }),
      shell_command_status: ({ processId, waitMillis }) =>
        runtime.run({ _tag: "ShellCommandStatus", processId, ...(waitMillis == null ? {} : { waitMillis }) }),
      git_status: () => runtime.run({ _tag: "GitStatus" }),
      web_search: ({ objective, searchQueries, kind, strategy, githubSearchType }) =>
        runtime.run({
          _tag: "WebSearch",
          objective,
          searchQueries,
          ...(kind === undefined ? {} : { kind }),
          ...(strategy === undefined ? {} : { strategy }),
          ...(githubSearchType === undefined ? {} : { githubSearchType }),
        }),
      read_web_page: ({ url, objective, fullContent, forceRefetch }) =>
        runtime.run({
          _tag: "ReadWebPage",
          url,
          ...(objective === undefined ? {} : { objective }),
          ...(fullContent === undefined ? {} : { fullContent }),
          ...(forceRefetch === undefined ? {} : { forceRefetch }),
        }),
      view_media: ({ path }) => runtime.run({ _tag: "ViewMedia", path }),
    }
  }),
)

const maxOutput = 40_000
const boundedPrefix = (text: string, limit: number) => {
  const prefix = text.slice(0, limit)
  const final = prefix.charCodeAt(prefix.length - 1)
  return final >= 0xd800 && final <= 0xdbff ? prefix.slice(0, -1) : prefix
}
const bounded = (text: string, limit = maxOutput): Result => ({
  text: boundedPrefix(text, limit),
  truncated: text.length > limit,
})
const gitStatusOutputLimit = 20_000

const toolName = (request: Request) => request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()

const contract = (request: Request) => ToolPolicy.get(toolName(request))!

const boundResult = (request: Request, result: Result): Result => {
  const limit = contract(request).outputLimit
  let remaining = limit
  const trim = (value: string | undefined) => {
    if (value === undefined) return undefined
    const trimmed = boundedPrefix(value, remaining)
    remaining -= trimmed.length
    return trimmed
  }
  const text = trim(result.text)!
  const stdout = trim(result.stdout)
  const stderr = trim(result.stderr)
  const diff = trim(result.diff)
  return {
    ...result,
    text,
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(diff === undefined ? {} : { diff }),
    truncated:
      result.truncated ||
      text.length < result.text.length ||
      (stdout !== undefined && stdout.length < result.stdout!.length) ||
      (stderr !== undefined && stderr.length < result.stderr!.length) ||
      (diff !== undefined && diff.length < result.diff!.length),
  }
}

const toolError = (request: Request, cause: unknown, kind: "operation" | "timeout") =>
  ToolError.make(
    kind === "timeout" && contract(request).idempotency === "unsafe"
      ? {
          tool: toolName(request),
          message: "Tool call timed out; its outcome is unknown and the call must not be repeated",
          kind,
          outcome: "unknown",
        }
      : { tool: toolName(request), message: String(cause), kind, outcome: "known" },
  )

class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<{ readonly message: string }> {}

const operationError = (cause: unknown) => new RuntimeOperationError({ message: String(cause) })

export const layerWithProcessRegistry = (workspace: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const webSearch = yield* WebSearchService.Service
      const readWebPage = yield* ReadWebPageService
      const processes = yield* ProcessRegistry.Service
      const mediaView = yield* MediaView.Service
      const canonicalWorkspace = yield* fileSystem.realPath(workspace).pipe(Effect.orDie)
      const resolve = (value: string) =>
        Effect.try({
          try: () => {
            const target = path.resolve(workspace, value)
            if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`))
              throw new RuntimeOperationError({ message: `Path escapes workspace: ${value}` })
            return target
          },
          catch: operationError,
        })
      const resolveCwd = (value: string) =>
        resolve(value).pipe(
          Effect.flatMap((target) =>
            Effect.all([fileSystem.realPath(workspace), fileSystem.realPath(target)]).pipe(
              Effect.mapError(operationError),
            ),
          ),
          Effect.flatMap(([canonicalRoot, canonicalTarget]) =>
            canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)
              ? Effect.succeed(canonicalTarget)
              : Effect.fail(new RuntimeOperationError({ message: `Path escapes workspace: ${value}` })),
          ),
        )
      const resolveEdit = (value: string) =>
        resolve(value).pipe(
          Effect.flatMap((target) => {
            const relative = path.relative(workspace, target)
            return Effect.forEach(relative.split(path.sep), (_, index) => {
              const current = path.join(workspace, ...relative.split(path.sep).slice(0, index + 1))
              return fileSystem.readLink(current).pipe(
                Effect.option,
                Effect.flatMap((link) =>
                  Option.isNone(link)
                    ? Effect.void
                    : Effect.fail(new RuntimeOperationError({ message: `symbolic link is not writable: ${value}` })),
                ),
              )
            }).pipe(Effect.as(target))
          }),
        )
      const isContained = (target: string) =>
        target === canonicalWorkspace || target.startsWith(`${canonicalWorkspace}${path.sep}`)
      const resolveContained = (value: string) =>
        resolve(value).pipe(
          Effect.flatMap((target) => fileSystem.realPath(target)),
          Effect.flatMap((target) =>
            isContained(target)
              ? Effect.succeed(target)
              : Effect.fail(new RuntimeOperationError({ message: `Path escapes workspace: ${value}` })),
          ),
        )
      const listFiles = Effect.fn("ToolRuntime.listFiles")(function* () {
        const found: Array<string> = []
        const visited = new Set([canonicalWorkspace])
        const ignored = (target: string) =>
          path
            .relative(canonicalWorkspace, target)
            .split(path.sep)
            .some((segment) => segment === ".git" || segment === "node_modules")
        const visit = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            for (const entry of yield* fileSystem.readDirectory(directory)) {
              if (entry === ".git" || entry === "node_modules") continue
              const absolute = path.join(directory, entry)
              const canonical = yield* fileSystem.realPath(absolute).pipe(Effect.option)
              if (Option.isNone(canonical) || !isContained(canonical.value) || ignored(canonical.value)) continue
              const info = yield* fileSystem.stat(canonical.value)
              if (info.type === "Directory") {
                if (visited.has(canonical.value)) continue
                visited.add(canonical.value)
                yield* visit(canonical.value)
              } else if (info.type === "File") found.push(path.relative(canonicalWorkspace, canonical.value))
            }
          })
        yield* visit(canonicalWorkspace)
        return found.toSorted()
      })
      const runGitStatus = Effect.fn("ToolRuntime.runGitStatus")(function* () {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", ["--no-optional-locks", "status", "--short", "--branch"], { cwd: workspace }),
            )
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                ProcessRegistry.collectBoundedText(handle.stdout, gitStatusOutputLimit),
                ProcessRegistry.collectBoundedText(handle.stderr, gitStatusOutputLimit),
                handle.exitCode,
              ],
              { concurrency: 3 },
            )
            if (exitCode !== 0)
              return yield* new RuntimeOperationError({
                message: `${stdout.text}${stderr.text}`.trim() || `Git status exited with code ${exitCode}`,
              })
            const text = `${stdout.text}${stderr.text}`.trim()
            const result = {
              text: text.slice(0, gitStatusOutputLimit),
              truncated: text.length > gitStatusOutputLimit,
            }
            return { ...result, truncated: result.truncated || stdout.truncated || stderr.truncated }
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => new RuntimeOperationError({ message: "Git status timed out after 10 seconds" }),
          }),
        )
      })
      return Service.of({
        run: Effect.fn("ToolRuntime.run")(function* (request) {
          const operation = Effect.gen(function* () {
            switch (request._tag) {
              case "FindFiles":
                return bounded(
                  (yield* listFiles())
                    .filter((file) => file.includes(request.query))
                    .slice(0, 1_000)
                    .join("\n"),
                )
              case "Grep": {
                if (request.regex) yield* Effect.try({ try: () => new RegExp(request.pattern), catch: operationError })
                const expression = request.regex ? new RegExp(request.pattern) : undefined
                const matches: Array<string> = []
                for (const file of yield* listFiles()) {
                  const content = yield* resolveContained(file).pipe(
                    Effect.flatMap((target) => fileSystem.readFileString(target)),
                    Effect.option,
                  )
                  if (content._tag === "None") continue
                  const lines = content.value.split("\n")
                  for (let index = 0; index < lines.length; index += 1) {
                    const line = lines[index] ?? ""
                    if (expression?.test(line) === true || (expression === undefined && line.includes(request.pattern)))
                      matches.push(`${file}:${index + 1}:${line}`)
                    if (matches.length === 1_000) break
                  }
                  if (matches.length === 1_000) break
                }
                return bounded(matches.join("\n"))
              }
              case "Read": {
                const start = request.readRange?.[0] ?? 1
                const end = request.readRange?.[1] ?? 1_000
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
                  return yield* new RuntimeOperationError({ message: "Invalid file range" })
                const target = yield* resolveContained(request.path)
                const lines = (yield* fileSystem.readFileString(target)).split("\n")
                return bounded(
                  lines
                    .slice(start - 1, end)
                    .map((line, index) => `${start + index}: ${line}`)
                    .join("\n"),
                )
              }
              case "Write": {
                const target = yield* resolveEdit(request.path)
                const exists = yield* fileSystem.exists(target)
                const previous = exists ? yield* fileSystem.readFileString(target) : ""
                yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
                yield* fileSystem.writeFileString(target, request.content)
                return {
                  ...bounded(`Successfully wrote ${request.content.length} bytes to ${request.path}`),
                  ...boundedDiff(unifiedDiff(request.path, previous, request.content, !exists)),
                }
              }
              case "Edit": {
                const target = yield* resolveEdit(request.path)
                const content = yield* fileSystem.readFileString(target)
                if (request.oldStr === request.newStr)
                  return yield* new RuntimeOperationError({ message: "old_str and new_str must be different" })
                if (request.oldStr.length === 0)
                  return yield* new RuntimeOperationError({ message: "old_str must not be empty" })
                const first = content.indexOf(request.oldStr)
                if (first < 0) return yield* new RuntimeOperationError({ message: "old_str was not found" })
                const second = content.indexOf(request.oldStr, first + request.oldStr.length)
                if (second >= 0 && request.replaceAll !== true)
                  return yield* new RuntimeOperationError({ message: "old_str is not unique; set replace_all to true" })
                const next =
                  request.replaceAll === true
                    ? content.split(request.oldStr).join(request.newStr)
                    : content.slice(0, first) + request.newStr + content.slice(first + request.oldStr.length)
                yield* fileSystem.writeFileString(target, next)
                return {
                  ...bounded(`Successfully replaced text in ${request.path}`),
                  ...boundedDiff(unifiedDiff(request.path, content, next)),
                }
              }
              case "Bash": {
                const cwd = yield* resolveCwd(request.workdir ?? ".")
                const processId = yield* processes.start("/bin/bash", ["-lc", request.command], cwd)
                const output = yield* processes
                  .poll(processId, Math.min(Math.max(0, request.timeoutMillis ?? 10_000), 60_000), maxOutput)
                  .pipe(Effect.onInterrupt(() => processes.cancel(processId).pipe(Effect.ignore)))
                return {
                  ...output,
                  text: `${output.stdout}${output.stderr}${output.exitCode === undefined || output.exitCode === 0 ? "" : `\nexit ${output.exitCode}`}`.trim(),
                }
              }
              case "Shell": {
                const cwd = yield* resolveCwd(request.cwd ?? ".")
                const processId = yield* processes.start(request.command, request.args, cwd)
                const output = yield* processes
                  .poll(processId, Math.min(Math.max(0, request.waitMillis ?? 10_000), 120_000), maxOutput)
                  .pipe(Effect.onInterrupt(() => processes.cancel(processId).pipe(Effect.ignore)))
                return {
                  ...output,
                  text: `${output.stdout}${output.stderr}${output.exitCode === undefined || output.exitCode === 0 ? "" : `\nexit ${output.exitCode}`}`.trim(),
                }
              }
              case "ShellCommandStatus": {
                const output = yield* processes.poll(
                  request.processId,
                  Math.min(Math.max(0, request.waitMillis ?? 0), 10_000),
                  maxOutput,
                )
                return { ...output, text: `${output.stdout}${output.stderr}` }
              }
              case "GitStatus":
                return yield* runGitStatus()
              case "WebSearch": {
                const results = yield* webSearch.search({
                  objective: request.objective,
                  searchQueries: request.searchQueries,
                  ...(request.kind === undefined ? {} : { kind: request.kind }),
                  ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
                  ...(request.githubSearchType === undefined ? {} : { githubSearchType: request.githubSearchType }),
                })
                return bounded(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(results))
              }
              case "ReadWebPage":
                return bounded(
                  yield* readWebPage.read({
                    url: request.url,
                    ...(request.objective === undefined ? {} : { objective: request.objective }),
                    ...(request.fullContent === undefined ? {} : { fullContent: request.fullContent }),
                    ...(request.forceRefetch === undefined ? {} : { forceRefetch: request.forceRefetch }),
                  }),
                )
              case "ViewMedia": {
                const viewed = yield* mediaView.view(request.path)
                return { text: viewed.text, artifact: viewed.artifact, truncated: viewed.truncated }
              }
            }
          }).pipe(
            Effect.map(boundResult.bind(undefined, request)),
            Effect.mapError((cause) => toolError(request, cause, "operation")),
          )
          return yield* Effect.scoped(operation).pipe(
            Effect.timeoutOrElse({
              duration: `${contract(request).timeoutMillis} millis`,
              orElse: () => Effect.fail(toolError(request, "Tool call timed out", "timeout")),
            }),
          )
        }),
      })
    }),
  ).pipe(Layer.provide(MediaView.layer(workspace)))

export const layer = (workspace: string) =>
  layerWithProcessRegistry(workspace).pipe(Layer.provide(ProcessRegistry.layer))

export const testLayer = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))
