import { Clock, Context, DateTime, Effect, LayerMap, Schema } from "effect"
import { ThreadId as HostedThreadId, type OwnerId } from "@rika/product/hosted-model"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId } from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { loadTranscriptWindow } from "@rika/product/transcript-window"
import type { PageCursor } from "@rika/product/transcript-page"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import { interactiveSessionSnapshot } from "../interactive-session-buffer"

export class HostedThreadSnapshotPublicationError extends Schema.TaggedError<HostedThreadSnapshotPublicationError>()(
  "HostedThreadSnapshotPublicationError",
  { message: Schema.String },
) {}

export const make = Effect.gen(function* () {
  const hosted = yield* HostedClientAuthority
  const store = yield* ThreadProtocolStore
  const ownerRepositories = yield* LayerMap.make((ownerId: OwnerId) => ProductRepositories.layer(ownerId))
  const failure = (error: { readonly message: string }) =>
    HostedThreadSnapshotPublicationError.make({
      message: error.message,
    })
  const snapshot = Effect.fn("HostedThreadSnapshotPublication.snapshot")(function* (
    ownerId: OwnerId,
    threadId: ThreadId,
    before?: PageCursor,
  ) {
    return yield* Effect.scoped(
      ownerRepositories.contextEffect(ownerId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const threads = Context.get(context, ThreadRepository.Service)
            const turns = Context.get(context, TurnRepository.Service)
            const transcripts = Context.get(context, TranscriptRepository.Service)
            const thread = yield* threads.get(threadId)
            if (thread === undefined)
              return yield* HostedThreadSnapshotPublicationError.make({ message: "Thread is unavailable" })
            const hostedThread = yield* hosted.readThread({ ownerId, threadId: HostedThreadId.make(threadId) })
            if (hostedThread === undefined)
              return yield* HostedThreadSnapshotPublicationError.make({ message: "Thread is unavailable" })
            const queue = yield* turns.readQueue(threadId)
            const page = yield* loadTranscriptWindow(threadId, transcripts, before)
            const active = yield* turns.findActive(threadId)
            const activeProjection = active === undefined ? undefined : yield* transcripts.get(active.id)
            const loadedAt = yield* Clock.currentTimeMillis
            const feed = makeThreadViewFeed(() => loadedAt)
            const loaded: Extract<Parameters<typeof feed.publish>[0], { readonly _tag: "SelectionLoaded" }> = {
              _tag: "SelectionLoaded",
              selectionEpoch: 0,
              activitySequence: 0,
              thread,
              entries: page.entries,
              hasOlder: page.hasOlder,
              hasNewer: page.hasNewer,
              usage: page.usage,
              queueRevision: queue.revision,
              queuedCount: queue.queuedCount,
              queue: queue.turns.map((turn) => ({ id: turn.id, prompt: turn.prompt, createdAt: turn.createdAt })),
              projectionCheckpoints:
                activeProjection?.projectorCheckpoint === undefined
                  ? []
                  : [{ turnId: activeProjection.turn.id, checkpoint: activeProjection.projectorCheckpoint }],
            }
            if (page.oldestCursor !== undefined) Object.assign(loaded, { oldestCursor: page.oldestCursor })
            if (page.newestCursor !== undefined) Object.assign(loaded, { newestCursor: page.newestCursor })
            if (active !== undefined && before === undefined) Object.assign(loaded, { activeTurn: active })
            feed.publish(loaded)
            const view = feed.current()
            if (view === undefined)
              return yield* HostedThreadSnapshotPublicationError.make({ message: "Thread checkpoint is invalid" })
            const authorizations = interactiveSessionSnapshot.pendingAuthorizations(
              HostedThreadId.make(threadId),
              view,
              (turnId) =>
                activeProjection !== undefined && turnId === String(activeProjection.turn.id)
                  ? activeProjection.projectorCheckpoint
                  : undefined,
            )
            if (authorizations === undefined)
              return yield* HostedThreadSnapshotPublicationError.make({
                message: "Pending authorization has no durable execution checkpoint",
              })
            return { executorKind: hostedThread.executorKind, view, pendingAuthorizations: authorizations }
          }).pipe(Effect.provide(context)),
        ),
        Effect.mapError((error) => (Schema.is(HostedThreadSnapshotPublicationError)(error) ? error : failure(error))),
      ),
    )
  })
  const publish = Effect.fn("HostedThreadSnapshotPublication.publish")(function* (value: string) {
    const threadId = ThreadId.make(value)
    const thread = yield* hosted.findThread(HostedThreadId.make(threadId))
    if (thread === undefined)
      return yield* HostedThreadSnapshotPublicationError.make({ message: "Thread is unavailable" })
    const current = yield* snapshot(thread.ownerId, threadId)
    yield* store.appendEvents({
      ownerId: thread.ownerId,
      threadId: HostedThreadId.make(threadId),
      events: [{ _tag: "ThreadViewSnapshot", snapshot: current.view }],
      snapshot: current,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    })
  })
  return { snapshot, publish: (threadId: string) => publish(threadId).pipe(Effect.mapError(failure)) }
})
