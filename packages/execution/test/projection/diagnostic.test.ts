import { describe, expect, it } from "@effect/vitest"
import { Effect, Inspectable, Logger, Metric } from "effect"
import { makeHostedModelObserver, makeModelTerminalTelemetry } from "../../src/runtime"

const correlation = {
  threadId: "thread-06",
  turnId: "turn-06",
  runId: "run-06",
  modelAttemptId: "attempt-06",
}

const producerEvent = (event: unknown) => ({ runId: correlation.runId, event }) as never

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
        observe(
          producerEvent({
            _tag: "ModelAttemptStarted",
            modelAttemptId: correlation.modelAttemptId,
            startedAt: 20,
            provider: "private-provider",
            model: "private-model",
            prompt: "private-prompt",
          }),
        ).pipe(
          Effect.andThen(
            observe(
              producerEvent({
                _tag: "ModelAttemptCompleted",
                modelAttemptId: correlation.modelAttemptId,
                completedAt: 35,
                usage: {
                  inputTokens: { total: 12, uncached: 9, cacheRead: 3, cacheWrite: 0 },
                  outputTokens: { total: 7, text: 7, reasoning: 0 },
                },
                content: "private-model-body",
                response: "private-response",
              }),
            ),
          ),
        ),
      )
      const rendered = Inspectable.toStringUnknown(logs)
      expect(rendered).toContain("hosted.model_start.success")
      expect(rendered).toContain("hosted.model_terminal.success")
      for (const value of Object.values(correlation)) expect(rendered).toContain(value)
      expect(rendered).toContain('"rika.duration.millis": 15')
      expect(rendered).toContain('"rika.model.input_tokens": 12')
      expect(rendered).toContain('"rika.model.output_tokens": 7')
      for (const value of [
        "private-provider",
        "private-model",
        "private-prompt",
        "private-model-body",
        "private-response",
      ])
        expect(rendered).not.toContain(value)
    })
  })

  it.effect("emits a correlated failure terminal without provider failure detail", () => {
    const observe = makeHostedModelObserver(correlation)
    return Effect.gen(function* () {
      const logs = yield* capture(
        observe(
          producerEvent({
            _tag: "ModelAttemptFailed",
            modelAttemptId: correlation.modelAttemptId,
            failedAt: 40,
            category: "provider-response",
            providerUsage: { inputTokens: -10, outputTokens: Number.NaN },
            provider: "private-provider",
            error: new Error("private-provider-failure"),
            body: "private-failure-body",
          }),
        ),
      )
      const rendered = Inspectable.toStringUnknown(logs)
      expect(rendered).toContain("hosted.model_start.success")
      expect(rendered).toContain("hosted.model_terminal.failure")
      for (const value of Object.values(correlation)) expect(rendered).toContain(value)
      expect(rendered).toContain('"rika.duration.millis": 0')
      expect(rendered).toContain('"rika.model.input_tokens": 0')
      expect(rendered).toContain('"rika.model.output_tokens": 0')
      for (const value of ["private-provider", "private-provider-failure", "private-failure-body"])
        expect(rendered).not.toContain(value)
    })
  })

  it("maps completed input and output totals once for the same attempt", () => {
    const telemetry = makeModelTerminalTelemetry()
    telemetry.started("attempt-completed", 10)
    const event = {
      _tag: "ModelAttemptCompleted",
      modelAttemptId: "attempt-completed",
      completedAt: 25,
      usage: {
        inputTokens: { total: 12, uncached: 9, cacheRead: 3, cacheWrite: 4 },
        outputTokens: { total: 7, text: 5, reasoning: 2 },
      },
      provider: "must-not-emit",
      model: "must-not-emit",
      content: "must-not-emit",
      prompt: "must-not-emit",
      credentials: "must-not-emit",
    } as never

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
    const observation = telemetry.terminal({
      _tag: "ModelAttemptFailed",
      modelAttemptId: `attempt-${category}`,
      failedAt: 20,
      category,
      providerUsage: { inputTokens: -4, outputTokens: 6, totalTokens: 999 },
      provider: "must-not-emit",
      error: new Error("must-not-emit"),
      rawUsage: { secret: true },
    } as never)

    expect(observation).toEqual({
      modelAttemptId: `attempt-${category}`,
      outcome,
      durationMillis: 0,
      syntheticStart: false,
      usage: { inputTokens: 0, outputTokens: 6 },
    })
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      "durationMillis",
      "modelAttemptId",
      "outcome",
      "syntheticStart",
      "usage",
    ])
  })

  it("omits usage when a failed attempt reports none", () => {
    const telemetry = makeModelTerminalTelemetry()
    expect(
      telemetry.terminal({
        _tag: "ModelAttemptFailed",
        modelAttemptId: "attempt-missing",
        failedAt: 10,
        category: "provider-response",
      } as never),
    ).toEqual({
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
    expect(
      telemetry.terminal({
        _tag: "ModelAttemptFailed",
        modelAttemptId: "attempt",
        failedAt: 25,
        category: "provider-response",
      } as never),
    ).toMatchObject({ durationMillis: 15, syntheticStart: false })
  })

  it("bounds starts without terminals and synthesizes a pair after start eviction", () => {
    const telemetry = makeModelTerminalTelemetry(2)
    telemetry.started("evicted", 1)
    telemetry.started("retained-1", 2)
    telemetry.started("retained-2", 3)

    expect(
      telemetry.terminal({
        _tag: "ModelAttemptFailed",
        modelAttemptId: "evicted",
        failedAt: 50,
        category: "provider-response",
      } as never),
    ).toMatchObject({ durationMillis: 0, syntheticStart: true })
  })

  it("synthesizes start immediately before a terminal and ignores a later start", () => {
    const telemetry = makeModelTerminalTelemetry()
    const emitted: Array<readonly [string, number]> = []
    const terminal = telemetry.terminal({
      _tag: "ModelAttemptFailed",
      modelAttemptId: "out-of-order",
      failedAt: 40,
      category: "provider-response",
    } as never)
    if (terminal?.syntheticStart === true) emitted.push(["model_start", 0])
    if (terminal !== undefined) emitted.push(["model_terminal", terminal.durationMillis])

    expect(emitted).toEqual([
      ["model_start", 0],
      ["model_terminal", 0],
    ])
    expect(telemetry.started("out-of-order", 10)).toBe(false)
    expect(
      telemetry.terminal({
        _tag: "ModelAttemptFailed",
        modelAttemptId: "out-of-order",
        failedAt: 45,
        category: "provider-response",
      } as never),
    ).toBeUndefined()
  })

  it("forms a fresh synthetic pair when a duplicate terminal's tombstone was evicted", () => {
    const telemetry = makeModelTerminalTelemetry(2)
    const terminal = (modelAttemptId: string, failedAt: number) =>
      telemetry.terminal({
        _tag: "ModelAttemptFailed",
        modelAttemptId,
        failedAt,
        category: "provider-response",
      } as never)

    expect(terminal("evicted", 10)?.syntheticStart).toBe(true)
    expect(terminal("retained-1", 20)?.syntheticStart).toBe(true)
    expect(terminal("retained-2", 30)?.syntheticStart).toBe(true)
    expect(terminal("evicted", 40)).toMatchObject({ durationMillis: 0, syntheticStart: true })
    expect(terminal("evicted", 50)).toBeUndefined()
  })
})
