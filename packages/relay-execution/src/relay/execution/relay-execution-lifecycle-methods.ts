import { awaitExecutionAvailable } from "./relay-execution-wait"
import { checkpointForExecution } from "./relay-execution-checkpoint"
import { error } from "./relay-event-payload"
import { event } from "./relay-event-state"
import { Client, Ids, type Execution } from "@relayfx/sdk"
import { Clock, Effect, Schema } from "effect"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import { BackendError } from "@rika/product/execution-service"
import { Status } from "@rika/product/execution-status"
import * as Identifier from "./relay-execution-identifier"
import * as IdentifierCodec from "./relay-execution-id-codec"
import * as Tree from "./relay-execution-tree"

const InvocationProfile = Schema.Literals([
  "Root",
  "Title",
  "Task",
  "Oracle",
  "Librarian",
  "Review",
  "Surgeon",
  "ReadThread",
])

export const lifecycleMethods = (client: Client.Interface) => ({
  cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId: string, reference: ExecutionReference | undefined) {
    return yield* Effect.gen(function* () {
      const id = IdentifierCodec.executionId({ turnId, reference })
      yield* awaitExecutionAvailable({ client, id }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(Client.ClientError.make({ message: "Execution did not become available for cancellation" })),
        }),
      )
      const cancelledAt = yield* Clock.currentTimeMillis
      const accepted = yield* client.executions.cancel({ execution_id: id, cancelled_at: cancelledAt })
      const tree = yield* Tree.executionTreeIds({ client, root: id })
      yield* Tree.cancelOutlivingChildren({ client, root: id, cancelledAt, knownTree: tree })
      const replay = yield* client.executions.replay({ execution_id: id })
      const events = replay.events.map(event)
      const checkpoint = yield* checkpointForExecution({ client, id })
      return {
        turnId,
        status: Status.make(accepted.status),
        events,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }
    }).pipe(Effect.mapError(error))
  }),
  inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId: string, reference: ExecutionReference | undefined) {
    const id = IdentifierCodec.executionId({ turnId, reference })
    const existing = yield* client.executions.get(id)
    if (existing === undefined) return undefined
    return yield* client.executions.inspect(id).pipe(
      Effect.map((value) => ({
        turnId,
        status: Status.make(value.status),
        ...(existing.created_at === undefined ? {} : { createdAt: existing.created_at }),
        ...(value.last_event_cursor === undefined ? {} : { lastCursor: value.last_event_cursor }),
        waits: value.waiting_on.map((wait) => ({
          id: wait.wait_id,
          mode: wait.mode,
          createdAt: wait.created_at,
        })),
        pendingTools: value.pending_tool_calls.map((tool) => ({
          callId: tool.tool_call_id,
          name: tool.tool_name,
          input: tool.input,
          requestedAt: tool.requested_at,
        })),
        children: value.child_runs.map((child) => ({
          executionId: child.child_execution_id,
          status: Status.make(child.status),
        })),
      })),
    )
  }, Effect.mapError(error)),
  resolveInvocationSource: Effect.fn("ExecutionBackend.resolveInvocationSource")(function* (requestedId: string) {
    return yield* Effect.gen(function* () {
      const visited = new Set<string>()
      const found = yield* client.executions.get(Ids.ExecutionId.make(requestedId))
      if (found === undefined) return yield* BackendError.make({ message: "ExecutionNotFound" })
      const source = found
      let current: Execution.Execution = found
      while (true) {
        const id = String(current.id)
        if (visited.has(id)) return yield* BackendError.make({ message: "Malformed execution ancestry" })
        visited.add(id)
        const parentId: unknown = current.metadata?.parent_execution_id
        if (typeof parentId !== "string") break
        const parent: Execution.Execution | undefined = yield* client.executions.get(Ids.ExecutionId.make(parentId))
        if (parent === undefined) return yield* BackendError.make({ message: `Missing parent execution ${parentId}` })
        current = parent
      }
      const rootExecution = current.metadata?.rika_execution_id
      const threadId = Identifier.threadIdFromMetadata(current.metadata)
      const depth = source.metadata?.rika_agent_depth
      const profile = source.metadata?.product_profile
      if (
        typeof rootExecution !== "string" ||
        !rootExecution.startsWith("execution:") ||
        threadId === undefined ||
        typeof depth !== "number" ||
        !Number.isInteger(depth) ||
        depth < 0 ||
        (depth > 0 && typeof profile !== "string")
      )
        return yield* BackendError.make({ message: `Malformed invocation provenance for ${requestedId}` })
      const callerProfile: unknown = depth === 0 ? "Root" : profile
      if (!Schema.is(InvocationProfile)(callerProfile))
        return yield* BackendError.make({ message: `Malformed invocation profile for ${requestedId}` })
      return {
        rootTurnId: rootExecution.slice("execution:".length),
        threadId,
        callerProfile,
        threadCreationDepth: depth,
      }
    }).pipe(Effect.mapError(error))
  }),
})
