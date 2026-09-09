/* oxlint-disable max-lines, effecttsgo/missing-pipeable-signature -- workspace routing and its public layer factory share one protocol boundary. */

import * as LocalRuntime from "@rika/execution/local-runtime"
import {
  ExecutorTransportError,
  ExecutorFenceError,
  makeNativeOperationCoordinator,
  NativeOperationError,
  NativeOperationIntent,
  WorkspaceBinding,
  workspaceComponentReader,
  type CanonicalResult,
} from "@rika/execution-v2"
import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as NativeResult from "@rika/product/native-tool-result"
import * as NativeRuntime from "@rika/product/native-tool-runtime"
import * as Read from "@rika/product/read-file-tool"
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { Pins, ToolContext, ToolExecutor, ToolPlacement } from "generalist"
import { RunStore } from "generalist/runtime"

import {
  RunnerExecutor,
  RunnerExecutorError,
  runnerExecutorLayer,
  type RunnerCancellation,
  type RunnerExecutorService,
  type RunnerToolRequest,
} from "./executor"
import {
  SearchProviderError,
  SearchResult,
  missingSearchProvider,
  searchProviderLayer,
  type SearchProvider,
} from "./search"
import { GrepParameters, WebSearchParameters, toolkit } from "./tools"
import type { WebSearchParameters as WebSearchInput } from "./tools"

import { RunnerGrepError, RunnerWorkspaceError } from "./errors"
import { layer as grepLayer } from "./grep"

export { RunnerWorkspaceError } from "./errors"

export interface RunnerWorkspaceOptions {
  /** Absolute checkout path selected by the caller; there is no cwd fallback. */
  readonly checkout: string
  /** Immutable binding admitted by the hosted assignment. */
  readonly binding: WorkspaceBinding
  readonly searchProvider?: SearchProvider
}

export interface NativeIntentInput {
  readonly binding: WorkspaceBinding
  readonly operationId: string
  readonly tool: string
  readonly input: Schema.Json
}

/** Stable, order-independent cryptographic digest used to bind an admitted operation to its exact input. */
export const inputDigest = (input: Schema.Json): string => Pins.digest(input)

export const makeNativeOperationIntent = (input: NativeIntentInput): NativeOperationIntent => ({
  operationId: input.operationId,
  tool: input.tool,
  inputDigest: inputDigest(input.input),
  binding: input.binding,
})

interface WorkspaceExecution {
  readonly execute: (
    tool: string,
    input: Schema.Json,
    context: ToolContext.Service,
  ) => Effect.Effect<ToolPlacement.PlacementResponse, never>
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<RunnerCancellation, RunnerExecutorError | ExecutorTransportError>
  readonly binding: WorkspaceBinding
  readonly checkout: string
}

export class RunnerWorkspace extends Context.Service<RunnerWorkspace, WorkspaceExecution>()(
  "@rika/runner-v2/workspace/RunnerWorkspace",
) {}

const isInside = (root: string, target: string, separator: string): boolean =>
  target === root || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)

const toolFailure = (
  tool: string,
  message: string,
  category: NativeResult.FailureCategory,
  outcome: "known" | "unknown" = "known",
): NativeResult.ToolFailure => ({
  _tag: "ToolError",
  tool,
  message,
  kind: "operation",
  category,
  outcome,
  recovery: outcome === "unknown" ? "never" : "after_change",
  nextAction:
    outcome === "unknown"
      ? "Inspect the workspace and process state before deciding whether another call is safe"
      : "Correct the input or workspace condition and retry",
})

type WorkspaceFailure =
  | NativeRuntime.ToolError
  | SearchProviderError
  | RunnerGrepError
  | RunnerWorkspaceError
  | RunnerExecutorError
  | NativeOperationError
  | ExecutorTransportError
  | ExecutorFenceError

