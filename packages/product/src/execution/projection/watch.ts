import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Clock, Effect, Stream } from "effect"

export const DefectMaxConsecutiveAttempts = 3
export const StallMaxSilenceMs = 15 * 60_000

export const watch = (input: {
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
}) =>
  Effect.gen(function* () {
    const { backend, onChange, onCommitted, onPreview, transcripts, turnId, turns } = input
    const stallSilenceMs = input.stallSilenceMs ?? StallMaxSilenceMs
    const clock = yield* Clock.Clock
    const turn = yield* turns.get(turnId)
    if (turn === undefined || turn._tag !== "AgentExecution" || turn.executionLink === undefined)
      return yield* ExecutionGateway.WatchTurnFailure.make({
        message: `Turn ${turnId} has no persisted execution link`,
      })
    const executionLink = turn.executionLink
    const pricing = turn.executionRoute.main.candidates.some(
      (candidate) => candidate.providerConnection.authentication === "account",
    )
      ? "included"
      : "metered"
    let latestChange: ExecutionProjection.Change | undefined
    let retryDelay = 100
    let consecutiveDefects = 0
    let lastProgressAt = yield* clock.currentTimeMillis
    while (true) {
      let progressed = false
      let previewed = false
      let callbackCause: Cause.Cause<never> | undefined
      const attempt = yield* Effect.exit(
        Effect.gen(function* () {
          const projection = yield* transcripts.get(turnId)
          const pendingTerminal = new Array<ExecutionProjection.Change>()
          const notify = (callback: () => void) =>
            Effect.sync(callback).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  callbackCause = cause
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
              latestChange = change
              progressed = true
              yield* notify(() => onChange?.(change))
            })
          let watchInput: Parameters<typeof backend.watchTurn>[1] = { prompt: turn.prompt, pricing }
          if (projection !== undefined) watchInput = { ...watchInput, units: projection.units }
          if (projection?.projectorCheckpoint !== undefined)
            watchInput = { ...watchInput, checkpoint: projection.projectorCheckpoint }
          yield* backend.watchTurn(executionLink, watchInput).pipe(
            Stream.timeout(stallSilenceMs),
            Stream.runForEach((event) => {
              if (event._tag === "ModelPreview" || event._tag === "ModelPreviewCleared")
                return notify(() => {
                  previewed = true
                  onPreview?.(event)
                })
              if (pendingTerminal.length > 0 && !ExecutionStatus.isTerminalStatus(event.state.status))
                return TranscriptRepository.RepositoryError.make({
                  message: `Turn ${turnId} projected a nonterminal change after terminal revision ${pendingTerminal.at(-1)!.revision}`,
                })
              if (ExecutionStatus.isTerminalStatus(event.state.status)) {
                pendingTerminal.push(event)
                return Effect.void
              }
              return commit(event)
            }),
          )
          const inspection = yield* backend.inspectTurn(executionLink)
          if (
            pendingTerminal.length > 0 &&
            inspection.status !== "unavailable" &&
            ExecutionStatus.isTerminalStatus(inspection.status)
          ) {
            const last = pendingTerminal.at(-1)!
            if (
              pendingTerminal.some((change) => change.state.status !== inspection.status) ||
              last.checkpoint?.cursor !== inspection.cursor
            )
              return yield* TranscriptRepository.RepositoryError.make({
                message: `Turn ${turnId} terminal projection does not match TenetKit inspection at ${inspection.cursor}`,
              })
            yield* Effect.forEach(pendingTerminal, commit, { discard: true })
            pendingTerminal.length = 0
          }
          const stored = yield* transcripts.get(turnId)
          if (
            inspection.status !== "unavailable" &&
            ExecutionStatus.isTerminalStatus(inspection.status) &&
            stored?.projectorCheckpoint?.cursor !== inspection.cursor
          )
            return yield* TranscriptRepository.RepositoryError.make({
              message: `Turn ${turnId} projection cursor does not match terminal TenetKit inspection at ${inspection.cursor}`,
            })
          return { stored, inspection, hasUncommittedTerminal: pendingTerminal.length > 0 }
        }).pipe(Effect.scoped),
      )
      if (progressed || previewed) lastProgressAt = yield* clock.currentTimeMillis
      if (attempt._tag === "Failure") {
        if (callbackCause !== undefined) return yield* Effect.failCause(callbackCause)
        if (Cause.hasInterrupts(attempt.cause)) return yield* Effect.interrupt
        const silence = (yield* clock.currentTimeMillis) - lastProgressAt
        if (silence >= stallSilenceMs && consecutiveDefects === 0 && !Cause.hasDies(attempt.cause)) {
          yield* Effect.logWarning("execution-projection-watch.stalled").pipe(
            Effect.annotateLogs({
              "rika.turn.id": String(turnId),
              "rika.stall.silence.ms": silence,
            }),
          )
        }
        if (Cause.hasDies(attempt.cause)) {
          consecutiveDefects += 1
          if (consecutiveDefects === DefectMaxConsecutiveAttempts) {
            const detail = Cause.pretty(attempt.cause)
            yield* Effect.logError("execution-projection-watch.defect").pipe(
              Effect.annotateLogs({
                "rika.turn.id": String(turnId),
                "rika.defect.attempts": consecutiveDefects,
                "rika.failure.message": detail,
              }),
            )
          }
        } else {
          consecutiveDefects = 0
        }
        const delay = progressed ? 100 : retryDelay
        retryDelay = Math.min(delay * 2, 5_000)
        yield* Effect.logWarning("execution-projection-watch.reconnecting").pipe(
          Effect.annotateLogs({
            "rika.turn.id": String(turnId),
            "rika.retry.delay.ms": delay,
            "rika.failure.message": Cause.pretty(attempt.cause),
          }),
        )
        yield* Effect.sleep(delay)
        continue
      }
      const { hasUncommittedTerminal, inspection, stored } = attempt.value
      consecutiveDefects = 0
      if (hasUncommittedTerminal || inspection.status === "running") {
        const silence = (yield* clock.currentTimeMillis) - lastProgressAt
        if (silence >= stallSilenceMs) {
          yield* Effect.logWarning("execution-projection-watch.stalled").pipe(
            Effect.annotateLogs({
              "rika.turn.id": String(turnId),
              "rika.stall.silence.ms": silence,
            }),
          )
        }
        const delay = progressed ? 100 : retryDelay
        retryDelay = Math.min(delay * 2, 5_000)
        yield* Effect.sleep(delay)
        continue
      }
      const storedIsNewest =
        stored !== undefined && (latestChange === undefined || stored.revision >= latestChange.revision)
      const checkpoint = storedIsNewest ? stored.projectorCheckpoint : latestChange?.checkpoint
      const projectedState = storedIsNewest ? stored.state : latestChange?.state
      const fallbackStatus = turn.status === "waiting" || turn.status === "cancelling" ? turn.status : "running"
      const projectedStatus =
        projectedState !== undefined && !ExecutionStatus.isTerminalStatus(projectedState.status)
          ? projectedState.status
          : fallbackStatus
      const inspectedTerminalStatus =
        inspection.status !== "unavailable" && ExecutionStatus.isTerminalStatus(inspection.status)
          ? inspection.status
          : undefined
      const inspectedActiveStatus =
        inspection.status === "waiting" || inspection.status === "cancelling" ? inspection.status : undefined
      const state =
        projectedState === undefined
          ? {
              status: inspectedTerminalStatus ?? inspectedActiveStatus ?? projectedStatus,
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            }
          : {
              ...projectedState,
              status: inspectedTerminalStatus ?? inspectedActiveStatus ?? projectedStatus,
            }
      const change = {
        turnId: String(turnId),
        status: state.status,
        state,
        units: stored?.units ?? [],
      }
      return checkpoint === undefined ? change : { ...change, checkpoint }
    }
  })
