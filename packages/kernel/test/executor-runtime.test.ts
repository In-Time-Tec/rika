import { expect, it } from "@effect/vitest"
import { Approvals, NestedOperation, Session, ToolContext } from "tenetkit"
import { HarnessStore } from "tenetkit/harness"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { GoalService } from "@rika/product/goal-service"
import * as ThreadQuery from "@rika/product/thread-query-service"
import { Context, Effect, Layer, Schema } from "effect"
import * as ExecutorRuntime from "../src/executor-runtime"
import { ArtifactStore } from "../src/binding/artifact/store"

const toolContext = (sessionId: string, operationKey: string): ToolContext.Interface =>
  ToolContext.ToolContext.of({
    signal: new AbortController().signal,
    emit: () => Effect.void,
    sessionId,
    runId: `run-${sessionId}`,
    toolCallId: `call-${sessionId}`,
    operationKey,
  })

/** A registry whose one operation reports the identity its handler actually observed. */
const observingRegistry = (observed: Array<string>): HostBindingRegistry.Interface => ({
  descriptors: [{ module: "probe", operations: ["identity"] }],
  resolve: () => Effect.die("unused"),
  invoke: () =>
    Effect.map(Effect.serviceOption(ToolContext.ToolContext), (context) => {
      const seen = context._tag === "Some" ? `${context.value.sessionId}:${context.value.operationKey}` : "none"
      observed.push(seen)
      return { _tag: "Success" as const, output: seen }
    }),
})

const request = (sessionId: string): HostBindingRegistry.Request => ({
  module: "probe",
  operation: "identity",
  input: {},
  sessionId,
})

it.effect("answers each Session's binding request under that Session's own cell identity", () =>
  Effect.gen(function* () {
    const observed: Array<string> = []
    const calls = Context.get(yield* Layer.build(ExecutorRuntime.cellContextLayer), ExecutorRuntime.CellContext)
    const bound = ExecutorRuntime.bind(observingRegistry(observed), calls)
    // Two Sessions each enter with their own identity, exactly as two concurrent cells would.
    yield* Effect.scoped(
      calls
        .enter("session-a")
        .pipe(
          Effect.andThen(bound.invoke(request("session-a"))),
          Effect.provideService(ToolContext.ToolContext, toolContext("session-a", "operation-a")),
        ),
    )
    yield* Effect.scoped(
      calls
        .enter("session-b")
        .pipe(
          Effect.andThen(bound.invoke(request("session-b"))),
          Effect.provideService(ToolContext.ToolContext, toolContext("session-b", "operation-b")),
        ),
    )
    expect(observed).toEqual(["session-a:operation-a", "session-b:operation-b"])
  }).pipe(Effect.scoped),
)

it.effect("never answers one Session's request under another Session's identity", () =>
  Effect.gen(function* () {
    const observed: Array<string> = []
    const calls = Context.get(yield* Layer.build(ExecutorRuntime.cellContextLayer), ExecutorRuntime.CellContext)
    const bound = ExecutorRuntime.bind(observingRegistry(observed), calls)
    yield* Effect.scoped(
      calls.enter("session-a").pipe(
        Effect.andThen(
          // While a's cell is live, b raises a request. It must NOT be answered as a.
          bound.invoke(request("session-b")),
        ),
        Effect.provideService(ToolContext.ToolContext, toolContext("session-a", "operation-a")),
      ),
    )
    expect(observed).toEqual([])
  }).pipe(Effect.scoped),
)

it.effect("refuses a binding request raised outside any executing cell", () =>
  Effect.gen(function* () {
    const observed: Array<string> = []
    const calls = Context.get(yield* Layer.build(ExecutorRuntime.cellContextLayer), ExecutorRuntime.CellContext)
    const bound = ExecutorRuntime.bind(observingRegistry(observed), calls)
    const response = yield* bound.invoke(request("session-a"))
    expect(response._tag).toBe("Failure")
    if (response._tag === "Failure")
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ message: Schema.String }))(response.failure)).message,
      ).toContain("outside an executing cell")
    expect(observed).toEqual([])
  }).pipe(Effect.scoped),
)

it.effect("releases a Session's identity when its cell completes", () =>
  Effect.gen(function* () {
    const observed: Array<string> = []
    const calls = Context.get(yield* Layer.build(ExecutorRuntime.cellContextLayer), ExecutorRuntime.CellContext)
    const bound = ExecutorRuntime.bind(observingRegistry(observed), calls)
    yield* Effect.scoped(
      calls
        .enter("session-a")
        .pipe(Effect.provideService(ToolContext.ToolContext, toolContext("session-a", "operation-a"))),
    )
    const afterCell = yield* bound.invoke(request("session-a"))
    expect(afterCell._tag).toBe("Failure")
  }).pipe(Effect.scoped),
)

