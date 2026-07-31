import { Config, ConfigProvider, Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import * as LocalPath from "./local-path"
import * as LocalSafetyPolicy from "./local-safety-policy"
import { Toolkit } from "effect/unstable/ai"
import * as WebSearchService from "./web-search"
import * as ReadWebPageService from "./read-web-page"
import * as ProcessRegistry from "./process-registry"
import * as MediaView from "./media-view"
import * as ToolPolicy from "./tool-policy"
import * as WorkspaceIndex from "./workspace-index"
import { unifiedDiff } from "./unified-diff"

import * as ToolDefinitions from "./tools"

export const Grep = ToolDefinitions.Grep.Request
export const Read = ToolDefinitions.Read.Request
export const Write = ToolDefinitions.Write.Request
export const Edit = ToolDefinitions.Edit.Request
export const Bash = ToolDefinitions.Bash.Request
export const ShellCommandStatus = ToolDefinitions.ShellCommandStatus.Request
export const WebSearch = ToolDefinitions.WebSearch.Request
export const ReadWebPage = ToolDefinitions.ReadWebPage.Request
export const ViewMedia = ToolDefinitions.ViewMedia.Request
export const Shell = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})

export const Request = Schema.Union([
  Grep,
  Read,
  Write,
  Edit,
  Bash,
  Shell,
  ShellCommandStatus,
  WebSearch,
  ReadWebPage,
  ViewMedia,
])
export type Request = typeof Request.Type
const boundedDiff = (patch: string | undefined): { readonly diff?: string } =>
  patch === undefined ? {} : { diff: patch }

export const Result = ToolDefinitions.Result.Result
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: ToolDefinitions.Result.FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: ToolDefinitions.Result.Recovery,
  nextAction: Schema.String,
}) {}

export const grepTool = ToolDefinitions.Grep.tool
export const readTool = ToolDefinitions.Read.tool
export const writeTool = ToolDefinitions.Write.tool
export const editTool = ToolDefinitions.Edit.tool
export const bashTool = ToolDefinitions.Bash.tool
export const shellCommandStatusTool = ToolDefinitions.ShellCommandStatus.tool
export const webSearchTool = ToolDefinitions.WebSearch.tool
export const readWebPageTool = ToolDefinitions.ReadWebPage.tool
export const viewMediaTool = ToolDefinitions.ViewMedia.tool

export const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  ToolDefinitions.Grep.registration,
  ToolDefinitions.Read.registration,
  ToolDefinitions.Write.registration,
  ToolDefinitions.Edit.registration,
  ToolDefinitions.Bash.registration,
  ToolDefinitions.ShellCommandStatus.registration,
  ToolDefinitions.WebSearch.registration,
  ToolDefinitions.ReadWebPage.registration,
  ToolDefinitions.ViewMedia.registration,
]

export const toolkit = Toolkit.make(
  grepTool,
  readTool,
  writeTool,
  editTool,
  bashTool,
  shellCommandStatusTool,
  webSearchTool,
  readWebPageTool,
  viewMediaTool,
)

const policyForName = (name: string) => registrations.find((registration) => registration.tool.name === name)?.policy
const toolName = (request: Request) => request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
const contract = (request: Request) => policyForName(request._tag === "Shell" ? "bash" : toolName(request))!

