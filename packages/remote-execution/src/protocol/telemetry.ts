import { Cause, Clock, Effect, Exit, Function, Metric, Predicate } from "effect"
import type { ApiMessage } from "./messages"

/**
 * Structured runner diagnostics. Events land in the client diagnostics JSONL through the root
 * Effect logger, so every annotation key must survive the allowlist in
 * `apps/rika/src/diagnostics/file-logging.ts`; free text never does. Metrics stay bounded by the
 * event name so a stalled operation cannot grow cardinality.
 */
export interface RunnerAnnotations {
  readonly [key: string]: string | number | boolean
}

const eventCount = Metric.counter("rika_runner_events_total", {
  description: "Runner protocol events by bounded event name",
})
const eventDuration = Metric.summary("rika_runner_event_duration_millis", {
  description: "Runner operation durations by bounded event name",
  maxAge: "15 minutes",
  maxSize: 1_024,
  quantiles: [0.5, 0.9, 0.99],
})

const record = (level: "info" | "warning", event: string, annotations: RunnerAnnotations) => {
  const durationMillis = annotations["rika.duration.millis"]
  const duration = Predicate.isNumber(durationMillis) ? durationMillis : undefined
  return Metric.update(Metric.withAttributes(eventCount, { event }), 1).pipe(
    Effect.andThen(
      duration === undefined ? Effect.void : Metric.update(Metric.withAttributes(eventDuration, { event }), duration),
    ),
    Effect.andThen(
      (level === "warning" ? Effect.logWarning(event) : Effect.logInfo(event)).pipe(Effect.annotateLogs(annotations)),
    ),
  )
}

export const runnerEvent: {
  (annotations: RunnerAnnotations): (event: string) => Effect.Effect<void>
  (event: string, annotations: RunnerAnnotations): Effect.Effect<void>
} = Function.dual(
  2,
  (event: string, annotations: RunnerAnnotations): Effect.Effect<void> => record("info", event, annotations),
)

export const runnerWarning: {
  (annotations: RunnerAnnotations): (event: string) => Effect.Effect<void>
  (event: string, annotations: RunnerAnnotations): Effect.Effect<void>
} = Function.dual(
  2,
  (event: string, annotations: RunnerAnnotations): Effect.Effect<void> => record("warning", event, annotations),
)

/**
 * Wraps an operation boundary that must stay diagnosable when it never finishes: the `<event>.start`
 * marker is logged before the effect runs, then `<event>` is logged with its duration and outcome
 * (success, failure, or interrupted) when it settles. The boundary is also traced as a span.
 */
export const runnerBoundary: {
  (event: string, annotations: RunnerAnnotations): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, event: string, annotations: RunnerAnnotations): Effect.Effect<A, E, R>
} = Function.dual(
  3,
  <A, E, R>(effect: Effect.Effect<A, E, R>, event: string, annotations: RunnerAnnotations): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* record("info", `${event}.start`, annotations)
      const startedAt = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(effect)
      let outcome: "success" | "interrupted" | "failure"
      if (Exit.isSuccess(exit)) {
        outcome = "success"
      } else if (Cause.hasInterruptsOnly(exit.cause)) {
        outcome = "interrupted"
      } else {
        outcome = "failure"
      }
      yield* record(outcome === "failure" ? "warning" : "info", event, {
        ...annotations,
        "rika.outcome": outcome,
        "rika.duration.millis": Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
      })
      return yield* exit
    }).pipe(Effect.withSpan(`rika.${event}`, { attributes: annotations })),
)

/** Splits an operation execution key (`operationKey\u0000attempt`) back into log-safe correlation fields. */
export const executionKeyParts = (key: string): RunnerAnnotations => {
  const separator = key.lastIndexOf("\u0000")
  const operationKey = separator === -1 ? key : key.slice(0, separator)
  const attempt = separator === -1 ? Number.NaN : Number(key.slice(separator + 1))
  const annotations: Record<string, string | number | boolean> = {}
  annotations["rika.operation.key"] = operationKey
  if (Number.isInteger(attempt) && attempt >= 0) annotations["rika.operation.attempt"] = attempt
  return annotations
}

/** Maps free-text runner failures onto stable, log-safe tokens (diagnostics drop free-text annotations). */
export const consumeFailureKind = (message: string): string => {
  if (message.includes("binding result") || message.includes("binding manifest")) return "binding_result_rejected"
  if (message.includes("stale session")) return "stale_session"
  if (message.includes("stale") || message.includes("fenced") || message.includes("Fenced")) return "fenced"
  if (message.includes("invalid Runner frame")) return "invalid_frame"
  return "unknown"
}

export const messageCorrelation = (message: ApiMessage): RunnerAnnotations => {
  const correlation: Record<string, string | number | boolean> = {}
  correlation["rika.runner.message"] = message._tag
  if (message._tag === "CellExecute") {
    correlation["rika.operation.key"] = message.request.operationKey
    correlation["rika.operation.attempt"] = message.request.attempt
  } else if (
    message._tag === "CellCancel" ||
    message._tag === "CellReplay" ||
    message._tag === "CellTerminalReceipt" ||
    message._tag === "CellTerminalSuperseded" ||
    message._tag === "LocalCellReceipt" ||
    message._tag === "MachineExecute" ||
    message._tag === "BindingResult"
  ) {
    correlation["rika.operation.key"] = message.operationKey
    correlation["rika.operation.attempt"] = message.attempt
  }
  if (message._tag === "BindingResult") correlation["rika.binding.call.id"] = message.callId
  if (message._tag === "MachineExecute") correlation["rika.machine.id"] = message.machineId
  return correlation
}
