import { expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { Response } from "effect/unstable/ai"
import { NestedOperation, ToolContext, ToolExecutor } from "generalist"
import * as RemoteTools from "../../src/remote-tools"
import { remoteToolExecutor } from "../../src/routing/route-tools"

const toolCall = (name: string, params: Readonly<Record<string, string>>) =>
  Schema.decodeSync(Response.ToolCallPart(name, Schema.Unknown))({
    type: "tool-call",
    id: `call-${name}`,
    name,
    params,
    providerExecuted: false,
  })

const request = (name: string, params: Readonly<Record<string, string>>): ToolExecutor.Request => {
  const call = toolCall(name, params)
  return {
    call,
    toolCallBatch: { calls: [call] },
    turn: 2,
    toolCallIndex: 0,
    agentName: "rika-root",
    sessionId: "thread-one",
  }
}

const contextLayer = ToolContext.layerTest({
  signal: new AbortController().signal,
  emit: () => Effect.succeed(true),
  sessionId: "thread-one",
  runId: "run-one",
  rootRunId: "run-one",
  toolCallId: "call-read",
  operationKey: "operation-one",
  attempt: 3,
})

it.effect("routes a native call through the durable remote operation identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen: Array<RemoteTools.Request> = []
      const remote = RemoteTools.layer({
        execute: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { _tag: "Success" as const, result: { text: "1:hello", truncated: false } }
          }),
        cancel: () => Effect.succeed({ _tag: "Cancelled" as const }),
      })
      const layer = remoteToolExecutor({
        route: remote,
        workspace: "workspace-one",
        executionIdentity: { threadId: "thread-one", turnId: "turn-one" },
      })
      const built = yield* Layer.build(layer)
      const executor = Context.get(built, ToolExecutor.ToolExecutor)
      const toolContext = yield* Layer.build(contextLayer)
      const execution = request("read", { path: "README.md" })
      const outcome = yield* executor.execute(execution).pipe(Effect.provide(toolContext))

      expect(outcome).toMatchObject({ _tag: "Success", result: { text: "1:hello", truncated: false } })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({
        operationKey: "operation-one",
        workspaceId: "workspace-one",
        sessionId: "thread-one",
        threadId: "thread-one",
        turnId: "turn-one",
        runId: "run-one",
        rootRunId: "run-one",
        toolCallId: "call-read",
        toolName: "read",
        request: { _tag: "Read", path: "README.md" },
        attempt: 3,
        replayPolicy: "provider-idempotent",
      })
      expect(executor.replayPolicy?.(execution)).toBe("provider-idempotent")
      expect(executor.cancellable?.(execution)).toBe(true)
    }),
  ),
)

it.effect("returns exact remote cancellation and retained terminal outcomes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let terminal = false
      const remote = RemoteTools.layer({
        execute: () => Effect.die("unused"),
        cancel: () =>
          terminal
            ? Effect.succeed({
                _tag: "AlreadyTerminal" as const,
                response: { _tag: "Success" as const, result: { text: "done", truncated: false } },
              })
            : Effect.succeed({ _tag: "Cancelled" as const }),
      })
      const built = yield* Layer.build(
        remoteToolExecutor({
          route: remote,
          workspace: "workspace-one",
          executionIdentity: { threadId: "thread-one", turnId: "turn-one" },
        }),
      )
      const executor = Context.get(built, ToolExecutor.ToolExecutor)
      const toolContext = yield* Layer.build(contextLayer)
      const execution = request("read", { path: "README.md" })
      const cancellation = {
        execution,
        operationKey: "operation-one",
        attempt: 3,
        sessionId: "thread-one",
        runId: "run-one",
        rootRunId: "run-one",
        toolCallId: "call-read",
        toolName: "read",
      }
      expect(yield* executor.cancel!(cancellation).pipe(Effect.provide(toolContext))).toEqual({ _tag: "Cancelled" })
      terminal = true
      expect(yield* executor.cancel!(cancellation).pipe(Effect.provide(toolContext))).toEqual({
        _tag: "AlreadyTerminal",
        outcome: {
          _tag: "Success",
          result: { text: "done", truncated: false },
          encodedResult: { text: "done", truncated: false },
        },
      })
    }),
  ),
)

