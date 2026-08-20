import { Clock, Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { expect, test } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "./tui-app"
import { laneExecutionRoute, model } from "./tui-app-model"

const promptTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role === "user") return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    return []
  })

type QueueSnapshot = Effect.Success<ReturnType<TuiApp.TuiApp["queue"]>>

const waitQueue = (
  app: TuiApp.TuiApp,
  threadId: Thread.ThreadId,
  predicate: (queue: QueueSnapshot) => boolean,
  budgetMillis = 20_000,
): Effect.Effect<QueueSnapshot, never> =>
  Effect.gen(function* () {
    const started = performance.now()
    for (;;) {
      const queue = yield* app.queue(threadId).pipe(Effect.orDie)
      if (predicate(queue)) return queue
      if (performance.now() - started >= budgetMillis)
        return yield* Effect.die(
          `queue condition was not met: ${queue.turns.map((turn) => String(turn.id)).join(", ")}`,
        )
      yield* Effect.sleep("10 millis")
    }
  })

const selectQueue = (app: TuiApp.TuiApp, prompts: ReadonlyArray<string>, target: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < prompts.length + 2; attempt += 1) {
      const lines = (yield* app.nextFrame).split("\n")
      const selected = prompts.findIndex((prompt) =>
        lines.some((line) => line.includes(prompt) && line.includes("Backspace to dequeue")),
      )
      if (selected === target) return
      app.pressArrow(selected < 0 || selected > target ? "up" : "down")
    }
    return yield* Effect.die(`could not select ${prompts[target]}`)
  })

test(
  "drains ten pending turns after steering a middle row and editing another row",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const prompts = Array.from({ length: 10 }, (_, index) => `QUEUE_${index}`)
        const threadId = Thread.ThreadId.make("tui-thread-0")
        const app = yield* TuiApp.tuiApp({
          height: 42,
          inspectTranscript: true,
          workspaceFiles: { "fixture.txt": "deterministic queue fixture" },
          script: [
            model.turn(
              [model.binding({ module: "workspace", operation: "read", input: { path: "fixture.txt" } }, "queue-read")],
              // Filling and steering the queue measures ~0.5s; this keeps several times that
              // margin without the test sitting out the remainder of the answer.
              { delayMillis: 4_000 },
            ),
            model.text("STEERED_CONTINUATION_COMPLETE"),
            ...Array.from({ length: 9 }, (_, index) => model.text(`DRAINED_${index}`)),
          ],
        })

        yield* Effect.promise(() => app.type("Run the deterministic agentic queue scenario."))
        app.pressEnter()
        yield* app.waitModelRequests(1)

        for (const prompt of prompts) {
          yield* Effect.promise(() => app.type(prompt))
          app.pressEnter()
        }

        const queued = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 10)
        expect(queued.turns.map((turn) => turn.prompt)).toEqual(prompts)

        yield* selectQueue(app, prompts, 4)
        app.pressEnter()
        const remainingPrompts = prompts.filter((prompt) => prompt !== "QUEUE_4")
        const steered = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 9)
        expect(steered.turns.map((turn) => turn.prompt)).toEqual(remainingPrompts)
        yield* app.waitFrameMatch((frame) =>
          frame.split("\n").every((line) => !line.includes("QUEUE_4") || !line.includes("Backspace to dequeue")),
        )

        yield* selectQueue(app, remainingPrompts, remainingPrompts.indexOf("QUEUE_7"))
        app.pressKey("e", { ctrl: true })
        yield* app.waitFrame("Editing queued")
        yield* Effect.promise(() => app.type("_EDITED"))
        app.pressEnter()
        const edited = yield* waitQueue(app, threadId, (queue) =>
          queue.turns.some((turn) => turn.prompt === "QUEUE_7_EDITED"),
        )
        expect(edited.queuedCount).toBe(9)
        expect(edited.revision).toBe(steered.revision + 1)
        expect(edited.turns.map((turn) => turn.prompt)).toEqual(
          remainingPrompts.map((prompt) => (prompt === "QUEUE_7" ? "QUEUE_7_EDITED" : prompt)),
        )

        yield* app.waitFrame("STEERED_CONTINUATION_COMPLETE", 30_000)
        yield* app.waitFrame("DRAINED_8", 30_000)
        const drained = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 20_000)
        expect(drained.turns).toEqual([])

        const requestTexts = (yield* app.modelPrompts).map(promptTexts)
        expect(requestTexts).toHaveLength(11)
        expect(requestTexts.map((texts) => texts.at(-1))).toEqual([
          "Run the deterministic agentic queue scenario.",
          "QUEUE_4",
          "QUEUE_0",
          "QUEUE_1",
          "QUEUE_2",
          "QUEUE_3",
          "QUEUE_5",
          "QUEUE_6",
          "QUEUE_7_EDITED",
          "QUEUE_8",
          "QUEUE_9",
        ])
        expect(requestTexts.slice(1).every((texts) => texts.filter((text) => text === "QUEUE_4").length === 1)).toBe(
          true,
        )
        const activeTranscript = yield* app.transcript(Turn.TurnId.make("tui-turn-0")).pipe(Effect.orDie)
        expect(
          activeTranscript?.units.filter(
            (unit) => unit.content._tag === "Entry" && unit.content.role === "user" && unit.content.text === "QUEUE_4",
          ),
        ).toHaveLength(1)
        yield* app.quit
      }),
    ),
  60_000,
)

