import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Clock, Effect, Stream } from "effect"

export const DefectMaxConsecutiveAttempts = 3
export const StallMaxSilenceMs = 15 * 60_000

interface WatchInput {
  readonly turnId: Turn.TurnId
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly onChange?: (change: ExecutionProjection.Change) => void
  readonly onCommitted?: (
    change: ExecutionProjection.Change,
  ) => Effect.Effect<void, TranscriptRepository.RepositoryError, never>
  readonly onPreview?: (preview: ExecutionGateway.ModelPreviewEvent) => void
  readonly stallSilenceMs?: number | undefined
}

interface AttemptSignals {
  progressed: boolean
  previewed: boolean
  callbackCause: Cause.Cause<never> | undefined
  latestChange: ExecutionProjection.Change | undefined
}

type Inspection = Effect.Success<ReturnType<ExecutionGateway.Interface["inspectTurn"]>>
type StoredProjection = Effect.Success<ReturnType<TranscriptRepository.Interface["get"]>>
type TerminalInspection = {
  readonly status: "completed" | "failed" | "cancelled"
  readonly cursor: string
}

const watchRequest = (
  turn: Turn.AgentExecutionTurn,
  projection: StoredProjection,
): Parameters<ExecutionGateway.Interface["watchTurn"]>[1] => {
  const pricing = turn.executionRoute.main.candidates.some(
    (candidate) => candidate.providerConnection.authentication === "account",
  )
    ? "included"
    : "metered"
  const units = projection === undefined ? {} : { units: projection.units }
  const checkpoint = projection?.projectorCheckpoint === undefined ? {} : { checkpoint: projection.projectorCheckpoint }
  return { prompt: turn.prompt, pricing, ...units, ...checkpoint }
}

const terminalInspection = (inspection: Inspection): inspection is TerminalInspection =>
  inspection.status !== "unavailable" && ExecutionStatus.isTerminalStatus(inspection.status)

const reconcileTerminal = (
  turnId: Turn.TurnId,
  inspection: Inspection,
  pending: Array<ExecutionProjection.Change>,
  commit: (change: ExecutionProjection.Change) => Effect.Effect<void, TranscriptRepository.RepositoryError>,
) =>
  Effect.gen(function* () {
    if (pending.length === 0 || !terminalInspection(inspection)) return
    const last = pending.at(-1)!
    if (
      pending.some((change) => change.state.status !== inspection.status) ||
      last.checkpoint?.cursor !== inspection.cursor
    )
      return yield* TranscriptRepository.RepositoryError.make({
        message: `Turn ${turnId} terminal projection does not match Generalist inspection at ${inspection.cursor}`,
      })
    yield* Effect.forEach(pending, commit, { discard: true })
    pending.length = 0
  })

const runAttempt = (
  input: WatchInput,
  turn: Turn.AgentExecutionTurn,
  executionLink: ExecutionGateway.ExecutionLink,
  stallSilenceMs: number,
  signals: AttemptSignals,
) =>
  Effect.gen(function* () {
    const { backend, onChange, onCommitted, onPreview, transcripts, turnId } = input
    const projection = yield* transcripts.get(turnId)
    const pending = new Array<ExecutionProjection.Change>()
    const notify = (callback: () => void) =>
      Effect.sync(callback).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            signals.callbackCause = cause
          }).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )
    const commit = (change: ExecutionProjection.Change) =>
      Effect.gen(function* () {
        const committed = yield* transcripts.commitProjection(turn, change, onCommitted?.(change))
        if (committed === "stale")
          return yield* TranscriptRepository.RepositoryError.make({
            message: `Turn ${turnId} projection revision is stale`,
          })
        signals.latestChange = change
        signals.progressed = true
        yield* notify(() => onChange?.(change))
      })
    yield* backend.watchTurn(executionLink, watchRequest(turn, projection)).pipe(
      Stream.timeout(stallSilenceMs),
      Stream.runForEach((event) => {
        if (event._tag === "ModelPreview" || event._tag === "ModelPreviewCleared")
          return notify(() => {
            signals.previewed = true
            onPreview?.(event)
          })
        if (pending.length > 0 && !ExecutionStatus.isTerminalStatus(event.state.status))
          return TranscriptRepository.RepositoryError.make({
            message: `Turn ${turnId} projected a nonterminal change after terminal revision ${pending.at(-1)!.revision}`,
          })
        if (!ExecutionStatus.isTerminalStatus(event.state.status)) return commit(event)
        pending.push(event)
        return Effect.void
      }),
    )
    const inspection = yield* backend.inspectTurn(executionLink)
    yield* reconcileTerminal(turnId, inspection, pending, commit)
    const stored = yield* transcripts.get(turnId)
    if (terminalInspection(inspection) && stored?.projectorCheckpoint?.cursor !== inspection.cursor)
      return yield* TranscriptRepository.RepositoryError.make({
        message: `Turn ${turnId} projection cursor does not match terminal Generalist inspection at ${inspection.cursor}`,
      })
    return { stored, inspection, hasUncommittedTerminal: pending.length > 0 }
  }).pipe(Effect.scoped)

const logStall = (turnId: Turn.TurnId, silence: number) =>
  Effect.logWarning("execution-projection-watch.stalled").pipe(
    Effect.annotateLogs({ "rika.turn.id": String(turnId), "rika.stall.silence.ms": silence }),
  )

const projectedSelection = (stored: StoredProjection, latestChange: ExecutionProjection.Change | undefined) => {
  const storedIsNewest =
    stored !== undefined && (latestChange === undefined || stored.revision >= latestChange.revision)
  return {
    checkpoint: storedIsNewest ? stored.projectorCheckpoint : latestChange?.checkpoint,
    state: storedIsNewest ? stored.state : latestChange?.state,
  }
}

