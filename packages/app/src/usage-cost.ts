import * as ExecutionBackend from "@rika/runtime/contract"
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
  readonly attempts: ReadonlyMap<string, AttemptCost>
  readonly collectionComplete: boolean
}

interface AttemptCost {
  readonly threadId: string
  readonly turnId: string
  readonly estimate: "absent" | "valid" | "invalid"
  readonly estimateAmount?: number
  readonly provider: "absent" | "valid" | "invalid"
  readonly providerAmount?: number
}

export const maximumGlobalThreads = 100
const collectionConcurrency = 1

export const empty: Snapshot = {
  turnCostUsd: new Map(),
  threadCostUsd: new Map(),
  globalCostUsd: 0,
  usageCursors: new Set(),
  complete: true,
  attempts: new Map(),
  collectionComplete: true,
}

export const eventCostUsd = (event: ExecutionBackend.Event): number | undefined =>
  event.type === "model.usage.reported"
    ? Transcript.project("usage", "", [{ ...event, sequence: 0 }]).costUsd
    : undefined

const stringField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = data?.[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const pricedAttempt = (attempt: AttemptCost): number | undefined => {
  if (attempt.provider === "valid") return attempt.providerAmount
  if (attempt.provider !== "absent" || attempt.estimate !== "valid") return undefined
  return attempt.estimateAmount
}

const invalidEstimate = (previous: AttemptCost): AttemptCost => {
  const { estimateAmount: _, ...attempt } = previous
  return { ...attempt, estimate: "invalid" }
}

const mergeEstimate = (previous: AttemptCost, estimateAmount: number | undefined): AttemptCost => {
  if (previous.estimate === "invalid" || estimateAmount === undefined) return invalidEstimate(previous)
  if (previous.estimate === "absent") return { ...previous, estimate: "valid", estimateAmount }
  return previous.estimateAmount === estimateAmount ? previous : invalidEstimate(previous)
}

const invalidProvider = (previous: AttemptCost): AttemptCost => {
  const { providerAmount: _, ...attempt } = previous
  return { ...attempt, provider: "invalid" }
}

const mergeProvider = (previous: AttemptCost, providerAmount: number | undefined): AttemptCost => {
  if (previous.provider === "invalid" || providerAmount === undefined) return invalidProvider(previous)
  if (previous.provider === "absent") return { ...previous, provider: "valid", providerAmount }
  return previous.providerAmount === providerAmount ? previous : invalidProvider(previous)
}

const totals = (attempts: ReadonlyMap<string, AttemptCost>, collectionComplete: boolean) => {
  const turnCostUsd = new Map<string, number>()
  const threadCostUsd = new Map<string, number>()
  let globalCostUsd = 0
  let complete = collectionComplete
  for (const attempt of attempts.values()) {
    const cost = pricedAttempt(attempt)
    if (cost === undefined) {
      complete = false
      continue
    }
    turnCostUsd.set(attempt.turnId, (turnCostUsd.get(attempt.turnId) ?? 0) + cost)
    threadCostUsd.set(attempt.threadId, (threadCostUsd.get(attempt.threadId) ?? 0) + cost)
    globalCostUsd += cost
  }
  return { turnCostUsd, threadCostUsd, globalCostUsd, complete }
}

export const observe: {
  (input: RootExecution & { readonly event: ExecutionBackend.Event }): (snapshot: Snapshot) => Snapshot
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot
} = Function.dual(
  2,
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot => {
    if (input.event.type !== "model.usage.reported" && input.event.type !== "model.attempt.completed") return snapshot
    if (
      input.event.executionId === undefined ||
      input.event.executionId.length === 0 ||
      input.event.id === undefined ||
      input.event.id.length === 0
    )
      return { ...snapshot, complete: false, collectionComplete: false }
    const deliveryKey = `${input.event.executionId}\u0000${input.event.id}`
    if (snapshot.usageCursors.has(deliveryKey)) return snapshot
    const attemptId = stringField(input.event.data, "model_attempt_id")
    if (attemptId === undefined) return { ...snapshot, complete: false, collectionComplete: false }
    const attemptKey = `${input.event.executionId}\u0000${attemptId}`
    const previous = snapshot.attempts.get(attemptKey) ?? {
      threadId: input.threadId,
      turnId: input.turnId,
      estimate: "absent" as const,
      provider: "absent" as const,
    }
    let attempt: AttemptCost
    if (input.event.type === "model.usage.reported") {
      attempt = mergeEstimate(previous, eventCostUsd(input.event))
    } else if (input.event.data !== undefined && Object.hasOwn(input.event.data, "cost")) {
      const cost = input.event.data.cost
      const valid =
        cost !== null &&
        typeof cost === "object" &&
        typeof (cost as { amount?: unknown }).amount === "number" &&
        Number.isFinite((cost as { amount: number }).amount) &&
        (cost as { amount: number }).amount >= 0 &&
        (cost as { currency?: unknown }).currency === "USD"
      const providerAmount = valid ? (cost as { amount: number }).amount : undefined
      attempt = mergeProvider(previous, providerAmount)
    } else {
      attempt = previous
    }
    const attempts = new Map(snapshot.attempts).set(attemptKey, attempt)
    return {
      ...snapshot,
      ...totals(attempts, snapshot.collectionComplete),
      attempts,
      usageCursors: new Set(snapshot.usageCursors).add(deliveryKey),
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
  const pending = roots.map((root) => ({ ...root, executionId: root.executionId ?? root.turnId, reference: false }))
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
          const reference = current.reference ? ExecutionBackend.executionReference : undefined
          const inspection = yield* readExecution(reader.inspect(current.executionId, reference), current.executionId)
          if (inspection === undefined) return { current, inspection }
          const replay = yield* readExecution(
            reader.replay(current.executionId, undefined, reference),
            current.executionId,
          )
          return { current, inspection, replay }
        }),
      { concurrency: collectionConcurrency },
    )
    for (const { current, inspection, replay } of results) {
      if (inspection === undefined) {
        if (current.optional !== true) Object.assign(snapshot, { complete: false, collectionComplete: false })
        continue
      }
      if (replay === undefined) {
        Object.assign(snapshot, { complete: false, collectionComplete: false })
        continue
      }
      for (const event of replay.events)
        snapshot = observe(snapshot, {
          threadId: current.threadId,
          turnId: current.turnId,
          event,
        })
      for (const child of inspection.children)
        pending.push({ ...current, executionId: child.executionId, reference: true })
    }
  }
  return snapshot
})