test(
  "queues composer input by default and explicitly steers the selected row while a response completes",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const threadId = Thread.ThreadId.make("tui-thread-0")
        const activeTurnId = Turn.TurnId.make("tui-turn-0")
        const app = yield* TuiApp.tuiApp({
          height: 36,
          inspectTranscript: true,
          // Steering the queued row measures ~0.5s, so the active answer stays pending with
          // several times that margin instead of holding the turn open for ten seconds.
          script: [model.text("HELLO_COMPLETE", 4_000), model.text("HI_COMPLETE")],
        })

        yield* Effect.promise(() => app.type("Hello"))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        yield* Effect.promise(() => app.type("Hi"))
        app.pressEnter()
        yield* waitQueue(app, threadId, (queue) => queue.turns.some((turn) => turn.prompt === "Hi"))
        app.pressArrow("up")
        yield* app.waitFrame("Enter to steer")
        app.pressEnter()
        yield* app.waitTranscript(
          activeTurnId,
          (projection) =>
            projection.state.steering.pending?.some((entry) => entry.text === "Hi") === true ||
            projection.state.steering.settled?.some((entry) => entry.outcome === "consumed") === true,
          20_000,
        )
        app.pressEnter()
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0)

        yield* app.waitFrame("HI_COMPLETE", 20_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 20_000)).turns).toEqual([])
        expect((yield* app.modelPrompts).map(promptTexts).map((texts) => texts.at(-1))).toEqual(["Hello", "Hi"])
        const activeTranscript = yield* app.transcript(activeTurnId).pipe(Effect.orDie)
        expect(
          activeTranscript?.units.filter(
            (unit) => unit.content._tag === "Entry" && unit.content.role === "user" && unit.content.text === "Hi",
          ),
        ).toHaveLength(1)
        yield* app.quit
      }),
    ),
  60_000,
)

