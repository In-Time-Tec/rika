import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Logger } from "effect"
import { GatewayError, type PreparationStore } from "../../src/executor/gateway"
import { GatewayTestHarness } from "./gateway/fixture"

const {
  encode,
  decode,
  encodeUnknown,
  milestone,
  workspaceCapabilities,
  readyPreparation,
  environmentDigest,
  makeGateway,
  fence,
  access,
  cellIdentity,
  attribution,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: lifecycle-persistence", () => {
  it.effect("never dispatches a cell for stale durable workspace readiness", () =>
    Effect.gen(function* () {
      const target = socket()
      const checked: Array<Parameters<PreparationStore["ready"]>[0]> = []
      const preparation: PreparationStore = {
        ...readyPreparation,
        ready: (candidate) => {
          checked.push(candidate)
          return Effect.fail(GatewayError.make({ kind: "fenced", message: "Workspace readiness fence is stale" }))
        },
      }
      const gateway = yield* makeGateway(controller(), undefined, undefined, preparation)
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "not-ready",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo should-not-run",
        }),
      )
      expect(checked).toEqual([access])
      expect(target.sent.map((message) => decode(message)._tag)).toEqual(["ExecutorWelcome", "PhaseEnvironmentGranted"])
    }),
  )

  it.effect("persists one bounded lifecycle before acknowledging terminal replay", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      const target = socket()
      const persisted: Array<string> = []
      const gateway = yield* makeGateway(controller(), (_access, frame) =>
        Effect.sync(() => persisted.push(`${frame.cursor}:${frame._tag}`)).pipe(
          Effect.as({ _tag: "Appended" as const }),
        ),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-lifecycle",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "private-cell-input-secret",
        }),
      )
      yield* Effect.yieldNow
      const identity = attribution("operation-lifecycle")
      const lifecycle = [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
        ...Array.from({ length: 16 }, (_, index) => ({
          _tag: "Output" as const,
          attribution: identity,
          cursor: index + 3,
          stream: "stdout" as const,
          text: `output-${index}`,
          redacted: true as const,
          truncated: false,
        })),
      ]
      for (const frame of lifecycle)
        yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame })))
      const response = { _tag: "Success" as const, result: "private-cell-output-secret" }
      const terminalFrame = {
        _tag: "Terminal" as const,
        attribution: identity,
        cursor: 19,
        outcome: "completed" as const,
        response,
      }
      yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame })))
      yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame })))
      expect(persisted).toEqual(lifecycle.map((frame) => `${frame.cursor}:${frame._tag}`).concat("19:Terminal"))
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellTerminalReceipt"),
      ).toHaveLength(2)
      const renderedObservability = encodeUnknown(observability)
      const cellCorrelation = {
        "rika.thread.id": "thread-1",
        "rika.turn.id": "turn-1",
        "rika.run.id": "run-1",
        "rika.operation.id": "operation-lifecycle",
        "rika.cell.id": "call-1",
      }
      expect(milestone(observability, "hosted.cell_admission.success").map((record) => record.annotations)).toEqual([
        { ...cellCorrelation, "rika.hosted.stage": "cell_admission", "rika.hosted.outcome": "success" },
      ])
      expect(milestone(observability, "hosted.terminal.success").map((record) => record.annotations)).toEqual([
        { ...cellCorrelation, "rika.hosted.stage": "terminal", "rika.hosted.outcome": "success" },
      ])
      expect(renderedObservability).not.toContain("private-cell-input-secret")
      expect(renderedObservability).not.toContain("private-cell-output-secret")
      expect(renderedObservability).not.toContain(access.sessionToken)
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey: "operation-lifecycle", attempt: 0, response }),
      )
      expect((yield* Fiber.join(running)).response).toEqual(response)
    }),
  )

  it.effect("rejects an out-of-order lifecycle frame before persisting it", () =>
    Effect.gen(function* () {
      const target = socket()
      const persisted: Array<string> = []
      const gateway = yield* makeGateway(controller(), (_access, frame) =>
        Effect.sync(() => persisted.push(`${frame.cursor}:${frame._tag}`)).pipe(
          Effect.as({ _tag: "Appended" as const }),
        ),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-out-of-order",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Started",
            attribution: attribution("operation-out-of-order"),
            cursor: 2,
          },
        }),
      )
      expect(persisted).toEqual([])
      expect(target.closed).toEqual([[1008, "fenced"]])
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("hydrates a durable terminal after API replacement", () =>
    Effect.gen(function* () {
      const target = socket()
      const response = { _tag: "Success" as const, result: 42 }
      const identity = attribution("operation-restored")
      const retained = [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
        {
          _tag: "Output" as const,
          attribution: identity,
          cursor: 3,
          stream: "stdout" as const,
          text: "restored",
          redacted: true as const,
          truncated: false,
        },
        { _tag: "Terminal" as const, attribution: identity, cursor: 4, outcome: "completed" as const, response },
      ]
      const gateway = yield* makeGateway(
        controller(),
        () => Effect.succeed({ _tag: "Appended" }),
        () => Effect.succeed(retained),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-restored",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      expect(target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellExecute")).toEqual(
        [],
      )
      expect(yield* Fiber.join(running)).toEqual({ response, outcome: "completed" })
    }),
  )
})
