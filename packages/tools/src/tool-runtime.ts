import { FileFinder } from "@ff-labs/fff-node"
import { Context, Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ParallelSearch from "./parallel-search"
import { Service as ReadWebPageService } from "./read-web-page"
import * as ApplyPatch from "./apply-patch"
import * as ProcessRegistry from "./process-registry"
import * as MediaView from "./media-view"
import { unifiedDiff } from "./unified-diff"

const diffLimit = 100_000

const boundedDiff = (patch: string | undefined): { readonly diff?: string } =>
  patch === undefined || patch.length > diffLimit ? {} : { diff: patch }

export const FindFiles = Schema.Struct({ _tag: Schema.tag("FindFiles"), query: Schema.String })
export const Grep = Schema.Struct({ _tag: Schema.tag("Grep"), pattern: Schema.String, regex: Schema.Boolean })
export const ReadFile = Schema.Struct({
  _tag: Schema.tag("ReadFile"),
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
})
export const CreateFile = Schema.Struct({
  _tag: Schema.tag("CreateFile"),
  path: Schema.String,
  content: Schema.String,
})
export const EditFile = Schema.Struct({
  _tag: Schema.tag("EditFile"),
  path: Schema.String,
  oldText: Schema.String,
  newText: Schema.String,
})
export const ApplyPatchRequest = Schema.Struct({ _tag: Schema.tag("ApplyPatch"), patchText: Schema.String })
export const Shell = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(Schema.Number),
})
export const ShellCommandStatus = Schema.Struct({
  _tag: Schema.tag("ShellCommandStatus"),
  processId: Schema.String,
  waitMillis: Schema.optionalKey(Schema.Number),
})
export const GitStatus = Schema.Struct({ _tag: Schema.tag("GitStatus") })
export const WebSearch = Schema.Struct({
  _tag: Schema.tag("WebSearch"),
  objective: Schema.String,
  searchQueries: ParallelSearch.SearchQueries,
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
  ReadFile,
  CreateFile,
  EditFile,
  ApplyPatchRequest,
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
  exitCode: Schema.optionalKey(Schema.Number),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  artifact: Schema.optionalKey(MediaView.Artifact),
})
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ToolError"),
  tool: Schema.String,
  message: Schema.String,
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
export const readFileTool = tool("read_file", "Read a bounded UTF-8 file range with stable line numbers", {
  path: Schema.String,
  offset: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
export const createFileTool = tool("create_file", "Create a new UTF-8 file without overwriting an existing path", {
  path: Schema.String,
  content: Schema.String,
})
export const editFileTool = tool(
  "edit_file",
  "Replace one exact text occurrence and reject stale or ambiguous anchors",
  {
    path: Schema.String,
    oldText: Schema.String,
    newText: Schema.String,
  },
)
export const applyPatchTool = tool(
  "apply_patch",
  "Apply a Codex patch. Validates every add, update, delete, or move before writing and rejects stale or ambiguous context.",
  {
    patchText: Schema.String,
  },
)
export const shellTool = tool(
  "shell",
  "Run one command in the workspace and return a process id if it outlives the wait",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
    waitMillis: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  },
)
export const shellCommandStatusTool = tool(
  "shell_command_status",
  "Return only new output from a running command without restarting it",
  {
    processId: Schema.String,
    waitMillis: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  },
)
export const gitStatusTool = tool("git_status", "Inspect concise Git working-tree status", {
  refresh: Schema.optionalKey(Schema.Boolean),
})
export const webSearchTool = tool(
  "web_search",
  "Search the current web with Parallel. Provide a self-contained objective and 2-3 concise keyword queries.",
  {
    objective: Schema.String,
    searchQueries: ParallelSearch.SearchQueries,
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
  readFileTool,
  createFileTool,
  editFileTool,
  applyPatchTool,
  shellTool,
  shellCommandStatusTool,
  gitStatusTool,
  webSearchTool,
  readWebPageTool,
  viewMediaTool,
)

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, ToolError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/Runtime") {}

export const handlerLayer = toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* Service
    return {
      find_files: ({ query }) => runtime.run({ _tag: "FindFiles", query }),
      grep: ({ pattern, regex }) => runtime.run({ _tag: "Grep", pattern, regex }),
      read_file: ({ path, offset, limit }) =>
        runtime.run({
          _tag: "ReadFile",
          path,
          ...(offset == null ? {} : { offset }),
          ...(limit == null ? {} : { limit }),
        }),
      create_file: ({ path, content }) => runtime.run({ _tag: "CreateFile", path, content }),
      edit_file: ({ path, oldText, newText }) => runtime.run({ _tag: "EditFile", path, oldText, newText }),
      apply_patch: ({ patchText }) => runtime.run({ _tag: "ApplyPatch", patchText }),
      shell: ({ command, args, cwd, waitMillis }) =>
        runtime.run({
          _tag: "Shell",
          command,
          args,
          ...(cwd == null ? {} : { cwd }),
          ...(waitMillis == null ? {} : { waitMillis }),
        }),
      shell_command_status: ({ processId, waitMillis }) =>
        runtime.run({ _tag: "ShellCommandStatus", processId, ...(waitMillis == null ? {} : { waitMillis }) }),
      git_status: () => runtime.run({ _tag: "GitStatus" }),
      web_search: ({ objective, searchQueries }) => runtime.run({ _tag: "WebSearch", objective, searchQueries }),
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
const bounded = (text: string): Result => ({ text: text.slice(0, maxOutput), truncated: text.length > maxOutput })
const toolError = (request: Request, cause: unknown) => new ToolError({ tool: request._tag, message: String(cause) })

export const layer = (workspace: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const parallelSearch = yield* ParallelSearch.Service
      const readWebPage = yield* ReadWebPageService
      const processes = yield* ProcessRegistry.Service
      const mediaView = yield* MediaView.Service
      const finder = yield* Effect.acquireRelease(
        Effect.sync(() => {
          try {
            const created = FileFinder.create({ basePath: workspace, aiMode: true })
            return created.ok ? created.value : undefined
          } catch {
            return undefined
          }
        }).pipe(
          Effect.tap((created) =>
            created === undefined ? Effect.void : Effect.promise(() => created.waitForScan(10_000)),
          ),
        ),
        (created) => (created === undefined ? Effect.void : Effect.sync(() => created.destroy())),
      )
      const resolve = (value: string) =>
        Effect.try({
          try: () => {
            const target = path.resolve(workspace, value)
            if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`))
              throw new Error(`Path escapes workspace: ${value}`)
            return target
          },
          catch: (cause) => cause,
        })
      const listFiles = Effect.fn("ToolRuntime.listFiles")(function* () {
        const found: Array<string> = []
        const visit = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            for (const entry of yield* fileSystem.readDirectory(directory)) {
              if (entry === ".git" || entry === "node_modules") continue
              const absolute = path.join(directory, entry)
              const info = yield* fileSystem.stat(absolute)
              if (info.type === "Directory") yield* visit(absolute)
              else if (info.type === "File") found.push(path.relative(workspace, absolute))
            }
          })
        yield* visit(workspace)
        return found.toSorted()
      })
      const runProcess = Effect.fn("ToolRuntime.runProcess")(function* (command: string, args: ReadonlyArray<string>) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const process = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: workspace }))
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                ProcessRegistry.collectBoundedText(process.stdout, maxOutput),
                ProcessRegistry.collectBoundedText(process.stderr, maxOutput),
                process.exitCode,
              ],
              { concurrency: 3 },
            )
            const result = bounded(`${stdout.text}${stderr.text}${exitCode === 0 ? "" : `\nexit ${exitCode}`}`.trim())
            return { ...result, truncated: result.truncated || stdout.truncated || stderr.truncated }
          }),
        )
      })
      return Service.of({
        run: Effect.fn("ToolRuntime.run")(function* (request) {
          return yield* Effect.gen(function* () {
            switch (request._tag) {
              case "FindFiles":
                if (finder === undefined)
                  return bounded((yield* listFiles()).filter((file) => file.includes(request.query)).join("\n"))
                return bounded(
                  yield* Effect.try({
                    try: () => {
                      const result = finder.fileSearch(request.query, { pageSize: 1_000 })
                      if (!result.ok) throw new Error(result.error)
                      return result.value.items.map((item) => item.relativePath).join("\n")
                    },
                    catch: (cause) => cause,
                  }),
                )
              case "Grep": {
                if (finder === undefined) {
                  const expression = request.regex ? new RegExp(request.pattern) : undefined
                  const matches: Array<string> = []
                  for (const file of yield* listFiles()) {
                    const content = yield* resolve(file).pipe(
                      Effect.flatMap((target) => fileSystem.readFileString(target)),
                      Effect.option,
                    )
                    if (content._tag === "None") continue
                    const lines = content.value.split("\n")
                    for (let index = 0; index < lines.length; index += 1) {
                      const line = lines[index] ?? ""
                      if (
                        expression?.test(line) === true ||
                        (expression === undefined && line.includes(request.pattern))
                      )
                        matches.push(`${file}:${index + 1}:${line}`)
                    }
                  }
                  return bounded(matches.join("\n"))
                }
                return bounded(
                  yield* Effect.try({
                    try: () => {
                      const result = finder.grep(request.pattern, {
                        mode: request.regex ? "regex" : "plain",
                        pageSize: 1_000,
                        maxMatchesPerFile: 1_000,
                        classifyDefinitions: true,
                      })
                      if (!result.ok) throw new Error(result.error)
                      return result.value.items
                        .map((match) => `${match.relativePath}:${match.lineNumber}:${match.lineContent}`)
                        .join("\n")
                    },
                    catch: (cause) => cause,
                  }),
                )
              }
              case "ReadFile": {
                const target = yield* resolve(request.path)
                const lines = (yield* fileSystem.readFileString(target)).split("\n")
                const offset = Math.max(0, request.offset ?? 0)
                const limit = Math.min(Math.max(1, request.limit ?? 500), 2_000)
                return bounded(
                  lines
                    .slice(offset, offset + limit)
                    .map((line, index) => `${offset + index + 1}: ${line}`)
                    .join("\n"),
                )
              }
              case "CreateFile": {
                const target = yield* resolve(request.path)
                if (yield* fileSystem.exists(target))
                  return yield* Effect.fail(new Error(`${request.path} already exists`))
                yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
                yield* fileSystem.writeFileString(target, request.content)
                return {
                  ...bounded(`created ${request.path}`),
                  ...boundedDiff(unifiedDiff(request.path, "", request.content, true)),
                }
              }
              case "EditFile": {
                const target = yield* resolve(request.path)
                const content = yield* fileSystem.readFileString(target)
                const first = content.indexOf(request.oldText)
                if (first < 0) return yield* Effect.fail(new Error("stale anchor"))
                if (content.indexOf(request.oldText, first + request.oldText.length) >= 0)
                  return yield* Effect.fail(new Error("ambiguous anchor"))
                const next = content.slice(0, first) + request.newText + content.slice(first + request.oldText.length)
                yield* fileSystem.writeFileString(target, next)
                return {
                  ...bounded(`edited ${request.path}`),
                  ...boundedDiff(unifiedDiff(request.path, content, next)),
                }
              }
              case "ApplyPatch":
                return yield* ApplyPatch.apply(workspace, request.patchText, fileSystem, path)
              case "Shell": {
                const cwd = yield* resolve(request.cwd ?? ".")
                const processId = yield* processes.start(request.command, request.args, cwd)
                const output = yield* processes.poll(
                  processId,
                  Math.min(Math.max(0, request.waitMillis ?? 500), 120_000),
                  maxOutput,
                )
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
                return yield* runProcess("git", ["status", "--short", "--branch"])
              case "WebSearch": {
                const results = yield* parallelSearch.search({
                  objective: request.objective,
                  searchQueries: request.searchQueries,
                })
                return bounded(JSON.stringify(results))
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
          }).pipe(Effect.mapError((cause) => toolError(request, cause)))
        }),
      })
    }),
  ).pipe(Layer.provide(ProcessRegistry.layer), Layer.provide(MediaView.layer(workspace)))

export const testLayer = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))
