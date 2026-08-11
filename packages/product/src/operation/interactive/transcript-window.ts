import * as TranscriptPage from "@rika/product/transcript-page"
import { OperationError } from "../operation-error"
import { Effect } from "effect"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import { promptUnit } from "./interactive-prompt-unit"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import {
  boundTranscriptEntries,
  maximumTranscriptPayloadBytes,
  transcriptCursorFor,
  transcriptPageEncoder,
} from "../../transcript/transcript-bounds"
import type { SelectionEpochState } from "./interactive-thread-selection"
import type { Turn } from "@rika/product/turn-record"
import type { PageCursor as TurnPageCursor } from "../../thread/repository/turn-repository-pagination"

const entriesFor = (
  turn: Turn,
  input: Pick<TranscriptRepository.Interface, "get">,
  fail: (message: string) => Effect.Effect<never, OperationError, never>,
) =>
  Effect.gen(function* () {
    if (turn.status === "queued") return []
    if (ThreadResult.TurnResult.isRecordedShell(turn)) {
      const running = recordedShellProjection({ id: turn.id, command: turn.command, status: "running" })
      const shell = ThreadResult.TurnResult.isRunningRecordedShell(turn)
        ? running
        : settleRecordedShellProjection(running, turn)
      return shell.units.map((unit) => ({
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
    }
    const projection = yield* input.get(turn.id)
    if (projection === undefined || projection.projectionVersion < ExecutionProjection.projectionVersion) {
      if (!ThreadResult.TurnResult.isAgentExecution(turn)) return []
      return [
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
    }
    if (projection.projectionVersion !== ExecutionProjection.projectionVersion)
      return yield* fail(`Turn ${turn.id} has unsupported projection version ${projection.projectionVersion}`)
    const units = projection.units.length === 0 ? [promptUnit(projection.turn)] : projection.units
    return units.map((unit) => ({
      turn: projection.turn,
      unit,
      projectionRevision: projection.revision,
      projectionModelPhase: -1,
      projectionState: projection.state,
    }))
  })

export const initialTranscriptWindow = (input: {
  readonly state: SelectionEpochState
  readonly turns: Pick<TurnRepository.Interface, "page">
  readonly transcripts: Pick<TranscriptRepository.Interface, "get" | "usage">
  readonly encodeJson: (value: unknown) => string
  readonly fail: (message: string) => Effect.Effect<never, OperationError, never>
}) =>
  Effect.gen(function* () {
    // Pages arrive newest-first with turns ascending inside each page. Assemble the window
    // newest-first so the byte cap retains the newest tail, then emit chronological output.
    const turns: Array<Turn> = []
    let hasOlder = false
    let cursor: TurnPageCursor | undefined
    while (true) {
      const turnPage = yield* input.turns.page(input.state.thread.id, {
        ...(cursor === undefined ? {} : { before: cursor }),
        limit: 50,
      })
      turns.push(...turnPage.turns.toReversed())
      hasOlder = turnPage.hasOlder
      if (!hasOlder) break
      cursor = turnPage.oldestCursor
      if (cursor === undefined) break
    }
    const entries: Array<TranscriptPage.Entry> = []
    let bytes = 0
    let truncated = false
    for (const turn of turns) {
      if (turn.status === "queued") continue
      const turnEntries = yield* entriesFor(turn, input.transcripts, input.fail)
      if (turnEntries.length === 0) continue
      const turnBytes = transcriptPageEncoder.encode(input.encodeJson(turnEntries)).byteLength
      if (bytes + turnBytes > maximumTranscriptPayloadBytes) {
        truncated = true
        break
      }
      // entriesFor returns chronological units; the window accumulates newest-first so the byte
      // cap retains the newest tail, then the whole list is reversed for chronological output.
      for (const entry of [...turnEntries].reverse()) entries.push(entry)
      bytes += turnBytes
    }
    entries.reverse()
    let oldestCursor: TranscriptPage.PageCursor | undefined = transcriptCursorFor(entries[0])
    if (truncated) {
      const bounded = boundTranscriptEntries(entries, input.encodeJson)
      hasOlder = true
      oldestCursor = bounded.partialCursor ?? transcriptCursorFor(bounded.entries[0])
      return {
        entries: bounded.entries,
        hasOlder,
        oldestCursor,
        newestCursor: transcriptCursorFor(bounded.entries.at(-1)),
        usage: yield* input.transcripts.usage(input.state.thread.id),
      }
    }
    return {
      entries,
      hasOlder,
      oldestCursor,
      newestCursor: transcriptCursorFor(entries.at(-1)),
      usage: yield* input.transcripts.usage(input.state.thread.id),
    }
  })
