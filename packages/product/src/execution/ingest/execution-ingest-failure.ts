import * as UsageEvent from "../../usage/usage-event"
import { Deferred, Effect, Schema } from "effect"
import type { Options } from "./execution-ingest-service"
import type { ProjectionFailure } from "../../usage/usage-event"
import type { Node, Pipeline } from "./execution-ingest-state"

export class IngestFailure extends Schema.TaggedErrorClass<IngestFailure>()("ExecutionIngestFailure", {
  message: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  executionId: Schema.String,
  reason: Schema.Literals(["cursor-rejected", "backend", "repository", "checkpoint", "attachment"]),
}) {}

export type Failure = IngestFailure | ProjectionFailure

export interface FailureDependencies {
  readonly options: Options
  readonly failedPipelines: Map<string, Failure>
  readonly wake: (pipeline: Pipeline) => void
}

export const make = (dependencies: FailureDependencies) => {
  const retain = (turnId: import("@rika/product/turn-record").TurnId, failure: Failure) => {
    const key = String(turnId)
    dependencies.failedPipelines.delete(key)
    dependencies.failedPipelines.set(key, failure)
    while (dependencies.failedPipelines.size > 128)
      dependencies.failedPipelines.delete(dependencies.failedPipelines.keys().next().value!)
  }
  const fail = (pipeline: Pipeline, node: Node, reason: IngestFailure["reason"], message: string) => {
    if (pipeline.failure !== undefined) return
    pipeline.stopped = true
    const failure = IngestFailure.make({
      message,
      threadId: String(pipeline.threadId),
      turnId: String(pipeline.turnId),
      executionId: node.executionId,
      reason,
    })
    pipeline.failure = failure
    retain(pipeline.turnId, failure)
    dependencies.options.onFailure?.(failure)
    for (const waiter of pipeline.flushWaiters) Deferred.doneUnsafe(waiter.deferred, Effect.fail(failure))
    pipeline.flushWaiters.length = 0
    Deferred.doneUnsafe(pipeline.rootCommitted, Effect.fail(failure))
    pipeline.rootSettled.openUnsafe()
    pipeline.abandoned.openUnsafe()
    dependencies.wake(pipeline)
  }
  const failProjection = (pipeline: Pipeline, failure: UsageEvent.ProjectionFailure) => {
    if (pipeline.failure !== undefined) return
    pipeline.stopped = true
    pipeline.failure = failure
    retain(pipeline.turnId, failure)
    dependencies.options.onFailure?.(failure)
    for (const waiter of pipeline.flushWaiters) Deferred.doneUnsafe(waiter.deferred, Effect.fail(failure))
    pipeline.flushWaiters.length = 0
    Deferred.doneUnsafe(pipeline.rootCommitted, Effect.fail(failure))
    pipeline.rootSettled.openUnsafe()
    pipeline.abandoned.openUnsafe()
    dependencies.wake(pipeline)
  }
  return { fail, failProjection }
}
