import { Cell, KernelPool } from "tenetkit/repl"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Composition from "./kernel-composition"

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
}

export class CellExecutor extends Context.Service<CellExecutor, Interface>()(
  "@rika/kernel/cell-executor/CellExecutor",
) {}

export const make = (pool: KernelPool.Interface): Interface => ({
  execute: (request) => {
    const emit = request.emit ?? (() => Effect.void)
    return Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        pool
          .execute({
            sessionId: request.sessionId,
            cellId: request.cellId,
            code: request.code,
            signal: controller.signal,
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
          ),
      (controller) => Effect.sync(() => controller.abort()),
    )
  },
})

export const layer = (options: Composition.Options) =>
  Layer.effect(CellExecutor, Effect.map(KernelPool.KernelPool, make)).pipe(
    Layer.provide(Composition.pool({ ...options, bootstrap: false })),
  )
