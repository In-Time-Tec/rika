import { NestedOperation, Session, ToolContext } from "tenetkit"
import { HostBindingRegistry, KernelPool, KernelStateStore } from "tenetkit/repl"
import { Context, Effect, Function, Layer, Option, Ref, Scope } from "effect"
import type { FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { BindingRequirements } from "./binding/binding-modules"
import * as KernelComposition from "./kernel-composition"

export type CellServices = ToolContext.ToolContext | NestedOperation.NestedOperations | Session.SessionStore

const ambient: Effect.Effect<Context.Context<never>> = Effect.gen(function* () {
  const toolContext = yield* Effect.serviceOption(ToolContext.ToolContext)
  const nested = yield* Effect.serviceOption(NestedOperation.NestedOperations)
  const session = yield* Effect.serviceOption(Session.SessionStore)
  let captured = Context.empty()
  if (toolContext._tag === "Some") captured = Context.add(captured, ToolContext.ToolContext, toolContext.value)
  if (nested._tag === "Some") captured = Context.add(captured, NestedOperation.NestedOperations, nested.value)
  if (session._tag === "Some") captured = Context.add(captured, Session.SessionStore, session.value)
  return captured
})

export interface CellContextInterface {
  readonly enter: (sessionId: string) => Effect.Effect<void, never, Scope.Scope>
  readonly resolve: (sessionId: string | undefined) => Effect.Effect<Option.Option<Context.Context<never>>>
}

export class CellContext extends Context.Service<CellContext, CellContextInterface>()(
  "@rika/kernel/executor-runtime/CellContext",
) {}

export const cellContextLayer: Layer.Layer<CellContext> = Layer.effect(
  CellContext,
  Effect.map(Ref.make(new Map<string, Context.Context<never>>()), (entries) =>
    CellContext.of({
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
  ),
)

const unavailable = (request: HostBindingRegistry.Request) => ({
  _tag: "CellContextUnavailable" as const,
  module: request.module,
  operation: request.operation,
  message: "the rika surface was called outside an executing cell, so this Session has no durable operation identity",
})

const bindImpl = (
  registry: HostBindingRegistry.Interface,
  calls: CellContextInterface,
): HostBindingRegistry.Interface => ({
  descriptors: registry.descriptors,
  resolve: registry.resolve,
  invoke: (request) =>
    Effect.flatMap(calls.resolve(request.sessionId), (captured) =>
      Option.isNone(captured)
        ? Effect.succeed({ _tag: "Failure" as const, failure: unavailable(request) })
        : registry.invoke(request).pipe(Effect.provideContext(captured.value)),
    ),
})

export const bind: {
  (calls: CellContextInterface): (registry: HostBindingRegistry.Interface) => HostBindingRegistry.Interface
  (registry: HostBindingRegistry.Interface, calls: CellContextInterface): HostBindingRegistry.Interface
} = Function.dual(2, bindImpl)

export type Services = KernelPool.KernelPool | KernelStateStore.KernelStateStore | CellContext

export interface Executor<Request, Response, Error> {
  readonly execute: (request: Request) => Effect.Effect<Response, Error>
}

export interface Options extends KernelComposition.Options {
  readonly trustMode: NonNullable<KernelComposition.Options["trustMode"]>
  readonly bindingServices: Layer.Layer<Exclude<BindingRequirements, CellServices>>
}

const mountingPlaceholders: Layer.Layer<CellServices> = Layer.mergeAll(
  ToolContext.layerDefault,
  NestedOperation.layerDirect,
  Session.layerMemory,
)

export const layer = (
  options: Options,
): Layer.Layer<Services, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> => {
  const calls = cellContextLayer
  const registry = Layer.effect(
    HostBindingRegistry.HostBindingRegistry,
    Effect.map(Effect.all([HostBindingRegistry.HostBindingRegistry, CellContext]), ([mounted, callContext]) =>
      bind(mounted, callContext),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        KernelComposition.bindings(options).pipe(
          Layer.provide(options.bindingServices),
          Layer.provide(mountingPlaceholders),
          Layer.orDie,
        ),
        calls,
      ),
    ),
  )
  return Layer.mergeAll(KernelComposition.pool(options).pipe(Layer.provide(registry)), calls)
}

export const buildLayer: {
  (scope: Scope.Scope): (options: Options) => ReturnType<typeof buildLayerImpl>
  (options: Options, scope: Scope.Scope): ReturnType<typeof buildLayerImpl>
} = Function.dual(2, (options: Options, scope: Scope.Scope) => buildLayerImpl(options, scope))

const buildLayerImpl = (options: Options, scope: Scope.Scope) => Layer.buildWithScope(layer(options), scope)