export const handlerLayer = toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* Service
    return {
      grep: ({ pattern, regex }) => runtime.run({ _tag: "Grep", pattern, regex }),
      read: ({ path, read_range }) =>
        runtime.run({ _tag: "Read", path, ...(read_range === undefined ? {} : { readRange: read_range }) }),
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

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, ToolError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/tool-runtime/Service") {}

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

interface FailureDetails {
  readonly category: ToolDefinitions.Result.FailureCategory
  readonly message: string
  readonly outcome: "known" | "unknown"
  readonly recovery: ToolDefinitions.Result.Recovery
  readonly nextAction: string
}

class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<FailureDetails> {}

const runtimeError = (details: FailureDetails) => new RuntimeOperationError(details)

const tagOf = (cause: unknown) =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : undefined

const operationError = (cause: unknown): RuntimeOperationError => {
  if (cause instanceof RuntimeOperationError) return cause
  if (Schema.is(WebSearchService.SelectionError)(cause))
    return runtimeError({
      category: "dependency_unavailable",
      message: cause.message,
      outcome: "known",
      recovery: "after_change",
      nextAction: "Configure a provider that supports this search kind or choose a configured search kind",
    })
  if (Schema.is(WebSearchService.ExecutionError)(cause)) {
    const rateLimited =
      cause.outcomes.length > 0 && cause.outcomes.every((outcome) => outcome.error?.kind === "rate-limit")
    return rateLimited
      ? runtimeError({
          category: "rate_limited",
          message: "Every selected web search provider is rate limited",
          outcome: "known",
          recovery: "later",
          nextAction: "Retry later or use a different configured provider",
        })
      : runtimeError({
          category: "dependency_unavailable",
          message: "Every selected web search provider failed before returning results",
          outcome: "known",
          recovery: "later",
          nextAction: "Retry later or use a different configured provider",
        })
  }
  if (Schema.is(ReadWebPageService.HttpError)(cause))
    return cause.message.includes("PARALLEL_API_KEY")
      ? runtimeError({
          category: "dependency_unavailable",
          message: "Web page extraction is unavailable because PARALLEL_API_KEY is not configured",
          outcome: "known",
          recovery: "after_change",
          nextAction: "Configure PARALLEL_API_KEY or use another tool that can read the URL",
        })
      : runtimeError({
          category: "dependency_unavailable",
          message: "The web page provider failed before returning usable content",
          outcome: "known",
          recovery: "later",
          nextAction: "Retry later or use another source",
        })
  if (Schema.is(ReadWebPageService.ContentError)(cause))
    return cause.reason === "invalid_input"
      ? runtimeError({
          category: "invalid_input",
          message: "The web page URL or request options are invalid",
          outcome: "known",
          recovery: "after_change",
          nextAction: "Correct the URL or request options, or use another source",
        })
      : runtimeError({
          category: "dependency_unavailable",
          message: "The web page provider could not return usable content",
          outcome: "known",
          recovery: "later",
          nextAction: "Use another source or retry later",
        })
  if (Schema.is(WorkspaceIndex.WorkspaceIndexError)(cause))
    return runtimeError({
      category: cause.operation === "initialize" || cause.operation === "scan" ? "dependency_unavailable" : "operation",
      message:
        cause.operation === "initialize" || cause.operation === "scan"
          ? "The workspace index is unavailable"
          : `The workspace index could not complete ${cause.operation}`,
      outcome: "known",
      recovery: cause.operation === "initialize" || cause.operation === "scan" ? "after_change" : "later",
      nextAction:
        cause.operation === "initialize" || cause.operation === "scan"
          ? "Repair the workspace index installation or restart Rika after the index can initialize"
          : "Retry once later or use a narrower direct file operation",
    })
  if (
    tagOf(cause) === "PlatformError" &&
    "reason" in (cause as object) &&
    tagOf((cause as { reason: unknown }).reason) === "PermissionDenied"
  )
    return runtimeError({
      category: "access_denied",
      message: "The operating system denied access for this operation",
      outcome: "known",
      recovery: "after_change",
      nextAction: "Use an accessible path or correct the workspace permissions before retrying",
    })
  return runtimeError({
    category: "operation",
    message: "The operation failed before producing a usable result",
    outcome: "known",
    recovery: "after_change",
    nextAction: "Review the input and retry only after correcting the likely cause",
  })
}

const actionableMessage = (details: FailureDetails) =>
  `${details.message.replace(/[.\s]+$/, "")}. ${
    details.outcome === "known" ? "The call did not change state." : "The call may have changed state."
  } Next action: ${details.nextAction.replace(/[.\s]+$/, "")}.`

const toolError = (request: Request, cause: unknown, kind: "operation" | "timeout") => {
  const unsafe = contract(request).idempotency === "unsafe"
  let details: FailureDetails
  if (kind !== "timeout") details = operationError(cause)
  else if (unsafe)
    details = {
      category: "timeout",
      message: `${toolName(request)} timed out after ${contract(request).timeoutMillis}ms without confirming completion`,
      outcome: "unknown",
      recovery: "never",
      nextAction: "Inspect the workspace and process state; this call must not be repeated unchanged",
    }
  else
    details = {
      category: "timeout",
      message: `${toolName(request)} timed out after ${contract(request).timeoutMillis}ms without producing a result`,
      outcome: "known",
      recovery: "later",
      nextAction: "Retry once later with a narrower request or use an alternative tool",
    }
  const finalDetails =
    unsafe && kind === "operation" && !(cause instanceof RuntimeOperationError)
      ? {
          category: details.category,
          message: details.message,
          outcome: "unknown" as const,
          recovery: "never" as const,
          nextAction: "Inspect the workspace and process state before deciding whether another call is safe",
        }
      : details
  return ToolError.make({
    tool: toolName(request),
    message: actionableMessage(finalDetails),
    kind,
    category: finalDetails.category,
    outcome: finalDetails.outcome,
    recovery: finalDetails.recovery,
    nextAction: finalDetails.nextAction,
  })
}

const runtimeLayer = (workspace: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const webSearch = yield* WebSearchService.Service
      const readWebPage = yield* ReadWebPageService.Service
      const processes = yield* ProcessRegistry.Service
      const mediaView = yield* MediaView.Service
      const workspaceIndex = yield* WorkspaceIndex.Service
      const home = yield* Config.string("HOME").pipe(
        Config.option,
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
        Effect.orDie,
      )
      const lookup: LocalPath.Lookup = {
        exists: (target) => fileSystem.exists(target),
        readDirectory: (target) => fileSystem.readDirectory(target),
      }
      const resolveOptions = {
        path,
        base: workspace,
        ...(Option.isNone(home) ? {} : { home: home.value }),
      }
      const localPathError = (value: string, cause: unknown) => {
        if (!Schema.is(LocalPath.LocalPathError)(cause)) return operationError(cause)
        if (cause.reason === "ambiguous_case")
          return runtimeError({
            category: "conflict",
            message: `Several paths differ only by casing: ${cause.candidates.join(", ")}`,
            outcome: "known",
            recovery: "after_change",
            nextAction: "Call the tool again with the exact path casing",
          })
        return runtimeError({
          category: "not_found",
          message: `File not found: ${value}`,
          outcome: "known",
          recovery: "after_change",
          nextAction: "Search for the file or call the tool with a corrected path",
        })
      }
      const resolveExisting = (value: string) =>
        LocalPath.resolveExistingPath(lookup, value, resolveOptions).pipe(
          Effect.mapError((cause) => localPathError(value, cause)),
        )
      const resolveWrite = (value: string) =>
        LocalPath.resolveWriteTarget(lookup, value, resolveOptions).pipe(
          Effect.mapError((cause) => localPathError(value, cause)),
        )
      const withinWorkspace = (value: string) => {
        if (value === "~" || value.startsWith("~/")) return false
        const relative = path.relative(workspace, path.resolve(workspace, value))
        return !relative.startsWith("..") && !path.isAbsolute(relative)
      }
      const resolveRead = Effect.fn("ToolRuntime.resolveRead")(function* (value: string) {
        const resolved = yield* Effect.result(LocalPath.resolveExistingPath(lookup, value, resolveOptions))
        if (resolved._tag === "Success") return resolved.success
        const notFound =
          Schema.is(LocalPath.LocalPathError)(resolved.failure) && resolved.failure.reason === "not_found"
        if (!notFound || !withinWorkspace(value)) return yield* localPathError(value, resolved.failure)
        const found = yield* workspaceIndex.fileSearch(value, { pageSize: 20 })
        const bestMatch = found.items[0]
        if (bestMatch === undefined)
          return yield* runtimeError({
            category: "not_found",
            message: `File not found: ${value}`,
            outcome: "known",
            recovery: "after_change",
            nextAction: "Search for the file or call read with a corrected path",
          })
        return yield* resolveExisting(bestMatch.relativePath)
      })
      const requireRegularFile = (value: string, target: string) =>
        fileSystem.stat(target).pipe(
          Effect.mapError(operationError),
          Effect.flatMap((info) =>
            info.type === "File"
              ? Effect.void
              : Effect.fail(
                  runtimeError({
                    category: "invalid_input",
                    message: `Not a regular file: ${value}`,
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Target a regular file instead of a directory, device, or socket",
                  }),
                ),
          ),
        )
      const startChecked = (executable: string, args: ReadonlyArray<string>, cwd: string) => {
        const refusal = LocalSafetyPolicy.checkProcessInvocation({
          executable,
          args,
          cwd,
          home: Option.getOrUndefined(home),
        })
        return refusal === undefined
          ? processes.start(executable, args, cwd)
          : Effect.fail(
              runtimeError({
                category: "access_denied",
                message: refusal.message,
                outcome: "known",
                recovery: "never",
                nextAction: refusal.nextAction,
              }),
            )
      }
      return Service.of({
        run: Effect.fn("ToolRuntime.run")(function* (request) {
          const operation = Effect.gen(function* () {
            switch (request._tag) {
              case "Grep": {
                const matches: Array<string> = []
                let cursor: WorkspaceIndex.GrepResult["nextCursor"] = null
                do {
                  const page: WorkspaceIndex.GrepResult = yield* workspaceIndex.grep(request.pattern, {
                    mode: request.regex ? "regex" : "plain",
                    smartCase: false,
                    maxMatchesPerFile: 1_000,
                    pageSize: 1_000 - matches.length,
                    cursor,
                  })
                  if (page.regexFallbackError !== undefined)
                    return yield* runtimeError({
                      category: "invalid_input",
                      message: "The grep pattern is not a valid regular expression",
                      outcome: "known",
                      recovery: "after_change",
                      nextAction: "Correct the regular expression or set regex to false",
                    })
                  for (const match of page.items) {
                    matches.push(`${match.relativePath}:${match.lineNumber}:${match.lineContent}`)
                    if (matches.length === 1_000) break
                  }
                  cursor = page.nextCursor
                } while (cursor !== null && matches.length < 1_000)
                return bounded(matches.join("\n"))
              }
              case "Read": {
                const start = request.readRange?.[0] ?? 1
                const end = request.readRange?.[1] ?? 1_000
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: "The file range is invalid",
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Use whole-number line bounds where start is at least 1 and end is not before start",
                  })
                const target = yield* resolveRead(request.path)
                const lines = (yield* fileSystem.readFileString(target)).split("\n")
                return bounded(
                  lines
                    .slice(start - 1, end)
                    .map((line, index) => `${start + index}: ${line}`)
                    .join("\n"),
                )
              }
              case "Write": {
                const target = yield* resolveWrite(request.path)
                const exists = yield* fileSystem.exists(target)
                if (exists) yield* requireRegularFile(request.path, target)
                const previous = exists ? yield* fileSystem.readFileString(target) : ""
                yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
                yield* fileSystem.writeFileString(target, request.content)
                return {
                  ...bounded(`Successfully wrote ${request.content.length} bytes to ${request.path}`),
                  ...boundedDiff(unifiedDiff(request.path, previous, request.content, !exists)),
                }
              }
              case "Edit": {
                const target = yield* resolveExisting(request.path)
                yield* requireRegularFile(request.path, target)
                const content = yield* fileSystem.readFileString(target)
                if (request.oldStr === request.newStr)
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: "old_str and new_str must be different",
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Provide replacement text that differs from old_str",
                  })
                if (request.oldStr.length === 0)
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: "old_str must not be empty",
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Provide the exact existing text to replace",
                  })
                const first = content.indexOf(request.oldStr)
                if (first < 0)
                  return yield* runtimeError({
                    category: "conflict",
                    message: "old_str was not found in the current file",
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: `Reread ${request.path} and retry with the current exact text`,
                  })
                const second = content.indexOf(request.oldStr, first + request.oldStr.length)
                if (second >= 0 && request.replaceAll !== true)
                  return yield* runtimeError({
                    category: "conflict",
                    message: "old_str is not unique in the current file",
                    outcome: "known",
                    recovery: "after_change",
                    nextAction:
                      "Retry with more surrounding context, or set replace_all only when every match should change",
                  })
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
                const cwd = yield* resolveExisting(request.workdir ?? ".")
                const processId = yield* startChecked("/bin/bash", ["-lc", request.command], cwd)
                const output = yield* processes
                  .poll(processId, Math.min(Math.max(0, request.timeoutMillis ?? 10_000), 60_000), maxOutput)
                  .pipe(Effect.onInterrupt(() => processes.cancel(processId).pipe(Effect.ignore)))
                return {
                  ...output,
                  text: `${output.stdout}${output.stderr}${output.exitCode === undefined || output.exitCode === 0 ? "" : `\nexit ${output.exitCode}`}`.trim(),
                }
              }
              case "Shell": {
                const cwd = yield* resolveExisting(request.cwd ?? ".")
                const processId = yield* startChecked(request.command, request.args, cwd)
                const output = yield* processes
                  .poll(processId, Math.min(Math.max(0, request.waitMillis ?? 10_000), 120_000), maxOutput)
                  .pipe(Effect.onInterrupt(() => processes.cancel(processId).pipe(Effect.ignore)))
                const { stderr, stdout, ...status } = output
                return {
                  ...status,
                  text: `${stdout}${stderr}`,
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

export const layerWithProcessRegistry = (workspace: string) =>
  runtimeLayer(workspace).pipe(Layer.provide(WorkspaceIndex.layer(workspace)))

/** Runtime composition point for tests or hosts that provide their own index. */
export const layerWithServices = (workspace: string) => runtimeLayer(workspace)

export const layer = (workspace: string) =>
  layerWithProcessRegistry(workspace).pipe(Layer.provide(ProcessRegistry.layer))

export const testLayer = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))
