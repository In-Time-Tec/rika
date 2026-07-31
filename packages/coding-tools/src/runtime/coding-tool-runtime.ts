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

const maxOutput = 40_000
const bounded = (text: string, limit = maxOutput): Result => RuntimeFilesystem.boundedText<Result>(text, limit)
const policyForName = (name: string) => registrations.find((registration) => registration.tool.name === name)?.policy
const toolName = (request: Request) => request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
const contract = (request: Request) => policyForName(request._tag === "Shell" ? "bash" : toolName(request))!

const boundResult = (request: Request, result: Result): Result => {
  const limit = contract(request).outputLimit
  let remaining = limit
  const trim = (value: string | undefined) => {
    if (value === undefined) return undefined
    const trimmed = RuntimeFilesystem.boundedPrefix(value, remaining)
    remaining -= trimmed.length
    return trimmed
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
    truncated:
      result.truncated ||
      text.length < result.text.length ||
      (stdout !== undefined && stdout.length < result.stdout!.length) ||
      (stderr !== undefined && stderr.length < result.stderr!.length) ||
      (diff !== undefined && diff.length < result.diff!.length) ||
      (artifact !== undefined &&
        (artifact.path.length < result.artifact!.path.length ||
          artifact.mimeType.length < result.artifact!.mimeType.length)),
  }
}

const runtimeError = (details: FailureDetails) => new RuntimeOperationError(details)

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
      category: cause.operation === "initialize" ? "dependency_unavailable" : "operation",
      message:
        cause.operation === "initialize"
          ? "The workspace search tools are unavailable"
          : `Workspace search could not complete ${cause.operation}`,
      outcome: "known",
      recovery: cause.operation === "initialize" ? "after_change" : "later",
      nextAction:
        cause.operation === "initialize"
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