it.effect("parks an explicit remote unknown in a never-replay nested marker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const markers: Array<{
        readonly kind: string
        readonly payload: unknown
        readonly replayPolicy: NestedOperation.ReplayPolicy
      }> = []
      const remote = RemoteTools.layer({
        execute: () => RemoteTools.UnknownOutcome.make({ message: "receipt was not observed" }),
        cancel: () => Effect.die("unused"),
      })
      const built = yield* Layer.build(
        remoteToolExecutor({
          route: remote,
          workspace: "workspace-one",
          executionIdentity: { threadId: "thread-one", turnId: "turn-one" },
        }),
      )
      const executor = Context.get(built, ToolExecutor.ToolExecutor)
      const toolContext = yield* Layer.build(contextLayer)
      const runNested: NestedOperation.Service["run"] = (marker, effect) => {
        markers.push({ kind: marker.kind, payload: marker.payload, replayPolicy: marker.replayPolicy })
        return effect
      }
      const services = Context.add(
        toolContext,
        NestedOperation.Operations,
        NestedOperation.Operations.of({ run: runNested }),
      )
      const exit = yield* Effect.exit(
        executor.execute(request("read", { path: "README.md" })).pipe(Effect.provide(services)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "generalist/core/FrameworkFailure",
          stage: "placement",
          tool: "read",
          message: "Remote tool outcome is unknown: receipt was not observed",
        })
      }
      expect(markers).toHaveLength(1)
      expect(markers[0]).toMatchObject({
        kind: "rika-native-tool-terminal-unknown",
        replayPolicy: "never",
        payload: {
          sourceOperationKey: "operation-one",
          toolCallId: "call-read",
          toolName: "read",
        },
      })
    }),
  ),
)

it.effect("returns a typed failure when an unknown outcome has no Generalist operation host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const remote = RemoteTools.layer({
        execute: () => RemoteTools.UnknownOutcome.make({ message: "receipt was not observed" }),
        cancel: () => Effect.die("unused"),
      })
      const built = yield* Layer.build(
        remoteToolExecutor({
          route: remote,
          workspace: "workspace-one",
          executionIdentity: { threadId: "thread-one", turnId: "turn-one" },
        }),
      )
      const executor = Context.get(built, ToolExecutor.ToolExecutor)
      const toolContext = yield* Layer.build(contextLayer)
      const failure = yield* executor
        .execute(request("read", { path: "README.md" }))
        .pipe(Effect.provide(toolContext), Effect.flip)

      expect(failure).toMatchObject({
        _tag: "generalist/core/FrameworkFailure",
        stage: "placement",
        tool: "read",
        message: "Generalist nested-operation host is unavailable: receipt was not observed",
      })
    }),
  ),
)

it.effect("reports cancellation-time ambiguity as an already-terminal unknown outcome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const remote = RemoteTools.layer({
        execute: () => Effect.die("unused"),
        cancel: () => RemoteTools.UnknownOutcome.make({ message: "cancellation receipt was not observed" }),
      })
      const built = yield* Layer.build(
        remoteToolExecutor({
          route: remote,
          workspace: "workspace-one",
          executionIdentity: { threadId: "thread-one", turnId: "turn-one" },
        }),
      )
      const executor = Context.get(built, ToolExecutor.ToolExecutor)
      const toolContext = yield* Layer.build(contextLayer)
      const execution = request("read", { path: "README.md" })
      expect(
        yield* executor.cancel!({
          execution,
          operationKey: "operation-one",
          attempt: 3,
          sessionId: "thread-one",
          runId: "run-one",
          rootRunId: "run-one",
          toolCallId: "call-read",
          toolName: "read",
        }).pipe(Effect.provide(toolContext)),
      ).toEqual({
        _tag: "AlreadyTerminal",
        outcome: {
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "cancellation receipt was not observed" },
          encodedFailure: { kind: "unknown", message: "cancellation receipt was not observed" },
        },
      })
    }),
  ),
)
