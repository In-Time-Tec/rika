import type * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Effect, Function } from "effect"

export interface RootExecution {
  readonly threadId: string
  readonly turnId: string
  readonly executionId?: string
  readonly optional?: boolean
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
  readonly complete: boolean
}

export const maximumGlobalThreads = 100
const collectionConcurrency = 1

export const empty: Snapshot = {
  turnCostUsd: new Map(),
  threadCostUsd: new Map(),
  globalCostUsd: 0,
  usageCursors: new Set(),
  complete: true,
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
    if (snapshot.usageCursors.has(input.event.cursor)) return snapshot
    if (costUsd === undefined)
      return input.event.type === "model.usage.reported" ? { ...snapshot, complete: false } : snapshot
    const turnCostUsd = new Map(snapshot.turnCostUsd)
    const threadCostUsd = new Map(snapshot.threadCostUsd)
    turnCostUsd.set(input.turnId, (turnCostUsd.get(input.turnId) ?? 0) + costUsd)
    threadCostUsd.set(input.threadId, (threadCostUsd.get(input.threadId) ?? 0) + costUsd)
    return {
      turnCostUsd,
      threadCostUsd,
      globalCostUsd: snapshot.globalCostUsd + costUsd,
      usageCursors: new Set(snapshot.usageCursors).add(input.event.cursor),
      complete: snapshot.complete,
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
  let snapshot: Snapshot = { ...empty }
  const pending = roots.map((root) => ({ ...root, executionId: root.executionId ?? root.turnId }))
  const seenExecutions = new Set<string>()
  while (pending.length > 0) {
    const batch = pending.splice(0).filter((current) => {
      if (seenExecutions.has(current.executionId)) return false
      seenExecutions.add(current.executionId)
      return true
    })
    const results = yield* Effect.forEach(
      batch,
      (current) =>
        Effect.gen(function* () {
          const inspection = yield* readExecution(reader.inspect(current.executionId), current.executionId)
          if (inspection === undefined) return { current, inspection }
          const replay = yield* readExecution(reader.replay(current.executionId), current.executionId)
          return { current, inspection, replay }
        }),
      { concurrency: collectionConcurrency },
    )
    for (const { current, inspection, replay } of results) {
      if (inspection === undefined) {
        if (current.optional !== true) Object.assign(snapshot, { complete: false })
        continue
      }
      if (replay === undefined) {
        Object.assign(snapshot, { complete: false })
        continue
      }
      for (const event of replay.events)
        snapshot = observe(snapshot, {
          threadId: current.threadId,
          turnId: current.turnId,
          event,
        })
      for (const child of inspection.children) pending.push({ ...current, executionId: child.executionId })
    }
  }
  return snapshot
})
