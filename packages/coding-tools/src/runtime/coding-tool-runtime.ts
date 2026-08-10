import { Context, Effect, Function, Layer, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as Inputs from "./coding-tool-runtime-inputs"
import * as WorkspaceIndex from "../workspace/workspace-file-search"
import * as WebSearchErrors from "../web-research/web-search-errors"
import * as ReadWebPageService from "../web-research/read-web-page-service"
import * as ProcessRegistry from "../process/shell-process-registry"
import { RuntimeFilesystem } from "./coding-tool-runtime-filesystem"
import {
  runtimeLayer,
  RuntimeOperationError,
  type FailureDetails,
  type RuntimeLayerDependencies,
} from "./coding-tool-runtime-layer"

import * as ToolPolicy from "../policy/coding-tool-policy"
import * as CodingToolResult from "./coding-tool-result"

const Shell = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export const Request = Schema.Union([
  Inputs.Inputs.Grep.Request,
  Inputs.Inputs.Read.Request,
  Inputs.Inputs.Write.Request,
  Inputs.Inputs.Edit.Request,
  Inputs.Inputs.Bash.Request,
  Shell,
  Inputs.Inputs.ShellStatus.Request,
  Inputs.Inputs.WebSearch.Request,
  Inputs.Inputs.ReadPage.Request,
  Inputs.Inputs.Media.Request,
])
type Request = typeof Request.Type
type Result = CodingToolResult.Result
export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: CodingToolResult.FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: CodingToolResult.Recovery,
  nextAction: Schema.String,
}) {}

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, ToolError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/runtime/coding-tool-runtime/Service",
) {}

const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  Inputs.Inputs.Grep.registration,
  Inputs.Inputs.Read.registration,
  Inputs.Inputs.Write.registration,
  Inputs.Inputs.Edit.registration,
  Inputs.Inputs.Bash.registration,
  Inputs.Inputs.ShellStatus.registration,
  Inputs.Inputs.WebSearch.registration,
  Inputs.Inputs.ReadPage.registration,
  Inputs.Inputs.Media.registration,
]
export const toolkit = Toolkit.make(
  Inputs.Inputs.Grep.tool,
  Inputs.Inputs.Read.tool,
  Inputs.Inputs.Write.tool,
  Inputs.Inputs.Edit.tool,
  Inputs.Inputs.Bash.tool,
  Inputs.Inputs.ShellStatus.tool,
  Inputs.Inputs.WebSearch.tool,
  Inputs.Inputs.ReadPage.tool,
  Inputs.Inputs.Media.tool,
)

const bounded = (text: string): Result => ({ text, truncated: false })
const policyForName = (name: string) => registrations.find((registration) => registration.tool.name === name)?.policy
const toolName = (request: Request) => request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
const contract = (request: Request) => policyForName(request._tag === "Shell" ? "bash" : toolName(request))!

const outputRecovery = (request: Request): string => {
  switch (request._tag) {
    case "Grep":
      return "narrow the pattern or scope with path"
    case "Read":
      return "request a smaller read_range"
    case "Bash":
    case "Shell":
    case "ShellCommandStatus":
      return "page or narrow the command"
    case "WebSearch":
      return "narrow the search"
    case "ReadWebPage":
      return "request focused excerpts or disable full_content"
    case "ViewMedia":
      return "request a narrower analysis"
    case "Write":
    case "Edit":
      return "read a narrower file range to inspect the remaining diff"
  }
}

const boundResult = (request: Request, result: Result): Result => {
  const values = [
    result.text,
    result.stdout,
    result.stderr,
    result.diff,
    result.artifact?.path,
    result.artifact?.mimeType,
  ].filter((value): value is string => value !== undefined)
  const limit = contract(request).outputLimit
  const totalBytes = values.reduce((total, value) => total + RuntimeFilesystem.byteLength(value), 0)
  if (totalBytes <= limit) return result

  const recovery = outputRecovery(request)
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
  const artifact =
    result.artifact === undefined
      ? undefined
      : {
          ...result.artifact,
          path: trim(result.artifact.path)!,
          mimeType: trim(result.artifact.mimeType)!,
        }
  return {
    ...result,
    text,
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(diff === undefined ? {} : { diff }),
    ...(artifact === undefined ? {} : { artifact }),
    truncated: true,
  }
}

const runtimeError = (details: FailureDetails) => new RuntimeOperationError(details)

/**
 * A missing program is reported differently by every layer it passes through, so matching one exact
 * sentence left a reader told that a search "could not complete" and nothing about what to install.
 */
const missingRipgrep = (message: string): boolean =>
  /ripgrep|(^|\W)rg(\W|$)|ENOENT|No such file|failed to spawn/i.test(message)

const searchMessage = (operation: string, message: string): string => {
  if (operation === "initialize") return "The workspace search tools are unavailable"
  return missingRipgrep(message) ? message : `Workspace search could not complete ${operation}`
}

const tagOf = (cause: unknown) =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : undefined

const operationError = (cause: unknown): RuntimeOperationError => {
  if (cause instanceof RuntimeOperationError) return cause
  if (Schema.is(WebSearchErrors.SelectionError)(cause))
    return runtimeError({
      category: "dependency_unavailable",
      message: cause.message,
      outcome: "known",
      recovery: "after_change",
      nextAction: "Configure a provider that supports this search kind or choose a configured search kind",
    })
  if (Schema.is(WebSearchErrors.ExecutionError)(cause)) {
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
          /**
           * Each provider already reported why it failed, and summarising them away left a reader
           * unable to tell an expired key from an outage. The reasons are what decide what to do
           * next.
           */
          message: `Every selected web search provider failed before returning results${
            cause.outcomes.length === 0
              ? ""
              : `: ${cause.outcomes
                  .map((outcome) => `${outcome.provider}: ${outcome.error?.kind ?? "unknown"}`)
                  .join(", ")}`
          }`,
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
      category: cause.operation === "initialize" ? "dependency_unavailable" : "operation",
      message: searchMessage(cause.operation, cause.message),
      outcome: "known",
      recovery: cause.operation === "initialize" ? "after_change" : "later",
      nextAction:
        cause.operation === "initialize" || missingRipgrep(cause.message)
          ? "Confirm the workspace path is readable and that ripgrep (rg) is installed"
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
  }`

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

type WorkspaceIndexLayer = ReturnType<typeof WorkspaceIndex.layer>
const runtimeDependencies: RuntimeLayerDependencies = {
  bounded,
  boundResult,
  contract,
  toolError,
  operationError,
  runtimeError,
}

const layerWithProcessRegistryImpl = (workspace: string, indexLayer: WorkspaceIndexLayer) =>
  runtimeLayer(workspace, runtimeDependencies).pipe(Layer.provide(indexLayer))
type ProcessRegistryLayer = ReturnType<typeof layerWithProcessRegistryImpl>

export const layerWithProcessRegistry: {
  (workspace: string): (indexLayer: WorkspaceIndexLayer) => ProcessRegistryLayer
  (workspace: string, indexLayer: WorkspaceIndexLayer): ProcessRegistryLayer
} = Function.dual(2, layerWithProcessRegistryImpl)

export const layer = (workspace: string) =>
  runtimeLayer(workspace, runtimeDependencies).pipe(
    Layer.provide(WorkspaceIndex.layer(workspace)),
    Layer.provide(ProcessRegistry.layer),
  )

export const testLayer = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))
