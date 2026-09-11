/* oxlint-disable effecttsgo/missing-pipeable-signature -- direct executor factory is a testable protocol seam; production uses runnerExecutorLayer. */

import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as NativeResult from "@rika/product/native-tool-result"
import * as NativeRuntime from "@rika/product/native-tool-runtime"
import * as Read from "@rika/product/read-file-tool"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Scope, Semaphore } from "effect"

import {
  ExecutorEvidence,
  ExecutorFenceError,
  ExecutorTransportError,
  HandshakeEvidence,
  HandshakeRequest,
  NativeOperationIntent,
  canonicalFromEvidence,
  evidenceFor,
  sameBinding,
  sameEvidence,
  type ExecutorCancellation,
  type ExecutorBoundary,
} from "@rika/execution"
import type { GrepParameters } from "@rika/execution/tools"

import { Search, SearchProviderError, SearchRequest } from "./search"
import type { SearchProvider, SearchResult } from "./search"
import { RunnerGrep } from "./grep"
import { RunnerGrepError } from "./errors"
import { RunnerNativeRuntime, type RunnerNativeRuntimeService } from "./native/runtime"

export type RunnerToolRequest =
  | Bash.Request
  | Read.Request
  | Edit.Request
  | { readonly _tag: "Grep"; readonly parameters: GrepParameters }
  | { readonly _tag: "WebSearch"; readonly parameters: SearchRequest }

export interface RunnerExecutorOptions {
  readonly binding: NativeOperationIntent["binding"]
  readonly runtime: RunnerNativeRuntimeService
  readonly grep: (parameters: GrepParameters) => Effect.Effect<NativeResult.Result, RunnerGrepError>
  readonly withExecution?: (
    request: RunnerToolRequest,
    execution: Effect.Effect<NativeResult.Result | SearchResult, RunnerOperationError>,
  ) => Effect.Effect<NativeResult.Result | SearchResult, RunnerOperationError>
}

type RunnerOperationError = NativeRuntime.ToolError | RunnerGrepError | SearchProviderError

export class RunnerExecutorError extends Schema.TaggedError<RunnerExecutorError>()("RikaRunnerV2ExecutorError", {
  kind: Schema.Literals(["duplicate", "missing", "closed"]),
  message: Schema.String,
}) {}

export interface RunnerExecutorService extends ExecutorBoundary {
  readonly register: (
    intent: NativeOperationIntent,
    request: RunnerToolRequest,
  ) => Effect.Effect<void, RunnerExecutorError>
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ExecutorCancellation, RunnerExecutorError | ExecutorTransportError | ExecutorFenceError>
  readonly reject: (
    intent: NativeOperationIntent,
    failure: Schema.Json,
  ) => Effect.Effect<ExecutorEvidence, RunnerExecutorError | ExecutorFenceError>
}

export class RunnerExecutor extends Context.Service<RunnerExecutor, RunnerExecutorService>()(
  "@rika/runner/executor/RunnerExecutor",
) {}

interface ActiveOperation {
  readonly completion: Deferred.Deferred<ExecutorEvidence>
  readonly intent: NativeOperationIntent
  readonly fiber: Fiber.Fiber<void, never>
}

const requestIdentity = (request: RunnerToolRequest): string => JSON.stringify(request)

const nativeToolFailure = (tool: string, message: string, outcome: "known" | "unknown"): NativeResult.ToolFailure => ({
  _tag: "ToolError",
  tool,
  message,
  kind: "operation",
  category: outcome === "unknown" ? "operation" : "dependency_unavailable",
  outcome,
  recovery: outcome === "unknown" ? "never" : "after_change",
  nextAction:
    outcome === "unknown"
      ? "Inspect workspace and process state before deciding whether another call is safe"
      : "Correct the provider or workspace condition and retry",
})

