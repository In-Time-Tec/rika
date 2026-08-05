import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import type * as TurnRepository from "@rika/product/turn-repository"
import type * as UsageRepository from "@rika/product/usage-repository"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import { Effect, Result } from "effect"

export type ThreadContext =
  | {
      readonly _tag: "Available"
      readonly inputTokens: number
      readonly contextWindow: number
      readonly reserveTokens: number
    }
  | { readonly _tag: "Unavailable" }

export const readThreadContext = Effect.fn("ProductOperation.readThreadContext")(function* (input: {
  readonly threadId: string
  readonly turns: TurnRepository.Interface
  readonly usage: UsageRepository.Interface
}) {
  const turns = yield* input.turns.list(Thread.ThreadId.make(input.threadId))
  const candidates = turns
    .filter((turn): turn is Turn.AgentExecutionTurn => turn._tag === "AgentExecution")
    .filter((turn) => turn.status !== "queued")
    .toSorted((left, right) => right.createdAt - left.createdAt || String(right.id).localeCompare(String(left.id)))
  for (const turn of candidates) {
    if (turn.executionLink === undefined) continue
    const source = yield* input.usage.loadSourceFold(String(turn.id), String(turn.id))
    if (source?.foldJson === undefined || source.projectionVersion !== UsageSnapshot.projectionVersion) continue
    const decoded = UsageCodec.deserialize(source.foldJson)
    if (Result.isFailure(decoded)) continue
    const reading = decoded.success.executionContexts.get(TranscriptCorrelation.executionKey(turn.executionLink.runId))
    if (reading === undefined) continue
    return {
      _tag: "Available" as const,
      inputTokens: reading.inputTokens,
      contextWindow: turn.executionRoute.main.compaction.contextWindow,
      reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
    }
  }
  return { _tag: "Unavailable" as const }
})
