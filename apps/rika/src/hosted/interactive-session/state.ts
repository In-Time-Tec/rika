import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import * as ThreadView from "@rika/product/thread-view"
import type { HostedError } from "../contract"
import { AttachmentProjection, type PreparedAttachment, type Projection, type SnapshotProjection } from "./projection"

const { encodeThreadView } = AttachmentProjection

export const promptWorkspaceActivity = (
  workspace: HostedThreadSnapshot["workspace"],
): InteractiveConnection.Activity => {
  if (workspace?._tag !== "OrbWorkspace") return "executor-waiting"
  if (workspace.state === "failed") return "workspace-failed"
  if (workspace.readiness === "fresh") return "sandbox-preparing"
  if (workspace.readiness === "cold") return "sandbox-waking"
  return "prompt-waiting"
}

const projectionActivity = (
  view: ThreadView.ThreadViewSnapshot,
  pendingAuthorizations: ReadonlyArray<unknown>,
  executorKind: HostedThreadSnapshot["executorKind"],
  workspace: HostedThreadSnapshot["workspace"],
) => {
  const active = view.turns
  if (pendingAuthorizations.length > 0) return "approval-required" as const
  if (
    active.length > 0 &&
    active.every(
      (entry) =>
        entry.turn.status === "completed" || entry.turn.status === "failed" || entry.turn.status === "cancelled",
    )
  )
    return "terminal" as const
  if (active.length > 0 && executorKind === "orb" && workspace?._tag === "OrbWorkspace") {
    const activity = promptWorkspaceActivity(workspace)
    if (activity !== "prompt-waiting") return activity
  }
  if (active.some((entry) => entry.turn.status === "waiting")) return "executor-waiting" as const
  if (active.some((entry) => entry.turn.status === "running" || entry.turn.status === "cancelling"))
    return "executor-connected" as const
  return "executor-waiting" as const
}

const projectionFromSnapshot = (
  payload: SnapshotProjection,
  participants: number,
  deliveredCursor: string,
  deliveredFingerprint: string | undefined,
  failure: (message: string) => HostedError,
): Projection | HostedError => {
  const view = ThreadView.fromSnapshot(payload.snapshot.view)
  if (view._tag === "Failure") return failure("Thread snapshot view was invalid")
  return {
    threadId: String(payload.threadId),
    view: view.success.snapshot(),
    authorizations: new Map(
      payload.snapshot.pendingAuthorizations.map((pending) => [
        `${pending.turnId}:${pending.authorizationId}`,
        pending,
      ]),
    ),
    target: payload.snapshot.executorKind,
    workspace: payload.snapshot.workspace,
    activity: projectionActivity(
      payload.snapshot.view,
      payload.snapshot.pendingAuthorizations,
      payload.snapshot.executorKind,
      payload.snapshot.workspace,
    ),
    participants,
    committedCursor: String(payload.cursor),
    checkpointCursor: String(payload.cursor),
    version: String(payload.threadVersion),
    representedVersion: String(payload.threadVersion),
    deliveredCursor,
    deliveredFingerprint,
  }
}

const attachmentContext = (prepared: PreparedAttachment, previous: Projection | undefined) => {
  const checkpoint = prepared.checkpoint
  if (checkpoint === undefined) {
    const basis = previous!
    return {
      authorizations: basis.authorizations,
      target: basis.target,
      workspace: basis.workspace,
      checkpointCursor: basis.checkpointCursor,
    }
  }
  return {
    authorizations: new Map(
      checkpoint.pendingAuthorizations.map((pending) => [`${pending.turnId}:${pending.authorizationId}`, pending]),
    ),
    target: checkpoint.executorKind,
    workspace: checkpoint.workspace,
    checkpointCursor: String(prepared.attachment.baseCursor),
  }
}

const planAttachment = (
  prepared: PreparedAttachment,
  previous: Projection | undefined,
  threadCursors: ReadonlyMap<string, string>,
  failure: (message: string) => HostedError,
) => {
  const threadId = String(prepared.attachment.threadId)
  const continuing = previous?.threadId === threadId
  const deliveredCursor = continuing ? previous.deliveredCursor : (threadCursors.get(threadId) ?? "0")
  if (BigInt(deliveredCursor) > prepared.terminalCursor)
    return { _tag: "Invalid" as const, error: failure("Thread attachment terminal cursor regressed") }
  const view = ThreadView.fromSnapshot(prepared.view)
  if (view._tag === "Failure") return { _tag: "Invalid" as const, error: failure("Thread committed view was invalid") }
  const payload = prepared.attachment
  if (
    previous !== undefined &&
    previous.threadId === threadId &&
    BigInt(payload.threadVersion) < BigInt(previous.version)
  )
    return {
      _tag: "Invalid" as const,
      error: failure("Thread attachment terminal version regressed"),
    }
  const { authorizations, target, workspace, checkpointCursor } = attachmentContext(prepared, previous)
  const candidate: Projection = {
    threadId,
    view: view.success.snapshot(),
    authorizations,
    target,
    workspace,
    activity: projectionActivity(prepared.view, [...authorizations.values()], target, workspace),
    participants: payload.participants.length,
    committedCursor: String(payload.cursor),
    checkpointCursor,
    version: String(payload.threadVersion),
    representedVersion: String(prepared.representedVersion),
    deliveredCursor,
    deliveredFingerprint: continuing ? previous.deliveredFingerprint : undefined,
  }
  return {
    _tag: "Valid" as const,
    publishSnapshot: previous?.deliveredFingerprint !== encodeThreadView(prepared.view),
    candidate,
  }
}

export const InteractiveSessionState = { planAttachment, projectionFromSnapshot, promptWorkspaceActivity }
