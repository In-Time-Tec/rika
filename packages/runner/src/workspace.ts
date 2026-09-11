/* oxlint-disable max-lines, effecttsgo/missing-pipeable-signature, anti-slop-effect/no-service-constructor-imports -- path preparation and the local executor factory form one boundary. */

import * as LocalRuntime from "./native/runtime"
import { filesystemWorkspaceReader } from "@rika/context/filesystem"
import { handleWorkspaceContextRequest, workspaceContextToolName } from "@rika/context/remote"
import { WorkspaceReaderError } from "@rika/context/workspace"
import {
  ExecutorFenceError,
  ExecutorTransportError,
  HandshakeEvidence,
  HandshakeRequest,
  NativeOperationIntent,
  WorkspaceBinding,
  WorkspaceExecutor,
  bindingMismatchReason,
  evidenceFor,
  maxAdmittedOperations,
  nativeToolExecutionLayer,
  sameBinding,
  sameEvidence,
  type ExecutorEvidence,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { GrepParameters, WebSearchParameters, toolkit } from "@rika/execution/tools"
import type { WebSearchParameters as WebSearchInput } from "@rika/execution/tools"
import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as NativeResult from "@rika/product/native-tool-result"
import * as Read from "@rika/product/read-file-tool"
import { Effect, FileSystem, Layer, Path, Schema, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Pins, ToolContext, ToolExecutor, ToolPlacement } from "generalist"
import * as Hooks from "generalist/hooks"
import { RunStore } from "generalist/runtime"

import { RunnerExecutorError, makeRunnerExecutor, type RunnerExecutorService, type RunnerToolRequest } from "./executor"
import { RunnerWorkspaceError } from "./errors"
import { RunnerGrep, layer as grepLayer } from "./grep"
import { Search, missingSearchProvider, searchProviderLayer, type SearchProvider } from "./search"

export { RunnerWorkspaceError } from "./errors"

export interface RunnerWorkspaceOptions {
  readonly checkout: string
  readonly binding: WorkspaceBinding
  readonly searchProvider?: SearchProvider
}

export interface NativeIntentInput {
  readonly binding: WorkspaceBinding
  readonly operationId: string
  readonly tool: string
  readonly input: Schema.Json
}

export const inputDigest = (input: Schema.Json): string => Pins.digest(input)

export const makeNativeOperationIntent = (input: NativeIntentInput): NativeOperationIntent => ({
  operationId: input.operationId,
  tool: input.tool,
  inputDigest: inputDigest(input.input),
  binding: input.binding,
})

const isInside = (root: string, target: string, separator: string): boolean =>
  target === root || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)

const toolFailure = (
  tool: string,
  message: string,
  category: NativeResult.FailureCategory,
): NativeResult.ToolFailure => ({
  _tag: "ToolError",
  tool,
  message,
  kind: "operation",
  category,
  outcome: "known",
  recovery: "after_change",
  nextAction: "Correct the input or workspace condition and retry",
})

const workspaceFailureCategory = (kind: RunnerWorkspaceError["kind"]): NativeResult.FailureCategory => {
  switch (kind) {
    case "binding":
    case "path":
      return "access_denied"
    case "not_found":
      return "not_found"
    case "output":
    case "operation":
      return "operation"
  }
}

const failureFrom = (tool: string, error: RunnerWorkspaceError): NativeResult.ToolFailure =>
  toolFailure(tool, error.message, workspaceFailureCategory(error.kind))

const fence = (reason: ExecutorFenceError["reason"], message: string) => ExecutorFenceError.make({ reason, message })

const transport = (phase: ExecutorTransportError["phase"], message: string) =>
  ExecutorTransportError.make({ phase, message })

