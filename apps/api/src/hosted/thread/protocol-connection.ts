import { Clock, DateTime, Effect, Schema } from "effect"
import { Sequence, ThreadEventCursor, ThreadId, Timestamp } from "@rika/product/hosted-model"
import type { HostedPresence } from "@rika/product/hosted-presence"
import * as HostedObservability from "@rika/product/hosted-observability"
import { type ClientMessage, ServerFrame, type WorkspacePlacement } from "@rika/product/client-protocol"
import type { ThreadProtocolStore, ThreadReader } from "@rika/product/thread-protocol-store"
import type { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import type { HostedThreadApplication } from "./application"
import type { HostedProduct, ThreadAuthority } from "../product"
import type { ThreadProtocolNotificationGeneration, ThreadProtocolNotifications } from "./notifications"
import type { HostedPreviewBusService, HostedPreviewSubscription } from "./previews"
import {
  frame,
  type BrowserReadPrincipal,
  type HostedThreadConnection,
  type HostedThreadProtocolError,
  operationFailure,
  productFailure,
  storeFailure,
  unavailable,
  validateBrowserRead,
  zeroCursor,
} from "./protocol-contract"

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const maximumAttachmentEvents = 10_000
const maximumAttachmentBytes = 32 * 1024 * 1024

const replayDistance = (cursor: string, afterCursor: string) => {
  const distance = BigInt(cursor) - BigInt(afterCursor)
  return distance <= 0 ? 0 : Number(distance > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : distance)
}

// Device presence keeps Runner demand live; passive browser readers never write it.
export const presenceLifetimeMillis = 60_000
export const presenceRefreshMillis = 30_000

interface ReadAuthority {
  readonly ownerId: ThreadAuthority["ownerId"]
  readonly actor: ThreadReader
}

interface Attachment {
  readonly threadId: ThreadId
  readonly authority: ReadAuthority
  readonly cursor: ThreadEventCursor
  readonly checkpointCursor: ThreadEventCursor
  readonly knownHead: ThreadEventCursor
  readonly notificationGeneration: ThreadProtocolNotificationGeneration
  readonly previewSubscription: HostedPreviewSubscription
  readonly presenceRefreshedAt: number
}

export interface ProtocolConnectionDependencies {
  readonly principal: Parameters<HostedProduct["Service"]["authorizeThread"]>[0] | BrowserReadPrincipal
  readonly product: HostedProduct["Service"]
  readonly operations: HostedThreadApplication["Service"]
  readonly store: ThreadProtocolStore["Service"]
  readonly presence: HostedPresence["Service"]
  readonly changes: ThreadProtocolNotifications
  readonly previews: HostedPreviewBusService
  readonly workspacePlacement:
    | ((
        ownerId: ThreadAuthority["ownerId"],
        threadId: ThreadId,
      ) => Effect.Effect<WorkspacePlacement, HostedThreadProtocolError>)
    | undefined
}

export interface ProtocolConnectionState {
  readonly attach: (
    command: Extract<ClientMessage["command"], { readonly _tag: "AttachThread" }>,
    requestId: ClientMessage["requestId"],
    receivedAt: string,
  ) => Effect.Effect<ReadonlyArray<ServerFrame>, HostedThreadProtocolError>
  readonly detach: (receivedAt: string) => Effect.Effect<ReadonlyArray<ServerFrame>>
  readonly ready: Effect.Effect<void>
  readonly drain: HostedThreadConnection["outbound"]
  readonly outbound: (
    durableReady: Effect.Effect<void>,
    drainDurable: HostedThreadConnection["outbound"],
  ) => HostedThreadConnection["outbound"]
  readonly close: Effect.Effect<void>
}

export const protocolConnectionState = (dependencies: ProtocolConnectionDependencies): ProtocolConnectionState => {
  const { principal, product, operations, store, presence, changes, previews, workspacePlacement } = dependencies
  let attached: Attachment | undefined

  const validate = Effect.suspend(() => validateBrowserRead({ principal, product, threadId: attached?.threadId }))

  const presenceViewing = (
    authority: ReadAuthority,
    threadId: ThreadId,
    nowMillis: number,
  ): Effect.Effect<void, HostedPersistenceError> =>
    authority.actor._tag === "BrowserRead"
      ? Effect.void
      : presence
          .upsert({
            ownerId: authority.ownerId,
            threadId,
            actor: authority.actor,
            status: "viewing",
            now: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(nowMillis))),
            expiresAt: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(nowMillis + presenceLifetimeMillis))),
          })
          .pipe(Effect.asVoid)

  const presenceAway = (
    authority: ReadAuthority,
    threadId: ThreadId,
    nowMillis: number,
  ): Effect.Effect<void, HostedPersistenceError> => {
    if (authority.actor._tag === "BrowserRead") return Effect.void
    const now = Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(nowMillis)))
    return presence
      .upsert({
        ownerId: authority.ownerId,
        threadId,
        actor: authority.actor,
        status: "away",
        now,
        expiresAt: now,
      })
      .pipe(Effect.asVoid)
  }

  /** Refreshes the attachment's presence when it is due; never fails the connection over a presence write. */
  const refreshPresence = Effect.gen(function* () {
    const current = attached
    if (current === undefined) return
    const nowMillis = yield* Clock.currentTimeMillis
    if (nowMillis < current.presenceRefreshedAt + presenceRefreshMillis) return
    yield* presenceViewing(current.authority, current.threadId, nowMillis).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("thread.presence.refresh_failed").pipe(
          Effect.annotateLogs({ "rika.thread.id": String(current.threadId), "rika.failure.message": error.message }),
        ),
      ),
      Effect.ignore,
    )
    if (attached === current) attached = { ...current, presenceRefreshedAt: nowMillis }
  })

  const presenceDue = Effect.gen(function* () {
    if ("_tag" in principal) return yield* Effect.never
    const current = attached
    if (current === undefined) return yield* Effect.never
    const nowMillis = yield* Clock.currentTimeMillis
    yield* Effect.sleep(Math.max(0, current.presenceRefreshedAt + presenceRefreshMillis - nowMillis))
  })

  const materializeSnapshot = Effect.fn("HostedThreadProtocol.materializeSnapshot")(function* (
    authority: ReadAuthority,
    threadId: ThreadId,
    afterCursor: ThreadEventCursor,
    afterCheckpointCursor?: ThreadEventCursor,
  ) {
    const baseReplayInput = { ownerId: authority.ownerId, threadId, actor: authority.actor, afterCursor, limit: 1_000 }
    const readReplay = (
      afterCheckpointCursor === undefined
        ? store.replay(baseReplayInput)
        : store.replay({ ...baseReplayInput, afterCheckpointCursor })
    ).pipe(Effect.mapError(storeFailure))
    while (true) {
      if (!(yield* validate)) return yield* unavailable("Browser session is no longer authorized")
      const replay = yield* readReplay
      const directTail =
        afterCursor !== zeroCursor &&
        (afterCursor === replay.cursor ||
          replay.events[0]?.cursor === ThreadEventCursor.make((BigInt(afterCursor) + 1n).toString()))
      if (replay.snapshot !== undefined || directTail) return replay
      const currentSnapshot = yield* operations
        .snapshot(authority.ownerId, ProductThreadId.make(threadId))
        .pipe(Effect.mapError(operationFailure))
      const snapshot =
        workspacePlacement === undefined
          ? currentSnapshot
          : { ...currentSnapshot, workspace: yield* workspacePlacement(authority.ownerId, threadId) }
      const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
      const saved = yield* store
        .saveSnapshot({
          ownerId: authority.ownerId,
          threadId,
          threadVersion: replay.threadVersion,
          cursor: replay.cursor,
          snapshot,
          createdAt,
        })
        .pipe(Effect.result)
      if (saved._tag === "Success") return yield* readReplay
      if (saved.failure.reason !== "conflict") return yield* storeFailure(saved.failure)
    }
  })

  const completeAttachmentReplay = Effect.fn("HostedThreadProtocol.completeAttachmentReplay")(function* (
    authority: ReadAuthority,
    command: Extract<ClientMessage["command"], { readonly _tag: "AttachThread" }>,
    replay: Effect.Success<ReturnType<typeof store.replay>>,
  ) {
    const replaySnapshot = replay.snapshot
    const replayEvents = [...replay.events]
    const baseCursor = replaySnapshot?.cursor ?? command.afterCursor
    let representedCursor = replayEvents.at(-1)?.cursor ?? baseCursor
    while (BigInt(representedCursor) < BigInt(replay.cursor)) {
      if (!(yield* validate)) return yield* unavailable("Browser session is no longer authorized")
      const page = yield* store
        .replay({
          ownerId: authority.ownerId,
          threadId: command.threadId,
          actor: authority.actor,
          afterCursor: representedCursor,
          throughCursor: replay.cursor,
          includeSnapshot: false,
          limit: 1_000,
        })
        .pipe(Effect.mapError(storeFailure))
      if (page.events.length === 0)
        return yield* unavailable("Thread replay does not continuously represent its cursor")
      replayEvents.push(...page.events)
      if (replayEvents.length > maximumAttachmentEvents)
        return yield* unavailable("Thread replay exceeds the attachment event limit")
      representedCursor = page.events.at(-1)!.cursor
    }
    let expectedCursor = BigInt(baseCursor) + 1n
    for (const event of replayEvents) {
      if (BigInt(event.cursor) !== expectedCursor)
        return yield* unavailable(
          `Thread replay contains cursor ${event.cursor}; expected ${expectedCursor.toString()}`,
        )
      expectedCursor += 1n
    }
    if (representedCursor !== replay.cursor)
      return yield* unavailable("Thread replay terminal cursor is not represented")
    if (replaySnapshot === undefined && command.afterCursor === zeroCursor)
      return yield* unavailable("Initial Thread replay has no durable checkpoint")
    return { replaySnapshot, replayEvents, baseCursor, representedCursor }
  })

  const attach: ProtocolConnectionState["attach"] = Effect.fn("HostedThreadProtocol.attach")(
    function* (command, requestId, receivedAt) {
      if (!(yield* validate)) return yield* unavailable("Browser session is no longer authorized")
      const authority: ReadAuthority =
        "_tag" in principal
          ? {
              ...(yield* product
                .authorizeReadThread(principal, command.threadId)
                .pipe(Effect.mapError(productFailure))),
              actor: { _tag: "BrowserRead", userId: principal.userId },
            }
          : yield* product
              .authorizeThread(principal, command.threadId, "thread:view")
              .pipe(Effect.mapError(productFailure))
      const notificationGeneration = changes.generation(command.threadId)
      yield* store
        .initializeThread({ ownerId: authority.ownerId, threadId: command.threadId, actor: authority.actor })
        .pipe(Effect.mapError(storeFailure))
      const replayCorrelation = { ownerId: authority.ownerId, threadId: command.threadId }
      const replay = yield* materializeSnapshot(
        authority,
        command.threadId,
        command.afterCursor,
        command.afterCheckpointCursor,
      )
      const replayLag = replayDistance(replay.cursor, command.afterCursor)
      yield* HostedObservability.replayLagObserved(replayCorrelation, replayLag)
      if (replayLag >= HostedObservability.replayLagAlertEvents)
        yield* HostedObservability.health("replay_lag", replayCorrelation, {
          value: replayLag,
          threshold: HostedObservability.replayLagAlertEvents,
        })
      const { replaySnapshot, replayEvents, baseCursor, representedCursor } = yield* completeAttachmentReplay(
        authority,
        command,
        replay,
      )
      const checkpointSnapshot =
        replaySnapshot === undefined || workspacePlacement === undefined
          ? replaySnapshot?.snapshot
          : {
              ...replaySnapshot.snapshot,
              workspace: yield* workspacePlacement(authority.ownerId, command.threadId),
            }
      const presenceNow = Timestamp.make(receivedAt)
      const attachedAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(receivedAt))
      const participants =
        authority.actor._tag === "BrowserRead"
          ? []
          : yield* presenceViewing(authority, command.threadId, attachedAtMillis).pipe(
              Effect.andThen(
                presence.list({
                  ownerId: authority.ownerId,
                  threadId: command.threadId,
                  actor: authority.actor,
                  now: presenceNow,
                }),
              ),
              Effect.orElseSucceed(() => []),
            )
      const attachmentPayload = {
        _tag: "ThreadAttached",
        requestId,
        threadId: command.threadId,
        baseCursor,
        threadVersion: replay.threadVersion,
        cursor: representedCursor,
        events: replayEvents.map((event) => ({
          threadId: event.threadId,
          sequence: Sequence.make(event.sequence),
          cursor: event.cursor,
          threadVersion: event.threadVersion,
          event: event.event,
          createdAt: event.createdAt,
        })),
        participants: participants.map(({ actor, status }) => ({ actor, status })),
      } satisfies Extract<ServerFrame["payload"], { readonly _tag: "ThreadAttached" }>
      if (replaySnapshot !== undefined && checkpointSnapshot !== undefined)
        Object.assign(attachmentPayload, {
          checkpoint: {
            threadVersion: replaySnapshot.threadVersion,
            cursor: replaySnapshot.cursor,
            snapshot: checkpointSnapshot,
          },
        })
      const attachment = frame(attachmentPayload)
      if (new TextEncoder().encode(encodeUnknownJson(attachment)).byteLength > maximumAttachmentBytes)
        return yield* unavailable("Thread replay exceeds the attachment byte limit")
      const previewSubscription = yield* previews.subscribe(command.threadId)
      if (attached !== undefined) yield* attached.previewSubscription.close
      attached = {
        threadId: command.threadId,
        authority,
        cursor: representedCursor,
        checkpointCursor: replaySnapshot?.cursor ?? command.afterCheckpointCursor ?? zeroCursor,
        knownHead: representedCursor,
        notificationGeneration,
        previewSubscription,
        presenceRefreshedAt: attachedAtMillis,
      }
      return [attachment]
    },
  )

  const detach = (receivedAt: string) => {
    const current = attached
    if (current === undefined) return Effect.succeed<ReadonlyArray<ServerFrame>>([])
    return presenceAway(
      current.authority,
      current.threadId,
      DateTime.toEpochMillis(DateTime.makeUnsafe(receivedAt)),
    ).pipe(
      Effect.ignore,
      Effect.andThen(current.previewSubscription.close),
      Effect.tap(() => Effect.sync(() => (attached = undefined))),
      Effect.as([]),
    )
  }

  const ready = Effect.suspend(() => {
    const current = attached
    if (current === undefined) return Effect.never
    return BigInt(current.cursor) < BigInt(current.knownHead)
      ? Effect.void
      : changes.wait(current.threadId, current.notificationGeneration).pipe(Effect.asVoid)
  })

  const drainReplay = Effect.fn("HostedThreadProtocol.drainReplay")(function* (current: Attachment) {
    const input = {
      ownerId: current.authority.ownerId,
      threadId: current.threadId,
      actor: current.authority.actor,
      afterCursor: current.cursor,
      afterCheckpointCursor: current.checkpointCursor,
      limit: 1_000,
    }
    let replay = yield* store.replay(input).pipe(Effect.mapError(storeFailure))
    let expectedCursor = BigInt(current.cursor) + 1n
    let reset =
      (replay.snapshot !== undefined && BigInt(replay.snapshot.cursor) > BigInt(current.checkpointCursor)) ||
      (replay.events.length === 0 && BigInt(replay.cursor) > BigInt(current.cursor))
    for (const event of replay.events) {
      if (BigInt(event.cursor) !== expectedCursor) reset = true
      expectedCursor = BigInt(event.cursor) + 1n
    }
    if (!reset) return { replay, reset }
    replay = yield* store.replay({ ...input, includeSnapshot: true }).pipe(Effect.mapError(storeFailure))
    if (replay.snapshot === undefined || BigInt(replay.snapshot.cursor) <= BigInt(current.checkpointCursor))
      return yield* unavailable("Thread replay gap has no newer durable snapshot")
    expectedCursor = BigInt(replay.snapshot.cursor) + 1n
    for (const event of replay.events) {
      if (BigInt(event.cursor) !== expectedCursor)
        return yield* unavailable("Thread replay remains discontinuous after its durable snapshot")
      expectedCursor += 1n
    }
    return { replay, reset }
  })

  const drain: HostedThreadConnection["outbound"] = Effect.suspend(() => {
    const current = attached
    if (current === undefined) return Effect.succeed([])
    return Effect.gen(function* () {
      const notificationGeneration = changes.generation(current.threadId)
      const { replay, reset } = yield* drainReplay(current)
      const cursor = replay.events.at(-1)?.cursor ?? replay.snapshot?.cursor ?? current.cursor
      const snapshot = reset ? replay.snapshot : undefined
      const projectedSnapshot =
        snapshot === undefined || workspacePlacement === undefined
          ? snapshot?.snapshot
          : {
              ...snapshot.snapshot,
              workspace: yield* workspacePlacement(current.authority.ownerId, current.threadId),
            }
      if (attached !== current) return []
      attached = {
        ...current,
        cursor,
        checkpointCursor: snapshot?.cursor ?? current.checkpointCursor,
        knownHead: replay.cursor,
        notificationGeneration,
      }
      const frames =
        reset && projectedSnapshot !== undefined
          ? [
              frame({
                _tag: "ThreadSnapshot",
                threadId: current.threadId,
                threadVersion: snapshot!.threadVersion,
                cursor: snapshot!.cursor,
                snapshot: projectedSnapshot,
              }),
            ]
          : []
      frames.push(
        ...replay.events.map((event) =>
          frame({
            _tag: "ThreadEvent",
            event: {
              threadId: event.threadId,
              sequence: Sequence.make(event.sequence),
              cursor: event.cursor,
              threadVersion: event.threadVersion,
              event: event.event,
              createdAt: event.createdAt,
            },
          }),
        ),
      )
      return frames
    })
  })

  const outbound: ProtocolConnectionState["outbound"] = (durableReady, drainDurable) =>
    Effect.suspend(() => {
      const current = attached
      if (current === undefined) return durableReady.pipe(Effect.andThen(drainDurable))
      const presenceRefresh = presenceDue.pipe(Effect.as("presence" as const))
      return Effect.raceFirst(
        Effect.raceFirst(durableReady.pipe(Effect.as(undefined)), current.previewSubscription.take),
        presenceRefresh,
      ).pipe(
        Effect.flatMap((delivery) => {
          if (delivery === "presence") return refreshPresence.pipe(Effect.as([]))
          if (delivery === undefined) return refreshPresence.pipe(Effect.andThen(drainDurable))
          if (attached !== current) return Effect.succeed([])
          return Effect.succeed([
            frame(
              delivery._tag === "Reset"
                ? { _tag: "ThreadPreviewReset", threadId: current.threadId }
                : {
                    _tag: "ThreadPreview",
                    threadId: delivery.value.threadId,
                    turnId: delivery.value.turnId,
                    preview: delivery.value.preview,
                  },
            ),
          ])
        }),
      )
    })

  return {
    attach,
    detach,
    ready,
    drain,
    outbound,
    close: Effect.suspend(() => {
      const current = attached
      attached = undefined
      if (current === undefined) return Effect.void
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMillis) => presenceAway(current.authority, current.threadId, nowMillis)),
        Effect.ignore,
        Effect.andThen(current.previewSubscription.close),
      )
    }),
  }
}
