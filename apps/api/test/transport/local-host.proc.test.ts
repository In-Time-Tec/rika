import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schedule, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { expect } from "vitest"
import { runnerFixture } from "../fixtures/runner"
import { testWebSocketConstructor } from "../fixtures/runner-socket"

it.live(
  "runs an authenticated hosted prompt through Rivet and the native Runner",
  () =>
    Effect.gen(function* () {
      const { client, session, partition, fs, checkout, fixture, revoked, restart } = yield* runnerFixture
      expect(session.sessionId).toBe(partition.rootSessionId)
      const receipt = yield* client.sessions.submit({
        sessionId: session.sessionId,
        commandId: "submit-hosted",
        input: "Run the native command",
      })
      const snapshot = yield* client.sessions.snapshot({ sessionId: session.sessionId }).pipe(
        Effect.repeat({
          until: (value) => value.runs.some((run) => run.parentRunId === undefined && run.status === "succeeded"),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("20 seconds"),
      )
      const root = snapshot.runs.find((run) => run.parentRunId === undefined)
      expect(root).toBeDefined()
      if (root === undefined) return yield* Effect.die("Hosted root Run was not retained")
      const completed = yield* client.runs.inspect({ runId: root.runId }).pipe(
        Effect.repeat({
          until: (value) => value.children.length === 1 && value.children[0]?.status === "succeeded",
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("20 seconds"),
      )
      expect(completed.children).toHaveLength(1)
      expect(yield* fs.readFileString(`${checkout}/result.txt`)).toBe("hosted-runner")
      expect(yield* fixture.requests).toHaveLength(2)
      const settled = yield* client.sessions.snapshot({ sessionId: session.sessionId })
      expect(settled.runs.every((run) => run.status === "succeeded")).toBe(true)
      yield* restart
      expect(
        yield* client.sessions.submit({
          sessionId: session.sessionId,
          commandId: "submit-hosted",
          input: "Run the native command",
        }),
      ).toEqual(receipt)
      const reopened = yield* client.sessions.snapshot({ sessionId: session.sessionId })
      expect(reopened.runs.map((run) => [run.runId, run.status])).toEqual(
        settled.runs.map((run) => [run.runId, run.status]),
      )
      expect(yield* fixture.requests).toHaveLength(2)
      revoked.add("controller")
      expect((yield* Effect.result(client.sessions.snapshot({ sessionId: session.sessionId })))._tag).toBe("Failure")
    }),
  60_000,
)

it.live(
  "revokes held spectator SSE and WebSocket streams without cancelling controller work",
  () =>
    Effect.gen(function* () {
      const { client, clientFor, session, fixture, fs, checkout, revoked } = yield* runnerFixture
      const spectator = yield* clientFor("spectator")
      expect(
        (yield* Effect.result(
          spectator.sessions.submit({
            sessionId: session.sessionId,
            commandId: "forbidden-spectator-submit",
            input: "Must not run",
          }),
        ))._tag,
      ).toBe("Failure")
      expect(yield* fixture.requests).toEqual([])
      const sseReady = yield* Deferred.make<void>()
      const initial = yield* spectator.sessions.snapshot({ sessionId: session.sessionId })
      const sse = yield* spectator.events
        .subscribe({ sessionId: session.sessionId, cursor: initial.cursor, reconnect: Schedule.recurs(0) })
        .pipe(
          Stream.tap(() => Deferred.succeed(sseReady, undefined)),
          Stream.runDrain,
          Effect.result,
          Effect.forkScoped,
        )
      yield* client.sessions.submit({
        sessionId: session.sessionId,
        commandId: "initial-submit",
        input: "Run the first tool",
      })
      yield* Deferred.await(sseReady).pipe(
        Effect.raceFirst(Fiber.join(sse).pipe(Effect.flatMap((result) => Effect.die(result)))),
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.die("Spectator SSE did not deliver an admitted event")),
      )
      const socket = yield* spectator.events
        .connect({ sessionId: session.sessionId, reconnect: Schedule.recurs(0) })
        .pipe(Effect.provideService(Socket.WebSocketConstructor, testWebSocketConstructor("Bearer spectator")))
      yield* socket.status.pipe(
        Stream.filter((status) => status._tag === "Connected"),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.die("Spectator WebSocket did not connect")),
      )
      yield* Effect.sleep("11 seconds").pipe(
        Effect.raceFirst(Fiber.join(sse).pipe(Effect.flatMap((result) => Effect.die(result)))),
        Effect.raceFirst(socket.exhausted),
      )
      revoked.add("spectator")
      yield* client.sessions.submit({
        sessionId: session.sessionId,
        commandId: "controller-submit",
        input: "Run the tool",
      })
      expect(
        (yield* Fiber.join(sse).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () => Effect.die("Revoked spectator SSE remained open")),
        ))._tag,
      ).toBe("Failure")
      expect(yield* Effect.result(socket.exhausted.pipe(Effect.timeout("10 seconds")))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "generalist/server/ReconnectExhausted" },
      })
      yield* client.sessions.snapshot({ sessionId: session.sessionId }).pipe(
        Effect.repeat({
          until: (snapshot) =>
            snapshot.runs.filter((run) => run.parentRunId === undefined && run.status === "succeeded").length === 2,
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("20 seconds"),
      )
      expect(yield* fs.readFileString(`${checkout}/result.txt`)).toBe("hosted-runner")
      expect(yield* fixture.requests).toHaveLength(4)
    }),
  60_000,
)
