import * as ViewState from "@rika/terminal/terminal-state"
import * as TerminalMessage from "@rika/terminal/terminal-message"
import * as ServerService from "@rika/product/server-service"
import * as InteractiveController from "../../src/interactive/controller/interactive-controller"
import { Clock, Deferred, Effect, FileSystem, Fiber, Path, Queue, Ref, Stdio, Stream } from "effect"

export const runServerClientCommands = Effect.fn("ServerClient.runCommands")(function* (input: {
  readonly connection: ServerService.Connection
  readonly stdio: Stdio.Stdio
  readonly dataRoot: string
  readonly path: Path.Path
  readonly clock: Clock.Clock
  readonly fileSystem: FileSystem.FileSystem
  readonly hostPid: Ref.Ref<number>
  readonly emit: (value: unknown) => Effect.Effect<void>
  readonly kill: (pid: number) => Effect.Effect<void>
}) {
  const { connection, stdio, dataRoot, path, clock, fileSystem: fs, hostPid, emit, kill } = input

  const commands = stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
  )
  const done = yield* Deferred.make<void>()
  yield* Effect.raceFirst(
    commands.pipe(
      Stream.runForEach((command) => {
        const workspace = path.dirname(path.dirname(import.meta.dir))
        if (command === "ping") return connection.ping.pipe(Effect.andThen(emit({ type: "pong" })))
        if (command === "stall")
          return Effect.sync(() => {
            const until = clock.currentTimeMillisUnsafe() + 1_100
            while (clock.currentTimeMillisUnsafe() < until) {}
          }).pipe(Effect.andThen(connection.ping), Effect.andThen(emit({ type: "stall-survived" })))
        if (command === "reconnect-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_input, session) =>
                  Effect.gen(function* () {
                    yield* emit({ type: "interactive-callback", callbacks: 1 })
                    const events = yield* Queue.unbounded<string>()
                    const feed = yield* Effect.forkChild(
                      session.events((event) => Queue.offerUnsafe(events, event._tag)),
                    )
                    yield* emit({ type: "initial-read", tag: yield* Queue.take(events) })
                    const pid = yield* Ref.get(hostPid)
                    yield* kill(pid)
                    yield* emit({ type: "replacement-read", tag: yield* Queue.take(events) })
                    yield* session.submit("ambiguous")
                    let mutationFailed = false
                    let replacementRead = false
                    while (!mutationFailed || !replacementRead) {
                      const tag = yield* Queue.take(events)
                      if (tag === "ExecutionFailed" && !mutationFailed) {
                        mutationFailed = true
                        yield* emit({ type: "mutation-failed", tag })
                      } else if (tag === "ThreadsListed" && !replacementRead) {
                        replacementRead = true
                        yield* emit({ type: "post-mutation-read", tag })
                      }
                    }
                    const attempts = (yield* fs
                      .readFileString(path.join(dataRoot, "mutation-attempts.log"))
                      .pipe(Effect.orDie))
                      .trim()
                      .split("\n")
                    yield* emit({ type: "mutation-attempts", text: String(attempts.length) })
                    yield* Fiber.interrupt(feed)
                  }),
              },
            )
            .pipe(Effect.catch((error) => emit({ type: "reconnect-failed", error: error.message })))
        if (command === "flap-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_input, session) =>
                  Effect.gen(function* () {
                    yield* emit({ type: "interactive-callback", callbacks: 1 })
                    const attachedFeeds = yield* Queue.unbounded<void>()
                    const feed = yield* Effect.forkChild(
                      session.events(() => Queue.offerUnsafe(attachedFeeds, undefined)),
                    )
                    let killed = 0
                    while (killed < 20) {
                      yield* Queue.take(attachedFeeds)
                      const acquisitions = (yield* fs
                        .readFileString(path.join(dataRoot, "owner-acquisitions.log"))
                        .pipe(Effect.orDie))
                        .trim()
                        .split("\n")
                      const pid = Number(acquisitions.at(-1))
                      killed += 1
                      yield* kill(pid)
                    }
                    yield* Fiber.interrupt(feed)
                  }),
              },
            )
            .pipe(
              Effect.catch((error) =>
                fs.readFileString(path.join(dataRoot, "owner-acquisitions.log")).pipe(
                  Effect.flatMap((text) =>
                    emit({
                      type: "flap-failed",
                      callbacks: text.trim().split("\n").length,
                      error: error.message,
                    }),
                  ),
                  Effect.orDie,
                ),
              ),
            )
        if (command === "interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    yield* emit({ type: "interactive-callback" })
                    const events = yield* Queue.unbounded<string>()
                    const feed = yield* Effect.forkChild(
                      session.events((value) => Queue.offerUnsafe(events, value._tag)),
                    )
                    yield* emit({ type: "interactive-event", tag: yield* Queue.take(events) })
                    yield* Fiber.interrupt(feed)
                  }),
              },
            )
            .pipe(Effect.andThen(emit({ type: "interactive-completed" })))
        if (command === "child-execution-interactive")
          return connection.run(
            { _tag: "Interactive", prompt: ["child-execution-events"], ephemeral: false, workspace },
            {
              interactive: (_, session) =>
                Effect.gen(function* () {
                  const events = yield* Queue.unbounded<string>()
                  const feed = yield* Effect.forkChild(
                    session.events((event) => {
                      if (event._tag !== "ThreadViewPatch") return
                      const unit = event.patch.upsert[0]
                      if (unit?.content._tag === "Entry") Queue.offerUnsafe(events, unit.content.text)
                    }),
                  )
                  const tags = [yield* Queue.take(events), yield* Queue.take(events), yield* Queue.take(events)]
                  yield* Fiber.interrupt(feed)
                  yield* emit({ type: "child-execution-events-completed", tags })
                }),
            },
          )
        if (command === "timed-tool-interactive")
          return connection.run(
            { _tag: "Interactive", prompt: ["timed-tool-events"], ephemeral: false, workspace },
            {
              interactive: (_, session) =>
                Effect.gen(function* () {
                  const events = yield* Queue.unbounded<string>()
                  const eventClock = yield* Clock.Clock
                  const startedAt = eventClock.currentTimeMillisUnsafe()
                  let state: InteractiveController.State = {
                    model: {
                      ...ViewState.initial(workspace, "medium"),
                      currentThreadId: "timed-tool-thread",
                    },
                  }
                  const feed = yield* Effect.forkChild(
                    session.events((event) => {
                      if (
                        event._tag !== "ThreadViewSnapshot" &&
                        event._tag !== "ThreadViewPatch" &&
                        event._tag !== "ResyncRequired"
                      )
                        return
                      state = InteractiveController.update(state, event).state
                      if (event._tag !== "ThreadViewPatch") return
                      const unit = event.patch.upsert[0]
                      if (unit?.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return
                      Queue.offerUnsafe(
                        events,
                        `${unit.content.block.status}:${eventClock.currentTimeMillisUnsafe() - startedAt}:${TerminalMessage.formatActivity(state.model.activity)}`,
                      )
                    }),
                  )
                  const tags = [
                    yield* Queue.take(events),
                    yield* Queue.take(events),
                    yield* Queue.take(events),
                    yield* Queue.take(events),
                  ]
                  yield* Fiber.interrupt(feed)
                  yield* emit({ type: "timed-tool-events-completed", tags })
                }),
            },
          )
        if (command === "serialized-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: ["serialized-commands"], ephemeral: false, workspace },
              {
                interactive: (_input, session) =>
                  Effect.gen(function* () {
                    yield* Effect.all(
                      Array.from({ length: 4 }, (_, index) => session.submit(`serialized-${index}`)),
                      { concurrency: "unbounded", discard: true },
                    )
                    while (
                      !(yield* fs.exists(path.join(dataRoot, "interactive-serialization.json")).pipe(Effect.orDie))
                    )
                      yield* Effect.sleep("1 millis")
                    const result = yield* fs
                      .readFileString(path.join(dataRoot, "interactive-serialization.json"))
                      .pipe(Effect.orDie)
                    yield* emit({ type: "serialized-interactive-completed", text: result })
                  }),
              },
            )
            .pipe(Effect.catch((error) => emit({ type: "serialized-interactive-failed", error: error.message })))
        if (command === "oversized-submit")
          return Effect.gen(function* () {
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
                {
                  interactive: (_input, session) =>
                    Effect.gen(function* () {
                      yield* session.submit("oversized-submit", undefined, [
                        { type: "text", text: "look at this" },
                        { type: "image", mediaType: "image/png", data: "x".repeat(2_000_000), filename: "shot.png" },
                      ])
                      while (!(yield* fs.exists(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)))
                        yield* Effect.sleep("1 millis")
                      const text = yield* fs
                        .readFileString(path.join(dataRoot, "oversized-submit.json"))
                        .pipe(Effect.orDie)
                      const acquisitions = (yield* fs
                        .readFileString(path.join(dataRoot, "owner-acquisitions.log"))
                        .pipe(Effect.orDie))
                        .trim()
                        .split("\n")
                      yield* emit({ type: "oversized-submit-completed", text, callbacks: acquisitions.length })
                    }),
                },
              ),
            )
            if (exit._tag === "Failure") yield* emit({ type: "oversized-submit-failed", error: String(exit.cause) })
          })
        if (command === "over-ceiling-submit")
          return Effect.gen(function* () {
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
                {
                  interactive: (_input, session) =>
                    Effect.gen(function* () {
                      const events = yield* Queue.unbounded<{ readonly tag: string; readonly message: string }>()
                      const feed = yield* Effect.forkChild(
                        session.events((event) =>
                          Queue.offerUnsafe(events, {
                            tag: event._tag,
                            message: event._tag === "ExecutionFailed" ? event.failure.message : "",
                          }),
                        ),
                      )
                      yield* Queue.take(events)
                      yield* session.submit("over-ceiling", undefined, [
                        { type: "image", mediaType: "image/png", data: "x".repeat(17_000_000), filename: "big.png" },
                      ])
                      let failure = ""
                      while (failure === "") {
                        const next = yield* Queue.take(events)
                        if (next.tag === "ExecutionFailed") failure = next.message
                      }
                      yield* session.submit("oversized-submit", undefined, [
                        { type: "image", mediaType: "image/png", data: "y".repeat(2_000_000), filename: "ok.png" },
                      ])
                      while (!(yield* fs.exists(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)))
                        yield* Effect.sleep("1 millis")
                      const text = yield* fs
                        .readFileString(path.join(dataRoot, "oversized-submit.json"))
                        .pipe(Effect.orDie)
                      yield* Fiber.interrupt(feed)
                      yield* emit({ type: "over-ceiling-submit-completed", error: failure, text })
                    }),
                },
              ),
            )
            if (exit._tag === "Failure") yield* emit({ type: "over-ceiling-submit-failed", error: String(exit.cause) })
          })
        if (command === "rejected-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: ["reject-before-start"], ephemeral: false, workspace },
              { interactive: () => Effect.void },
            )
            .pipe(Effect.catch((error) => emit({ type: "interactive-rejected", error: error.message })))
        if (command === "burst-interactive")
          return Effect.gen(function* () {
            let count = 0
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["burst-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events(() => {
                          count += 1
                          if (count === 1_000) Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit(
              exit._tag === "Success"
                ? { type: "burst-completed", text: String(count) }
                : { type: "burst-failed", error: String(exit.cause) },
            )
          })
        if (command === "oversized-interactive-event")
          return Effect.gen(function* () {
            const events = yield* Queue.unbounded<string>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["oversized-event"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          if (event._tag === "ExecutionFailed") Queue.offerUnsafe(events, event.failure.message)
                        }),
                      )
                      const message = yield* Queue.take(events)
                      yield* Fiber.interrupt(feed)
                      yield* emit({ type: "oversized-interactive-event-completed", text: String(message.length) })
                    }),
                },
              ),
            )
            if (exit._tag === "Failure")
              yield* emit({ type: "oversized-interactive-event-failed", error: String(exit.cause) })
          })
        if (command === "wire-limit-reattach")
          return Effect.gen(function* () {
            const messages = yield* Queue.unbounded<string>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["wire-limit-event"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          if (
                            event._tag === "ExecutionFailed" &&
                            event.failure.message.includes("omitted an event larger than 16 MiB")
                          )
                            Queue.offerUnsafe(messages, event.failure.message)
                        }),
                      )
                      yield* Queue.take(messages)
                      const serverPid = yield* Ref.get(hostPid)
                      yield* kill(serverPid)
                      yield* Queue.take(messages)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: exit._tag === "Failure" ? "wire-limit-reattach-failed" : "wire-limit-reattach-completed",
              callbacks: 2,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "fragment-burst")
          return Effect.gen(function* () {
            const lengths = yield* Effect.forEach(
              ["large-event-a", "large-event-b"],
              (kind) =>
                Effect.gen(function* () {
                  const messages = yield* Queue.unbounded<string>()
                  let length = 0
                  yield* connection.run(
                    { _tag: "Interactive", prompt: [kind], ephemeral: false, workspace },
                    {
                      interactive: (_, session) =>
                        Effect.gen(function* () {
                          const feed = yield* Effect.forkChild(
                            session.events((event) => {
                              if (event._tag === "ExecutionFailed") Queue.offerUnsafe(messages, event.failure.message)
                            }),
                          )
                          const message = yield* Queue.take(messages)
                          length = message.length
                          yield* Fiber.interrupt(feed)
                        }),
                    },
                  )
                  return length
                }),
              { concurrency: 2 },
            )
            yield* emit({ type: "fragment-burst-completed", text: lengths.join(",") })
          }).pipe(Effect.catch((error) => emit({ type: "fragment-burst-failed", error: error.message })))
        if (command === "critical-overflow")
          return Effect.gen(function* () {
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["critical-overflow-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          if (event._tag === "ThreadsListed") Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* session.readQueue("critical-overflow-thread")
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: "critical-overflow-completed",
              outcome: exit._tag,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "overflow-interactive")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["overflow-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          tags.push(event._tag)
                          if (event._tag === "ThreadViewPatch" && event.patch.revision >= 6)
                            Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: exit._tag === "Failure" ? "overflow-failed" : "overflow-completed",
              callbacks: tags.length,
              tag: tags.at(-1),
              tags,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "slow-consumer")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["slow-consumer-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      yield* Effect.sleep("350 millis")
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          tags.push(event._tag)
                          if (event._tag === "ThreadViewPatch" && event.patch.revision >= 6)
                            Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: exit._tag === "Failure" ? "slow-consumer-failed" : "slow-consumer-completed",
              callbacks: tags.length,
              tags,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "queue-overflow-interactive")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["queue-overflow-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          tags.push(event._tag)
                          if (event._tag === "ThreadViewPatch" && event.patch.revision >= 6)
                            Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: exit._tag === "Failure" ? "queue-overflow-failed" : "queue-overflow-completed",
              callbacks: tags.length,
              tag: tags.at(-1),
              tags,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "overflow-watch")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const completed = yield* Queue.unbounded<void>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["overflow-watch"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    Effect.gen(function* () {
                      const feed = yield* Effect.forkChild(
                        session.events((event) => {
                          tags.push(event._tag)
                          if (event._tag === "ThreadsListed" && tags.includes("ThreadViewPatch"))
                            Queue.offerUnsafe(completed, undefined)
                        }),
                      )
                      yield* Queue.take(completed)
                      yield* Fiber.interrupt(feed)
                    }),
                },
              ),
            )
            yield* emit({
              type: "overflow-watch-finished",
              outcome: exit._tag,
              tags,
            })
          })
        if (command === "upgrade-interactive")
          return Effect.gen(function* () {
            let callbacks = 0
            yield* connection
              .run(
                { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
                {
                  interactive: (_input, session) =>
                    Effect.gen(function* () {
                      callbacks += 1
                      yield* emit({ type: "interactive-callback", callbacks })
                      const events = yield* Queue.unbounded<string>()
                      yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event._tag)))
                      yield* emit({ type: "initial-read", tag: yield* Queue.take(events) })
                      yield* emit({ type: "upgrade-survived", tag: yield* Queue.take(events), callbacks })
                      return yield* Effect.never
                    }),
                },
              )
              .pipe(
                Effect.catch((error) =>
                  emit({
                    type: "restart-required",
                    tag: error._tag,
                    error: error.message,
                    ...(error._tag === "ServerRestartRequired" && error.threadId !== undefined
                      ? { text: error.threadId }
                      : {}),
                  }),
                ),
              )
          })
        if (command === "blocking-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              { interactive: () => emit({ type: "interactive-callback" }).pipe(Effect.andThen(Effect.never)) },
            )
            .pipe(Effect.ensuring(emit({ type: "blocking-completed" })), Effect.forkChild, Effect.asVoid)
        if (command === "feed-takeover")
          return connection
            .run(
              { _tag: "Interactive", prompt: ["feed-takeover"], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    const first = yield* Effect.forkChild(session.events(() => undefined))
                    yield* Effect.sleep("50 millis")
                    yield* Fiber.interrupt(first)
                    const events = yield* Queue.unbounded<string>()
                    const second = yield* Effect.forkChild(
                      session.events((value) => Queue.offerUnsafe(events, value._tag)),
                    )
                    yield* emit({ type: "replacement-feed-event", tag: yield* Queue.take(events) })
                    yield* Fiber.interrupt(second)
                  }),
              },
            )
            .pipe(Effect.andThen(emit({ type: "feed-takeover-completed" })))
        if (command === "output")
          return connection
            .run({ _tag: "Doctor" }, { stdout: (text) => emit({ type: "output", text }) })
            .pipe(Effect.andThen(emit({ type: "output-completed" })))
        if (command === "oversized-output")
          return Effect.gen(function* () {
            let text = ""
            let callbacks = 0
            yield* connection.run(
              {
                _tag: "Run",
                prompt: ["oversized-output"],
                ephemeral: false,
                streamJson: false,
                streamJsonInput: false,
                streamJsonThinking: false,
              },
              {
                stdout: (chunk) =>
                  Effect.sync(() => {
                    text += chunk
                    callbacks += 1
                  }),
              },
            )
            yield* connection.ping
            yield* emit({
              type: "oversized-output-completed",
              text: String(text.length),
              callbacks,
              outcome: text === `${"x".repeat(1_100_000)}\n` ? "exact" : "mismatch",
            })
          })
        if (command === "delayed")
          return connection
            .run({
              _tag: "Run",
              prompt: ["delayed"],
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            })
            .pipe(
              Effect.andThen(emit({ type: "delayed-completed" })),
              Effect.catch((error) => emit({ type: "delayed-failed", error: error.message })),
            )
        if (command === "active-root-with-child")
          return connection
            .run({
              _tag: "Run",
              prompt: ["active-root-with-child"],
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            })
            .pipe(Effect.catch((error) => emit({ type: "active-execution-failed", error: error.message })))
        if (command === "cancel-delayed")
          return Effect.gen(function* () {
            const operation = yield* Effect.forkChild(
              connection.run({
                _tag: "Run",
                prompt: ["delayed"],
                ephemeral: false,
                streamJson: false,
                streamJsonInput: false,
                streamJsonThinking: false,
              }),
            )
            while (!(yield* fs.exists(path.join(dataRoot, "delayed-work-starts.log")).pipe(Effect.orDie)))
              yield* Effect.sleep("1 millis")
            yield* Fiber.interrupt(operation)
            while (!(yield* fs.exists(path.join(dataRoot, "delayed-work-finalizations.log")).pipe(Effect.orDie)))
              yield* Effect.sleep("1 millis")
            yield* connection.ping
            yield* emit({ type: "cancelled-delayed" })
          })
        if (command === "rejected")
          return connection.run({ _tag: "Doctor" }).pipe(
            Effect.andThen(emit({ type: "rejected-work-completed" })),
            Effect.catch((error) => emit({ type: "rejected-work", error: error.message })),
          )
        if (command === "close")
          return connection.close.pipe(
            Effect.andThen(emit({ type: "closed" })),
            Effect.andThen(Deferred.succeed(done, undefined)),
          )
        return Effect.void
      }),
    ),
    Deferred.await(done),
  )
})
