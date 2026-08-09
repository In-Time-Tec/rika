import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import { Result, Schema } from "effect"
import { projectSnapshot, type ProjectedThread, type ProjectionModel } from "./projection"

type Snapshot = ThreadView.ThreadViewSnapshot

export type ProjectionState = {
  readonly snapshot?: Snapshot
  readonly projected?: ProjectedThread
}

export type Translation = {
  readonly state: ProjectionState
  readonly events: ReadonlyArray<Event>
}

export class RikaProjectionError extends Schema.TaggedErrorClass<RikaProjectionError>()("RikaProjectionError", {
  reason: Schema.Literals(["missing-snapshot", "resync-required", "invalid-patch"]),
  message: Schema.String,
}) {}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const keyed = <A>(values: ReadonlyArray<A>, key: (value: A) => string) =>
  new Map(values.map((value) => [key(value), value]))

const eventDiff = (
  previous: ProjectedThread | undefined,
  next: ProjectedThread,
  revision: number,
): ReadonlyArray<Event> => {
  const events: Event[] = []
  let ordinal = 0
  const id = (type: string) =>
    `rika-event:${encodeURIComponent(next.session.id)}:${revision}:${(ordinal++).toString().padStart(4, "0")}:${type}`
  const previousParts = keyed(previous?.parts ?? [], (part) => `${part.messageID}\0${part.id}`)
  const nextParts = keyed(next.parts, (part) => `${part.messageID}\0${part.id}`)
  for (const [key, part] of previousParts) {
    if (nextParts.has(key)) continue
    events.push({
      id: id("message.part.removed"),
      type: "message.part.removed",
      properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
    })
  }
  const previousMessages = keyed(previous?.messages ?? [], (message) => message.id)
  const nextMessages = keyed(next.messages, (message) => message.id)
  for (const [messageID, message] of previousMessages) {
    if (nextMessages.has(messageID)) continue
    events.push({
      id: id("message.removed"),
      type: "message.removed",
      properties: { sessionID: message.sessionID, messageID },
    })
  }
  if (previous && previous.session.id !== next.session.id)
    events.push({
      id: id("session.deleted"),
      type: "session.deleted",
      properties: { sessionID: previous.session.id, info: previous.session },
    })
  if (!previous || !same(previous.session, next.session))
    events.push({
      id: id("session.updated"),
      type: "session.updated",
      properties: { sessionID: next.session.id, info: next.session },
    })
  for (const [messageID, message] of nextMessages) {
    if (same(previousMessages.get(messageID), message)) continue
    events.push({
      id: id("message.updated"),
      type: "message.updated",
      properties: { sessionID: message.sessionID, info: message },
    })
  }
  for (const [key, part] of nextParts) {
    if (same(previousParts.get(key), part)) continue
    events.push({
      id: id("message.part.updated"),
      type: "message.part.updated",
      properties: { sessionID: part.sessionID, part, time: Date.now() },
    })
  }
  const previousPermissions = keyed(previous?.permissions ?? [], (permission) => permission.id)
  const nextPermissions = keyed(next.permissions, (permission) => permission.id)
  for (const [requestID, permission] of previousPermissions) {
    if (nextPermissions.has(requestID)) continue
    events.push({
      id: id("permission.replied"),
      type: "permission.replied",
      properties: { sessionID: permission.sessionID, requestID, reply: "reject" },
    })
  }
  for (const [requestID, permission] of nextPermissions) {
    if (same(previousPermissions.get(requestID), permission)) continue
    events.push({ id: id("permission.asked"), type: "permission.asked", properties: permission })
  }
  if (!previous || !same(previous.status, next.status))
    events.push({
      id: id("session.status"),
      type: "session.status",
      properties: { sessionID: next.session.id, status: next.status },
    })
  return events
}

export const translateInteractiveEvent = (
  state: ProjectionState,
  event: InteractiveEvent.InteractiveEvent,
  model?: ProjectionModel,
): Result.Result<Translation, RikaProjectionError> => {
  if (event._tag === "SubmissionAdmitted" && event.submissionId)
    return Result.succeed({
      state,
      events: [
        {
          id: `rika-event:${encodeURIComponent(event.threadId)}:submission:${encodeURIComponent(event.submissionId)}`,
          type: "message.removed",
          properties: { sessionID: event.threadId, messageID: event.submissionId },
        },
      ],
    })
  if (event._tag === "ResyncRequired")
    return Result.fail(
      RikaProjectionError.make({ reason: "resync-required", message: `Thread ${event.threadId} requires resync` }),
    )
  if (event._tag === "ThreadViewSnapshot") {
    const projected = projectSnapshot(event.snapshot, model)
    return Result.succeed({
      state: { snapshot: event.snapshot, projected },
      events: eventDiff(state.projected, projected, event.snapshot.revision),
    })
  }
  if (event._tag === "ThreadViewPatch") {
    if (!state.snapshot)
      return Result.fail(
        RikaProjectionError.make({ reason: "missing-snapshot", message: "A patch arrived before its snapshot" }),
      )
    const applied = ThreadView.apply(state.snapshot, event.patch)
    if (applied._tag === "Failure")
      return Result.fail(RikaProjectionError.make({ reason: "invalid-patch", message: String(applied.failure) }))
    const projected = projectSnapshot(applied.success, model)
    return Result.succeed({
      state: { snapshot: applied.success, projected },
      events: eventDiff(state.projected, projected, applied.success.revision),
    })
  }
  if (event._tag === "TurnRetryScheduled" && state.projected) {
    const status: SessionStatus = {
      type: "retry",
      attempt: event.attempt,
      message: event.message,
      next: event.nextAt,
    }
    const projected = { ...state.projected, status }
    return Result.succeed({
      state: { ...state, projected },
      events: eventDiff(state.projected, projected, state.snapshot?.revision ?? 0),
    })
  }
  return Result.succeed({ state, events: [] })
}