const failureValue = (tool: string, error: RunnerOperationError): NativeResult.ToolFailure => {
  if (Schema.is(NativeRuntime.ToolError)(error)) return error
  if (Schema.is(SearchProviderError)(error))
    return { ...nativeToolFailure(tool, error.message, "known"), category: searchFailureCategory(error.kind) }
  if (Schema.is(RunnerGrepError)(error))
    return { ...nativeToolFailure(tool, error.message, "known"), category: grepFailureCategory(error.kind) }
  return nativeToolFailure(tool, "The Runner operation failed without a typed result", "unknown")
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

const outcomeFromExit = (
  intent: NativeOperationIntent,
  tool: string,
  exit: import("effect").Exit.Exit<NativeResult.Result | SearchResult, RunnerOperationError>,
): ExecutorEvidence => {
  if (exit._tag === "Success") {
    const bytes = new TextEncoder().encode(JSON.stringify(exit.value)).byteLength
    if (bytes > NativeResult.maxOutputBytes)
      return evidenceFor(intent, {
        _tag: "DomainFailure",
        failure: {
          ...nativeToolFailure(tool, `${tool} result exceeds the retained output limit`, "known"),
          category: "operation",
        },
      })
    return evidenceFor(intent, { _tag: "Completed", result: exit.value })
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  if (failure !== undefined) return evidenceFor(intent, { _tag: "DomainFailure", failure: failureValue(tool, failure) })
  return evidenceFor(intent, {
    _tag: "Unknown",
    reason: "Runner operation was interrupted before a canonical result was retained",
  })
}

const requestToolName = (request: RunnerToolRequest): string => {
  switch (request._tag) {
    case "Bash":
      return "bash"
    case "Read":
      return "read"
    case "Edit":
      return "edit"
    case "Grep":
      return "grep"
    case "WebSearch":
      return "web_search"
  }
}

const runRequest = (
  options: RunnerExecutorOptions,
  search: SearchProvider,
  request: RunnerToolRequest,
): Effect.Effect<NativeResult.Result | SearchResult, RunnerOperationError> => {
  switch (request._tag) {
    case "Bash":
    case "Read":
    case "Edit":
      return options.runtime.run(request)
    case "Grep":
      return options.grep(request.parameters)
    case "WebSearch":
      return search.search(request.parameters)
  }
}

const transportFailure = (phase: "before-dispatch" | "after-dispatch", message: string) =>
  ExecutorTransportError.make({ phase, message })

const fenceFailure = (reason: ExecutorFenceError["reason"], message: string) =>
  ExecutorFenceError.make({ reason, message })

const makeService = (
  options: RunnerExecutorOptions,
  search: SearchProvider,
): Effect.Effect<RunnerExecutorService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope
    const requests = yield* Ref.make(
      new Map<string, { readonly intent: NativeOperationIntent; readonly request: RunnerToolRequest }>(),
    )
    const receipts = yield* Ref.make(new Map<string, ExecutorEvidence>())
    const active = yield* Ref.make(new Map<string, ActiveOperation>())
    const lock = yield* Semaphore.make(1)

    const settle = (
      operationId: string,
      evidence: ExecutorEvidence,
      completion?: Deferred.Deferred<ExecutorEvidence>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(receipts)
          if (current.has(operationId)) return
          yield* Ref.set(receipts, new Map(current).set(operationId, evidence))
          const inFlight = (yield* Ref.get(active)).get(operationId)
          if (inFlight !== undefined) {
            const next = new Map(yield* Ref.get(active))
            next.delete(operationId)
            yield* Ref.set(active, next)
          }
          if (completion !== undefined) yield* Deferred.succeed(completion, evidence)
        }),
      )
    const handshake = (
      request: HandshakeRequest,
    ): Effect.Effect<HandshakeEvidence, ExecutorTransportError | ExecutorFenceError> =>
      Effect.succeed({
        workspaceId: options.binding.workspaceId,
        assignmentId: options.binding.assignmentId,
        generation: options.binding.generation,
        placement: options.binding.placement,
        buildId: options.binding.buildId,
        protocolVersion: options.binding.protocolVersion,
      }).pipe(
        Effect.flatMap((evidence) =>
          sameBinding(options.binding, request.binding)
            ? Effect.succeed(evidence)
            : Effect.fail(fenceFailure("generation", "Runner handshake binding does not match checkout binding")),
        ),
      )

    const register = Effect.fn("RikaRunnerV2.Executor.register")(function* (
      intent: NativeOperationIntent,
      request: RunnerToolRequest,
    ) {
      if (requestToolName(request) !== intent.tool)
        return yield* RunnerExecutorError.make({
          kind: "duplicate",
          message: "Runner request tool does not match intent",
        })
      const encoded = requestIdentity(request)
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(requests)
          const existing = current.get(intent.operationId)
          if (existing !== undefined) {
            if (existing.intent.inputDigest === intent.inputDigest && requestIdentity(existing.request) === encoded)
              return
            return yield* RunnerExecutorError.make({
              kind: "duplicate",
              message: "Runner operation identity was registered with a different request",
            })
          }
          yield* Ref.set(requests, new Map(current).set(intent.operationId, { intent, request }))
        }),
      )
    })

    const dispatch = (
      intent: NativeOperationIntent,
      evidence: HandshakeEvidence,
    ): Effect.Effect<ExecutorEvidence, ExecutorTransportError | ExecutorFenceError> =>
      Effect.gen(function* () {
        if (!sameEvidence(options.binding, evidence))
          return yield* fenceFailure("generation", "Runner dispatch uses a stale checkout binding")
        if (!sameBinding(options.binding, intent.binding))
          return yield* fenceFailure("generation", "Runner dispatch intent uses a stale checkout binding")
        const cached = (yield* Ref.get(receipts)).get(intent.operationId)
        if (cached !== undefined) {
          if (cached.inputDigest !== intent.inputDigest || !sameEvidence(intent.binding, cached.binding))
            return yield* fenceFailure("operation", "Runner receipt identity does not match dispatch intent")
          return cached
        }
        const registered = (yield* Ref.get(requests)).get(intent.operationId)
        if (registered === undefined)
          return yield* transportFailure(
            "after-dispatch",
            "Runner has no request payload for this admitted operation; reconcile instead of redispatching",
          )
        if (registered.intent.inputDigest !== intent.inputDigest || registered.intent.tool !== intent.tool)
          return yield* transportFailure("before-dispatch", "Runner request does not match the admitted operation")

        const completion = yield* Deferred.make<ExecutorEvidence>()
        const operation = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(active)
            const inFlight = current.get(intent.operationId)
            if (inFlight !== undefined) return inFlight
            const execution = runRequest(options, search, registered.request)
            const fiber = yield* Effect.forkIn(
              Effect.exit(options.withExecution?.(registered.request, execution) ?? execution).pipe(
                Effect.map((exit) => outcomeFromExit(intent, requestToolName(registered.request), exit)),
                Effect.tap((result) => settle(intent.operationId, result, completion)),
                Effect.asVoid,
              ),
              ownerScope,
            )
            const nextOperation: ActiveOperation = { completion, intent, fiber }
            yield* Ref.set(active, new Map(current).set(intent.operationId, nextOperation))
            return undefined
          }),
        )
        if (operation !== undefined) return yield* Deferred.await(operation.completion)
        return yield* Deferred.await(completion)
      })

    const receipt = (operationId: string) => Ref.get(receipts).pipe(Effect.map((current) => current.get(operationId)))

    const reject = (intent: NativeOperationIntent, failure: Schema.Json) =>
      Effect.gen(function* () {
        if (!sameBinding(options.binding, intent.binding))
          return yield* fenceFailure("generation", "Runner rejection uses a stale checkout binding")
        const cached = (yield* Ref.get(receipts)).get(intent.operationId)
        if (cached !== undefined) {
          if (cached.inputDigest !== intent.inputDigest || !sameEvidence(intent.binding, cached.binding))
            return yield* fenceFailure("operation", "Runner receipt identity does not match rejected intent")
          return cached
        }
        const evidence = evidenceFor(intent, { _tag: "DomainFailure", failure })
        yield* settle(intent.operationId, evidence)
        return evidence
      })

    const cancel = (
      operationId: string,
    ): Effect.Effect<ExecutorCancellation, RunnerExecutorError | ExecutorTransportError | ExecutorFenceError> =>
      Effect.gen(function* () {
        const inFlight = (yield* Ref.get(active)).get(operationId)
        if (inFlight !== undefined) {
          const unknown = evidenceFor(inFlight.intent, {
            _tag: "Unknown",
            reason: "Runner operation was cancelled before a canonical result was retained",
          })
          yield* Fiber.interrupt(inFlight.fiber)
          yield* settle(operationId, unknown, inFlight.completion)
          return { _tag: "Cancelled" as const }
        }
        const result = (yield* Ref.get(receipts)).get(operationId)
        if (result !== undefined) {
          const registered = (yield* Ref.get(requests)).get(operationId)
          const original = registered?.intent ?? {
            operationId,
            tool: "unknown",
            inputDigest: result.inputDigest,
            binding: options.binding,
          }
          return {
            _tag: "AlreadyTerminal" as const,
            result: canonicalFromEvidence(original, result),
          }
        }
        return yield* RunnerExecutorError.make({
          kind: "missing",
          message: `Runner has no active operation ${operationId}`,
        })
      })

    return { handshake, dispatch, receipt, register, cancel, reject }
  })

export const makeRunnerExecutor = (options: RunnerExecutorOptions, search: SearchProvider) =>
  makeService(options, search)

export const runnerExecutorLayer = (
  options: Pick<RunnerExecutorOptions, "binding">,
): Layer.Layer<RunnerExecutor, never, RunnerNativeRuntime | Search | RunnerGrep> =>
  Layer.effect(
    RunnerExecutor,
    Effect.gen(function* () {
      const runtime = yield* RunnerNativeRuntime
      const search = yield* Search
      const grep = yield* RunnerGrep
      return yield* makeService({ ...options, runtime, grep: grep.run }, search)
    }),
  )