const failureFrom = (tool: string, error: WorkspaceFailure): NativeResult.ToolFailure => {
  if (Schema.is(NativeRuntime.ToolError)(error)) return error
  if (Schema.is(SearchProviderError)(error)) return toolFailure(tool, error.message, searchFailureCategory(error.kind))
  if (Schema.is(RunnerGrepError)(error)) return toolFailure(tool, error.message, grepFailureCategory(error.kind))
  if (Schema.is(RunnerWorkspaceError)(error))
    return toolFailure(tool, error.message, workspaceFailureCategory(error.kind))
  if (Schema.is(RunnerExecutorError)(error)) return toolFailure(tool, error.message, "operation")
  if (Schema.is(NativeOperationError)(error)) {
    const unresolved = error.kind === "unresolved"
    return toolFailure(tool, error.message, unresolved ? "operation" : "conflict", unresolved ? "unknown" : "known")
  }
  if (Schema.is(ExecutorTransportError)(error))
    return toolFailure(tool, error.message, "dependency_unavailable", "unknown")
  return toolFailure(tool, "The Runner operation failed without a typed result", "operation", "unknown")
}

const workspaceFailureCategory = (kind: RunnerWorkspaceError["kind"]): NativeResult.FailureCategory => {
  switch (kind) {
    case "binding":
      return "access_denied"
    case "path":
      return "access_denied"
    case "not_found":
      return "not_found"
    case "output":
      return "operation"
    case "operation":
      return "operation"
  }
}

const searchFailureCategory = (kind: SearchProviderError["kind"]): NativeResult.FailureCategory => {
  switch (kind) {
    case "credentials":
      return "dependency_unavailable"
    case "rate_limited":
      return "rate_limited"
    case "invalid_input":
      return "invalid_input"
    case "transport":
      return "dependency_unavailable"
  }
}

const grepFailureCategory = (kind: RunnerGrepError["kind"]): NativeResult.FailureCategory => {
  switch (kind) {
    case "path":
      return "access_denied"
    case "not_found":
      return "not_found"
    case "operation":
      return "operation"
  }
}

const unknownFailure = (tool: string, reason: string): NativeResult.ToolFailure =>
  toolFailure(tool, reason, "operation", "unknown")

const jsonByteLength = (value: Schema.Json): number =>
  new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Schema.Json))(value)).byteLength

const canonicalResponse = (tool: string, result: CanonicalResult): ToolPlacement.PlacementResponse => {
  switch (result._tag) {
    case "Completed":
      return { _tag: "Success", result: result.result }
    case "DomainFailure":
      return { _tag: "DomainFailure", failure: result.failure }
    case "Accepted":
      return {
        _tag: "DomainFailure",
        failure: unknownFailure(
          tool,
          "Runner accepted the operation without a terminal result; reconcile before retrying",
        ),
      }
    case "Unknown":
      return { _tag: "DomainFailure", failure: unknownFailure(tool, result.reason) }
  }
}

const terminalOutcome = (tool: string, result: CanonicalResult): ToolExecutor.TerminalOutcome => {
  switch (result._tag) {
    case "Completed":
      return { _tag: "Success", result: result.result, encodedResult: result.result }
    case "DomainFailure":
      return { _tag: "DomainFailure", failure: result.failure, encodedFailure: result.failure }
    case "Accepted": {
      const failure = unknownFailure(tool, "Runner accepted the operation without a terminal result")
      return { _tag: "DomainFailure", failure, encodedFailure: failure }
    }
    case "Unknown": {
      const failure = unknownFailure(tool, result.reason)
      return { _tag: "DomainFailure", failure, encodedFailure: failure }
    }
  }
}

