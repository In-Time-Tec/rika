import type { Stream } from "effect"

export type Status = "connecting" | "connected" | "reconnecting"

export interface Connection {
  readonly initialStatus: Status
  readonly statusChanges: Stream.Stream<Status>
}
