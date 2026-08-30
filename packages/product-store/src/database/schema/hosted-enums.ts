import { pgEnum } from "drizzle-orm/pg-core"

export const rikaHostedGrantRole = pgEnum("rika_hosted_grant_role", ["viewer", "controller", "operator", "owner"])

export const rikaHostedRepositoryPublicationState = pgEnum("rika_hosted_repository_publication_state", [
  "approved",
  "pushing",
  "pushed",
  "completed",
  "failed",
  "unknown",
])

export const rikaHostedPresenceStatus = pgEnum("rika_hosted_presence_status", ["viewing", "controlling", "away"])

export const rikaHostedPreparationState = pgEnum("rika_hosted_preparation_state", ["preparing", "ready", "failed"])

export const rikaHostedPreparationPhase = pgEnum("rika_hosted_preparation_phase", [
  "checkout",
  "setup",
  "resume",
  "capabilities",
])

export const rikaHostedExecutorKind = pgEnum("rika_hosted_executor_kind", ["runner", "orb"])

export const rikaHostedAssignmentLifecycle = pgEnum("rika_hosted_assignment_lifecycle", [
  "pending",
  "provisioning",
  "awaiting_bootstrap",
  "active",
  "paused",
  "terminated",
])

export const rikaHostedRunnerOperationState = pgEnum("rika_hosted_runner_operation_state", [
  "accepted",
  "dispatched",
  "completed",
  "unknown",
])