const executorFailure = (
  error: RunnerExecutorError | ExecutorTransportError | ExecutorFenceError,
  phase: ExecutorTransportError["phase"],
) => {
  if (Schema.is(ExecutorTransportError)(error) || Schema.is(ExecutorFenceError)(error)) return error
  if (error.kind === "duplicate") return fence("operation", error.message)
  if (error.kind === "missing") return fence("operation", error.message)
  return transport(phase, error.message)
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
): Effect.Effect<RunnerToolRequest, RunnerWorkspaceError> =>
  Schema.decodeUnknownEffect(GrepParameters)(input).pipe(
    Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid grep input" })),
    Effect.flatMap((parameters) =>
      pathFor(parameters.path ?? ".").pipe(
        Effect.map((root) => ({ _tag: "Grep" as const, parameters: { ...parameters, path: root } })),
      ),
    ),
  )

const webSearchRequest = (input: Schema.Json): Effect.Effect<RunnerToolRequest, RunnerWorkspaceError> =>
  Schema.decodeUnknownEffect(WebSearchParameters)(input).pipe(
    Effect.mapError(() => RunnerWorkspaceError.make({ kind: "operation", message: "Invalid web search input" })),
    Effect.map((parameters: WebSearchInput) => ({
      _tag: "WebSearch" as const,
      parameters:
        parameters.max_results === undefined
          ? { query: parameters.query }
          : { query: parameters.query, maxResults: parameters.max_results },
    })),
  )

const prepareRequest = (
  tool: string,
  input: Schema.Json,
  pathFor: (value: string) => Effect.Effect<string, RunnerWorkspaceError>,
) => {
  if (tool === "grep") return grepRequest(input, pathFor)
  if (tool === "web_search") return webSearchRequest(input)
  return nativeRequest(tool, input, pathFor)
}

const makeWorkspace = (
  options: RunnerWorkspaceOptions,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  executor: RunnerExecutorService,
): Effect.Effect<WorkspaceExecutorService, RunnerWorkspaceError> =>
  Effect.gen(function* () {
    if (!path.isAbsolute(options.checkout))
      return yield* RunnerWorkspaceError.make({ kind: "binding", message: "Runner checkout must be an absolute path" })
    if (options.binding.placement.workspaceId !== options.binding.workspaceId)
      return yield* RunnerWorkspaceError.make({
        kind: "binding",
        message: "Workspace binding identity mismatches placement",
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
    const reader = yield* filesystemWorkspaceReader({ checkout: rootReal, binding: options.binding }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => RunnerWorkspaceError.make({ kind: "binding", message: "Workspace reader is unavailable" })),
    )

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

    const handshake = (request: HandshakeRequest) => {
      if (!sameBinding(options.binding, request.binding))
        return Effect.fail(
          fence(
            bindingMismatchReason(options.binding, request.binding) ?? "generation",
            "Runner handshake binding does not match the assigned checkout",
          ),
        )
      return executor.handshake(request)
    }

    const dispatch = Effect.fn("RikaRunnerV2.Workspace.dispatch")(function* (
      intent: NativeOperationIntent,
      input: Schema.Json,
      handshakeEvidence: HandshakeEvidence,
    ): Effect.fn.Return<ExecutorEvidence, ExecutorTransportError | ExecutorFenceError> {
      if (!sameBinding(options.binding, intent.binding))
        return yield* fence(
          bindingMismatchReason(options.binding, intent.binding) ?? "generation",
          "Runner dispatch intent does not match the assigned checkout",
        )
      if (!sameEvidence(options.binding, handshakeEvidence))
        return yield* fence(
          bindingMismatchReason(options.binding, handshakeEvidence) ?? "generation",
          "Runner dispatch handshake is stale",
        )
      if (Pins.digest(input) !== intent.inputDigest)
        return yield* fence("input", "Runner dispatch input does not match the admitted digest")
      if (intent.tool === workspaceContextToolName) {
        const result = yield* handleWorkspaceContextRequest({ reader, binding: options.binding }, input).pipe(
          Effect.result,
        )
        if (result._tag === "Success") return evidenceFor(intent, { _tag: "Completed", result: result.success })
        const failure = yield* Schema.encodeEffect(WorkspaceReaderError)(result.failure).pipe(
          Effect.mapError(() => transport("before-dispatch", "Workspace context failure could not be encoded")),
        )
        return evidenceFor(intent, { _tag: "DomainFailure", failure })
      }
      if (!Object.hasOwn(toolkit.tools, intent.tool))
        return yield* fence("operation", `Runner dispatch does not recognize native tool ${intent.tool}`)
      const cached = yield* executor.receipt(intent.operationId)
      if (cached !== undefined) {
        if (
          cached.inputDigest !== intent.inputDigest ||
          cached.operationId !== intent.operationId ||
          !sameEvidence(intent.binding, cached.binding)
        )
          return yield* fence("operation", "Runner receipt does not match the dispatched operation")
        return cached
      }
      const prepared = yield* Effect.result(prepareRequest(intent.tool, input, pathFor))
      if (prepared._tag === "Failure")
        return yield* executor
          .reject(intent, failureFrom(intent.tool, prepared.failure))
          .pipe(Effect.mapError((error) => executorFailure(error, "before-dispatch")))
      const request = prepared.success
      yield* executor
        .register(intent, request)
        .pipe(Effect.mapError((error) => executorFailure(error, "before-dispatch")))
      return yield* executor.dispatch(intent, handshakeEvidence)
    })

    return {
      binding: options.binding,
      handshake,
      dispatch,
      receipt: executor.receipt,
      cancel: (operationId) =>
        executor.cancel(operationId).pipe(Effect.mapError((error) => executorFailure(error, "cancel"))),
    }
  })

export const makeLocalWorkspaceExecutor = (
  options: RunnerWorkspaceOptions,
): Effect.Effect<
  WorkspaceExecutorService,
  RunnerWorkspaceError,
  FileSystem.FileSystem | Path.Path | LocalRuntime.RunnerNativeRuntime | Search | RunnerGrep | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runtime = yield* LocalRuntime.RunnerNativeRuntime
    const search = yield* Search
    const grep = yield* RunnerGrep
    const mutationGate = yield* Semaphore.make(1)
    const workspaceWrites = yield* Semaphore.make(maxAdmittedOperations)
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
    const executor = yield* makeRunnerExecutor(
      {
        binding: options.binding,
        runtime,
        grep: grep.run,
        withExecution: (request, execution) => {
          if (request._tag === "Bash") return workspaceWrites.withPermits(maxAdmittedOperations)(execution)
          if (request._tag !== "Edit") return execution
          return workspaceWrites.withPermits(1)(
            writeGate(request.path).pipe(Effect.flatMap((gate) => gate.withPermits(1)(execution))),
          )
        },
      },
      search,
    )
    return yield* makeWorkspace(options, fileSystem, path, executor)
  })

