import { expect, it } from "@effect/vitest"

import { Client, Content, Ids } from "@relayfx/sdk"
import { Deferred, Effect, Exit, Fiber, Logger, Ref, Schema, Stream, Tracer } from "effect"

import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"
import { fixture as testSupport } from "./execution-backend-fixture"

const { selection, relayEvent, makeClient, provideConfiguredBackend, provideBackend, provideBackendWithThreadTools } =
  testSupport
it.effect("maps distinct top-level Turn identities to distinct deterministic Relay identities", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      streamEvents: [relayEvent("execution.completed", 1)],
      existingStatus: "running",
    })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "first" })
      yield* start(backend, {
        threadId: "session:thread-a",
        turnId: "execution:turn-a",
        prompt: "second",
      })
      yield* backend.inspect("execution:turn-a")
      yield* backend.replay("execution:turn-a")
      if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
      yield* backend.pageEvents("execution:turn-a", "forward")
      yield* backend.cancel("execution:turn-a")
    }).pipe(provideBackendWithThreadTools(fixture.implementation))

    expect(yield* Ref.get(fixture.starts)).toMatchObject([
      {
        session_id: "session:thread-a",
        idempotency_key: "turn-a",
        execution_id: "execution:turn-a",
      },
      {
        session_id: "session:session:thread-a",
        idempotency_key: "execution:turn-a",
        execution_id: "execution:execution:turn-a",
      },
    ])
    expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:execution:turn-a", "execution:execution:turn-a"])
    expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
      "execution:execution:turn-a",
      "execution:execution:turn-a",
    ])
    expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual(["execution:execution:turn-a"])
    expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([
      "execution:execution:turn-a",
    ])
  }),
)
it.effect("keeps large execution results out of completed tracing spans", () =>
  Effect.gen(function* () {
    const streamEvents = [
      ...Array.from({ length: 4_000 }, (_, index) =>
        relayEvent("model.output.delta", index + 1, [Content.text(`chunk-${index}`)]),
      ),
      relayEvent("execution.completed", 4_001),
    ]
    const fixture = yield* makeClient({ streamEvents })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const results = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const started = yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
      })
      const followed = yield* backend.follow!("turn-a", undefined)
      return { started, followed }
    }).pipe(provideBackend(fixture.implementation), Effect.withTracer(tracer))
    expect(results.started.events).toHaveLength(4_001)
    expect(results.followed.events).toHaveLength(4_001)
    for (const name of ["ExecutionBackend.start", "ExecutionBackend.follow"]) {
      const span = spans.find((candidate) => candidate.name === name)
      expect(span?.status._tag).toBe("Ended")
      if (span?.status._tag !== "Ended") continue
      expect(Exit.isSuccess(span.status.exit)).toBe(true)
      if (!Exit.isSuccess(span.status.exit)) continue
      expect(typeof span.status.exit.value).toBe("undefined")
    }
  }),
)
it.effect("follows execution events while the durable start call is still running", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const running = relayEvent("tool.call.requested", 1, [], { tool_name: "bash", input: "sleep 20" })
    const completed = relayEvent("execution.completed", 2)
    const implementation: Client.Interface = {
      ...fixture.implementation,
      executions: {
        ...fixture.implementation.executions,
        startByAgentDefinition: (input) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ execution_id: input.execution_id!, status: "completed" as const }),
          ),
        get: () =>
          Deferred.isDone(started).pipe(
            Effect.map((visible) =>
              visible
                ? {
                    id: Ids.ExecutionId.make("execution:turn-a"),
                    root_address_id: Ids.AddressId.make("address:rika"),
                    status: "running" as const,
                    created_at: 1,
                    updated_at: 1,
                  }
                : undefined,
            ),
          ),
        follow: () =>
          Stream.concat(
            Stream.fromEffect(Deferred.await(started).pipe(Effect.as({ _tag: "event" as const, event: running }))),
            Stream.fromEffect(Deferred.await(release).pipe(Effect.as({ _tag: "event" as const, event: completed }))),
          ),
      },
    }
    const seen: Array<string> = []
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* Effect.forkChild(
        start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          onEvent: (event) => seen.push(event.type),
        }),
      )
    }).pipe(provideBackend(implementation))
    yield* Effect.whileLoop({
      while: () => seen.length === 0,
      body: () => Effect.yieldNow,
      step: () => undefined,
    })
    expect(seen).toEqual(["tool.call.requested"])
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(result)).events.map((event) => event.type)).toEqual([
      "tool.call.requested",
      "execution.completed",
    ])
  }),
)
it.effect("emits safe correlated execution breadcrumbs without payloads", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      streamEvents: [
        relayEvent("tool.call.requested", 1, [Content.text("SECRET_CONTENT")], { input: "SECRET_DATA" }),
        relayEvent("tool.result.received", 2, [Content.text("SECRET_RESULT")]),
        relayEvent("model.attempt.completed", 3, undefined, {
          model_attempt_id: "attempt-priced",
          cost: { amount: 0, currency: "USD" },
        }),
        relayEvent("model.attempt.failed", 4, undefined, {
          model_attempt_id: "attempt-failed",
          error: { message: "provider unavailable" },
        }),
        relayEvent("execution.completed", 5),
      ],
    })
    const lines: Array<string> = []
    const logger = Logger.make((options) => lines.push(Logger.formatJson.log(options)))
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, {
        threadId: "thread-observed",
        turnId: "turn-observed",
        prompt: "SECRET_PROMPT",
      })
    }).pipe(provideConfiguredBackend(fixture.implementation, { selection }, Logger.layer([logger])))
    const records = yield* Effect.forEach(lines, (line) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ message: Schema.String, annotations: Schema.Record(Schema.String, Schema.Unknown) }),
        ),
      )(line),
    )
    expect(records.map((record) => record.message)).toEqual([
      "execution.starting",
      "execution.accepted",
      "execution.follow.started",
      "execution.event.received",
      "execution.event.received",
      "execution.event.received",
      "execution.event.received",
      "execution.event.received",
      "execution.follow.completed",
    ])
    expect(result.events.find((event) => event.type === "model.attempt.completed")?.data).toMatchObject({
      model_attempt_id: "attempt-priced",
      cost: { amount: 0, currency: "USD" },
    })
    expect(result.events.find((event) => event.type === "model.attempt.failed")?.data).toMatchObject({
      model_attempt_id: "attempt-failed",
      error: { message: "provider unavailable" },
    })
    expect(records.find((record) => record.message === "execution.event.received")?.annotations).toMatchObject({
      "rika.execution.id": "execution:turn-observed",
      "rika.turn.id": "turn-observed",
      "rika.event.type": "tool.call.requested",
    })
    expect(lines.join("\n")).not.toContain("SECRET_")
  }),
)
it.effect("annotates every follow with its resume cursor and event scope", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    const lines: Array<string> = []
    const logger = Logger.make((options) => lines.push(Logger.formatJson.log(options)))
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
      yield* backend.follow("turn-a", undefined)
      yield* backend.follow("turn-a", "cursor-7", undefined, undefined, "execution")
      yield* backend.follow("turn-a", { cursor: "cursor-9", sequence: 9 })
    }).pipe(provideConfiguredBackend(fixture.implementation, { selection }, Logger.layer([logger])))
    const records = yield* Effect.forEach(lines, (line) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ message: Schema.String, annotations: Schema.Record(Schema.String, Schema.Unknown) }),
        ),
      )(line),
    )
    const annotationsFor = (message: string) =>
      records.filter((record) => record.message === message).map((record) => record.annotations)
    expect(annotationsFor("execution.follow.started")).toEqual([
      {
        "rika.execution.id": "execution:turn-a",
        "rika.turn.id": "turn-a",
        "rika.follow.cursor": "start",
        "rika.follow.scope": "tree",
      },
      {
        "rika.execution.id": "execution:turn-a",
        "rika.turn.id": "turn-a",
        "rika.follow.cursor": "cursor-7",
        "rika.follow.scope": "execution",
      },
      {
        "rika.execution.id": "execution:turn-a",
        "rika.turn.id": "turn-a",
        "rika.follow.cursor": "cursor-9",
        "rika.follow.scope": "tree",
      },
    ])
    expect(
      annotationsFor("execution.follow.completed").map((annotations) => annotations["rika.follow.cursor"]),
    ).toEqual(["start", "cursor-7", "cursor-9"])
  }),
)
it.effect("sends ordered image content to Relay and Baton", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* start(backend, {
        threadId: "thread-image",
        turnId: "turn-image",
        prompt: "before [Image 1] after",
        promptParts: [
          { type: "text", text: "before " },
          { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
          { type: "text", text: " after" },
        ],
      })
    }).pipe(provideBackend(fixture.implementation))
    expect((yield* Ref.get(fixture.starts))[0]?.input).toEqual([
      Content.text("before "),
      { type: "blob-reference", uri: "data:image/png;base64,cG5n", media_type: "image/png", filename: "shot.png" },
      Content.text(" after"),
    ])
  }),
)
it.effect.each(["execution.completed", "execution.failed", "execution.cancelled"] as const)(
  "terminates the start stream at %s",
  (type) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent(type, 1), relayEvent("model.output.delta", 2)] })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
      }).pipe(provideBackend(fixture.implementation))
      expect(result.events.map((value) => value.type)).toEqual([type])
    }),
)
it.effect("projects opaque Relay failure detail without discarding event data", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      streamEvents: [
        relayEvent("execution.failed", 1, [], {
          message: "opaque provider failure",
          diagnostic: { retained: true },
        }),
      ],
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
    }).pipe(provideBackend(fixture.implementation))

    expect(result.events[0]).toMatchObject({
      type: "execution.failed",
      text: "opaque provider failure",
      data: { message: "opaque provider failure", diagnostic: { retained: true } },
    })
  }),
)
it.effect("replaces opaque context overflow failures with an actionable message", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      streamEvents: [
        relayEvent("execution.failed", 1, [], {
          message: "[object Object]",
          details: { failure_classification: "context-overflow" },
        }),
      ],
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
    }).pipe(provideBackend(fixture.implementation))

    expect(result.events[0]?.text).toBe("Automatic compaction could not reduce the thread enough for this model.")
  }),
)
it.effect("prefers terminal failure content over Relay failure metadata", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      streamEvents: [
        relayEvent("execution.failed", 1, [Content.text("content failure")], { message: "metadata failure" }),
      ],
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
    }).pipe(provideBackend(fixture.implementation))

    expect(result.events[0]?.text).toBe("content failure")
  }),
)
it.effect.each(["queued", "running"] as const)(
  "derives terminal completion after Relay starts with status %s",
  (status) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ startStatus: status, streamEvents: [relayEvent("execution.completed", 1)] })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
      }).pipe(provideBackend(fixture.implementation))
      expect(result.status).toBe("completed")
    }),
)
it.effect("detects an approval wait from inspection metadata after reconnect", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    Object.assign(fixture.implementation.executions, {
      inspect: () =>
        Effect.succeed({
          status: "waiting",
          last_event_cursor: "cursor-resume",
          waiting_on: [
            {
              wait_id: Ids.WaitId.make("wait:approval"),
              execution_id: Ids.ExecutionId.make("execution:turn-a"),
              mode: "event",
              state: "open",
              metadata: { kind: "tool-permission" },
              created_at: 1,
            },
          ],
          pending_tool_calls: [],
          child_runs: [],
        }),
      pageEvents: () =>
        Effect.succeed({
          events: [
            {
              execution_id: Ids.ExecutionId.make("execution:turn-a"),
              type: "model.output.delta",
              sequence: 1,
              cursor: "cursor-resume",
              created_at: 1,
            },
          ],
          has_more: false,
        }),
      follow: () => Stream.never,
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
      return yield* backend.follow("turn-a", "cursor-resume")
    }).pipe(provideBackend(fixture.implementation))

    expect(result.status).toBe("waiting")
    expect(yield* Ref.get(fixture.cancellations)).toEqual([])
  }),
)