const nativeRequest = (
  tool: string,
  input: Schema.Json,
  pathFor: (value: string) => Effect.Effect<string, RunnerWorkspaceError>,
): Effect.Effect<RunnerToolRequest, RunnerWorkspaceError> => {
  switch (tool) {
    case "bash":
      return Schema.decodeUnknownEffect(Bash.tool.parametersSchema)(input).pipe(
        Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid bash input" })),
        Effect.flatMap((value) =>
          pathFor(value.workdir ?? ".").pipe(
            Effect.map((workdir) => {
              const request: Bash.Request = { _tag: "Bash", command: value.command, workdir }
              if (value.timeout_ms !== undefined) Object.assign(request, { timeoutMillis: value.timeout_ms })
              return request
            }),
          ),
        ),
      )
    case "read":
      return Schema.decodeUnknownEffect(Read.tool.parametersSchema)(input).pipe(
        Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid read input" })),
        Effect.flatMap((value) =>
          pathFor(value.path).pipe(
            Effect.map((path) =>
              value.read_range === undefined
                ? ({ _tag: "Read", path } as const)
                : ({ _tag: "Read", path, readRange: value.read_range } as const),
            ),
          ),
        ),
      )
    case "edit":
      return Schema.decodeUnknownEffect(Edit.tool.parametersSchema)(input).pipe(
        Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid edit input" })),
        Effect.flatMap((value) =>
          pathFor(value.path).pipe(
            Effect.map((path) => {
              const request: Edit.Request = { _tag: "Edit", path, oldStr: value.old_str, newStr: value.new_str }
              if (value.replace_all !== undefined) Object.assign(request, { replaceAll: value.replace_all })
              return request
            }),
          ),
        ),
      )
    default:
      return Effect.fail(RunnerWorkspaceError.make({ kind: "operation", message: `Unsupported native tool ${tool}` }))
  }
}

const grepRequest = (
  input: Schema.Json,
  pathFor: (value: string) => Effect.Effect<string, RunnerWorkspaceError>,
): Effect.Effect<{ readonly parameters: GrepParameters }, RunnerWorkspaceError> =>
  Schema.decodeUnknownEffect(GrepParameters)(input).pipe(
    Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid grep input" })),
    Effect.flatMap((parameters) =>
      pathFor(parameters.path ?? ".").pipe(Effect.map((root) => ({ parameters: { ...parameters, path: root } }))),
    ),
  )

const webSearchRequest = (
  input: Schema.Json,
): Effect.Effect<{ readonly parameters: WebSearchInput }, RunnerWorkspaceError> =>
  Schema.decodeUnknownEffect(WebSearchParameters)(input).pipe(
    Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid web search input" })),
    Effect.map((parameters) => ({
      parameters:
        parameters.max_results === undefined
          ? { query: parameters.query }
          : { query: parameters.query, maxResults: parameters.max_results },
    })),
  )

