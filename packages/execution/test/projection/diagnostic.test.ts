import { describe, expect, it } from "@effect/vitest"
import { Effect, Inspectable, Logger, Metric } from "effect"
import { ExecutableManifest, RunEvent, RunTree } from "generalist/runtime"
import { makeHostedModelObserver, makeModelTerminalTelemetry } from "../../src/engine/runtime"
import type { SemanticTreeEvent } from "../../src/projection/semantic/event"

const correlation = {
  threadId: "thread-06",
  turnId: "turn-06",
  runId: "run-06",
  modelAttemptId: "attempt-06",
}

type ModelAttemptStarted = Extract<RunEvent.RunEvent, { readonly _tag: "ModelAttemptStarted" }>
type ModelAttemptCompleted = Extract<RunEvent.RunEvent, { readonly _tag: "ModelAttemptCompleted" }>
type ModelAttemptFailed = Extract<RunEvent.RunEvent, { readonly _tag: "ModelAttemptFailed" }>

const eventBase: RunEvent.RunEventBase = {
  specVersion: "1",
  eventId: "diagnostic-event",
  runId: correlation.runId,
  rootRunId: correlation.runId,
  sequence: 1,
  executableRef: ExecutableManifest.makeTest("diagnostic", "1").ref,
  depth: 0,
  occurredAt: "1970-01-01T00:00:00.000Z",
}

const started = (modelAttemptId: string, startedAt: number): ModelAttemptStarted => ({
  ...eventBase,
  _tag: "ModelAttemptStarted",
  deliveryId: `${modelAttemptId}:delivery`,
  turn: 0,
  modelCallId: `${modelAttemptId}:call`,
  modelAttemptId,
  attempt: 0,
  startedAt,
  provider: "private-provider",
  model: "private-model",
})

const completed = (modelAttemptId: string, completedAt: number): ModelAttemptCompleted => ({
  ...eventBase,
  _tag: "ModelAttemptCompleted",
  deliveryId: `${modelAttemptId}:delivery`,
  turn: 0,
  modelCallId: `${modelAttemptId}:call`,
  modelAttemptId,
  attempt: 0,
  completedAt,
  usageAt: completedAt,
  usage: {
    inputTokens: { total: 12, uncached: 9, cacheRead: 3, cacheWrite: 4 },
    outputTokens: { total: 7, text: 5, reasoning: 2 },
  },
  finishReason: "stop",
  provider: "must-not-emit",
  model: "must-not-emit",
})

const producerEvent = (event: ModelAttemptStarted | ModelAttemptCompleted | ModelAttemptFailed): SemanticTreeEvent => ({
  rootRunId: correlation.runId,
  runId: correlation.runId,
  event,
  cursor: RunTree.TreeCursor.make("diagnostic-cursor"),
})

const failed = (
  modelAttemptId: string,
  failedAt: number,
  category: ModelAttemptFailed["category"] = "provider-response",
  providerUsage?: ModelAttemptFailed["providerUsage"],
): ModelAttemptFailed => {
  const event: ModelAttemptFailed = {
    ...eventBase,
    _tag: "ModelAttemptFailed",
    eventId: `${modelAttemptId}:failed`,
    deliveryId: `${modelAttemptId}:delivery`,
    turn: 0,
    modelCallId: `${modelAttemptId}:call`,
    modelAttemptId,
    attempt: 0,
    failedAt,
    category,
    classification: "terminal",
    disposition: "terminal",
    provider: "must-not-emit",
  }
  return providerUsage === undefined ? event : { ...event, providerUsage }
}

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (record) => logs.push(record))
  return Effect.as(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
    logs,
  )
}

