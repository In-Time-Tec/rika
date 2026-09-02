import type { Stream } from "effect"

export type Connectivity = "connecting" | "connected" | "reconnecting" | "disconnected"
export type ExecutionTarget = "resolving" | "runner" | "orb"
export type Activity =
  | "authenticating"
  | "executor-waiting"
  | "executor-connected"
  | "sandbox-preparing"
  | "sandbox-waking"
  | "prompt-waiting"
  | "workspace-failed"
  | "approval-required"
  | "unknown-operation"
  | "terminal"
export type Ownership = "personal" | "organization"

export interface State {
  readonly connectivity: Connectivity
  readonly target: ExecutionTarget
  readonly activity?: Activity
  readonly ownership?: Ownership
  readonly participants: number
  /** Reason for a terminal `disconnected` state; absent while connected or reconnecting. */
  readonly errorMessage?: string
}

export interface Connection {
  readonly initialState: State
  readonly stateChanges: Stream.Stream<State>
}
