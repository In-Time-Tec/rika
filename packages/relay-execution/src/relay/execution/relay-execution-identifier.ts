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

const childIdFromExecutionId = (input: { readonly parentTurnId: string; readonly value: unknown }) => {
  const id = String(input.value)
  const prefix = `child:${encodeURIComponent(input.parentTurnId)}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^child:/, "")
}

const executionId = (input: { readonly turnId: string; readonly reference: ExecutionReference | undefined }) =>
  Ids.ExecutionId.make(input.reference === undefined ? `execution:${input.turnId}` : input.turnId)

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

export const threadIdFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const threadId = metadata?.rika_thread_id
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined
}

const cursorOf = (checkpoint: string | ExecutionCheckpoint | undefined) =>
  typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor

const checkpointForExecution = (input: { readonly client: Client.Interface; readonly id: Ids.ExecutionId }) =>
  Effect.gen(function* () {
    const inspection = yield* input.client.executions.inspect(input.id)
    if (inspection.last_event_cursor === undefined) return undefined
    const page = yield* input.client.executions.pageEvents({
      execution_id: input.id,
      direction: "backward",
      limit: 1,
    })
    const cursor = inspection.last_event_cursor
    const item = page.events.findLast((event) => event.cursor === cursor)
    if (item === undefined)
      return yield* BackendError.make({ message: `Execution ${String(input.id)} checkpoint is not replayable` })
    return { cursor, sequence: item.sequence }
  })

const makeChildExecutionId = (input: { readonly parentTurnId: string; readonly childId: string }) =>
  Ids.ChildExecutionId.make(encodeChildExecutionId(input.parentTurnId, input.childId))

const workflowExecutionId = (input: {
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

const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
const startSessionId = (input: Pick<StartInput, "threadId">) => sessionId(input.threadId)
const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)

export const awaitExecutionAvailable = (input: {
  readonly client: Client.Interface
  readonly id: Ids.ExecutionId
}): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    input.client.executions.get(input.id).pipe(
      Effect.flatMap((existing) =>
        existing === undefined ? Effect.sleep("25 millis").pipe(Effect.andThen(poll)) : Effect.void,
      ),
      Effect.catchTag("ClientError", () => Effect.sleep("250 millis").pipe(Effect.andThen(poll))),
    ),
  )
  return poll
}

export const awaitExecutionRunning = (input: {
  readonly client: Client.Interface
  readonly id: Ids.ExecutionId
}): Effect.Effect<void, Client.ClientError> => {
  const poll: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
    input.client.executions.get(input.id).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sleep("250 millis").pipe(Effect.andThen(poll)),
        onSuccess: (existing) => {
          if (existing?.status === "running") return Effect.void
          if (existing === undefined || existing.status === "queued")
            return Effect.sleep("25 millis").pipe(Effect.andThen(poll))
          return Effect.fail(Client.ClientError.make({ message: `Execution is not running: ${input.id}` }))
        },
      }),
    ),
  )
  return poll
}

export {
  checkpointForExecution,
  childIdFromExecutionId,
  childSessionId,
  cursorOf,
  decodeExecutionRouteMetadata,
  executionId,
  makeChildExecutionId,
  sessionId,
  startSessionId,
  workflowExecutionId,
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
