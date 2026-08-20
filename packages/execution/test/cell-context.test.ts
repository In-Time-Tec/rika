import { expect, it } from "@effect/vitest"
import { NestedOperation, ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { Context, Effect, Layer, Schema } from "effect"
import * as CellContext from "../src/cell-context"

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
    const calls = Context.get(yield* Layer.build(CellContext.layer), CellContext.Service)
    const bound = CellContext.bind(observingRegistry(observed), calls)
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
    const calls = Context.get(yield* Layer.build(CellContext.layer), CellContext.Service)
    const bound = CellContext.bind(observingRegistry(observed), calls)
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
    const calls = Context.get(yield* Layer.build(CellContext.layer), CellContext.Service)
    const bound = CellContext.bind(observingRegistry(observed), calls)
    const response = yield* bound.invoke(request("session-a"))
    expect(response._tag).toBe("Failure")
    if (response._tag === "Failure")
      expect((response.failure as { readonly message: string }).message).toContain("outside an executing cell")
    expect(observed).toEqual([])
  }).pipe(Effect.scoped),
)

it.effect("releases a Session's identity when its cell completes", () =>
  Effect.gen(function* () {
    const observed: Array<string> = []
    const calls = Context.get(yield* Layer.build(CellContext.layer), CellContext.Service)
    const bound = CellContext.bind(observingRegistry(observed), calls)
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
    const calls = Context.get(yield* Layer.build(CellContext.layer), CellContext.Service)
    const bound = CellContext.bind(registry, calls)
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

it("declares the Session identity the seam needs", () => {
  const shape = Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) })
  expect(Schema.is(shape)({ sessionId: "session-a" })).toBe(true)
})
