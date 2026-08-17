import { Config, ConfigProvider, Data, Effect, FileSystem, Function, Layer, Option, Path, Schema } from "effect"
import * as LocalPath from "../workspace/local-path"
import * as LocalSafetyPolicy from "../policy/local-safety-policy"
import * as WebSearchService from "../web-research/web-search-service"
import * as ReadWebPageService from "../web-research/read-web-page-service"
import * as ProcessRegistry from "../process/shell-process-registry"
import * as Bash from "../process/bash-tool"
import * as ShellStatus from "../process/shell-command-status-tool"
import * as MediaView from "../media/media-view-service"
import { RuntimeFilesystem } from "./coding-tool-runtime-filesystem"
import * as WorkspaceIndex from "../workspace/workspace-file-search"
import * as WorkspaceDirectoryListing from "../workspace/workspace-directory-listing"
import { unifiedDiff } from "../workspace/unified-diff"
import * as ToolPolicy from "../policy/coding-tool-policy"
import * as CodingToolResult from "./coding-tool-result"
import { Request as RequestSchema, Service, ToolError } from "./coding-tool-runtime"
type Request = typeof RequestSchema.Type
type Result = CodingToolResult.Result

export interface FailureDetails {
  readonly category: CodingToolResult.FailureCategory
  readonly message: string
  readonly outcome: "known" | "unknown"
  readonly recovery: CodingToolResult.Recovery
  readonly nextAction: string
}

export class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<FailureDetails> {}

export interface RuntimeLayerDependencies {
  readonly bounded: (text: string, limit?: number) => Result
  readonly boundResult: (request: Request, result: Result) => Result
  readonly contract: (request: Request) => ToolPolicy.Policy
  readonly toolError: (request: Request, cause: unknown, kind: "operation" | "timeout") => ToolError
  readonly operationError: (cause: unknown) => RuntimeOperationError
  readonly runtimeError: (details: FailureDetails) => RuntimeOperationError
}

