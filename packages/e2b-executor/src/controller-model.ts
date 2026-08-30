import type { ExecutorAssignment, OrbPlacement } from "@rika/product/executor-assignment"
import type { AssignmentError } from "@rika/product/executor-assignments"
import type * as HostedObservability from "@rika/product/hosted-observability"
import { DateTime, Effect } from "effect"
import type { ProviderError } from "./provider"
import { type Assignment, ControllerError } from "./controller-contract"

export const assignmentFailureKind = (cause: AssignmentError): ControllerError["kind"] => {
  if (cause.reason === "not-found") return "assignment-missing"
  if (cause.reason === "stale-fence") return "fenced"
  if (cause.reason === "authentication") return "authentication"
  if (cause.reason === "database") return "repository"
  return "assignment-conflict"
}

export const assignmentFailure = (cause: AssignmentError) =>
  ControllerError.make({ kind: assignmentFailureKind(cause), message: cause.message })

export const providerFailure = (cause: ProviderError) =>
  ControllerError.make({ kind: "provider", message: `${cause.operation}: ${cause.message}` })

export const failures = {
  make: (kind: ControllerError["kind"], message: string) => ControllerError.make({ kind, message }),
}
export const epochMillis = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))
export const number = (value: string) => Number(value)

export const orbPlacement = (assignment: ExecutorAssignment): Effect.Effect<OrbPlacement, ControllerError> =>
  assignment.placement._tag === "OrbPlacement"
    ? Effect.succeed(assignment.placement)
    : Effect.fail(failures.make("fenced", "Assignment placement is not an Orb"))

export const providerInstanceId = (assignment: ExecutorAssignment): string | undefined => {
  const lifecycle = assignment.lifecycle
  if (
    lifecycle._tag === "Provisioning" ||
    lifecycle._tag === "AwaitingBootstrap" ||
    lifecycle._tag === "Active" ||
    lifecycle._tag === "Paused"
  )
    return lifecycle.providerInstanceId ?? undefined
  return undefined
}

interface AssignmentCorrelation {
  ownerId: ExecutorAssignment["ownerId"]
  threadId: ExecutorAssignment["threadId"]
  assignmentId: ExecutorAssignment["id"]
  sandboxId?: string
  buildId?: string
}

export interface ExecutorEnvironment {
  [name: string]: string
}

export const assignmentCorrelation = (assignment: ExecutorAssignment): HostedObservability.Correlation => {
  const sandboxId = providerInstanceId(assignment)
  const correlation: AssignmentCorrelation = {
    ownerId: assignment.ownerId,
    threadId: assignment.threadId,
    assignmentId: assignment.id,
  }
  if (sandboxId !== undefined) correlation.sandboxId = sandboxId
  if (assignment.placement._tag === "OrbPlacement") correlation.buildId = assignment.placement.templateBuildId
  return correlation
}

export const publicAssignment = (assignment: ExecutorAssignment): Assignment => {
  const lifecycle = assignment.lifecycle
  let state: Assignment["state"] = "provisioning"
  if (lifecycle._tag === "Active") state = "running"
  if (lifecycle._tag === "Paused") state = "paused"
  if (lifecycle._tag === "Terminated") state = "terminated"
  const templateBuildId = assignment.placement._tag === "OrbPlacement" ? assignment.placement.templateBuildId : ""
  const sandboxId = providerInstanceId(assignment)
  const result: Assignment = {
    assignmentId: assignment.id,
    threadId: assignment.threadId,
    generation: number(assignment.generation),
    templateBuildId,
    state,
    cursor: { sequence: number(assignment.cursor.sequence), value: assignment.cursor.value },
  }
  if (sandboxId === undefined) return result
  return { ...result, sandboxId }
}

export const version = (assignment: ExecutorAssignment) => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})
