import type { Stream } from "effect"

export type Status =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "authenticating"
  | "personal-owner"
  | "organization-owner"
  | "local-placement"
  | "e2b-placement"
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
  | "presence"

export interface Connection {
  readonly initialStatus: Status
  readonly statusChanges: Stream.Stream<Status>
}
