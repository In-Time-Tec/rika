import type * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Effect, Function } from "effect"

export interface RootExecution {
  readonly threadId: string
  readonly turnId: string
  readonly executionId?: string
}

export interface ExecutionReader {
  readonly inspect: ExecutionBackend.Interface["inspect"]
  readonly replay: ExecutionBackend.Interface["replay"]
}

export interface Snapshot {
  readonly turnCostUsd: ReadonlyMap<string, number>
  readonly threadCostUsd: ReadonlyMap<string, number>
  readonly globalCostUsd: number
  readonly usageCursors: ReadonlySet<string>
}

export const maximumGlobalThreads = 100

export const empty: Snapshot = {
  turnCostUsd: new Map(),
  threadCostUsd: new Map(),
  globalCostUsd: 0,
  usageCursors: new Set(),
}

export const eventCostUsd = (event: ExecutionBackend.Event): number | undefined =>
  event.type === "model.usage.reported"
    ? Transcript.project("usage", "", [{ ...event, sequence: 0 }]).costUsd
    : undefined

export const observe: {
  (input: RootExecution & { readonly event: ExecutionBackend.Event }): (snapshot: Snapshot) => Snapshot
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot
} = Function.dual(
  2,
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot => {
    const costUsd = eventCostUsd(input.event)
    if (costUsd === undefined || snapshot.usageCursors.has(input.event.cursor)) return snapshot
    const turnCostUsd = new Map(snapshot.turnCostUsd)
    const threadCostUsd = new Map(snapshot.threadCostUsd)
    turnCostUsd.set(input.turnId, (turnCostUsd.get(input.turnId) ?? 0) + costUsd)
    threadCostUsd.set(input.threadId, (threadCostUsd.get(input.threadId) ?? 0) + costUsd)
    return {
      turnCostUsd,
      threadCostUsd,
      globalCostUsd: snapshot.globalCostUsd + costUsd,
      usageCursors: new Set(snapshot.usageCursors).add(input.event.cursor),
    }
  },
)

const readExecution = <A, E>(effect: Effect.Effect<A, E>, executionId: string): Effect.Effect<A | undefined> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage-cost.execution.read.failed").pipe(
        Effect.annotateLogs("rika.execution.id", executionId),
        Effect.annotateLogs("rika.failure.cause", String(cause)),
        Effect.as(undefined),
      ),
    ),
  )

export const collect = Effect.fn("UsageCost.collect")(function* (
  reader: ExecutionReader,
  roots: ReadonlyArray<RootExecution>,
) {
  let snapshot: Snapshot = empty
  const pending = roots.map((root) => ({ ...root, executionId: root.executionId ?? root.turnId }))
  const seenExecutions = new Set<string>()
  while (pending.length > 0) {
    const current = pending.shift()!
    if (seenExecutions.has(current.executionId)) continue
    seenExecutions.add(current.executionId)
    const inspection = yield* readExecution(reader.inspect(current.executionId), current.executionId)
    if (inspection === undefined) continue
    const replay = yield* readExecution(reader.replay(current.executionId), current.executionId)
    if (replay === undefined) continue
    for (const event of replay.events)
      snapshot = observe(snapshot, {
        threadId: current.threadId,
        turnId: current.turnId,
        event,
      })
    for (const child of inspection.children) pending.push({ ...current, executionId: child.executionId })
  }
  return snapshot
})