const makeWorkspace = (
  options: RunnerWorkspaceOptions,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  runStore: RunStore.Service,
  executor: RunnerExecutorService,
): Effect.Effect<WorkspaceExecution, RunnerWorkspaceError> =>
  Effect.gen(function* () {
    if (!path.isAbsolute(options.checkout))
      return yield* RunnerWorkspaceError.make({ kind: "binding", message: "Runner checkout must be an absolute path" })
    if (options.binding.placement._tag !== "Runner")
      return yield* RunnerWorkspaceError.make({
        kind: "binding",
        message: "Runner workspace requires Runner placement",
      })
    if (options.binding.placement.workspaceId !== options.binding.workspaceId)
      return yield* RunnerWorkspaceError.make({
        kind: "binding",
        message: "Runner binding workspace identity mismatches placement",
      })
    const checkout = path.resolve(options.checkout)
    const rootReal = yield* fileSystem
      .realPath(checkout)
      .pipe(
        Effect.mapError(() =>
          RunnerWorkspaceError.make({ kind: "not_found", message: "Runner checkout does not exist" }),
        ),
      )
    const rootInfo = yield* fileSystem
      .stat(rootReal)
      .pipe(
        Effect.mapError(() =>
          RunnerWorkspaceError.make({ kind: "not_found", message: "Runner checkout is unavailable" }),
        ),
      )
    if (rootInfo.type !== "Directory")
      return yield* RunnerWorkspaceError.make({ kind: "binding", message: "Runner checkout must be a directory" })

    const pathFor = (input: string): Effect.Effect<string, RunnerWorkspaceError> => {
      if (input.trim().length === 0 || input === "~" || input.startsWith("~/"))
        return Effect.fail(
          RunnerWorkspaceError.make({ kind: "path", message: "Workspace paths must stay inside the Runner checkout" }),
        )
      const lexical = path.resolve(checkout, input)
      if (!isInside(checkout, lexical, path.sep))
        return Effect.fail(
          RunnerWorkspaceError.make({ kind: "path", message: "Workspace path resolves outside the Runner checkout" }),
        )
      return fileSystem.realPath(lexical).pipe(
        Effect.mapError(() =>
          RunnerWorkspaceError.make({ kind: "not_found", message: `Workspace path not found: ${input}` }),
        ),
        Effect.flatMap((target) =>
          isInside(rootReal, target, path.sep)
            ? Effect.succeed(target)
            : Effect.fail(
                RunnerWorkspaceError.make({
                  kind: "path",
                  message: "Workspace symlink resolves outside the Runner checkout",
                }),
              ),
        ),
      )
    }

    const mutationGate = yield* Semaphore.make(1)
    const writeGates = new Map<string, Semaphore.Semaphore>()
    const writeGate = (target: string) =>
      mutationGate.withPermits(1)(
        Effect.gen(function* () {
          let gate = writeGates.get(target)
          if (gate === undefined) {
            gate = yield* Semaphore.make(1)
            writeGates.set(target, gate)
          }
          return gate
        }),
      )

    const execute = Effect.fn("RikaRunnerV2.Workspace.execute")(function* (
      tool: string,
      input: Schema.Json,
      context: ToolContext.Service,
    ): Effect.fn.Return<ToolPlacement.PlacementResponse, never> {
      const failure = (error: WorkspaceFailure): ToolPlacement.PlacementResponse => ({
        _tag: "DomainFailure",
        failure: failureFrom(tool, error),
      })
      const operationId = context.operationKey?.trim()
      if (operationId === undefined || operationId.length === 0)
        return failure(
          RunnerWorkspaceError.make({
            kind: "operation",
            message: "Native Runner Tool requires a stable operation key",
          }),
        )
      if (operationId.length > 256)
        return failure(
          RunnerWorkspaceError.make({ kind: "operation", message: "Native Runner operation key is too long" }),
        )
      const prepared: Effect.Effect<RunnerToolRequest, RunnerWorkspaceError> = (() => {
        switch (tool) {
          case "grep":
            return grepRequest(input, pathFor).pipe(Effect.map(({ parameters }) => ({ _tag: "Grep", parameters })))
          case "web_search":
            return webSearchRequest(input).pipe(Effect.map(({ parameters }) => ({ _tag: "WebSearch", parameters })))
          default:
            return nativeRequest(tool, input, pathFor)
        }
      })()
      const request = yield* Effect.result(prepared)
      if (request._tag === "Failure") return failure(request.failure)
      const native = request.success
      const intent = makeNativeOperationIntent({ binding: options.binding, operationId, tool, input })
      const run = Effect.gen(function* () {
        yield* executor.register(intent, native)
        const component = workspaceComponentReader(context, runStore)
        const coordinator = makeNativeOperationCoordinator(component, executor)
        const canonical = yield* coordinator.dispatch(intent)
        if (canonical._tag === "Completed" && jsonByteLength(canonical.result) > NativeResult.maxOutputBytes)
          return yield* RunnerWorkspaceError.make({
            kind: "output",
            message: `${tool} result exceeds the retained output limit`,
          })
        if (canonical._tag === "DomainFailure" && jsonByteLength(canonical.failure) > NativeResult.maxOutputBytes)
          return yield* RunnerWorkspaceError.make({
            kind: "output",
            message: `${tool} failure exceeds the retained output limit`,
          })
        return canonicalResponse(tool, canonical)
      })
      const guarded = (() => {
        if (tool !== "bash" && tool !== "edit") return run
        const target = tool === "edit" && native._tag === "Edit" ? native.path : checkout
        return writeGate(target).pipe(Effect.flatMap((gate) => gate.withPermits(1)(run)))
      })()
      return yield* guarded.pipe(
        Effect.catchIf(
          (
            _error,
          ): _error is
            | RunnerWorkspaceError
            | RunnerExecutorError
            | NativeOperationError
            | ExecutorTransportError
            | ExecutorFenceError => true,
          (error) => Effect.succeed(failure(error)),
        ),
      )
    })

    return {
      binding: options.binding,
      checkout,
      execute,
      cancel: executor.cancel,
    }
  })