describe("runtime model terminal telemetry", () => {
  it.effect("emits correlated bounded start and successful terminal records without model values", () => {
    const observe = makeHostedModelObserver(correlation)
    return Effect.gen(function* () {
      const logs = yield* capture(
        observe(producerEvent(started(correlation.modelAttemptId, 20))).pipe(
          Effect.andThen(observe(producerEvent(completed(correlation.modelAttemptId, 35)))),
        ),
      )
      const rendered = Inspectable.toStringUnknown(logs)
      expect(rendered).toContain("hosted.model_start.success")
      expect(rendered).toContain("hosted.model_terminal.success")
      for (const value of Object.values(correlation)) expect(rendered).toContain(value)
      expect(rendered).toContain('"rika.duration.millis": 15')
      expect(rendered).toContain('"rika.model.input_tokens": 12')
      expect(rendered).toContain('"rika.model.output_tokens": 7')
      for (const value of ["private-provider", "private-model"]) expect(rendered).not.toContain(value)
    })
  })

  it.effect("emits a correlated failure terminal without provider failure detail", () => {
    const observe = makeHostedModelObserver(correlation)
    return Effect.gen(function* () {
      const logs = yield* capture(
        observe(
          producerEvent(
            failed(correlation.modelAttemptId, 40, "provider-response", {
              inputTokens: -10,
              outputTokens: Number.NaN,
            }),
          ),
        ),
      )
      const rendered = Inspectable.toStringUnknown(logs)
      expect(rendered).toContain("hosted.model_start.success")
      expect(rendered).toContain("hosted.model_terminal.failure")
      for (const value of Object.values(correlation)) expect(rendered).toContain(value)
      expect(rendered).toContain('"rika.duration.millis": 0')
      expect(rendered).toContain('"rika.model.input_tokens": 0')
      expect(rendered).toContain('"rika.model.output_tokens": 0')
      expect(rendered).not.toContain("private-provider")
    })
  })

  it("maps completed input and output totals once for the same attempt", () => {
    const telemetry = makeModelTerminalTelemetry()
    telemetry.started("attempt-completed", 10)
    const event = completed("attempt-completed", 25)

    expect(telemetry.terminal(event)).toEqual({
      modelAttemptId: "attempt-completed",
      outcome: "success",
      durationMillis: 15,
      syntheticStart: false,
      usage: { inputTokens: 12, outputTokens: 7 },
    })
    expect(telemetry.terminal(event)).toBeUndefined()
  })

  it.each([
    ["provider-response", "failure"],
    ["cancellation", "interrupted"],
  ] as const)("preserves normalized failed provider usage for %s", (category, outcome) => {
    const telemetry = makeModelTerminalTelemetry()
    telemetry.started(`attempt-${category}`, 30)
    const observation = telemetry.terminal(
      failed(`attempt-${category}`, 20, category, { inputTokens: -4, outputTokens: 6, totalTokens: 999 }),
    )

    expect(observation).toEqual({
      modelAttemptId: `attempt-${category}`,
      outcome,
      durationMillis: 0,
      syntheticStart: false,
      usage: { inputTokens: 0, outputTokens: 6 },
    })
    expect(Object.keys(observation ?? {}).toSorted()).toEqual([
      "durationMillis",
      "modelAttemptId",
      "outcome",
      "syntheticStart",
      "usage",
    ])
  })

  it("omits usage when a failed attempt reports none", () => {
    const telemetry = makeModelTerminalTelemetry()
    expect(telemetry.terminal(failed("attempt-missing", 10))).toEqual({
      modelAttemptId: "attempt-missing",
      outcome: "failure",
      durationMillis: 0,
      syntheticStart: true,
    })
  })

  it("emits a duplicate start once and preserves its first timestamp", () => {
    const telemetry = makeModelTerminalTelemetry()

    expect(telemetry.started("attempt", 10)).toBe(true)
    expect(telemetry.started("attempt", 18)).toBe(false)
    expect(telemetry.terminal(failed("attempt", 25))).toMatchObject({ durationMillis: 15, syntheticStart: false })
  })

  it("bounds starts without terminals and synthesizes a pair after start eviction", () => {
    const telemetry = makeModelTerminalTelemetry(2)
    telemetry.started("evicted", 1)
    telemetry.started("retained-1", 2)
    telemetry.started("retained-2", 3)

    expect(telemetry.terminal(failed("evicted", 50))).toMatchObject({ durationMillis: 0, syntheticStart: true })
  })

  it("synthesizes start immediately before a terminal and ignores a later start", () => {
    const telemetry = makeModelTerminalTelemetry()
    const emitted: Array<readonly [string, number]> = []
    const terminal = telemetry.terminal(failed("out-of-order", 40))
    if (terminal?.syntheticStart === true) emitted.push(["model_start", 0])
    if (terminal !== undefined) emitted.push(["model_terminal", terminal.durationMillis])

    expect(emitted).toEqual([
      ["model_start", 0],
      ["model_terminal", 0],
    ])
    expect(telemetry.started("out-of-order", 10)).toBe(false)
    expect(telemetry.terminal(failed("out-of-order", 45))).toBeUndefined()
  })

  it("forms a fresh synthetic pair when a duplicate terminal's tombstone was evicted", () => {
    const telemetry = makeModelTerminalTelemetry(2)
    const terminal = (modelAttemptId: string, failedAt: number) => telemetry.terminal(failed(modelAttemptId, failedAt))

    expect(terminal("evicted", 10)?.syntheticStart).toBe(true)
    expect(terminal("retained-1", 20)?.syntheticStart).toBe(true)
    expect(terminal("retained-2", 30)?.syntheticStart).toBe(true)
    expect(terminal("evicted", 40)).toMatchObject({ durationMillis: 0, syntheticStart: true })
    expect(terminal("evicted", 50)).toBeUndefined()
  })
})
