import { checkpointForExecution, cursorOf } from "./relay-execution-checkpoint"
import { error } from "./relay-event-payload"
import { event, statusFromEvents } from "./relay-event-state"
import { Client } from "@relayfx/sdk"
import { Effect } from "effect"
import type { OpenRootExecution, ExecutionReference } from "@rika/product/execution-identifier"
import * as Identifier from "./relay-execution-identifier"
import * as IdentifierCodec from "./relay-execution-id-codec"

export const historyMethods = (client: Client.Interface) => ({
  replay: Effect.fn("ExecutionBackend.replay")(function* (
    turnId: string,
    afterCursor: string | import("@rika/product/execution-event").ExecutionCheckpoint | undefined,
    reference: ExecutionReference | undefined,
  ) {
    const id = IdentifierCodec.executionId({ turnId, reference })
    const cursor = cursorOf(afterCursor)
    return yield* client.executions
      .replay({
        execution_id: id,
        ...(cursor === undefined ? {} : { after_cursor: cursor }),
      })
      .pipe(
        Effect.flatMap((result) =>
          checkpointForExecution({ client, id }).pipe(Effect.map((checkpoint) => ({ result, checkpoint }))),
        ),
        Effect.map(({ result, checkpoint }) => {
          const events = result.events.map(event)
          return {
            turnId,
            status: statusFromEvents(events),
            events,
            ...(checkpoint === undefined ? {} : { checkpoint }),
          }
        }),
        Effect.mapError(error),
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
        execution_id: IdentifierCodec.executionId({ turnId, reference }),
        direction,
        ...cursorPage,
        ...(limit === undefined ? {} : { limit }),
      })
      .pipe(
        Effect.map((result) => ({
          events: result.events.map(event),
          hasMore: result.has_more,
          ...(result.oldest_cursor === undefined ? {} : { oldestCursor: result.oldest_cursor }),
          ...(result.newest_cursor === undefined ? {} : { newestCursor: result.newest_cursor }),
        })),
        Effect.mapError(error),
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
        .pipe(Effect.mapError(error))
      for (const record of page.records) {
        const turnId = Identifier.turnIdFromExecutionId(String(record.execution_id))
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
})