const cancellationFailure = (tool: string, message: string) => ToolExecutor.CancellationFailure.make({ tool, message })

const route = ToolExecutor.route<RunnerWorkspace | ToolContext.ToolContext>({
  tools: Object.keys(toolkit.tools),
  replayPolicy: () => "provider-idempotent" as const,
  execute: (request) =>
    Effect.gen(function* () {
      const workspace = yield* RunnerWorkspace
      const context = yield* ToolContext.ToolContext
      const input = yield* Schema.decodeUnknownEffect(Schema.Json)(request.call.params).pipe(
        Effect.mapError(() =>
          ToolExecutor.FrameworkFailure.make({
            stage: "decode-input",
            tool: request.call.name,
            message: "Tool parameters must be JSON",
          }),
        ),
      )
      const response = yield* workspace.execute(request.call.name, input, context)
      switch (response._tag) {
        case "Success":
          return { _tag: "Success" as const, result: response.result, encodedResult: response.result }
        case "DomainFailure":
          return { _tag: "DomainFailure" as const, failure: response.failure, encodedFailure: response.failure }
        case "Suspend":
          return { _tag: "Suspend" as const, token: response.token }
      }
    }),
})

const routed = {
  ...route,
  replayPolicy: () => "provider-idempotent" as const,
  cancel: (request: ToolExecutor.CancellationRequest) =>
    Effect.gen(function* () {
      const workspace = yield* RunnerWorkspace
      const result = yield* workspace
        .cancel(request.operationKey)
        .pipe(Effect.mapError((error) => cancellationFailure(request.toolName, error.message)))
      if (result._tag === "Cancelled") return { _tag: "Cancelled" as const }
      return { _tag: "AlreadyTerminal" as const, outcome: terminalOutcome(request.toolName, result.result) }
    }),
}

const routeLayer = <R>(additionalRoutes: ReadonlyArray<ToolPlacement.RouteInput<ToolContext.ToolContext | R>>) =>
  ToolExecutor.layerRouter<RunnerWorkspace | ToolContext.ToolContext | R>([routed, ...additionalRoutes])

/** Build the Runner checkout adapter and its Generalist background ToolExecutor. */
export const layerWithRoutes = <R = never>(
  options: RunnerWorkspaceOptions,
  additionalRoutes: ReadonlyArray<ToolPlacement.RouteInput<ToolContext.ToolContext | R>> = [],
) => {
  const searchLayer = searchProviderLayer(options.searchProvider ?? missingSearchProvider)
  const localRuntime = LocalRuntime.layer(options.checkout)
  const executorLayer = runnerExecutorLayer({ binding: options.binding })
  const workspaceLayer = Layer.effect(
    RunnerWorkspace,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runStore = yield* RunStore.RunStore
      const executor = yield* RunnerExecutor
      return yield* makeWorkspace(options, fileSystem, path, runStore, executor)
    }),
  ).pipe(
    Layer.provide(executorLayer),
    Layer.provide(grepLayer(options.checkout)),
    Layer.provide(localRuntime),
    Layer.provide(searchLayer),
  )
  return Layer.provideMerge(routeLayer(additionalRoutes), workspaceLayer)
}

export const layer = (options: RunnerWorkspaceOptions) => layerWithRoutes(options)

export const RunnerWorkspaceContract = {
  GrepParameters,
  RunnerWorkspace,
  RunnerWorkspaceError,
  SearchResult,
  inputDigest,
  layer,
  layerWithRoutes,
  makeNativeOperationIntent,
  toolkit,
}