it.effect("carries the cell's nested-operation journal and Session store to the handler", () =>
  Effect.gen(function* () {
    const kinds: Array<string> = []
    const registry: HostBindingRegistry.Interface = {
      descriptors: [{ module: "probe", operations: ["journal"] }],
      resolve: () => Effect.die("unused"),
      invoke: () =>
        Effect.gen(function* () {
          const journal = yield* Effect.serviceOption(NestedOperation.NestedOperations)
          const context = yield* Effect.serviceOption(ToolContext.ToolContext)
          if (journal._tag === "None" || context._tag === "None")
            return { _tag: "Failure" as const, failure: "no-journal" }
          return yield* journal.value
            .run({ kind: "probe.write", payload: {}, replayPolicy: "never" }, Effect.succeed("written"))
            .pipe(
              Effect.map((output) => ({ _tag: "Success" as const, output })),
              Effect.provideService(ToolContext.ToolContext, context.value),
              Effect.catchCause(() => Effect.succeed({ _tag: "Failure" as const, failure: "journal-failed" })),
            )
        }),
    }
    const calls = Context.get(yield* Layer.build(ExecutorRuntime.cellContextLayer), ExecutorRuntime.CellContext)
    const bound = ExecutorRuntime.bind(registry, calls)
    const journal = NestedOperation.NestedOperations.of({
      run: (input, effect) => {
        kinds.push(input.kind)
        return effect
      },
    })
    const response = yield* Effect.scoped(
      calls
        .enter("session-a")
        .pipe(
          Effect.andThen(bound.invoke({ module: "probe", operation: "journal", input: {}, sessionId: "session-a" })),
          Effect.provideService(ToolContext.ToolContext, toolContext("session-a", "operation-a")),
          Effect.provideService(NestedOperation.NestedOperations, journal),
        ),
    )
    expect(response._tag).toBe("Success")
    expect(kinds).toEqual(["probe.write"])
  }).pipe(Effect.scoped),
)

it.effect("captures the exact per-cell authority objects without reconstructing them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const codingTools = CodingToolRuntime.Service.of({ run: () => Effect.die("unused") })
      const processes = ShellProcessRegistry.Service.of({
        start: () => Effect.die("unused"),
        poll: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      })
      const threads = ThreadQuery.Factory.of({ forWorkspace: () => Effect.die("unused") })
      const mcp = McpRuntime.McpRuntimeService.of({ connect: () => Effect.die("unused") })
      const harness = Context.get(yield* Layer.build(HarnessStore.layerMemory), HarnessStore.HarnessStore)
      const context = toolContext("session-a", "operation-a")
      const nested = NestedOperation.NestedOperations.of({ run: (_request, effect) => effect })
      const session = Context.get(yield* Layer.build(Session.layerMemory), Session.SessionStore)
      const approvals = Approvals.Approvals.of({ resolve: (pending) => Effect.succeed(pending) })
      const goals = GoalService.of({
        get: () => Effect.die("unused"),
        create: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        recordTurn: () => Effect.die("unused"),
        continuation: () => Effect.die("unused"),
      })
      const artifacts = ArtifactStore.of({
        put: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
      })
      const authority = Context.make(CodingToolRuntime.Service, codingTools).pipe(
        Context.add(ShellProcessRegistry.Service, processes),
        Context.add(ThreadQuery.Factory, threads),
        Context.add(McpRuntime.McpRuntimeService, mcp),
        Context.add(HarnessStore.HarnessStore, harness),
        Context.add(Session.SessionStore, session),
        Context.add(GoalService, goals),
        Context.add(ArtifactStore, artifacts),
        Context.add(NestedOperation.NestedOperations, nested),
        Context.add(ToolContext.ToolContext, context),
        Context.add(Approvals.Approvals, approvals),
      )
      const captured = yield* ExecutorRuntime.capture.pipe(Effect.provide(authority))

      expect(Context.get(captured, CodingToolRuntime.Service)).toBe(codingTools)
      expect(Context.get(captured, ShellProcessRegistry.Service)).toBe(processes)
      expect(Context.get(captured, ThreadQuery.Factory)).toBe(threads)
      expect(Context.get(captured, McpRuntime.McpRuntimeService)).toBe(mcp)
      expect(Context.get(captured, HarnessStore.HarnessStore)).toBe(harness)
      expect(Context.get(captured, ToolContext.ToolContext)).toBe(context)
      expect(Context.get(captured, NestedOperation.NestedOperations)).toBe(nested)
      expect(Context.get(captured, Session.SessionStore)).toBe(session)
      expect(Context.get(captured, Approvals.Approvals)).toBe(approvals)
      expect(Context.get(captured, GoalService)).toBe(goals)
      expect(Context.get(captured, ArtifactStore)).toBe(artifacts)
    }),
  ),
)

it("declares the Session identity the seam needs", () => {
  const sessionIdentity = Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) })
  expect(Schema.is(sessionIdentity)({ sessionId: "session-a" })).toBe(true)
})
