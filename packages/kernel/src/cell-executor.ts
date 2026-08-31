import { Cell, HostBindings, KernelPool } from "generalist/repl"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Composition from "./kernel-composition"
import * as KernelBootstrap from "./kernel-bootstrap"

export interface Request {
  readonly sessionId: string
  readonly cellId: string
  readonly code: string
  readonly emit?: (event: Cell.CellEvent) => Effect.Effect<void>
}

export type Response =
  | { readonly _tag: "Success"; readonly result: Cell.CellResult }
  | { readonly _tag: "DomainFailure"; readonly failure: typeof Cell.CellFailure.Encoded }

export interface Interface {
  readonly execute: (request: Request) => Effect.Effect<Response>
  readonly restart: (sessionId: string) => Effect.Effect<void>
}

export class CellExecutor extends Context.Service<CellExecutor, Interface>()(
  "@rika/kernel/cell-executor/CellExecutor",
) {}

const make = (pool: KernelPool.Service, modules: ReadonlyArray<string>): Interface => ({
  execute: (request) => {
    const emit = request.emit ?? (() => Effect.void)
    return pool
      .execute({
        sessionId: request.sessionId,
        cellId: request.cellId,
        code: `${KernelBootstrap.source(modules)}\n${request.code}`,
      })
      .pipe(
        Effect.flatMap((execution) =>
          Effect.all([Stream.runForEach(execution.events, emit), execution.result], { concurrency: 2 }).pipe(
            Effect.map(([, result]) => result),
          ),
        ),
        Effect.match({
          onFailure: (failure) => ({
            _tag: "DomainFailure" as const,
            failure: Schema.encodeSync(Cell.CellFailure)(failure),
          }),
          onSuccess: (result) => ({ _tag: "Success" as const, result }),
        }),
        Effect.scoped,
      )
  },
  restart: (sessionId) => pool.restart(sessionId, "profile-changed").pipe(Effect.asVoid, Effect.orDie),
})

export interface Options extends Composition.Options {
  readonly registry: Layer.Layer<HostBindings.HostBindings>
}

export const layer = (options: Options) =>
  Layer.effect(
    CellExecutor,
    Effect.map(Effect.all([KernelPool.KernelPool, HostBindings.HostBindings]), ([pool, registry]) =>
      make(
        pool,
        registry.descriptors.map((descriptor) => descriptor.module),
      ),
    ),
  ).pipe(
    Layer.provide(
      Layer.merge(
        Composition.pool({ ...options, bootstrap: false }).pipe(Layer.provide(options.registry)),
        options.registry,
      ),
    ),
  )
