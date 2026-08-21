import { Cause, Clock, Effect, Exit, Metric } from "effect"

export const stages = [
  "command_admission",
  "queue_admission",
  "queue_claim",
  "run_start",
  "model",
  "executor_wait",
  "workspace_prepare",
  "executor_setup",
  "executor_resume",
  "cell",
  "lease_renew",
  "lease_steal",
  "unknown_outcome",
  "checkpoint",
  "projection_checkpoint",
  "sandbox_pause",
  "sandbox_resume",
  "sandbox_replace",
  "sandbox_reap",
  "client_replay",
] as const

export type Stage = (typeof stages)[number]
export const outcomes = ["success", "failure", "interrupted", "unknown"] as const
export type Outcome = (typeof outcomes)[number]
export const tokenKinds = ["input", "output"] as const
export const healthSignalNames = [
  "stuck_queue_claim",
  "stale_lease",
  "setup_failure",
  "unknown_outcome",
  "replay_lag",
  "orphan_sandbox",
  "restore_failure",
] as const
export type HealthSignal = (typeof healthSignalNames)[number]

export interface Correlation {
  readonly ownerId?: string
  readonly threadId?: string
  readonly turnId?: string
  readonly runId?: string
  readonly operationId?: string
  readonly assignmentId?: string
  readonly sandboxId?: string
  readonly buildId?: string
  readonly commandId?: string
  readonly checkpointId?: string
}

export const metricRetention = { maxAge: "15 minutes", maxSize: 1_024 } as const
export const replayLagAlertEvents = 1_000

const operationCount = Metric.counter("rika_hosted_operations_total", {
  description: "Hosted operations by bounded stage and outcome",
})
const operationDuration = Metric.summary("rika_hosted_operation_duration_millis", {
  description: "Hosted operation duration by bounded stage and outcome",
  maxAge: metricRetention.maxAge,
  maxSize: metricRetention.maxSize,
  quantiles: [0.5, 0.9, 0.99],
})
const queueWait = Metric.summary("rika_hosted_queue_wait_millis", {
  maxAge: metricRetention.maxAge,
  maxSize: metricRetention.maxSize,
  quantiles: [0.5, 0.9, 0.99],
})
const replayLag = Metric.summary("rika_hosted_client_replay_lag_events", {
  maxAge: metricRetention.maxAge,
  maxSize: metricRetention.maxSize,
  quantiles: [0.5, 0.9, 0.99],
})
const modelTokens = Metric.counter("rika_hosted_model_tokens_total")
const healthSignalCount = Metric.counter("rika_hosted_health_signals_total")

export const annotations = (correlation: Correlation): Record<string, string> => {
  const values: Record<string, string> = {}
  const add = (key: string, value: string | undefined) => {
    if (value !== undefined) values[key] = value.slice(0, 512)
  }
  add("rika.owner.id", correlation.ownerId)
  add("rika.thread.id", correlation.threadId)
  add("rika.turn.id", correlation.turnId)
  add("rika.run.id", correlation.runId)
  add("rika.operation.id", correlation.operationId)
  add("rika.assignment.id", correlation.assignmentId)
  add("rika.sandbox.id", correlation.sandboxId)
  add("rika.build.id", correlation.buildId)
  add("rika.command.id", correlation.commandId)
  add("rika.checkpoint.id", correlation.checkpointId)
  return values
}

const record = (stage: Stage, outcome: Outcome, correlation: Correlation, durationMillis?: number) => {
  const dimensions = { stage, outcome }
  const values = {
    ...annotations(correlation),
    "rika.hosted.stage": stage,
    "rika.hosted.outcome": outcome,
    ...(durationMillis === undefined ? {} : { "rika.duration.millis": durationMillis }),
  }
  return Metric.update(Metric.withAttributes(operationCount, dimensions), 1).pipe(
    Effect.andThen(
      durationMillis === undefined
        ? Effect.void
        : Metric.update(Metric.withAttributes(operationDuration, dimensions), durationMillis),
    ),
    Effect.andThen(Effect.logInfo(`hosted.${stage}.${outcome}`).pipe(Effect.annotateLogs(values))),
  )
}

