import { Function } from "effect"
import { Effect, Exit, Fiber, Queue, Scope } from "effect"
import type { Options } from "./execution-ingest-state"
import type { Node, Pipeline } from "./execution-ingest-state"

export interface LifecycleDependencies {
  readonly options: Options
  readonly pipelines: Map<string, Pipeline>
  readonly commit: (pipeline: Pipeline) => Effect.Effect<void, never>
  readonly startNode: (pipeline: Pipeline, node: Node) => void
  readonly wake: (pipeline: Pipeline) => void
  readonly finishReaders: (pipeline: Pipeline) => void
  readonly finishPipeline: (pipeline: Pipeline) => void
  readonly settlePipeline: (pipeline: Pipeline) => void
  readonly fail: (pipeline: Pipeline, node: Node, reason: "checkpoint", message: string) => void
}

const makeImpl = (
  dependencies: LifecycleDependencies,
  pipeline: Pipeline,
  pipelineScope: Scope.Closeable,
  commitWindow: import("effect").Duration.Input,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const committing = yield* Effect.forkChild(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.raceFirst(Effect.sleep(commitWindow), Queue.take(pipeline.wake))
          yield* dependencies.commit(pipeline)
        }
      }),
    )
    pipeline.active += 1
    pipeline.reading += 1
    const restored = pipeline.order.slice()
    for (const key of restored) {
      const node = pipeline.nodes.get(key)
      if (node !== undefined && (key === pipeline.rootKey || node.status === undefined))
        dependencies.startNode(pipeline, node)
    }
    pipeline.reading -= 1
    if (pipeline.reading <= 0) dependencies.wake(pipeline)
    pipeline.active -= 1
    dependencies.finishReaders(pipeline)
    yield* Effect.raceFirst(pipeline.readersFinished.await, pipeline.abandoned.await)
    yield* Fiber.interrupt(committing)
    yield* Scope.close(pipelineScope, Exit.void)
    pipeline.accepting = false
    yield* dependencies.commit(pipeline)
    if (
      pipeline.failure === undefined &&
      (pipeline.delta.units.size > 0 ||
        pipeline.delta.checkpoints.size > 0 ||
        pipeline.usagePending.length > 0 ||
        pipeline.usageRefoldFromVersion !== undefined ||
        pipeline.usageNotificationPending)
    )
      dependencies.fail(
        pipeline,
        pipeline.nodes.get(pipeline.rootKey)!,
        "checkpoint",
        `Turn ${pipeline.turnId} stopped before every accepted projection change became durable`,
      )
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => {
        dependencies.finishPipeline(pipeline)
        if (dependencies.pipelines.get(String(pipeline.turnId)) === pipeline)
          dependencies.pipelines.delete(String(pipeline.turnId))
        dependencies.settlePipeline(pipeline)
        if (pipeline.refolding)
          dependencies.options.onRefold?.({
            threadId: pipeline.threadId,
            rootTurnId: pipeline.turnId,
            phase: "finished",
          })
        const failure = pipeline.failure
        const logged =
          failure === undefined
            ? Effect.void
            : Effect.logWarning("execution.ingest.stopped").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": failure.threadId,
                  "rika.turn.id": failure.turnId,
                  "rika.execution.id": failure.executionId,
                  "rika.ingest.reason": failure.reason,
                  "rika.failure.cause": failure.message,
                }),
              )
        return logged.pipe(Effect.andThen(Scope.close(pipelineScope, Exit.void)))
      }),
    ),
  )

export const make: {
  (
    arg1: Pipeline,
    arg2: Scope.Closeable,
    arg3: import("effect").Duration.Input,
  ): (arg0: LifecycleDependencies) => ReturnType<typeof makeImpl>
  (
    arg0: LifecycleDependencies,
    arg1: Pipeline,
    arg2: Scope.Closeable,
    arg3: import("effect").Duration.Input,
  ): ReturnType<typeof makeImpl>
} = Function.dual(4, makeImpl)
