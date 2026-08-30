import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthUserId,
  ClientId,
  DeviceId,
  OwnerId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { DateTime } from "effect"

const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe())

export const timestampAfter = (milliseconds: number) =>
  Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(startedAt + milliseconds)))

export const now = timestampAfter(0)
export const later = timestampAfter(60_000)
export const authorityExpiresAt = timestampAfter(5 * 60_000)
export const presenceExpiresAt = timestampAfter(4 * 60_000)
export const userId = BetterAuthUserId.make("protocol-user")
export const ownerId = OwnerId.make("protocol-owner")
export const workspaceId = WorkspaceId.make("protocol-workspace")
export const threadId = ThreadId.make("protocol-thread")
export const assignmentId = "protocol-assignment"
export const clientId = ClientId.make("protocol-client")
export const deviceId = DeviceId.make("protocol-device")
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
      workspace: workspaceId,
      title: "Protocol Thread",
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
