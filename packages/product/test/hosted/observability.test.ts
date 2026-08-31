import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Inspectable, Logger, Metric, Tracer } from "effect"
import * as Observability from "@rika/product/hosted-observability"

describe("HostedObservability", () => {
  it.effect("preserves model terminal projection when telemetry defects", () => {
    const terminalProjection: Array<string> = []
    const defectingLogger = Logger.make(() => {
      throw new Error("logger defect")
    })
    const defectingTracer = Tracer.make({
      span() {
        throw new Error("tracer defect")
      },
    })
    const projectTerminal = Effect.sync(() => terminalProjection.push("model_terminal"))

    return Effect.gen(function* () {
      yield* Observability.modelObserved({}, "success", 12, { inputTokens: 3, outputTokens: 2 }).pipe(
        Effect.andThen(projectTerminal),
        Effect.provideService(Logger.CurrentLoggers, new Set([defectingLogger])),
      )
      yield* Observability.modelObserved({}, "failure", 8).pipe(
        Effect.andThen(projectTerminal),
        Effect.provideService(Tracer.Tracer, defectingTracer),
      )

      assert.deepStrictEqual(terminalProjection, ["model_terminal", "model_terminal"])
    })
  })

  it.effect("isolates defecting telemetry from product exits", () => {
    const defectingLogger = Logger.make(() => {
      throw new Error("logger defect")
    })
    const productFailure = new Error("product failure")
    return Effect.gen(function* () {
      const eventExit = yield* Effect.exit(Observability.event("process_start", "success", {}))
      const successExit = yield* Effect.exit(Observability.observe("attach", {}, Effect.succeed("attached")))
      const failureExit = yield* Effect.exit(Observability.observe("attach", {}, Effect.fail(productFailure)))
      const interruptionExit = yield* Effect.exit(Observability.observe("attach", {}, Effect.interrupt))

      assert.isTrue(Exit.isSuccess(eventExit))
      assert.isTrue(Exit.isSuccess(successExit))
      if (Exit.isSuccess(successExit)) assert.strictEqual(successExit.value, "attached")
      assert.isTrue(Exit.isFailure(failureExit))
      if (Exit.isFailure(failureExit)) {
        const failure = failureExit.cause.reasons.find(Cause.isFailReason)
        assert.strictEqual(failure?.error, productFailure)
      }
      assert.isTrue(Exit.isFailure(interruptionExit) && Cause.hasInterruptsOnly(interruptionExit.cause))
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([defectingLogger])))
  })

  it.effect("separates immediate milestones from measured completion and redacts annotations", () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.map(Logger.formatStructured, (record) => logs.push(record))
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const correlation = {
      threadId: "Thread:01",
      turnId: "turn_01",
      runId: "run-01",
      operationId: "operation.01",
      cellId: "cell-01",
      bindingId: "binding-01",
      modelAttemptId: "attempt-01",
    }
    const unsafe = {
      ...correlation,
      turnId: "user supplied prose must not survive",
      operationId: "x".repeat(129),
      ownerId: "owner-secret",
      commandId: "command-secret",
      assignmentId: "assignment-secret",
      sandboxId: "sandbox-secret",
      buildId: "build-secret",
      checkpointId: "checkpoint-secret",
      arbitrary: "prompt-never-record",
    }
    return Effect.gen(function* () {
      yield* Observability.event("process_start", "success", correlation)
      yield* Observability.event("first_draw", "success", correlation)
      yield* Observability.event("connection_ready", "success", correlation)
      yield* Observability.observe("connection_ticket", correlation, Effect.void)
      yield* Observability.observe("connection_socket", correlation, Effect.void)
      yield* Observability.observe("target_resolution", correlation, Effect.void)
      yield* Observability.observe("attach", correlation, Effect.void)
      yield* Observability.observe("attach_response", correlation, Effect.void)
      yield* Observability.observe("attach_projection", correlation, Effect.void)
      yield* Observability.observe("attach_refresh", correlation, Effect.void)
      yield* Observability.observe("attach_ack", correlation, Effect.void)
      yield* Observability.event("admission", "success", correlation)
      yield* Observability.event("turn_claim", "success", correlation)
      yield* Observability.event("run_created", "success", correlation)
      yield* Observability.event("run_claim", "success", correlation)
      yield* Observability.event("model_start", "success", correlation)
      yield* Observability.modelObserved(correlation, "failure", 25, { inputTokens: 5, outputTokens: 3 })
      yield* Observability.modelObserved(correlation, "interrupted", 0)
      yield* Observability.event("cell_admission", "success", correlation)
      yield* Observability.observe("cell_execution", correlation, Effect.void)
      yield* Observability.event("binding_send", "success", correlation)
      yield* Observability.observe("binding_terminal", correlation, Effect.fail("private failure")).pipe(Effect.exit)
      yield* Observability.event("terminal", "failure", unsafe)

      assert.deepStrictEqual(Observability.annotations(correlation), {
        "rika.thread.id": "Thread:01",
        "rika.turn.id": "turn_01",
        "rika.run.id": "run-01",
        "rika.operation.id": "operation.01",
        "rika.cell.id": "cell-01",
        "rika.binding.id": "binding-01",
        "rika.model_attempt.id": "attempt-01",
      })
      assert.deepStrictEqual(Observability.annotations(unsafe), {
        "rika.thread.id": "Thread:01",
        "rika.run.id": "run-01",
        "rika.cell.id": "cell-01",
        "rika.binding.id": "binding-01",
        "rika.model_attempt.id": "attempt-01",
      })

      const rendered = Inspectable.toStringUnknown({
        logs,
        spans: spans.map((span) => Object.fromEntries(span.attributes)),
      })
      const immediateNames = [
        "hosted.process_start.success",
        "hosted.first_draw.success",
        "hosted.connection_ready.success",
        "hosted.admission.success",
        "hosted.turn_claim.success",
        "hosted.run_created.success",
        "hosted.run_claim.success",
        "hosted.model_start.success",
        "hosted.cell_admission.success",
        "hosted.binding_send.success",
        "hosted.terminal.failure",
      ]
      const completionNames = [
        "hosted.connection_ticket.success",
        "hosted.connection_socket.success",
        "hosted.target_resolution.success",
        "hosted.attach.success",
        "hosted.attach_response.success",
        "hosted.attach_projection.success",
        "hosted.attach_refresh.success",
        "hosted.attach_ack.success",
        "hosted.model_terminal.failure",
        "hosted.model_terminal.interrupted",
        "hosted.cell_execution.success",
        "hosted.binding_terminal.failure",
      ]
      for (const name of [...immediateNames, ...completionNames]) assert.include(rendered, name)
      for (const stage of [
        "connection_ticket",
        "connection_socket",
        "target_resolution",
        "attach",
        "attach_response",
        "attach_projection",
        "attach_refresh",
        "attach_ack",
        "model_terminal",
        "cell_execution",
        "binding_terminal",
      ])
        assert.isNumber(
          spans.find((span) => span.name === `rika.hosted.${stage}`)?.attributes.get("rika.duration.millis"),
        )
      for (const stage of [
        "process_start",
        "first_draw",
        "connection_ready",
        "admission",
        "turn_claim",
        "run_created",
        "run_claim",
        "model_start",
      ])
        assert.notInclude(rendered, `rika.hosted.${stage}","rika.duration.millis`)
      for (const sensitive of [
        "user supplied prose must not survive",
        "owner-secret",
        "command-secret",
        "assignment-secret",
        "sandbox-secret",
        "build-secret",
        "checkpoint-secret",
        "prompt-never-record",
        "private failure",
      ])
        assert.notInclude(rendered, sensitive)
      assert.deepStrictEqual(Observability.stages, [
        "process_start",
        "first_draw",
        "connection_ready",
        "connection_ticket",
        "connection_socket",
        "target_resolution",
        "attach",
        "attach_response",
        "attach_projection",
        "attach_refresh",
        "attach_ack",
        "admission",
        "turn_claim",
        "run_created",
        "run_claim",
        "model_start",
        "model_terminal",
        "cell_admission",
        "cell_execution",
        "binding_send",
        "binding_terminal",
        "terminal",
      ])
    }).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    )
  })
})
