import { NestedOperation, Session, ToolContext } from "@batonfx/core"
import { Runtime } from "@batonfx/runtime"
import type { HostBindingRegistry } from "@batonfx/repl"
import { Context, Effect, Function, Layer, Option, Ref, Scope } from "effect"

/**
 * The per-call services one executing cell owns: its durable operation identity and cancellation
 * signal, its nested-operation journal, the Session its history reads from, and the durable Runtime
 * its `agents` calls act through.
 *
 * The mounted binding surface is built once and shared by every Session a pool serves, so these
 * cannot be closed over when the surface is built. A cell registers them for the duration of its
 * own execution and the binding seam resolves them per request.
 *
 * The Runtime is here rather than read from the tool's own context because Baton hosts a tool with
 * `ChildRuns` and `NestedOperations` and never with the Runtime, so a cell that asked for it
 * ambiently would find nothing. The cell route supplies it around each call instead.
 */
export type CellServices =
  | ToolContext.ToolContext
  | NestedOperation.NestedOperations
  | Session.SessionStore
  | Runtime.Runtime

const ambient: Effect.Effect<Context.Context<never>, never, never> = Effect.gen(function* () {
  const toolContext = yield* Effect.serviceOption(ToolContext.ToolContext)
  const nested = yield* Effect.serviceOption(NestedOperation.NestedOperations)
  const session = yield* Effect.serviceOption(Session.SessionStore)
  const runtime = yield* Effect.serviceOption(Runtime.Runtime)
  let captured = Context.empty()
  if (toolContext._tag === "Some") captured = Context.add(captured, ToolContext.ToolContext, toolContext.value)
  if (nested._tag === "Some") captured = Context.add(captured, NestedOperation.NestedOperations, nested.value)
  if (session._tag === "Some") captured = Context.add(captured, Session.SessionStore, session.value)
  if (runtime._tag === "Some") captured = Context.add(captured, Runtime.Runtime, runtime.value)
  return captured
})

export interface Interface {
  readonly enter: (sessionId: string) => Effect.Effect<void, never, Scope.Scope>
  readonly resolve: (sessionId: string | undefined) => Effect.Effect<Option.Option<Context.Context<never>>>
}

export class CellCallContext extends Context.Service<CellCallContext, Interface>()(
  "@rika/baton-execution/baton-cell-call-context/CellCallContext",
) {}

/**
 * One entry per Session rather than per cell: the kernel runs cells exclusively and in authored
 * order for a Session, so at most one cell of a Session is ever executing.
 */
const make: Effect.Effect<Interface> = Effect.map(Ref.make(new Map<string, Context.Context<never>>()), (entries) =>
  CellCallContext.of({
    enter: (sessionId) =>
      Effect.flatMap(ambient, (captured) =>
        Ref.update(entries, (current) => new Map(current).set(sessionId, captured)).pipe(
          Effect.andThen(
            Effect.addFinalizer(() =>
              Ref.update(entries, (current) => {
                const next = new Map(current)
                next.delete(sessionId)
                return next
              }),
            ),
          ),
        ),
      ),
    resolve: (sessionId) =>
      sessionId === undefined
        ? Effect.succeedNone
        : Effect.map(Ref.get(entries), (current) => Option.fromNullishOr(current.get(sessionId))),
  }),
)

export const layer: Layer.Layer<CellCallContext> = Layer.effect(CellCallContext, make)

const unavailable = (request: HostBindingRegistry.Request) => ({
  _tag: "CellContextUnavailable" as const,
  module: request.module,
  operation: request.operation,
  message: "the rika surface was called outside an executing cell, so this Session has no durable operation identity",
})

/**
 * Answer every binding request under the identity of the cell that raised it.
 *
 * A request whose Session has no live cell is refused rather than answered under whichever identity
 * happened to be captured when the surface was mounted: a wrong thread id, a stale operation key, or
 * a dead cancellation signal would corrupt the durable journal instead of failing.
 */
const bindCallsImpl = (registry: HostBindingRegistry.Interface, calls: Interface): HostBindingRegistry.Interface => ({
  descriptors: registry.descriptors,
  resolve: registry.resolve,
  invoke: (request) =>
    Effect.flatMap(calls.resolve(request.sessionId), (captured) =>
      Option.isNone(captured)
        ? Effect.succeed({ _tag: "Failure" as const, failure: unavailable(request) })
        : registry.invoke(request).pipe(Effect.provideContext(captured.value)),
    ),
})

export const bindCalls: {
  (calls: Interface): (registry: HostBindingRegistry.Interface) => HostBindingRegistry.Interface
  (registry: HostBindingRegistry.Interface, calls: Interface): HostBindingRegistry.Interface
} = Function.dual(2, bindCallsImpl)
