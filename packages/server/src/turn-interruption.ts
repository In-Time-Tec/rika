import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Effect } from "effect"
import * as ThreadLive from "./thread-live"

export const BackendRestartMessage = "turn interrupted by backend restart"
export const OrbPauseMessage = "turn interrupted by orb pause"

export type RunError =
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError

export const appendIfLatestTurnOpen = Effect.fn("TurnInterruption.appendIfLatestTurnOpen")(function* (input: {
  readonly thread_id: Ids.ThreadId
  readonly message: string
  readonly eventLog: ThreadEventLog.Interface
  readonly live?: ThreadLive.Interface
}) {
  const events = yield* input.eventLog.readThread({ thread_id: input.thread_id })
  const started = latestOpenTurn(events)
  if (started === undefined) return undefined
  const event = interruptedTurnFailed(started, (events.at(-1)?.sequence ?? 0) + 1, input.message)
  const result = yield* input.eventLog.appendIfAbsentAndProject(event)
  if (result.status === "inserted" && input.live !== undefined) yield* input.live.publish(result.event)
  return result.status === "inserted" ? result.event : undefined
})

const latestOpenTurn = (events: ReadonlyArray<Event.Event>): Event.TurnStarted | undefined => {
  let open: Event.TurnStarted | undefined
  for (const event of events) {
    if (event.type === "turn.started") open = event
    if ((event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === open?.turn_id) {
      open = undefined
    }
  }
  return open
}

const interruptedTurnFailed = (started: Event.TurnStarted, sequence: number, message: string): Event.TurnFailed => ({
  id: Ids.EventId.make(`event_${started.thread_id}_${started.turn_id}_interrupted_${sequence}`),
  thread_id: started.thread_id,
  turn_id: started.turn_id,
  sequence,
  version: started.version,
  created_at: started.created_at,
  type: "turn.failed",
  data: { error: { kind: "unknown", message } },
})
