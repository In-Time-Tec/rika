import { interactiveEventThreadId, type ServerFrame } from "@rika/product/client-protocol"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { ThreadId } from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import { Effect, Schema } from "effect"
import { HostedError } from "../contract"
import type { PhysicalConnection } from "./connection"
import { AttachmentProjection, type Preview, type Projection, type Snapshot } from "./projection"

type Payload = ServerFrame["payload"]
const { encodeThreadView } = AttachmentProjection

export const interactiveSessionEvents = (dependencies: {
  readonly activePreviews: Map<string, Preview>
  readonly currentFrame: (connection: PhysicalConnection) => boolean
  readonly selectedFrame: (threadId: string) => boolean
  readonly resetPreviews: (threadId: string) => void
  readonly dispatch: (event: InteractiveEvent) => void
  readonly authority: () => Projection | undefined
  readonly replaceAuthority: (expected: Projection, replacement: Projection) => boolean
  readonly setParticipants: (participants: number) => Effect.Effect<void>
  readonly commitSnapshot: (payload: Snapshot, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
  readonly reconcileSubmission: (threadId: string, submissionId: string) => Effect.Effect<void>
  readonly acknowledge: (connection: PhysicalConnection, threadId: string, cursor: string) => Effect.Effect<void>
  readonly threadCursors: Map<string, string>
  readonly failure: (message: string) => HostedError
}) => {
  const preview = (payload: Extract<Payload, { readonly _tag: "ThreadPreview" | "ThreadPreviewReset" }>) => {
    const threadId = String(payload.threadId)
    if (!dependencies.selectedFrame(threadId)) return
    if (payload._tag === "ThreadPreviewReset") return dependencies.resetPreviews(threadId)
    const key = `${threadId}:${payload.turnId}:${payload.preview.runId}`
    if (payload.preview._tag === "ModelPreview") dependencies.activePreviews.set(key, payload)
    else if (payload.preview._tag === "ModelPreviewCleared") dependencies.activePreviews.delete(key)
    dependencies.dispatch({
      _tag: "ExecutionModelPreviewChanged",
      threadId: ThreadId.make(payload.threadId),
      turnId: payload.turnId,
      preview: payload.preview,
    })
  }
  const eventView = (projection: Projection, event: Extract<Payload, { readonly _tag: "ThreadEvent" }>) => {
    if (event.event.event._tag === "ThreadViewSnapshot") {
      const view = ThreadView.fromSnapshot(event.event.event.snapshot)
      return view._tag === "Failure"
        ? dependencies.failure("Thread event snapshot was invalid")
        : view.success.snapshot()
    }
    if (event.event.event._tag !== "ThreadViewPatch") return projection.view
    const view = ThreadView.fromSnapshot(projection.view)
    if (view._tag === "Failure") return dependencies.failure("Thread event view was invalid")
    const applied = view.success.apply(event.event.event.patch)
    return applied._tag === "Failure" ? dependencies.failure("Thread event patch was invalid") : view.success.snapshot()
  }
  const threadEvent = (payload: Extract<Payload, { readonly _tag: "ThreadEvent" }>, connection: PhysicalConnection) =>
    Effect.gen(function* () {
      const threadId = String(payload.event.threadId)
      if (!dependencies.selectedFrame(threadId)) return
      const eventThreadId = interactiveEventThreadId(payload.event.event)
      if (eventThreadId !== undefined && eventThreadId !== threadId)
        return yield* dependencies.failure("Thread event identity did not match its response")
      const projection = dependencies.authority()!
      const next = BigInt(payload.event.cursor)
      const previous = BigInt(projection.committedCursor)
      if (next <= previous) return
      if (next !== previous + 1n) return yield* dependencies.failure("Thread event cursor was not contiguous")
      const eventVersion = BigInt(payload.event.threadVersion)
      if (eventVersion < BigInt(projection.representedVersion))
        return yield* dependencies.failure("Thread event version regressed")
      const event = payload.event.event
      if (
        (event._tag === "SubmissionAdmitted" || event._tag === "SubmissionRejected") &&
        event.submissionId !== undefined
      )
        yield* Effect.uninterruptible(dependencies.reconcileSubmission(threadId, event.submissionId))
      const nextView = eventView(projection, payload)
      if (Schema.is(HostedError)(nextView)) return yield* nextView
      const candidate = {
        ...projection,
        view: nextView,
        version: eventVersion < BigInt(projection.version) ? projection.version : String(payload.event.threadVersion),
        representedVersion: String(payload.event.threadVersion),
        committedCursor: String(payload.event.cursor),
      }
      if (!dependencies.replaceAuthority(projection, candidate)) return
      dependencies.dispatch(event)
      dependencies.replaceAuthority(candidate, {
        ...candidate,
        deliveredCursor: candidate.committedCursor,
        deliveredFingerprint: encodeThreadView(nextView),
      })
      dependencies.threadCursors.set(threadId, candidate.committedCursor)
      yield* dependencies.acknowledge(connection, threadId, String(payload.event.cursor))
    })
  return (payload: Payload, connection: PhysicalConnection) => {
    if (!dependencies.currentFrame(connection)) return Effect.void
    if (payload._tag === "ThreadPreview" || payload._tag === "ThreadPreviewReset")
      return Effect.sync(() => preview(payload))
    if (payload._tag === "PresenceSnapshot") {
      if (!dependencies.selectedFrame(String(payload.threadId))) return Effect.void
      const projection = dependencies.authority()!
      dependencies.replaceAuthority(projection, { ...projection, participants: payload.participants.length })
      return dependencies.setParticipants(payload.participants.length)
    }
    if (payload._tag === "ThreadSnapshot")
      return payload.requestId === undefined ? dependencies.commitSnapshot(payload, connection) : Effect.void
    if (payload._tag === "ThreadEvent") return threadEvent(payload, connection)
    return Effect.void
  }
}

export const interactivePreviewState = (dispatch: (event: InteractiveEvent) => void) => {
  const activePreviews = new Map<string, Preview>()
  const resetPreviews = (threadId: string) => {
    for (const [key, payload] of activePreviews) {
      if (String(payload.threadId) !== threadId) continue
      if (payload.preview._tag !== "ModelPreview") {
        activePreviews.delete(key)
        continue
      }
      dispatch({
        _tag: "ExecutionModelPreviewChanged",
        threadId: ThreadId.make(payload.threadId),
        turnId: payload.turnId,
        preview:
          payload.preview.parentId === undefined
            ? {
                _tag: "ModelPreviewCleared",
                runId: payload.preview.runId,
                attemptFence: payload.preview.attemptFence,
                generation: 0,
              }
            : {
                _tag: "ModelPreviewCleared",
                runId: payload.preview.runId,
                parentId: payload.preview.parentId,
                attemptFence: payload.preview.attemptFence,
                generation: 0,
              },
      })
      activePreviews.delete(key)
    }
  }
  return { activePreviews, resetPreviews }
}