const dependencies = (options: RunnerWorkspaceOptions) =>
  Layer.mergeAll(
    LocalRuntime.layer(options.checkout),
    grepLayer(options.checkout),
    searchProviderLayer(options.searchProvider ?? missingSearchProvider),
  )

export const localWorkspaceExecutorLayer = (options: RunnerWorkspaceOptions) =>
  Layer.effect(WorkspaceExecutor, makeLocalWorkspaceExecutor(options)).pipe(Layer.provide(dependencies(options)))

export type RunnerWorkspaceLayer<R = never> = Layer.Layer<
  ToolExecutor.ToolExecutor | Hooks.Hooks,
  RunnerWorkspaceError,
  | ToolContext.ToolContext
  | RunStore.RunStore
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | R
>

export const layerWithRoutes = <R = never>(
  options: RunnerWorkspaceOptions,
  additionalRoutes: ReadonlyArray<ToolPlacement.RouteInput<ToolContext.ToolContext | R>> = [],
): RunnerWorkspaceLayer<R> =>
  Layer.unwrap(
    makeLocalWorkspaceExecutor(options).pipe(
      Effect.map((workspace) => nativeToolExecutionLayer(workspace, additionalRoutes)),
    ),
  ).pipe(Layer.provide(dependencies(options)))

export const layer = (options: RunnerWorkspaceOptions): RunnerWorkspaceLayer => layerWithRoutes(options)

export const RunnerWorkspaceContract = {
  GrepParameters,
  RunnerWorkspaceError,
  inputDigest,
  layer,
  layerWithRoutes,
  localWorkspaceExecutorLayer,
  makeLocalWorkspaceExecutor,
  makeNativeOperationIntent,
  toolkit,
}
