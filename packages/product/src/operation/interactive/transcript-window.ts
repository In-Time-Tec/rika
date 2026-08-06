import * as TranscriptPage from "@rika/product/transcript-page"
import { OperationError } from "../operation-error"
import { Effect } from "effect"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import { promptUnit } from "./interactive-prompt-unit"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import { boundTurnEntries, transcriptCursorFor } from "../../transcript/transcript-bounds"
import type { SelectionEpochState } from "./interactive-thread-selection"

export const initialTranscriptWindow = (input: {
  readonly state: SelectionEpochState
  readonly turns: Pick<TurnRepository.Interface, "page">
  readonly transcripts: Pick<TranscriptRepository.Interface, "get" | "usage">
  readonly maxTurns: number
  readonly maxEntries: number
  readonly fail: (message: string) => Effect.Effect<never, OperationError, never>
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
      if (ThreadResult.TurnResult.isRecordedShell(turn)) {
        const running = recordedShellProjection({ id: turn.id, command: turn.command, status: "running" })
        const shell = ThreadResult.TurnResult.isRunningRecordedShell(turn)
          ? running
          : settleRecordedShellProjection(running, turn)
        entries = shell.units.map((unit) => ({
          turn,
          unit,
          projectionRevision: shell.revision,
          projectionModelPhase: -1,
          projectionState: {
            status: turn.status,
            usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: turn.status !== "running" },
            steering: { steeringMessages: 0, followUpMessages: 0 },
          },
        }))
      } else if (projection === undefined || projection.projectionVersion < ExecutionProjection.projectionVersion) {
        if (!ThreadResult.TurnResult.isAgentExecution(turn)) continue
        entries = [
          {
            turn,
            unit: promptUnit(turn),
            projectionRevision: 0,
            projectionModelPhase: -1,
            projectionState: {
              status: turn.status === "accepted" ? "running" : turn.status,
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          },
        ]
      } else {
        if (projection.projectionVersion !== ExecutionProjection.projectionVersion)
          return yield* input.fail(`Turn ${turn.id} has unsupported projection version ${projection.projectionVersion}`)
        const units = projection.units.length === 0 ? [promptUnit(projection.turn)] : projection.units
        entries = units.map((unit) => ({
          turn: projection.turn,
          unit,
          projectionRevision: projection.revision,
          projectionModelPhase: -1,
          projectionState: projection.state,
        }))
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
    return {
      entries: window.flat(),
      hasOlder,
      oldestCursor,
      usage: yield* input.transcripts.usage(input.state.thread.id),
    }
  })
