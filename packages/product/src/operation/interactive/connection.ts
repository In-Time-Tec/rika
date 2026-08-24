import type { Stream } from "effect"

export type Connectivity = "connecting" | "connected" | "reconnecting"
export type ExecutionTarget = "resolving" | "runner" | "orb"
export type Activity =
  | "authenticating"
  | "executor-waiting"
  | "executor-connecting"
  | "executor-connected"
  | "workspace-preparing"
  | "workspace-setup"
  | "workspace-resuming"
  | "lease-active"
  | "retrying"
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
}

export interface Connection {
  readonly initialState: State
  readonly stateChanges: Stream.Stream<State>
}