test(
  "replays a terminal TenetKit run to settle steering accepted before product recovery",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const threadId = Thread.ThreadId.make("recovered-steering-thread")
        const activeTurnId = Turn.TurnId.make("recovered-steering-active")
        const steeringTurnId = Turn.TurnId.make("recovered-steering-source")
        const followUpTurnId = Turn.TurnId.make("recovered-steering-follow-up")
        const request = {
          text: "RECOVERED_STEERING",
          idempotencyKey: "rika:steer:recovered-steering-source",
        }
        let acceptedRunId = ""
        let acceptedEntryId = ""
        let acceptedSequence = -1
        const app = yield* TuiApp.tuiApp({
          initialThreadId: threadId,
          idStart: 10,
          height: 36,
          inspectTranscript: true,
          workspaceFiles: { "recovery.txt": "durable recovery fixture" },
          script: [
            model.turn(
              [
                model.binding(
                  { module: "workspace", operation: "read", input: { path: "recovery.txt" } },
                  "recovery-read",
                ),
              ],
              { delayMillis: 2_000 },
            ),
            model.text("RECOVERED_STEERING_COMPLETE"),
            model.text("RECOVERED_FOLLOW_UP_COMPLETE"),
          ],
          prepareRuntimeState: ({ workspace, backend, threads, turns, waitModelRequests }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              yield* threads.create({
                id: threadId,
                workspace,
                title: "Recovered steering",
                now,
              })
              const link = yield* backend.startTurn({
                threadId,
                turnId: activeTurnId,
                workspace,
                prompt: "Run a real agentic step before product recovery.",
                executionRoute: laneExecutionRoute(),
              })
              acceptedRunId = link.runId
              const provenance = {
                _tag: "AgentExecution" as const,
                author: { _tag: "Human" as const },
                lineage: { _tag: "Original" as const },
              }
              yield* turns.copy(
                {
                  ...provenance,
                  id: activeTurnId,
                  threadId,
                  prompt: "Run a real agentic step before product recovery.",
                  executionRoute: laneExecutionRoute(),
                  executionLink: link,
                  status: "running",
                  createdAt: now,
                  updatedAt: now,
                },
                32,
              )
              yield* turns.copy(
                {
                  ...provenance,
                  id: steeringTurnId,
                  threadId,
                  prompt: request.text,
                  executionRoute: laneExecutionRoute(),
                  status: "queued",
                  createdAt: now + 1,
                  updatedAt: now + 1,
                },
                32,
              )
              yield* turns.copy(
                {
                  ...provenance,
                  id: followUpTurnId,
                  threadId,
                  prompt: "RECOVERED_FOLLOW_UP",
                  executionRoute: laneExecutionRoute(),
                  status: "queued",
                  createdAt: now + 2,
                  updatedAt: now + 2,
                },
                32,
              )
              yield* turns.prepareQueuedSteeringAdmission(steeringTurnId, link, request, [], now + 3)
              yield* waitModelRequests(1)
              const receipt = yield* backend.steerTurn(link, request)
              acceptedEntryId = receipt.entryId
              acceptedSequence = receipt.sequence
              yield* turns.acceptSteeringAdmission(request.idempotencyKey, receipt)
              yield* waitModelRequests(2)
              const waitForCompletion = (remaining: number): Effect.Effect<void> =>
                backend.inspectTurn(link).pipe(
                  Effect.flatMap(({ status }) => {
                    if (status === "completed") return Effect.void
                    if (status === "failed" || status === "cancelled" || status === "unavailable" || remaining <= 0)
                      return Effect.die(`seeded TenetKit run settled as ${status}`)
                    return Effect.sleep("10 millis").pipe(Effect.andThen(waitForCompletion(remaining - 10)))
                  }),
                  Effect.orDie,
                )
              yield* waitForCompletion(10_000)
              yield* turns.setStatus(activeTurnId, "completed", now + 4)

              expect(yield* turns.readQueue(threadId)).toMatchObject({
                queuedCount: 1,
                turns: [{ id: followUpTurnId, prompt: "RECOVERED_FOLLOW_UP" }],
              })
              expect(yield* turns.listSteeringAdmissions).toMatchObject([
                {
                  input: request,
                  outcome: { _tag: "Accepted", receipt },
                },
              ])
            }),
        })

        yield* app.waitFrame("RECOVERED_FOLLOW_UP_COMPLETE", 20_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 20_000)).turns).toEqual([])
        expect(
          (yield* app.nextFrame)
            .split("\n")
            .some((line) => line.includes("RECOVERED_STEERING") && line.includes("Backspace to dequeue")),
        ).toBe(false)
        expect((yield* app.modelPrompts).map(promptTexts).map((texts) => texts.at(-1))).toEqual([
          "Run a real agentic step before product recovery.",
          request.text,
          "RECOVERED_FOLLOW_UP",
        ])
        const recoveredTranscript = yield* app.transcript(activeTurnId).pipe(Effect.orDie)
        expect(recoveredTranscript?.state.steering.settled).toContainEqual({
          runId: acceptedRunId,
          entryId: acceptedEntryId,
          requestId: request.idempotencyKey,
          sequence: acceptedSequence,
          outcome: "consumed",
        })
        expect(
          recoveredTranscript?.units.filter(
            (unit) =>
              unit.content._tag === "Entry" && unit.content.role === "user" && unit.content.text === request.text,
          ),
        ).toHaveLength(1)
        const followUpTranscript = yield* app.waitTranscript(
          followUpTurnId,
          (projection) => projection.state.status === "completed",
          20_000,
        )
        expect(
          followUpTranscript.units.filter(
            (unit) =>
              unit.content._tag === "Entry" &&
              unit.content.role === "assistant" &&
              unit.content.text === "RECOVERED_FOLLOW_UP_COMPLETE",
          ),
        ).toHaveLength(1)
        yield* app.quit
      }),
    ),
  60_000,
)

