import { Client, Ids } from "@relayfx/sdk"
import { Cause, Clock, Effect } from "effect"
import { isExecutionNotFound } from "./relay-event-state"
import { terminalExecutionStatus, outlivedParentReason } from "./relay-recovery-policy"

export const executionTreeIds = (input: { readonly client: Client.Interface; readonly root: Ids.ExecutionId }) =>
  Effect.gen(function* () {
    const pending = [input.root]
    const seen = new Set<string>()
    const ids: Array<Ids.ExecutionId> = []
    while (pending.length > 0) {
      const current = pending.shift()!
      if (seen.has(String(current))) continue
      seen.add(String(current))
      ids.push(current)
      const inspection = yield* input.client.executions.inspect(current)
      for (const child of inspection.child_runs) pending.push(Ids.ExecutionId.make(String(child.child_execution_id)))
    }
    return ids
  })

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

export const cancelOutlivingChildren = (input: {
  readonly client: Client.Interface
  readonly root: Ids.ExecutionId
  readonly cancelledAt?: number
  readonly knownTree?: ReadonlyArray<Ids.ExecutionId>
}) =>
  Effect.gen(function* () {
    const ids = (input.knownTree ?? (yield* executionTreeIds({ client: input.client, root: input.root }))).slice(1)
    const live: Array<Ids.ExecutionId> = []
    for (const id of ids) {
      const inspection = yield* input.client.executions.inspect(id)
      if (!terminalExecutionStatus(inspection.status)) live.push(id)
    }
    if (live.length === 0) return
    const cancellationTime = input.cancelledAt ?? (yield* Clock.currentTimeMillis)
    yield* Effect.logWarning("execution.subagents.outlived_parent").pipe(
      Effect.annotateLogs({ "rika.execution.id": String(input.root), "rika.subagent.count": live.length }),
    )
    yield* Effect.forEach(
      live.toReversed(),
      (id) =>
        input.client.executions.cancel({
          execution_id: id,
          cancelled_at: cancellationTime,
          reason: outlivedParentReason,
        }),
      { concurrency: 1, discard: true },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("execution.subagents.cancel_failed").pipe(
        Effect.annotateLogs({
          "rika.execution.id": String(input.root),
          "rika.failure.kind": failureKind(cause),
          "rika.execution.not_found": isExecutionNotFound(Cause.squash(cause)),
        }),
      ),
    ),
  )

export const isActionableChild = (mode: string) => mode === "child"
