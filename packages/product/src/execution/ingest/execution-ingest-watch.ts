import * as Thread from "@rika/product/thread-record"
import { Cause, Effect, Queue, Scope, Schema, Stream } from "effect"
import * as IngestPatch from "./execution-projection-patch"
import type { Pipeline, Watcher } from "./execution-ingest-state"
import type { ProjectionChange } from "./execution-ingest-event"
import type * as IngestProjectionContract from "./execution-projection-contract"
import type * as IngestProjectionTypes from "./execution-projection-types"

export class ProjectionWatchOverflow extends Schema.TaggedErrorClass<ProjectionWatchOverflow>()(
  "ExecutionIngestProjectionWatchOverflow",
  { threadId: Schema.String, capacity: Schema.Int },
) {}

export interface ProjectionWatch {
  readonly snapshots: ReadonlyArray<IngestProjectionContract.Snapshot>
  readonly refolding: boolean
  readonly changes: Stream.Stream<ProjectionChange, ProjectionWatchOverflow>
}

export const make = (
  pipelines: ReadonlyMap<string, Pipeline>,
  watchCapacity: number,
): {
  readonly publish: (pipeline: Pipeline, change: ProjectionChange) => void
  readonly publishPatch: (
    pipeline: Pipeline,
    origin: IngestProjectionContract.ProjectionOrigin,
    visible: IngestProjectionTypes.VisibleDelta,
  ) => void
  readonly publishStarted: (pipeline: Pipeline) => void
  readonly watchThread: (threadId: Thread.ThreadId) => Effect.Effect<ProjectionWatch, never, Scope.Scope>
} => {
  const watchers = new Map<string, Map<number, Watcher>>()
  let nextWatcherId = 0
  const publish = (pipeline: Pipeline, change: ProjectionChange) => {
    const key = String(pipeline.threadId)
    const threadWatchers = watchers.get(key)
    if (threadWatchers === undefined) return
    for (const watcher of threadWatchers.values()) {
      if (Queue.offerUnsafe(watcher.queue, change)) continue
      threadWatchers.delete(watcher.id)
      Queue.failCauseUnsafe(
        watcher.queue,
        Cause.fail(ProjectionWatchOverflow.make({ threadId: key, capacity: watchCapacity })),
      )
    }
    if (threadWatchers.size === 0) watchers.delete(key)
  }
  const publishPatch = (
    pipeline: Pipeline,
    origin: IngestProjectionContract.ProjectionOrigin,
    visible: IngestProjectionTypes.VisibleDelta,
  ) => publish(pipeline, { _tag: "ProjectionPatched", patch: IngestPatch.patch(pipeline, origin, visible) })
  const publishStarted = (pipeline: Pipeline) =>
    publish(pipeline, { _tag: "ProjectionStarted", snapshot: IngestPatch.snapshot(pipeline) })
  const watchThread = (threadId: Thread.ThreadId) =>
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<ProjectionChange, ProjectionWatchOverflow | Cause.Done>(watchCapacity)
      const registration = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const id = nextWatcherId
          nextWatcherId += 1
          const key = String(threadId)
          const threadWatchers = watchers.get(key) ?? new Map<number, Watcher>()
          threadWatchers.set(id, { id, queue })
          watchers.set(key, threadWatchers)
          const threadPipelines = [...pipelines.values()].filter((pipeline) => pipeline.threadId === threadId)
          return {
            id,
            key,
            snapshots: threadPipelines.map(IngestPatch.snapshot),
            refolding: threadPipelines.some((pipeline) => pipeline.refolding),
          }
        }),
        ({ id, key }) =>
          Effect.sync(() => {
            const threadWatchers = watchers.get(key)
            threadWatchers?.delete(id)
            if (threadWatchers?.size === 0) watchers.delete(key)
          }).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid),
      )
      return { snapshots: registration.snapshots, refolding: registration.refolding, changes: Stream.fromQueue(queue) }
    })
  return { publish, publishPatch, publishStarted, watchThread }
}
