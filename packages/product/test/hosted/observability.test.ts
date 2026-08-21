import { assert, describe, it } from "@effect/vitest"
import { Effect, Inspectable, Logger, Metric, Schema, Tracer } from "effect"
import * as Observability from "@rika/product/hosted-observability"

class SensitiveFailure extends Schema.TaggedError<SensitiveFailure>()("SensitiveFailure", { message: Schema.String }) {}

describe("HostedObservability", () => {
  it.effect("keeps one failed Turn joinable across API, store, executor, and lifecycle hops without payloads", () => {
    const prompt = "prompt-never-record-7214"
    const cellSource = "cell-source-never-record-6391"
    const credential = "credential-never-record-4827"
    const admission = {
      ownerId: "owner-1",
      threadId: "thread-1",
      turnId: "turn-1",
      commandId: "command-1",
    }
    const run = { ownerId: "owner-1", threadId: "thread-1", turnId: "turn-1", runId: "run-1" }
    const executor = {
      ...run,
      operationId: "operation-1",
      assignmentId: "assignment-1",
    }
    const cell = { ...executor, sandboxId: "sandbox-1" }
    const lifecycle = {
      ownerId: "owner-1",
      threadId: "thread-1",
      assignmentId: "assignment-1",
      sandboxId: "sandbox-1",
      buildId: "build-1",
    }
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.map(Logger.formatStructured, (record) => {
      logs.push(record)
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const span = (name: string) => spans.find((candidate) => candidate.name === name)!
    const join = (left: Tracer.NativeSpan, right: Tracer.NativeSpan, keys: ReadonlyArray<string>) => {
      for (const key of keys) assert.strictEqual(left.attributes.get(key), right.attributes.get(key))
    }
    const failedCell = { _tag: "DomainFailure" as const, failure: { prompt, cellSource, credential } }
    return Effect.gen(function* () {
      yield* Observability.observe(
        "command_admission",
        admission,
        Observability.observe("queue_admission", admission, Effect.void),
      )
      yield* Observability.observe("queue_claim", admission, Observability.queueWaitObserved(admission, 17))
      yield* Observability.observe("run_start", admission, Effect.void)
      yield* Observability.modelObserved(run, "success", 25, { inputTokens: 5, outputTokens: 3 })
      yield* Observability.observe(
        "executor_wait",
        executor,
        Observability.observe("workspace_prepare", lifecycle, Effect.void),
      )
      yield* Observability.observe("executor_setup", lifecycle, Effect.void)
      yield* Observability.observe("cell", cell, Effect.succeed(failedCell), (result) =>
        result._tag === "DomainFailure" ? "failure" : "success",
      )
      yield* Observability.unknownOutcome(cell)
      yield* Observability.observe("checkpoint", { ...lifecycle, checkpointId: "checkpoint-1" }, Effect.void)
      yield* Observability.observe("sandbox_resume", lifecycle, Effect.void)
      yield* Observability.observe(
        "client_replay",
        admission,
        Observability.replayLagObserved(admission, Observability.replayLagAlertEvents).pipe(
          Effect.andThen(
            Observability.health("replay_lag", admission, {
              value: Observability.replayLagAlertEvents,
              threshold: Observability.replayLagAlertEvents,
            }),
          ),
        ),
      )
      yield* Effect.exit(
        Observability.observe(
          "projection_checkpoint",
          admission,
          Effect.fail(SensitiveFailure.make({ message: `${prompt}:${cellSource}:${credential}` })),
        ),
      )
      yield* Effect.forEach(Observability.healthSignalNames, (signal) => Observability.health(signal, admission), {
        discard: true,
      })
      const snapshots = yield* Metric.snapshot
      const hostedSpans = spans.filter((candidate) => candidate.name.startsWith("rika.hosted."))
      assert.isAbove(new Set(hostedSpans.map((candidate) => candidate.traceId)).size, 5)
      assert.notStrictEqual(span("rika.hosted.command_admission").traceId, span("rika.hosted.queue_claim").traceId)
      assert.notStrictEqual(span("rika.hosted.run_start").traceId, span("rika.hosted.model").traceId)
      assert.notStrictEqual(span("rika.hosted.executor_wait").traceId, span("rika.hosted.executor_setup").traceId)
      assert.notStrictEqual(span("rika.hosted.executor_wait").traceId, span("rika.hosted.cell").traceId)
      join(span("rika.hosted.queue_admission"), span("rika.hosted.queue_claim"), [
        "rika.owner.id",
        "rika.thread.id",
        "rika.turn.id",
      ])
      join(span("rika.hosted.queue_claim"), span("rika.hosted.run_start"), [
        "rika.owner.id",
        "rika.thread.id",
        "rika.turn.id",
      ])
      join(span("rika.hosted.run_start"), span("rika.hosted.model"), ["rika.thread.id", "rika.turn.id"])
      join(span("rika.hosted.model"), span("rika.hosted.executor_wait"), [
        "rika.thread.id",
        "rika.turn.id",
        "rika.run.id",
      ])
      join(span("rika.hosted.executor_wait"), span("rika.hosted.cell"), [
        "rika.thread.id",
        "rika.turn.id",
        "rika.run.id",
        "rika.operation.id",
        "rika.assignment.id",
      ])
      join(span("rika.hosted.cell"), span("rika.hosted.executor_setup"), ["rika.assignment.id", "rika.sandbox.id"])
      join(span("rika.hosted.executor_setup"), span("rika.hosted.sandbox_resume"), [
        "rika.assignment.id",
        "rika.sandbox.id",
        "rika.build.id",
      ])
      assert.strictEqual(span("rika.hosted.model").attributes.get("rika.duration.millis"), 25)
      assert.strictEqual(span("rika.hosted.model").attributes.get("rika.model.input_tokens"), 5)
      assert.strictEqual(span("rika.hosted.model").attributes.get("rika.model.output_tokens"), 3)
      assert.strictEqual(span("rika.hosted.queue_claim").attributes.get("rika.queue.wait.millis"), 17)
      assert.strictEqual(
        span("rika.hosted.client_replay").attributes.get("rika.replay.lag.events"),
        Observability.replayLagAlertEvents,
      )
      assert.strictEqual(span("rika.hosted.client_replay").attributes.get("rika.health.signal"), "replay_lag")
      assert.strictEqual(span("rika.hosted.cell").attributes.get("rika.hosted.outcome"), "failure")
      const bounded = Observability.annotations({ ...executor, ownerId: "o".repeat(1_024) })
      assert.strictEqual(bounded["rika.owner.id"]?.length, 512)
      assert.deepStrictEqual(Object.keys(bounded).sort(), [
        "rika.assignment.id",
        "rika.operation.id",
        "rika.owner.id",
        "rika.run.id",
        "rika.thread.id",
        "rika.turn.id",
      ])
      for (const snapshot of snapshots) {
        const expectedDimensions: Record<string, ReadonlyArray<string>> = {
          rika_hosted_operations_total: ["outcome", "stage"],
          rika_hosted_operation_duration_millis: ["outcome", "stage"],
          rika_hosted_model_tokens_total: ["kind"],
          rika_hosted_health_signals_total: ["signal"],
        }
        assert.deepStrictEqual(Object.keys(snapshot.attributes ?? {}).sort(), expectedDimensions[snapshot.id] ?? [])
        const attributes = snapshot.attributes ?? {}
        if (typeof attributes.stage === "string") assert.include(Observability.stages, attributes.stage)
        if (typeof attributes.outcome === "string") assert.include(Observability.outcomes, attributes.outcome)
        if (typeof attributes.kind === "string") assert.include(Observability.tokenKinds, attributes.kind)
        if (typeof attributes.signal === "string") assert.include(Observability.healthSignalNames, attributes.signal)
      }
      const rendered = Inspectable.toStringUnknown({
        logs,
        spans: spans.map((candidate) => ({
          attributes: Object.fromEntries(candidate.attributes),
          status: candidate.status,
        })),
        snapshots,
      })
      for (const privateValue of [prompt, cellSource, credential]) assert.notInclude(rendered, privateValue)
      assert.deepStrictEqual(Observability.metricRetention, { maxAge: "15 minutes", maxSize: 1_024 })
      assert.strictEqual(Observability.stages.length, 20)
      assert.strictEqual(Observability.outcomes.length, 4)
      assert.strictEqual(Observability.healthSignalNames.length, 7)
    }).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    )
  })
})
