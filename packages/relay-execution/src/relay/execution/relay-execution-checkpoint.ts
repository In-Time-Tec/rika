import { Client, Ids } from "@relayfx/sdk"
import { Effect } from "effect"
import type { ExecutionCheckpoint } from "@rika/product/execution-event"
import { BackendError } from "@rika/product/execution-service"

export const cursorOf = (checkpoint: string | ExecutionCheckpoint | undefined) =>
  typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor

export const checkpointForExecution = (input: { readonly client: Client.Interface; readonly id: Ids.ExecutionId }) =>
  Effect.gen(function* () {
    const inspection = yield* input.client.executions.inspect(input.id)
    if (inspection.last_event_cursor === undefined) return undefined
    const page = yield* input.client.executions.pageEvents({ execution_id: input.id, direction: "backward", limit: 1 })
    const cursor = inspection.last_event_cursor
    const item = page.events.findLast((event) => event.cursor === cursor)
    if (item === undefined)
      return yield* BackendError.make({ message: `Execution ${String(input.id)} checkpoint is not replayable` })
    return { cursor, sequence: item.sequence }
  })