export const observe = Effect.fnUntraced(function* <A, E, R>(
  stage: Stage,
  correlation: Correlation,
  effect: Effect.Effect<A, E, R>,
  outcomeOf?: (value: A) => Outcome,
) {
  const values = { ...annotations(correlation), "rika.hosted.stage": stage }
  let exit: Exit.Exit<A, E> | undefined
  yield* Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* Effect.exit(effect)
    const durationMillis = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)
    let outcome: Outcome = "failure"
    if (Exit.isSuccess(result)) outcome = outcomeOf?.(result.value) ?? "success"
    else if (Cause.hasInterruptsOnly(result.cause)) outcome = "interrupted"
    yield* record(stage, outcome, correlation, durationMillis)
    yield* Effect.annotateCurrentSpan({ "rika.hosted.outcome": outcome, "rika.duration.millis": durationMillis })
    exit = result
  }).pipe(Effect.annotateLogs(values), Effect.withSpan(`rika.hosted.${stage}`, { attributes: values }))
  if (exit === undefined) return yield* Effect.die("Hosted observability did not capture an operation outcome")
  return yield* Exit.match(exit, { onFailure: Effect.failCause, onSuccess: Effect.succeed })
})

export const queueWaitObserved = Effect.fnUntraced(function* (correlation: Correlation, millis: number) {
  const waitMillis = Math.max(0, millis)
  yield* Metric.update(queueWait, waitMillis)
  yield* Effect.annotateCurrentSpan({ "rika.queue.wait.millis": waitMillis })
  yield* Effect.logInfo("hosted.queue_wait.observed").pipe(
    Effect.annotateLogs({ ...annotations(correlation), "rika.queue.wait.millis": waitMillis }),
  )
})

export const replayLagObserved = Effect.fnUntraced(function* (correlation: Correlation, events: number) {
  const lagEvents = Math.max(0, events)
  yield* Metric.update(replayLag, lagEvents)
  yield* Effect.annotateCurrentSpan({ "rika.replay.lag.events": lagEvents })
  yield* Effect.logInfo("hosted.client_replay.observed").pipe(
    Effect.annotateLogs({ ...annotations(correlation), "rika.replay.lag.events": lagEvents }),
  )
})

export const modelObserved = Effect.fnUntraced(function* (
  correlation: Correlation,
  outcome: "success" | "failure",
  durationMillis: number,
  usage?: { readonly inputTokens?: number; readonly outputTokens?: number },
) {
  const duration = Math.max(0, durationMillis)
  const inputTokens = usage?.inputTokens === undefined ? undefined : Math.max(0, usage.inputTokens)
  const outputTokens = usage?.outputTokens === undefined ? undefined : Math.max(0, usage.outputTokens)
  const values = {
    ...annotations(correlation),
    "rika.hosted.stage": "model",
    "rika.hosted.outcome": outcome,
    "rika.duration.millis": duration,
    ...(inputTokens === undefined ? {} : { "rika.model.input_tokens": inputTokens }),
    ...(outputTokens === undefined ? {} : { "rika.model.output_tokens": outputTokens }),
  }
  const update = (kind: "input" | "output", value: number | undefined) =>
    value === undefined ? Effect.void : Metric.update(Metric.withAttributes(modelTokens, { kind }), value)
  yield* Effect.gen(function* () {
    yield* record("model", outcome, correlation, duration)
    yield* update("input", inputTokens)
    yield* update("output", outputTokens)
  }).pipe(Effect.annotateLogs(values), Effect.withSpan("rika.hosted.model", { attributes: values }))
})

export const unknownOutcome = (correlation: Correlation): Effect.Effect<void> => {
  const values = {
    ...annotations(correlation),
    "rika.hosted.stage": "unknown_outcome",
    "rika.hosted.outcome": "unknown",
  }
  return Effect.gen(function* () {
    yield* record("unknown_outcome", "unknown", correlation)
    yield* health("unknown_outcome", correlation)
  }).pipe(Effect.annotateLogs(values), Effect.withSpan("rika.hosted.unknown_outcome", { attributes: values }))
}

export const health = Effect.fnUntraced(function* (
  signal: HealthSignal,
  correlation: Correlation,
  measurement?: { readonly value: number; readonly threshold: number },
) {
  const values = {
    "rika.health.signal": signal,
    ...(measurement === undefined
      ? {}
      : {
          "rika.health.value": Math.max(0, measurement.value),
          "rika.health.threshold": Math.max(0, measurement.threshold),
        }),
  }
  yield* Metric.update(Metric.withAttributes(healthSignalCount, { signal }), 1)
  yield* Effect.annotateCurrentSpan(values)
  yield* Effect.logWarning("hosted.health.degraded").pipe(
    Effect.annotateLogs({
      ...annotations(correlation),
      ...values,
    }),
  )
})
