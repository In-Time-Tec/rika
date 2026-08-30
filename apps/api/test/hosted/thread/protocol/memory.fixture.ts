import { Effect, Schema, Layer } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthUserId,
  ClientId,
  CommitCursor,
  DeviceId,
  OwnerId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { HostedPresence } from "@rika/product/hosted-presence"
import { PendingAuthorization, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type {
  CommandAdmission,
  ThreadProtocolCommand,
  ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"

export const timestamp = Timestamp.make("2026-08-21T00:00:00.000Z")
const pendingAuthorizationsEquivalent = Schema.toEquivalence(Schema.Array(PendingAuthorization))
const userId = BetterAuthUserId.make("user-1")
export const ownerId = OwnerId.make("owner-1")
export const threadId = ThreadId.make("thread-1")
export const assignmentId = "assignment-1"
const clientId = ClientId.make("client-1")
export const deviceId = DeviceId.make("device-1")
export const actor = {
  _tag: "PersonalActor" as const,
  owner: { _tag: "PersonalOwner" as const, userId },
  userId,
  clientId,
  deviceId,
}
export const snapshot = {
  executorKind: "runner" as const,
  view: {
    thread: {
      id: ProductThreadId.make(threadId),
      workspace: WorkspaceId.make("workspace-1"),
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" as const },
      createdAt: 1,
      updatedAt: 1,
    },
    revision: 0,
    source: { projectionVersion: ExecutionProjection.projectionVersion },
    turns: [],
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.emptyUsageState() },
  },
  pendingAuthorizations: [],
}

export const presenceLayer = Layer.succeed(HostedPresence, {
  upsert: (input) =>
    Effect.succeed({
      ownerId: input.ownerId,
      threadId: input.threadId,
      actor: input.actor,
      status: input.status,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
    }),
  list: () => Effect.succeed([]),
})

export const memoryStore = () => {
  let version = 0n
  let cursor = 0n
  const commands = new Map<string, ThreadProtocolCommand>()
  const keys = new Map<string, string>()
  const admissions: Array<{
    readonly threadId: string
    readonly commandId: string
  }> = []
  let latestSnapshot: HostedThreadSnapshot | undefined
  let latestSnapshotCursor = 0n
  let latestSnapshotVersion = 0n
  let latestSnapshotReplayRequired = false
  let snapshotSaves = 0
  const claims = new Map<string, string>()
  const acknowledgements: Array<{
    readonly threadId: string
    readonly cursor: string
  }> = []
  const events: Array<{
    readonly event: InteractiveEvent
    readonly cursor: string
    readonly threadVersion: string
  }> = []
  const service: ThreadProtocolStoreService = {
    initializeThread: () => Effect.void,
    admitCommand: (input) =>
      Effect.suspend((): Effect.Effect<CommandAdmission, HostedPersistenceError> => {
        admissions.push({
          threadId: input.threadId,
          commandId: input.commandId,
        })
        const found = commands.get(input.commandId) ?? commands.get(keys.get(input.idempotencyKey) ?? "")
        if (found !== undefined)
          return Effect.succeed({
            _tag: "Duplicate" as const,
            command: found,
          })
        if (input.expectedThreadVersion !== String(version))
          return Effect.fail(HostedPersistenceError.make({ reason: "stale-version", message: "stale" }))
        version += 1n
        const admitted: ThreadProtocolCommand = {
          ...input,
          threadVersion: ThreadVersion.make(String(version)),
          sequence: Sequence.make(String(version)),
          commitCursor: CommitCursor.make(String(version)),
          state: "admitted",
        }
        commands.set(input.commandId, admitted)
        keys.set(input.idempotencyKey, input.commandId)
        return Effect.succeed({ _tag: "Admitted" as const, command: admitted })
      }),
    admitServerCommand: () => Effect.die("unused"),
    applyPrompt: () => Effect.die("unused"),
    cancelPrompt: () => Effect.die("unused"),
    claimNextCommand: () => Effect.die("unused"),
    oldestRunnableCommandAt: Effect.map(Effect.void, (): number | undefined => undefined),
    renewCommandClaim: (input) => Effect.sync(() => claims.get(input.commandId) === input.claimToken),
    releaseCommandClaim: (input) =>
      Effect.sync(() => {
        if (claims.get(input.commandId) === input.claimToken) claims.delete(input.commandId)
      }),
    completeCommand: (input) =>
      Effect.sync(() => {
        const admitted = commands.get(input.commandId)!
        if (admitted.state === "completed") return { _tag: "Duplicate" as const, command: admitted }
        for (const event of input.events) {
          cursor += 1n
          events.push({
            event,
            cursor: String(cursor),
            threadVersion: admitted.threadVersion,
          })
        }
        if (input.snapshot !== undefined) {
          const replayRequired =
            latestSnapshot !== undefined &&
            !pendingAuthorizationsEquivalent(latestSnapshot.pendingAuthorizations, input.snapshot.pendingAuthorizations)
          latestSnapshot = input.snapshot
          latestSnapshotCursor = cursor
          latestSnapshotVersion = BigInt(admitted.threadVersion)
          latestSnapshotReplayRequired ||= replayRequired
        }
        const completed: ThreadProtocolCommand = {
          ...admitted,
          state: "completed",
          result: input.result,
          cursor: ThreadEventCursor.make(String(cursor)),
          completedAt: input.completedAt,
        }
        commands.set(input.commandId, completed)
        return { _tag: "Completed" as const, command: completed }
      }),
    appendEvents: (input) =>
      Effect.sync(() => {
        const written = input.events.map((event) => {
          cursor += 1n
          events.push({
            event,
            cursor: String(cursor),
            threadVersion: String(version),
          })
          return {
            ownerId,
            threadId,
            sequence: String(cursor),
            cursor: ThreadEventCursor.make(String(cursor)),
            threadVersion: ThreadVersion.make(String(version)),
            event,
            createdAt: input.createdAt,
          }
        })
        return written
      }),
    checkpoint: (input) =>
      Effect.sync(() => {
        latestSnapshot = input.snapshot
        latestSnapshotCursor = BigInt(input.cursor)
        latestSnapshotVersion = BigInt(input.threadVersion)
        latestSnapshotReplayRequired = true
        return true
      }),
    saveSnapshot: (input) =>
      Effect.sync(() => {
        snapshotSaves += 1
        latestSnapshot = input.snapshot
        latestSnapshotCursor = BigInt(input.cursor)
        latestSnapshotVersion = BigInt(input.threadVersion)
        latestSnapshotReplayRequired = false
      }),
    replay: (input) =>
      Effect.sync(() => {
        const targetCursor =
          input.throughCursor === undefined || BigInt(input.throughCursor) > cursor
            ? cursor
            : BigInt(input.throughCursor)
        const afterCursor = BigInt(input.afterCursor)
        const firstEvent = events.find(
          (event) => BigInt(event.cursor) > afterCursor && BigInt(event.cursor) <= targetCursor,
        )
        const directTail = afterCursor === targetCursor || BigInt(firstEvent?.cursor ?? "-1") === afterCursor + 1n
        const checkpointBehind = BigInt(input.afterCheckpointCursor ?? "-1") < latestSnapshotCursor
        const includeSnapshot =
          input.includeSnapshot !== false &&
          latestSnapshot !== undefined &&
          latestSnapshotCursor <= targetCursor &&
          (input.afterCursor === "0" || !directTail || (latestSnapshotReplayRequired && checkpointBehind))
        const replayCursor = includeSnapshot ? latestSnapshotCursor : BigInt(input.afterCursor)
        const replay = {
          threadVersion: ThreadVersion.make(String(version)),
          cursor: ThreadEventCursor.make(String(cursor)),
          events: events
            .filter((event) => BigInt(event.cursor) > replayCursor && BigInt(event.cursor) <= targetCursor)
            .slice(0, input.limit)
            .map((event) => ({
              ownerId,
              threadId,
              sequence: event.cursor,
              cursor: ThreadEventCursor.make(event.cursor),
              threadVersion: ThreadVersion.make(event.threadVersion),
              event: event.event,
              createdAt: timestamp,
            })),
          hasMore:
            events.filter((event) => BigInt(event.cursor) > replayCursor && BigInt(event.cursor) <= targetCursor)
              .length > input.limit,
        }
        if (includeSnapshot)
          return {
            ...replay,
            snapshot: {
              ownerId,
              threadId,
              threadVersion: ThreadVersion.make(String(latestSnapshotVersion)),
              cursor: ThreadEventCursor.make(String(latestSnapshotCursor)),
              snapshot: latestSnapshot!,
              createdAt: timestamp,
            },
          }
        return replay
      }),
    acknowledgeCursor: (input) =>
      Effect.sync(() => {
        acknowledgements.push({
          threadId: input.threadId,
          cursor: input.cursor,
        })
        return input.cursor
      }),
    issueTicket: () => Effect.void,
    redeemTicket: () =>
      Effect.succeed({
        ticketId: "ticket",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        expiresAt: timestamp,
      }),
    revokeTicket: () => Effect.void,
  }
  return Object.assign(service, {
    admissions: () => admissions,
    acknowledgements: () => acknowledgements,
    command: (id: string) => commands.get(id),
    snapshotSaves: () => snapshotSaves,
    dropSnapshot: () => {
      latestSnapshot = undefined
      latestSnapshotCursor = 0n
      latestSnapshotVersion = 0n
      latestSnapshotReplayRequired = false
    },
    dropEventsThrough: (throughCursor: string) => {
      const retained = events.filter((event) => BigInt(event.cursor) > BigInt(throughCursor))
      events.splice(0, events.length, ...retained)
    },
  })
}
