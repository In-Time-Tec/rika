import { Ids } from "@relayfx/sdk"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { toExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import type { StartInput } from "@rika/product/execution-request"
import { childExecutionId as encodeChildExecutionId } from "../../agent-depth"

export const childIdFromExecutionId = (input: { readonly parentTurnId: string; readonly value: unknown }) => {
  const id = String(input.value)
  const prefix = `child:${encodeURIComponent(input.parentTurnId)}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^child:/, "")
}

export const executionId = (input: { readonly turnId: string; readonly reference: ExecutionReference | undefined }) =>
  Ids.ExecutionId.make(input.reference === undefined ? `execution:${input.turnId}` : input.turnId)

export const decodeExecutionRouteMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): ExecutionRoutePin | undefined => {
  const route = metadata?.rika_execution_route
  try {
    return route === undefined ? undefined : toExecutionRouteSnapshot(route)
  } catch {
    return undefined
  }
}

export const makeChildExecutionId = (input: { readonly parentTurnId: string; readonly childId: string }) =>
  Ids.ChildExecutionId.make(encodeChildExecutionId(input.parentTurnId, input.childId))

export const workflowExecutionId = (input: {
  readonly runId: string
  readonly ownerTurnId: string | undefined
  readonly workspace: string | undefined
}) => {
  if (input.ownerTurnId !== undefined)
    return Ids.ExecutionId.make(
      `workflow:turn:${encodeURIComponent(input.ownerTurnId)}:run:${encodeURIComponent(input.runId)}`,
    )
  if (input.workspace !== undefined)
    return Ids.ExecutionId.make(
      `workflow:workspace:${encodeURIComponent(input.workspace)}:run:${encodeURIComponent(input.runId)}`,
    )
  return Ids.ExecutionId.make(`workflow:${input.runId}`)
}

export const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
export const startSessionId = (input: Pick<StartInput, "threadId">) => sessionId(input.threadId)
export const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)