const statusFromInspection = (inspection: Inspection) => {
  if (terminalInspection(inspection)) return inspection.status
  if (inspection.status === "waiting" || inspection.status === "cancelling") return inspection.status
  return undefined
}

const resultFrom = (
  turn: Turn.AgentExecutionTurn,
  inspection: Inspection,
  stored: StoredProjection,
  latestChange: ExecutionProjection.Change | undefined,
): ExecutionProjection.Result => {
  const { checkpoint, state: projectedState } = projectedSelection(stored, latestChange)
  const fallbackStatus = turn.status === "waiting" || turn.status === "cancelling" ? turn.status : "running"
  const projectedStatus =
    projectedState !== undefined && !ExecutionStatus.isTerminalStatus(projectedState.status)
      ? projectedState.status
      : fallbackStatus
  const status = statusFromInspection(inspection) ?? projectedStatus
  const state =
    projectedState === undefined
      ? {
          status,
          usage: ExecutionProjection.emptyUsageState(),
          steering: { steeringMessages: 0, followUpMessages: 0 },
        }
      : { ...projectedState, status }
  const result = { turnId: String(turn.id), status, state, units: stored?.units ?? [] }
  return checkpoint === undefined ? result : { ...result, checkpoint }
}

const recoverFailure = (input: {
  readonly cause: Cause.Cause<unknown>
  readonly callbackCause: Cause.Cause<never> | undefined
  readonly consecutiveDefects: number
  readonly lastProgressAt: number
  readonly progressed: boolean
  readonly retryDelay: number
  readonly stallSilenceMs: number
  readonly turnId: Turn.TurnId
}) =>
  Effect.gen(function* () {
    if (input.callbackCause !== undefined) return yield* Effect.failCause(input.callbackCause)
    if (Cause.hasInterrupts(input.cause)) return yield* Effect.interrupt
    const now = yield* Clock.currentTimeMillis
    const silence = now - input.lastProgressAt
    if (silence >= input.stallSilenceMs && input.consecutiveDefects === 0 && !Cause.hasDies(input.cause))
      yield* logStall(input.turnId, silence)
    const consecutiveDefects = Cause.hasDies(input.cause) ? input.consecutiveDefects + 1 : 0
    if (consecutiveDefects === DefectMaxConsecutiveAttempts)
      yield* Effect.logError("execution-projection-watch.defect").pipe(
        Effect.annotateLogs({
          "rika.turn.id": String(input.turnId),
          "rika.defect.attempts": consecutiveDefects,
          "rika.failure.message": Cause.pretty(input.cause),
        }),
      )
    const delay = input.progressed ? 100 : input.retryDelay
    yield* Effect.logWarning("execution-projection-watch.reconnecting").pipe(
      Effect.annotateLogs({
        "rika.turn.id": String(input.turnId),
        "rika.retry.delay.ms": delay,
        "rika.failure.message": Cause.pretty(input.cause),
      }),
    )
    yield* Effect.sleep(delay)
    return { consecutiveDefects, retryDelay: Math.min(delay * 2, 5_000) }
  })

const watchLinked = (
  input: WatchInput,
  turn: Turn.AgentExecutionTurn,
  executionLink: ExecutionGateway.ExecutionLink,
  stallSilenceMs: number,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const signals: AttemptSignals = {
      progressed: false,
      previewed: false,
      callbackCause: undefined,
      latestChange: undefined,
    }
    let retryDelay = 100
    let consecutiveDefects = 0
    let lastProgressAt = yield* clock.currentTimeMillis
    while (true) {
      signals.progressed = false
      signals.previewed = false
      signals.callbackCause = undefined
      const attempt = yield* Effect.exit(runAttempt(input, turn, executionLink, stallSilenceMs, signals))
      if (signals.progressed || signals.previewed) lastProgressAt = yield* clock.currentTimeMillis
      if (attempt._tag === "Failure") {
        const recovered = yield* recoverFailure({
          cause: attempt.cause,
          callbackCause: signals.callbackCause,
          consecutiveDefects,
          lastProgressAt,
          progressed: signals.progressed,
          retryDelay,
          stallSilenceMs,
          turnId: input.turnId,
        })
        consecutiveDefects = recovered.consecutiveDefects
        retryDelay = recovered.retryDelay
        continue
      }
      consecutiveDefects = 0
      if (attempt.value.hasUncommittedTerminal || attempt.value.inspection.status === "running") {
        const silence = (yield* clock.currentTimeMillis) - lastProgressAt
        if (silence >= stallSilenceMs) yield* logStall(input.turnId, silence)
        const delay = signals.progressed ? 100 : retryDelay
        retryDelay = Math.min(delay * 2, 5_000)
        yield* Effect.sleep(delay)
        continue
      }
      return resultFrom(turn, attempt.value.inspection, attempt.value.stored, signals.latestChange)
    }
  })

export const watch = (input: WatchInput) =>
  Effect.gen(function* () {
    const stallSilenceMs = input.stallSilenceMs ?? StallMaxSilenceMs
    const found = yield* input.turns.get(input.turnId)
    if (found === undefined || found._tag !== "AgentExecution" || found.executionLink === undefined)
      return yield* ExecutionGateway.WatchTurnFailure.make({
        message: `Turn ${input.turnId} has no persisted execution link`,
      })
    return yield* watchLinked(input, found, found.executionLink, stallSilenceMs)
  })
