import { Compaction, Session } from "@batonfx/core"
import { createHash } from "node:crypto"
import { Effect, Function, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

export const Config = Schema.Struct({
  contextWindow: Schema.Finite,
  reserveTokens: Schema.Finite,
  keepRecentTokens: Schema.Finite,
  toolOutputMaxBytes: Schema.Finite,
})
export type Config = typeof Config.Type

export const Checkpoint = Schema.Struct({
  cursor: Schema.String,
  digest: Schema.String,
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
})
export type Checkpoint = typeof Checkpoint.Type

export interface CompactInput {
  readonly compactionId: string
  readonly agentName: string
  readonly sessionId: string
  readonly turn: number
  readonly history: Prompt.Prompt
  readonly prompt: Prompt.Prompt
  readonly path: ReadonlyArray<Session.Entry>
  readonly contextTokens: number
  readonly checkpoint?: Checkpoint
}

export interface CompactOutput {
  readonly history: Prompt.Prompt
  readonly prompt: Prompt.Prompt
  readonly checkpoint?: Checkpoint
}

export const checkpoint: {
  (cursor: string, summary: string, firstKeptEntryId: string): Checkpoint
  (summary: string, firstKeptEntryId: string): (cursor: string) => Checkpoint
} = Function.dual(
  3,
  (cursor: string, summary: string, firstKeptEntryId: string): Checkpoint => ({
    cursor,
    digest: createHash("sha256").update(`${cursor}\0${firstKeptEntryId}\0${summary}`).digest("hex"),
    summary,
    firstKeptEntryId,
  }),
)

export const checkpointFromReplay = (
  events: ReadonlyArray<{ readonly cursor: string; readonly metadata?: unknown }>,
) => {
  for (const event of events.toReversed()) {
    if (typeof event.metadata !== "object" || event.metadata === null) continue
    const metadata = event.metadata as Record<string, unknown>
    if (metadata.kind !== "context-compaction") continue
    const decoded = Schema.decodeUnknownOption(Checkpoint)(metadata.checkpoint)
    if (Option.isSome(decoded)) return decoded.value
  }
  return undefined
}

export const shouldPersistCheckpoint: {
  (current: Checkpoint | undefined, next: Checkpoint): boolean
  (next: Checkpoint): (current: Checkpoint | undefined) => boolean
} = Function.dual(2, (current: Checkpoint | undefined, next: Checkpoint) => current?.digest !== next.digest)

export const relayMetadata = (value: Checkpoint) => ({ kind: "context-compaction", checkpoint: value })

export const strategy = (config: Config) =>
  Compaction.strategy([
    Compaction.toolOutputBound({ maxBytes: config.toolOutputMaxBytes }),
    Compaction.keepRecent({ tokens: config.keepRecentTokens }),
    Compaction.structuredSummary(),
  ])

export const compact = Effect.fn("ContextCompaction.compact")(function* (config: Config, input: CompactInput) {
  const service = Compaction.make(strategy(config), {
    contextWindow: config.contextWindow,
    reserveTokens: config.reserveTokens,
  })
  const result = yield* service.maybeCompact({
    compactionId: input.compactionId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    turn: input.turn,
    history: input.history,
    prompt: input.prompt,
    path: input.path,
    usage: {
      contextTokens: input.contextTokens,
      contextWindow: config.contextWindow,
      reserveTokens: config.reserveTokens,
    },
    overflow: false,
  })
  if (Option.isNone(result)) return { history: input.history, prompt: input.prompt, checkpoint: input.checkpoint }
  if (result.value._tag === "Microcompact") return { ...result.value, checkpoint: input.checkpoint }
  return {
    history: result.value.history,
    prompt: result.value.prompt,
    checkpoint: checkpoint(String(input.turn), result.value.summary, result.value.firstKeptEntryId),
  }
})