const runtimeLayerImpl = (workspace: string, dependencies: RuntimeLayerDependencies) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { bounded, boundResult, contract, toolError, operationError, runtimeError } = dependencies
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
      const lookup: LocalPath.ExactLookup = {
        exists: (target) => fileSystem.exists(target),
        readDirectory: (target) => fileSystem.readDirectory(target),
        realPath: (target) => fileSystem.realPath(target),
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
        const found = yield* workspaceIndex
          .fileSearch(value, { pageSize: 3 })
          .pipe(Effect.orElseSucceed(() => ({ items: [], scores: [], totalMatched: 0, totalFiles: 0 })))
        const suggestions = found.items.map((item) => item.relativePath)
        return yield* runtimeError({
          category: "not_found",
          message:
            suggestions.length === 0
              ? `File not found: ${value}`
              : `File not found: ${value}. Did you mean ${suggestions.join(", ")}?`,
          outcome: "known",
          recovery: "after_change",
          nextAction:
            suggestions.length === 0
              ? "Search for the file or call read with a corrected path"
              : "Call read again with one of the suggested existing paths",
        })
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
                const deadlineMillis = Math.max(1_000, contract(request).timeoutMillis - 1_000)
                const page = yield* workspaceIndex.grep(request.pattern, {
                  mode: request.regex ? "regex" : "plain",
                  maxMatchesPerFile: 1_000,
                  pageSize: 1_000,
                  deadlineMillis,
                  ...(request.path === undefined ? {} : { include: request.path }),
                })
                if (page.regexFallbackError !== undefined)
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: `The grep pattern "${request.pattern}" is not a valid regular expression: ${page.regexFallbackError}`,
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Correct the regular expression or set regex to false",
                  })
                const structuredMatches = page.items.map((match) => ({
                  path: match.relativePath,
                  line: match.lineNumber,
                  text: match.lineContent,
                }))
                const matches = structuredMatches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n")
                const deadline =
                  page.deadlineReached === true
                    ? `search greps file CONTENTS repo-wide and stopped before the ${Math.round(contract(request).timeoutMillis / 1_000)}s tool timeout: ${page.items.length} ${page.items.length === 1 ? "match" : "matches"} found; scope with path or use workspace.list`
                    : undefined
                if (page.outputTruncation !== undefined) {
                  const recovery = `${deadline === undefined ? "rg output reached its capacity" : deadline}; narrow the pattern or scope with path`
                  return {
                    ...RuntimeFilesystem.boundedText(
                      matches,
                      contract(request).outputLimit,
                      recovery,
                      page.outputTruncation.totalBytes,
                    ),
                    matches: structuredMatches,
                  }
                }
                if (deadline !== undefined) {
                  const marker = deadline
                  return {
                    ...bounded(matches.length === 0 ? marker : `${matches}\n${marker}`),
                    matches: structuredMatches,
                    truncated: true,
                  }
                }
                return { ...bounded(matches), matches: structuredMatches }
              }
              case "List": {
                const displayPath = request.path ?? "."
                const target = yield* LocalPath.resolveExactWorkspacePath(lookup, displayPath, resolveOptions).pipe(
                  Effect.mapError((cause) => localPathError(displayPath, cause)),
                )
                const targetInfo = yield* fileSystem.stat(target).pipe(Effect.mapError(operationError))
                if (targetInfo.type !== "Directory")
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: `Not a directory: ${displayPath}`,
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "Call list with a directory path",
                  })
                return yield* WorkspaceDirectoryListing.list(target, displayPath, { depth: request.depth ?? 2 }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError(operationError),
                )
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
                const targetInfo = yield* fileSystem.stat(target).pipe(Effect.mapError(operationError))
                if (targetInfo.type === "Directory")
                  return yield* runtimeError({
                    category: "invalid_input",
                    message: `${request.path} is a directory — list it or read a file inside it`,
                    outcome: "known",
                    recovery: "after_change",
                    nextAction: "List the directory with bash or glob, then read a specific file inside it",
                  })
                const content = yield* fileSystem.readFileString(target)
                return bounded(RuntimeFilesystem.lineWindow(content, start, end))
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
                  ...RuntimeFilesystem.boundedDiff(unifiedDiff(request.path, previous, request.content, !exists)),
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
                if (second >= 0 && request.replaceAll !== true) {
                  const matchLines: Array<number> = []
                  for (
                    let matchIndex = first;
                    matchIndex >= 0;
                    matchIndex = content.indexOf(request.oldStr, matchIndex + request.oldStr.length)
                  )
                    matchLines.push(content.slice(0, matchIndex).split("\n").length)
                  return yield* runtimeError({
                    category: "conflict",
                    message: `old_str is not unique in the current file: ${matchLines.length} matches at lines ${[...new Set(matchLines)].join(", ")}`,
                    outcome: "known",
                    recovery: "after_change",
                    nextAction:
                      "Retry with more surrounding context, or set replace_all only when every match should change",
                  })
                }
                const next = RuntimeFilesystem.replaceText(
                  content,
                  request.oldStr,
                  request.newStr,
                  request.replaceAll === true,
                )
                yield* fileSystem.writeFileString(target, next)
                return {
                  ...bounded(`Successfully replaced text in ${request.path}`),
                  ...RuntimeFilesystem.boundedDiff(unifiedDiff(request.path, content, next, false)),
                }
              }
              case "Bash": {
                const cwd = yield* resolveExisting(request.workdir ?? ".")
                const processId = yield* startChecked("/bin/bash", ["-lc", request.command], cwd)
                const output = yield* processes
                  .poll(
                    processId,
                    Math.min(Math.max(0, request.timeoutMillis ?? 10_000), Bash.initialWaitMaximumMillis),
                    contract(request).outputLimit,
                  )
                  .pipe(
                    Effect.onInterrupt(() => Effect.uninterruptible(processes.cancel(processId).pipe(Effect.ignore))),
                  )
                const { stderr, stdout, ...status } = output
                return {
                  ...status,
                  text: `${stdout}${stderr}${output.exitCode === undefined || output.exitCode === 0 ? "" : `\nexit ${output.exitCode}`}`.trim(),
                }
              }
              case "Shell": {
                const cwd = yield* resolveExisting(request.cwd ?? ".")
                const processId = yield* startChecked(request.command, request.args, cwd)
                const output = yield* processes
                  .poll(
                    processId,
                    Math.min(Math.max(0, request.waitMillis ?? 10_000), 120_000),
                    contract(request).outputLimit,
                  )
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
                  Math.min(Math.max(0, request.waitMillis ?? 0), ShellStatus.statusWaitMaximumMillis),
                  contract(request).outputLimit,
                )
                const { stderr, stdout, ...status } = output
                return { ...status, text: `${stdout}${stderr}` }
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

export const runtimeLayer: {
  (workspace: string, dependencies: RuntimeLayerDependencies): ReturnType<typeof runtimeLayerImpl>
  (dependencies: RuntimeLayerDependencies): (workspace: string) => ReturnType<typeof runtimeLayerImpl>
} = Function.dual(2, runtimeLayerImpl)
