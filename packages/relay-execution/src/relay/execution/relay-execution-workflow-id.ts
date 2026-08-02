export const attachedWorkflow = (value: string) => {
  const match = /^workflow:turn:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { ownerTurnId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}

export const standaloneWorkflow = (value: string) => {
  const match = /^workflow:workspace:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { workspace: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}
