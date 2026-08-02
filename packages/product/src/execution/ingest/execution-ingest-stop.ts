import { Function } from "effect"
import { Deferred, Effect } from "effect"
import type { Pipeline, Node } from "./execution-ingest-state"
import type { ProjectionChange } from "./execution-ingest-event"
import type { Failure } from "./execution-ingest-failure"

const finishImpl = (
  pipeline: Pipeline,
  publish: (pipeline: Pipeline, change: ProjectionChange) => void,
  fail: (pipeline: Pipeline, node: Node, reason: "checkpoint", message: string) => void,
  fullyConsumed: (nodes: ReadonlyMap<string, Node>) => boolean,
) => {
  if (pipeline.streamClosed) return
  if (pipeline.failure === undefined && !fullyConsumed(pipeline.nodes))
    fail(
      pipeline,
      pipeline.nodes.get(pipeline.rootKey)!,
      "checkpoint",
      `Turn ${pipeline.turnId} stopped before every execution reached a durable terminal outcome`,
    )
  pipeline.streamClosed = true
  if (pipeline.failure === undefined) {
    const root = pipeline.nodes.get(pipeline.rootKey)!
    publish(pipeline, {
      _tag: "ProjectionStopped",
      threadId: pipeline.threadId,
      rootTurnId: pipeline.turnId,
      streamId: pipeline.streamId,
      patchRevision: pipeline.patchRevision,
      status: root.status!,
    })
    return
  }
  publish(pipeline, {
    _tag: "ProjectionFailed",
    threadId: pipeline.threadId,
    rootTurnId: pipeline.turnId,
    streamId: pipeline.streamId,
    patchRevision: pipeline.patchRevision,
    failure: pipeline.failure as Failure,
  })
}

export const finish: {
  (
    arg1: (pipeline: Pipeline, change: ProjectionChange) => void,
    arg2: (pipeline: Pipeline, node: Node, reason: "checkpoint", message: string) => void,
    arg3: (nodes: ReadonlyMap<string, Node>) => boolean,
  ): (arg0: Pipeline) => ReturnType<typeof finishImpl>
  (
    arg0: Pipeline,
    arg1: (pipeline: Pipeline, change: ProjectionChange) => void,
    arg2: (pipeline: Pipeline, node: Node, reason: "checkpoint", message: string) => void,
    arg3: (nodes: ReadonlyMap<string, Node>) => boolean,
  ): ReturnType<typeof finishImpl>
} = Function.dual(4, finishImpl)

export const settle = (pipeline: Pipeline) =>
  Deferred.doneUnsafe(pipeline.finished, pipeline.failure === undefined ? Effect.void : Effect.fail(pipeline.failure))
