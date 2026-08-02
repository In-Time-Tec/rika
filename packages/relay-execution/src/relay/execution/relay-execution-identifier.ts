import { decodeParentExecutionId } from "../../agent-depth"
import { attachedWorkflow, standaloneWorkflow } from "./relay-execution-workflow-id"

export const threadIdFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const threadId = metadata?.rika_thread_id
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined
}

export const turnIdFromExecutionId = (value: string): string | undefined => {
  if (value.startsWith("execution:")) {
    const id = value.slice("execution:".length)
    const separator = id.indexOf(":child:")
    return separator < 0 ? id : id.slice(0, separator)
  }
  const workflowOwner = attachedWorkflow(value)?.ownerTurnId
  if (workflowOwner !== undefined) return workflowOwner
  const parent = decodeParentExecutionId(value)
  if (parent === undefined) return undefined
  if (parent.startsWith("workflow:") || parent.startsWith("execution:") || parent.startsWith("child:"))
    return turnIdFromExecutionId(parent)
  return parent
}

export const workspaceFromExecutionId = (value: string): string | undefined => {
  const workflow = standaloneWorkflow(value)
  if (workflow !== undefined) return workflow.workspace
  const parent = decodeParentExecutionId(value)
  return parent === undefined ? undefined : workspaceFromExecutionId(parent)
}
