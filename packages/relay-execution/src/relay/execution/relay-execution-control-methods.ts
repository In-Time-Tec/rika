import { Client, Content, Ids, type Execution } from "@relayfx/sdk"
import { Clock, Effect, Schema } from "effect"
import { BackendError } from "@rika/product/execution-service"
import type { OpenRootExecution, ExecutionReference } from "@rika/product/execution-identifier"
import { Status } from "@rika/product/execution-status"
import * as Identifier from "./relay-execution-identifier"
import * as Mapping from "./relay-event-mapping"
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
const ExecutionIdentifier = Identifier
const ExecutionMapping = Mapping
const ExecutionTree = Tree
const turnIdFromExecutionId = Identifier.turnIdFromExecutionId

export const controlMethods = (client: Client.Interface) => ({
  replay: Effect.fn("ExecutionBackend.replay")(function* (
    turnId: string,
    afterCursor: string | import("@rika/product/execution-event").ExecutionCheckpoint | undefined,
    reference: ExecutionReference | undefined,
  ) {
    const id = ExecutionIdentifier.executionId({ turnId, reference })
    const cursor = ExecutionIdentifier.cursorOf(afterCursor)
    return yield* client.executions
      .replay({
        execution_id: id,
        ...(cursor === undefined ? {} : { after_cursor: cursor }),
      })
      .pipe(
        Effect.flatMap((result) =>
          ExecutionIdentifier.checkpointForExecution({ client, id }).pipe(
            Effect.map((checkpoint) => ({ result, checkpoint })),
          ),
        ),
        Effect.map(({ result, checkpoint }) => {
          const events = result.events.map(ExecutionMapping.event)
          return {
            turnId,
            status: ExecutionMapping.statusFromEvents(events),
            events,
            ...(checkpoint === undefined ? {} : { checkpoint }),
          }
        }),
        Effect.mapError(ExecutionMapping.error),
      )
  }),
  pageEvents: Effect.fn("ExecutionBackend.pageEvents")(function* (
    turnId: string,
    direction: "forward" | "backward",
    cursor: string | undefined,
    limit: number | undefined,
    reference: ExecutionReference | undefined,
  ) {
    const cursorPage: { after_cursor?: string; before_cursor?: string } = {}
    if (cursor !== undefined) {
      if (direction === "forward") cursorPage.after_cursor = cursor
      else cursorPage.before_cursor = cursor
    }
    return yield* client.executions
      .pageEvents({
        execution_id: ExecutionIdentifier.executionId({ turnId, reference }),
        direction,
        ...cursorPage,
        ...(limit === undefined ? {} : { limit }),
      })
      .pipe(
        Effect.map((result) => ({
          events: result.events.map(ExecutionMapping.event),
          hasMore: result.has_more,
          ...(result.oldest_cursor === undefined ? {} : { oldestCursor: result.oldest_cursor }),
          ...(result.newest_cursor === undefined ? {} : { newestCursor: result.newest_cursor }),
        })),
        Effect.mapError(ExecutionMapping.error),
      )
  }),
  listOpenRootExecutions: Effect.gen(function* () {
    const roots: Array<OpenRootExecution> = []
    let cursor: string | undefined
    do {
      const page = yield* client.executions
        .list({
          statuses: ["queued", "running", "waiting"],
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(Effect.mapError(ExecutionMapping.error))
      for (const record of page.records) {
        const turnId = turnIdFromExecutionId(String(record.execution_id))
        if (turnId === undefined) continue
        roots.push({
          executionId: String(record.execution_id),
          turnId,
          createdAt: record.created_at,
        })
      }
      cursor = page.next_cursor
    } while (cursor !== undefined)
    return roots
  }).pipe(Effect.withSpan("ExecutionBackend.listOpenRootExecutions")),
  cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId: string, reference: ExecutionReference | undefined) {
    return yield* Effect.gen(function* () {
      const id = ExecutionIdentifier.executionId({ turnId, reference })
      yield* ExecutionIdentifier.awaitExecutionAvailable({ client, id }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(Client.ClientError.make({ message: "Execution did not become available for cancellation" })),
        }),
      )
      const cancelledAt = yield* Clock.currentTimeMillis
      const accepted = yield* client.executions.cancel({
        execution_id: id,
        cancelled_at: cancelledAt,
      })
      const tree = yield* ExecutionTree.executionTreeIds({ client, root: id })
      yield* ExecutionTree.cancelOutlivingChildren({ client, root: id, cancelledAt, knownTree: tree })
      const replay = yield* client.executions.replay({ execution_id: id })
      const events = replay.events.map(ExecutionMapping.event)
      const checkpoint = yield* ExecutionIdentifier.checkpointForExecution({ client, id })
      return {
        turnId,
        status: Status.make(accepted.status),
        events,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }
    }).pipe(Effect.mapError(ExecutionMapping.error))
  }),
  inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId: string, reference: ExecutionReference | undefined) {
    const existing = yield* client.executions.get(ExecutionIdentifier.executionId({ turnId, reference }))
    if (existing === undefined) return undefined
    return yield* client.executions.inspect(ExecutionIdentifier.executionId({ turnId, reference })).pipe(
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
  }, Effect.mapError(ExecutionMapping.error)),
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
      const threadId = ExecutionIdentifier.threadIdFromMetadata(current.metadata)
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
    }).pipe(Effect.mapError(ExecutionMapping.error))
  }),
  steer: Effect.fn("ExecutionBackend.steer")(function* (
    turnId: string,
    text: string,
    idempotencyIdentity: string,
    reference: ExecutionReference | undefined,
  ) {
    const id = ExecutionIdentifier.executionId({ turnId, reference })
    const createdAt = yield* Clock.currentTimeMillis
    yield* ExecutionIdentifier.awaitExecutionRunning({ client, id }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(Client.ClientError.make({ message: "Execution did not become available for steering" })),
      }),
      Effect.mapError(ExecutionMapping.error),
    )
    const accepted = yield* client.executions
      .steer({
        execution_id: id,
        idempotency_key: idempotencyIdentity,
        kind: "steering",
        content: [Content.text(text)],
        created_at: createdAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause !== null && typeof cause === "object" && "_tag" in cause && cause._tag === "SteeringIdempotencyConflict"
            ? BackendError.make({
                message: "Steering idempotency identity was already used with a different semantic payload",
              })
            : ExecutionMapping.error(cause),
        ),
      )
    return {
      steeringMessageId: String(accepted.steering_message_id),
      sequence: accepted.sequence,
    }
  }),
  listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (
    turnId: string,
    reference: ExecutionReference | undefined,
  ) {
    return yield* Effect.gen(function* () {
      const ids = yield* ExecutionTree.executionTreeIds({
        client,
        root: ExecutionIdentifier.executionId({ turnId, reference }),
      })
      const approvals = yield* Effect.forEach(ids, (execution) =>
        client.tools.listPendingApprovals({ execution_id: execution }),
      )
      return approvals.flatMap((result, index) =>
        result.approvals.map((approval) => ({
          waitId: approval.wait_id,
          executionId: String(ids[index]),
          callId: approval.tool_call_id,
          toolName: approval.tool_name,
          input: approval.input,
          requestedAt: approval.requested_at,
        })),
      )
    }).pipe(Effect.mapError(ExecutionMapping.error))
  }),
  resolveToolApproval: Effect.fn("ExecutionBackend.resolveToolApproval")(function* (
    waitId: string,
    approved: boolean,
    resolvedAt: number,
    comment: string | undefined,
  ) {
    yield* client.tools
      .resolveApproval({
        wait_id: Ids.WaitId.make(waitId),
        approved,
        resolved_at: resolvedAt,
        ...(comment === undefined ? {} : { comment }),
      })
      .pipe(Effect.mapError(ExecutionMapping.error))
  }),
  resolvePermission: Effect.fn("ExecutionBackend.resolvePermission")(function* (
    waitId: string,
    answer: "Always" | "Approved" | "Denied",
    resolvedAt: number,
    reason: string | undefined,
  ) {
    yield* client.tools
      .resolvePermission({
        wait_id: Ids.WaitId.make(waitId),
        answer,
        resolved_at: resolvedAt,
        ...(reason === undefined ? {} : { reason }),
      })
      .pipe(Effect.mapError(ExecutionMapping.error))
  }),
})
