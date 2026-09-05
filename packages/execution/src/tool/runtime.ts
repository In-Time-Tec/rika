import * as Bash from "@rika/product/bash-tool"
import type * as ToolPolicy from "@rika/product/native-tool-policy"
import type * as NativeToolResult from "@rika/product/native-tool-result"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import * as ShellStatus from "@rika/product/shell-command-status-tool"
import { Config, ConfigProvider, Data, Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { RuntimeFilesystem } from "./filesystem"
import * as LocalPath from "@rika/product/local-path"
import * as LocalSafetyPolicy from "./local-safety"
import * as ProcessRegistry from "./process-registry"
import { unifiedDiff } from "./unified-diff"
import * as Mcp from "./mcp"

type Result = NativeToolResult.Result
type NativeRequest = Exclude<ToolRuntime.Request, { _tag: "McpCall" | "McpDiscover" }>

interface FailureDetails {
  readonly category: NativeToolResult.FailureCategory
  readonly message: string
  readonly outcome: "known" | "unknown"
  readonly recovery: NativeToolResult.Recovery
  readonly nextAction: string
}

class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<FailureDetails> {}

const bounded = (text: string): Result => ({ text, truncated: false })
const policyForName = (name: string) =>
  ToolRuntime.registrations.find((registration) => registration.tool.name === name)?.policy
const toolName = (request: NativeRequest) => request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
const contract = (request: NativeRequest): ToolPolicy.Policy =>
  policyForName(request._tag === "Shell" ? "bash" : toolName(request))!

const outputRecovery = (request: NativeRequest): string => {
  switch (request._tag) {
    case "Read":
      return "request a smaller read_range"
    case "Bash":
    case "Shell":
    case "ShellCommandStatus":
      return "page or narrow the command"
    case "Edit":
      return "read a narrower file range to inspect the remaining diff"
  }
}

const boundFields = (result: Result, limit: number, totalBytes: number, recovery: string): Result => {
  const longestMarker = `[truncated: kept first ${totalBytes} of ${totalBytes} bytes — ${recovery}]`
  let remaining = Math.max(0, limit - RuntimeFilesystem.byteLength(longestMarker) - 1)
  let keptBytes = 0
  let marked = false
  const trim = (value: string | undefined) => {
    if (value === undefined) return undefined
    if (marked) return ""
    const kept = RuntimeFilesystem.boundedPrefix(value, remaining)
    const acceptedBytes = RuntimeFilesystem.byteLength(kept)
    remaining -= acceptedBytes
    keptBytes += acceptedBytes
    if (kept === value) return kept
    marked = true
    const marker = `[truncated: kept first ${keptBytes} of ${totalBytes} bytes — ${recovery}]`
    const separator = kept.length === 0 || kept.endsWith("\n") ? "" : "\n"
    return `${kept}${separator}${marker}`
  }
  const text = trim(result.text)!
  const stdout = trim(result.stdout)
  const stderr = trim(result.stderr)
  const diff = trim(result.diff)
  const answer: Result = { ...result, text, truncated: true }
  if (stdout !== undefined) Object.assign(answer, { stdout })
  if (stderr !== undefined) Object.assign(answer, { stderr })
  if (diff !== undefined) Object.assign(answer, { diff })
  return answer
}

const boundResult = (request: NativeRequest, result: Result): Result => {
  const values = [result.text, result.stdout, result.stderr, result.diff].filter(
    (value): value is string => value !== undefined,
  )
  const limit = contract(request).outputLimit
  const totalBytes = values.reduce((total, value) => total + RuntimeFilesystem.byteLength(value), 0)
  return totalBytes <= limit ? result : boundFields(result, limit, totalBytes, outputRecovery(request))
}

const runtimeError = (details: FailureDetails) => new RuntimeOperationError(details)

const operationError = (cause: unknown): RuntimeOperationError => {
  if (cause instanceof RuntimeOperationError) return cause
  if (cause instanceof ProcessRegistry.ProcessNotFound)
    return runtimeError({
      category: "not_found",
      message: cause.message,
      outcome: "known",
      recovery: "after_change",
      nextAction: "Use a process id returned by a running bash call",
    })
  if (cause instanceof PlatformError.PlatformError && cause.reason._tag === "PermissionDenied")
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
  }`

const toolError = (request: NativeRequest, cause: unknown, kind: "operation" | "timeout") => {
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
  return ToolRuntime.ToolError.make({
    tool: toolName(request),
    message: actionableMessage(finalDetails),
    kind,
    category: finalDetails.category,
    outcome: finalDetails.outcome,
    recovery: finalDetails.recovery,
    nextAction: finalDetails.nextAction,
  })
}

/** Runtime implementation requiring one ProcessRegistry from its owning Run layer. */
export const layerWithProcessRegistry = (workspace: string) =>
  Layer.effect(
    ToolRuntime.Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processes = yield* ProcessRegistry.Service
      const home = yield* Config.string("HOME").pipe(
        Config.option,
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
        Effect.catchTag("ConfigError", (error) =>
          Effect.logWarning("native-tool-runtime.home-unavailable").pipe(
            Effect.annotateLogs({ "rika.failure.message": String(error) }),
            Effect.as(Option.none<string>()),
          ),
        ),
      )
      const lookup: LocalPath.Lookup = {
        exists: (target) => fileSystem.exists(target),
        readDirectory: (target) => fileSystem.readDirectory(target),
      }
      const resolveOptions: LocalPath.Options = { path, base: workspace }
      if (Option.isSome(home)) Object.assign(resolveOptions, { home: home.value })
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
      const read = Effect.fn("NativeToolRuntime.read")(function* (
        request: Extract<ToolRuntime.Request, { readonly _tag: "Read" }>,
      ) {
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
        const target = yield* resolveExisting(request.path)
        const targetInfo = yield* fileSystem.stat(target).pipe(Effect.mapError(operationError))
        if (targetInfo.type === "Directory")
          return yield* runtimeError({
            category: "invalid_input",
            message: `${request.path} is a directory — list it or read a file inside it`,
            outcome: "known",
            recovery: "after_change",
            nextAction: "Use bash to inspect the directory, then read a specific file inside it",
          })
        const content = yield* fileSystem.readFileString(target)
        return bounded(RuntimeFilesystem.lineWindow(content, start, end))
      })
      const edit = Effect.fn("NativeToolRuntime.edit")(function* (
        request: Extract<ToolRuntime.Request, { readonly _tag: "Edit" }>,
      ) {
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
            message: `old_str is not unique in the current file: ${matchLines.length} matches at lines ${[
              ...new Set(matchLines),
            ].join(", ")}`,
            outcome: "known",
            recovery: "after_change",
            nextAction: "Retry with more surrounding context, or set replace_all only when every match should change",
          })
        }
        const next = RuntimeFilesystem.replaceText(content, request.oldStr, request.newStr, request.replaceAll === true)
        yield* fileSystem.writeFileString(target, next)
        const result: Result = bounded(`Successfully replaced text in ${request.path}`)
        const diff = unifiedDiff(request.path, content, next, false)
        if (diff !== undefined) Object.assign(result, { diff })
        return result
      })
      const bash = Effect.fn("NativeToolRuntime.bash")(function* (
        request: Extract<ToolRuntime.Request, { readonly _tag: "Bash" }>,
      ) {
        const cwd = yield* resolveExisting(request.workdir ?? ".")
        const processId = yield* startChecked("/bin/bash", ["-lc", request.command], cwd)
        const output = yield* processes
          .poll(
            processId,
            Math.min(Math.max(0, request.timeoutMillis ?? 10_000), Bash.initialWaitMaximumMillis),
            contract(request).outputLimit,
          )
          .pipe(Effect.onInterrupt(() => Effect.uninterruptible(processes.cancel(processId).pipe(Effect.ignore))))
        const { stderr, stdout, ...status } = output
        const exit = output.exitCode === undefined || output.exitCode === 0 ? "" : `\nexit ${output.exitCode}`
        return { ...status, text: `${stdout}${stderr}${exit}`.trim() }
      })
      const recordedShell = Effect.fn("NativeToolRuntime.recordedShell")(function* (
        request: Extract<ToolRuntime.Request, { readonly _tag: "Shell" }>,
      ) {
        const cwd = yield* resolveExisting(request.cwd ?? ".")
        const processId = yield* startChecked(request.command, request.args, cwd)
        const output = yield* processes
          .poll(processId, Math.min(Math.max(0, request.waitMillis ?? 10_000), 120_000), contract(request).outputLimit)
          .pipe(Effect.onInterrupt(() => Effect.uninterruptible(processes.cancel(processId).pipe(Effect.ignore))))
        const { stderr, stdout, ...status } = output
        return { ...status, text: `${stdout}${stderr}` }
      })
      const shellCommandStatus = Effect.fn("NativeToolRuntime.shellCommandStatus")(function* (
        request: Extract<ToolRuntime.Request, { readonly _tag: "ShellCommandStatus" }>,
      ) {
        const output = yield* processes.poll(
          request.processId,
          Math.min(Math.max(0, request.waitMillis ?? 0), ShellStatus.statusWaitMaximumMillis),
          contract(request).outputLimit,
        )
        const { stderr, stdout, ...status } = output
        return { ...status, text: `${stdout}${stderr}` }
      })
      const executeOperation = (
        request: NativeRequest,
      ): Effect.Effect<
        Result,
        RuntimeOperationError | PlatformError.PlatformError | ProcessRegistry.ProcessNotFound
      > => {
        switch (request._tag) {
          case "Read":
            return read(request)
          case "Edit":
            return edit(request)
          case "Bash":
            return bash(request)
          case "Shell":
            return recordedShell(request)
          case "ShellCommandStatus":
            return shellCommandStatus(request)
        }
      }
      return ToolRuntime.Service.of({
        run: (request) => {
          if (request._tag === "McpCall" || request._tag === "McpDiscover") return Mcp.execute(workspace, request)
          const operation = executeOperation(request).pipe(
            Effect.map((result) => boundResult(request, result)),
            Effect.mapError((cause) => toolError(request, cause, "operation")),
          )
          return Effect.scoped(operation).pipe(
            Effect.timeoutOrElse({
              duration: `${contract(request).timeoutMillis} millis`,
              orElse: () => Effect.fail(toolError(request, "Tool call timed out", "timeout")),
            }),
          )
        },
      })
    }),
  )

/** A standalone runtime owns one registry for the lifetime of the built layer. */
export const layer = (workspace: string) =>
  layerWithProcessRegistry(workspace).pipe(Layer.provide(ProcessRegistry.layer))
