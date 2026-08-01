import * as TranscriptPage from "@rika/product/transcript-page"
import { Effect } from "effect"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { boundTurnEntries, transcriptCursorFor } from "../../transcript/transcript-bounds"
import type { SelectionEpochState } from "./interactive-thread-selection"

export const initialTranscriptWindow = (input: {
  readonly state: SelectionEpochState
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly ensureIngest: (threadId: Turn.Turn["threadId"], turnId: Turn.Turn["id"]) => Effect.Effect<void, unknown>
  readonly maxTurns: number
  readonly maxEntries: number
  readonly fail: (message: string) => Effect.Effect<never, unknown>
}) =>
  Effect.gen(function* () {
    const turnPage = yield* input.turns.page(input.state.thread.id, { limit: 50 })
    const window: Array<ReadonlyArray<TranscriptPage.Entry>> = []
    let entryCount = 0
    let projectedTurns = 0
    let hasOlder = turnPage.hasOlder
    let reduced = false
    let oldestCursor: TranscriptPage.PageCursor | undefined
    for (const turn of turnPage.turns.toReversed()) {
      if (projectedTurns >= input.maxTurns) {
        hasOlder = true
        break
      }
      if (turn.status === "queued") continue
      const projection = yield* input.transcripts.get(turn.id)
      let entries: ReadonlyArray<TranscriptPage.Entry>
      if (projection === undefined || projection.projectionVersion < ExecutionIngest.projectionVersion) {
        if (ThreadResult.TurnResult.isRecordedShell(turn))
          return yield* input.fail(`Recorded shell turn ${turn.id} has no current durable transcript`)
        yield* input.ensureIngest(turn.threadId, turn.id)
        if (!ThreadResult.TurnResult.isAgentExecution(turn)) continue
        const seed = TranscriptProjection.Projection.empty(turn.id, turn.prompt)
        entries = seed.units.map((unit) => ({
          turn,
          unit,
          projectionRevision: seed.revision,
          projectionModelPhase: seed.modelPhase,
        }))
      } else {
        if (projection.projectionVersion !== ExecutionIngest.projectionVersion)
          return yield* input.fail(`Turn ${turn.id} has unsupported projection version ${projection.projectionVersion}`)
        if (projection.units.length === 0)
          return yield* input.fail(`Turn ${turn.id} has an empty current-version transcript`)
        entries = projection.units.map((unit) =>
          Object.assign(
            {
              turn: projection.turn,
              unit,
              projectionRevision: projection.revision,
              projectionModelPhase: projection.modelPhase,
            },
            projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd },
          ),
        )
      }
      projectedTurns += 1
      if (!reduced && entryCount + entries.length <= input.maxEntries) {
        window.unshift(entries)
        entryCount += entries.length
        oldestCursor = transcriptCursorFor(entries[0]) ?? oldestCursor
        continue
      }
      const detail = reduced ? 0 : input.maxEntries - entryCount
      reduced = true
      hasOlder = true
      const bounded = boundTurnEntries(entries, detail)
      window.unshift(bounded.entries)
      entryCount += bounded.entries.length
      if (detail > 0) oldestCursor = transcriptCursorFor(entries[bounded.contiguousFrom]) ?? oldestCursor
    }
    return { entries: window.flat(), hasOlder, oldestCursor }
  })
