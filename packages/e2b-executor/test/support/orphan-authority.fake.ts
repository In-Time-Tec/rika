import type { ExecutorAssignment } from "@rika/product/executor-assignment"

interface AssignmentState {
  readonly assignments: Map<string, ExecutorAssignment>
}

const boundToProvider = (current: AssignmentState, providerInstanceId: string) =>
  [...current.assignments.values()].find((assignment) => {
    const lifecycle = assignment.lifecycle
    return (
      (lifecycle._tag === "Provisioning" ||
        lifecycle._tag === "AwaitingBootstrap" ||
        lifecycle._tag === "Active" ||
        lifecycle._tag === "Paused") &&
      lifecycle.providerInstanceId === providerInstanceId
    )
  })

const identifiedAssignment = (current: AssignmentState, assignmentId?: string) =>
  assignmentId === undefined ? undefined : current.assignments.get(assignmentId)

export const orphanAuthorityFake = {
  inspect: (
    current: AssignmentState,
    input: { readonly providerInstanceId: string; readonly assignmentId?: string; readonly generation?: string },
    now: string,
  ) => {
    const bound = boundToProvider(current, input.providerInstanceId)
    const identified = identifiedAssignment(current, input.assignmentId)
    const matched = identified?.generation === input.generation ? identified : undefined
    const assignment = bound ?? matched
    if (assignment === undefined)
      return identified === undefined ? ({ status: "preserved" } as const) : ({ status: "candidate" } as const)
    const lifecycle = assignment.lifecycle
    if (lifecycle._tag === "Active" || lifecycle._tag === "Paused")
      return bound === undefined ? ({ status: "candidate" } as const) : ({ status: "preserved" } as const)
    if (lifecycle._tag === "Terminated") return { status: "candidate" } as const
    if (
      (lifecycle._tag === "Provisioning" || lifecycle._tag === "AwaitingBootstrap") &&
      lifecycle.bootstrapExpiresAt > now
    )
      return lifecycle.providerInstanceId === null || bound !== undefined
        ? ({ status: "preserved" } as const)
        : ({ status: "candidate" } as const)
    return { status: "candidate", retire: assignment } as const
  },
}