test(
  "removes discarded steering and drains the other nine turns after cancellation",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const prompts = Array.from({ length: 10 }, (_, index) => `CANCEL_QUEUE_${index}`)
        const threadId = Thread.ThreadId.make("tui-thread-0")
        const activeTurnId = Turn.TurnId.make("tui-turn-0")
        const app = yield* TuiApp.tuiApp({
          height: 42,
          inspectTranscript: true,
          script: [
            // The queue is filled and cancelled well inside a second, so the answer that must
            // never render is held several times that instead of for ten seconds.
            model.text("CANCELLED_RESPONSE_MUST_NOT_RENDER", 4_000),
            ...Array.from({ length: 9 }, (_, index) => model.text(`CANCEL_DRAINED_${index}`)),
          ],
        })
        yield* Effect.promise(() => app.type("Hold the active turn for cancellation."))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        for (const prompt of prompts) {
          yield* Effect.promise(() => app.type(prompt))
          app.pressEnter()
        }
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 10)

        yield* selectQueue(app, prompts, 4)
        app.pressEnter()
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 9)
        yield* app.waitTranscript(
          activeTurnId,
          (projection) => projection.state.steering.pending?.some((entry) => entry.text === "CANCEL_QUEUE_4") === true,
        )
        app.pressKey("c", { ctrl: true })

        yield* app.waitFrame("CANCEL_DRAINED_8", 90_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 20_000)).turns).toEqual([])
        const frame = yield* app.nextFrame
        expect(frame).not.toContain("CANCELLED_RESPONSE_MUST_NOT_RENDER")

        const requestTexts = (yield* app.modelPrompts).map(promptTexts)
        expect(requestTexts.map((texts) => texts.at(-1))).toEqual([
          "Hold the active turn for cancellation.",
          "CANCEL_QUEUE_0",
          "CANCEL_QUEUE_1",
          "CANCEL_QUEUE_2",
          "CANCEL_QUEUE_3",
          "CANCEL_QUEUE_5",
          "CANCEL_QUEUE_6",
          "CANCEL_QUEUE_7",
          "CANCEL_QUEUE_8",
          "CANCEL_QUEUE_9",
        ])
        const activeTranscript = yield* app.transcript(activeTurnId).pipe(Effect.orDie)
        expect(activeTranscript?.state.status).toBe("cancelled")
        expect(activeTranscript?.state.steering.settled).toContainEqual(
          expect.objectContaining({ outcome: "discarded" }),
        )
        expect(
          activeTranscript?.units.some(
            (unit) =>
              unit.content._tag === "Entry" && unit.content.role === "user" && unit.content.text === "CANCEL_QUEUE_4",
          ),
        ).toBe(false)
        yield* app.quit
      }),
    ),
  120_000,
)

test(
  "discards tail steering after model failure and preserves a cancelled queue edit",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const prompts = Array.from({ length: 3 }, (_, index) => `FAIL_QUEUE_${index}`)
        const threadId = Thread.ThreadId.make("tui-thread-0")
        const activeTurnId = Turn.TurnId.make("tui-turn-0")
        const app = yield* TuiApp.tuiApp({
          height: 36,
          inspectTranscript: true,
          script: [
            // Queueing, steering, and editing before the failure lands measures ~0.7s, so the
            // failure is held several times that rather than for ten seconds.
            model.failure("EXPECTED_ACTIVE_FAILURE", 4_000),
            model.text("FAIL_DRAINED_0"),
            model.text("FAIL_DRAINED_1"),
          ],
        })

        yield* Effect.promise(() => app.type("Fail after accepting steering."))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        for (const prompt of prompts) {
          yield* Effect.promise(() => app.type(prompt))
          app.pressEnter()
        }
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 3)

        yield* selectQueue(app, prompts, 2)
        app.pressEnter()
        const remainingPrompts = prompts.filter((prompt) => prompt !== "FAIL_QUEUE_2")
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 2)

        yield* selectQueue(app, remainingPrompts, 1)
        app.pressKey("e", { ctrl: true })
        yield* app.waitFrame("Editing queued")
        yield* Effect.promise(() => app.type("_MUST_NOT_SAVE"))
        app.pressKey("escape")
        const unchanged = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 2)
        expect(unchanged.turns.map((turn) => turn.prompt)).toEqual(remainingPrompts)

        yield* app.waitFrame("FAIL_DRAINED_1", 30_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 20_000)).turns).toEqual([])
        expect((yield* app.nextFrame).match(/FAIL_QUEUE_2/g) ?? []).toHaveLength(0)

        const requestTexts = (yield* app.modelPrompts).map(promptTexts)
        expect(requestTexts.map((texts) => texts.at(-1))).toEqual([
          "Fail after accepting steering.",
          "FAIL_QUEUE_0",
          "FAIL_QUEUE_1",
        ])
        expect(requestTexts.flat()).not.toContain("FAIL_QUEUE_1_MUST_NOT_SAVE")
        const activeTranscript = yield* app.transcript(activeTurnId).pipe(Effect.orDie)
        expect(activeTranscript?.state.status).toBe("failed")
        expect(activeTranscript?.state.steering.settled).toContainEqual(
          expect.objectContaining({ outcome: "discarded" }),
        )
        yield* app.quit
      }),
    ),
  60_000,
)
