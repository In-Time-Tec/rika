import type { Execution } from "@relayfx/sdk"
import { Client, Ids } from "@relayfx/sdk"
import { Effect } from "effect"
import type { ExecutionCheckpoint } from "@rika/product/execution-event"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { toExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import type { StartInput } from "@rika/product/execution-request"
import { BackendError } from "@rika/product/execution-service"
import { ExecutionId } from "@rika/product/execution-identifier"
import { decodeParentExecutionId, childExecutionId as encodeChildExecutionId } from "../../agent-depth"

const attachedWorkflow = (value: string) => {
  const match = /^workflow:turn:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { ownerTurnId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}

const standaloneWorkflow = (value: string) => {
  const match = /^workflow:workspace:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { workspace: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}

const childIdFromExecutionId = (parentTurnId: string, value: unknown) => {
  const id = String(value)
  const prefix = `child:${encodeURIComponent(parentTurnId)}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^child:/, "")
}

const executionId = (turnId: string, reference?: ExecutionReference) =>
  Ids.ExecutionId.make(reference === undefined ? `execution:${turnId}` : turnId)

const decodeExecutionRouteMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): ExecutionRoutePin | undefined => {
  const route = metadata?.rika_execution_route
  try {
    return route === undefined ? undefined : toExecutionRouteSnapshot(route)
  } catch {
    return undefined
  }
}

const threadIdFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const threadId = metadata?.rika_thread_id
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined
}

const cursorOf = (checkpoint: string | ExecutionCheckpoint | undefined) =>
  typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor

const checkpointForExecution = (client: Client.Interface, id: Ids.ExecutionId) =>
  Effect.gen(function* () {
    const inspection = yield* client.executions.inspect(id)
    if (inspection.last_event_cursor === undefined) return undefined
    const page = yield* client.executions.pageEvents({ execution_id: id, direction: "backward", limit: 1 })
    const cursor = inspection.last_event_cursor
    const item = page.events.findLast((event) => event.cursor === cursor)
    if (item === undefined)
      return yield* BackendError.make({ message: `Execution ${String(id)} checkpoint is not replayable` })
    return { cursor, sequence: item.sequence }
  })

const makeChildExecutionId = (parentTurnId: string, childId: string) =>
  Ids.ChildExecutionId.make(encodeChildExecutionId(parentTurnId, childId))

const workflowExecutionId = (runId: string, ownerTurnId?: string, workspace?: string) => {
  if (ownerTurnId !== undefined)
    return Ids.ExecutionId.make(`workflow:turn:${encodeURIComponent(ownerTurnId)}:run:${encodeURIComponent(runId)}`)
  if (workspace !== undefined)
    return Ids.ExecutionId.make(`workflow:workspace:${encodeURIComponent(workspace)}:run:${encodeURIComponent(runId)}`)
  return Ids.ExecutionId.make(`workflow:${runId}`)
}

const turnIdFromExecutionId = (value: string): string | undefined => {
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

const workspaceFromExecutionId = (value: string): string | undefined => {
  const workflow = standaloneWorkflow(value)
  if (workflow !== undefined) return workflow.workspace
  const parent = decodeParentExecutionId(value)
  return parent === undefined ? undefined : workspaceFromExecutionId(parent)
}

const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
const startSessionId = (input: Pick<StartInput, "threadId">) => sessionId(input.threadId)
const childSessionId = (childExecutionId: Ids.ChildExecutionId) => Ids.SessionId.make(`session:child:${String(childExecutionId)}`)

export const awaitExecutionAvailable = (client: Client.Interface, id: Ids.ExecutionId): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    client.executions.get(id).pipe(
      Effect.flatMap((existing) =>
        existing === undefined ? Effect.sleep("25 millis").pipe(Effect.andThen(poll)) : Effect.void,
      ),
      Effect.catchTag("ClientError", () => Effect.sleep("250 millis").pipe(Effect.andThen(poll))),
    ),
  )
  return poll
}

export const awaitExecutionRunning = (
  client: Client.Interface,
  id: Ids.ExecutionId,
): Effect.Effect<void, Client.ClientError> => {
  const poll: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
    client.executions.get(id).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sleep("250 millis").pipe(Effect.andThen(poll)),
        onSuccess: (existing) => {
          if (existing?.status === "running") return Effect.void
          if (existing === undefined || existing.status === "queued")
            return Effect.sleep("25 millis").pipe(Effect.andThen(poll))
          return Effect.fail(Client.ClientError.make({ message: `Execution is not running: ${id}` }))
        },
      }),
    ),
  )
  return poll
}


export const ExecutionIdentifiers = {
  attachedWorkflow,
  awaitExecutionAvailable,
  awaitExecutionRunning,
  checkpointForExecution,
  childIdFromExecutionId,
  childSessionId,
  cursorOf,
  decodeExecutionRouteMetadata,
  executionId,
  makeChildExecutionId,
  sessionId,
  startSessionId,
  standaloneWorkflow,
  threadIdFromMetadata,
  turnIdFromExecutionId,
  workflowExecutionId,
  workspaceFromExecutionId,
}

export type ExecutionIdentifierOperations = typeof ExecutionIdentifiers
export type { ExecutionId }
