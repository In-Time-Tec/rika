import { Effect, Function, Metric, Predicate } from "effect"
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

/** Maps free-text runner failures onto stable, log-safe tokens (diagnostics drop free-text annotations). */
export const consumeFailureKind = (message: string): string => {
  if (message.includes("stale session")) return "stale_session"
  if (message.includes("stale") || message.includes("fenced") || message.includes("Fenced")) return "fenced"
  if (message.includes("invalid Runner frame")) return "invalid_frame"
  return "unknown"
}

export const messageCorrelation = (message: ApiMessage): RunnerAnnotations => {
  const correlation: Record<string, string | number | boolean> = {}
  correlation["rika.runner.message"] = message._tag
  if (message._tag === "MachineExecute" || message._tag === "MachineCancel") {
    correlation["rika.operation.key"] = message.operationKey
    correlation["rika.operation.attempt"] = message.attempt
    correlation["rika.machine.id"] = message.machineId
  }
  return correlation
}
