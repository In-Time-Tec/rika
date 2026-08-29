import { Schema } from "effect"

export const HostedPersistenceFailure = Schema.Literals([
  "not-found",
  "conflict",
  "stale-version",
  "invalid-authority",
  "lease-unavailable",
  "stale-fence",
  "database",
])
export type HostedPersistenceFailure = typeof HostedPersistenceFailure.Type

export class HostedPersistenceError extends Schema.TaggedError<HostedPersistenceError>()("HostedPersistenceError", {
  reason: HostedPersistenceFailure,
  message: Schema.String,
}) {}
