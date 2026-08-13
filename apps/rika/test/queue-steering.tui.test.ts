import { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { expect, test } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

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
  remaining = 2_000,
): Effect.Effect<QueueSnapshot, never> =>
  Effect.gen(function* () {
    const queue = yield* app.queue(threadId).pipe(Effect.orDie)
    if (predicate(queue)) return queue
    if (remaining <= 0)
      return yield* Effect.die(
        `queue condition was not met: ${queue.turns.map((turn) => `${turn.id}:${turn.delivery ?? "followUp"}`).join(", ")}`,
      )
    yield* Effect.sleep("10 millis")
    return yield* waitQueue(app, threadId, predicate, remaining - 10)
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
              { delayMillis: 10_000 },
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
          app.pressKey("\u001b[13;3u")
        }

        const queued = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 10)
        expect(queued.turns.map((turn) => [turn.prompt, turn.delivery ?? "followUp"])).toEqual(
          prompts.map((prompt) => [prompt, "followUp"]),
        )

        yield* selectQueue(app, prompts, 4)
        app.pressEnter()
        const steering = yield* waitQueue(
          app,
          threadId,
          (queue) => queue.turns.find((turn) => turn.prompt === "QUEUE_4")?.delivery === "steer",
        )
        expect(steering.queuedCount).toBe(10)

        yield* selectQueue(app, prompts, 7)
        app.pressKey("e", { ctrl: true })
        yield* app.waitFrame("Editing queued")
        yield* Effect.promise(() => app.type("_EDITED"))
        app.pressEnter()
        const edited = yield* waitQueue(app, threadId, (queue) =>
          queue.turns.some((turn) => turn.prompt === "QUEUE_7_EDITED"),
        )
        expect(edited.queuedCount).toBe(10)
        expect(edited.revision).toBe(steering.revision + 1)
        expect(edited.turns.map((turn) => turn.prompt)).toEqual(
          prompts.map((prompt, index) => (index === 7 ? "QUEUE_7_EDITED" : prompt)),
        )
        expect(edited.turns.find((turn) => turn.prompt === "QUEUE_7_EDITED")?.delivery ?? "followUp").toBe("followUp")

        yield* app.waitFrame("STEERED_CONTINUATION_COMPLETE", 30_000)
        yield* app.waitFrame("DRAINED_8", 30_000)
        const drained = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 5_000)
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
            model.text("CANCELLED_RESPONSE_MUST_NOT_RENDER", 10_000),
            ...Array.from({ length: 9 }, (_, index) => model.text(`CANCEL_DRAINED_${index}`)),
          ],
        })
        yield* Effect.promise(() => app.type("Hold the active turn for cancellation."))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        for (const prompt of prompts) {
          yield* Effect.promise(() => app.type(prompt))
          app.pressKey("\u001b[13;3u")
        }
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 10)

        yield* selectQueue(app, prompts, 4)
        app.pressEnter()
        yield* waitQueue(
          app,
          threadId,
          (queue) => queue.turns.find((turn) => turn.prompt === "CANCEL_QUEUE_4")?.delivery === "steer",
        )
        app.pressKey("c", { ctrl: true })

        yield* app.waitFrame("CANCEL_DRAINED_8", 30_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 5_000)).turns).toEqual([])
        const frame = yield* app.waitGone("steering: CANCEL_QUEUE_4")
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
  60_000,
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
            model.failure("EXPECTED_ACTIVE_FAILURE", 10_000),
            model.text("FAIL_DRAINED_0"),
            model.text("FAIL_DRAINED_1"),
          ],
        })

        yield* Effect.promise(() => app.type("Fail after accepting steering."))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        for (const prompt of prompts) {
          yield* Effect.promise(() => app.type(prompt))
          app.pressKey("\u001b[13;3u")
        }
        yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 3)

        yield* selectQueue(app, prompts, 2)
        app.pressEnter()
        yield* waitQueue(
          app,
          threadId,
          (queue) => queue.turns.find((turn) => turn.prompt === "FAIL_QUEUE_2")?.delivery === "steer",
        )

        yield* selectQueue(app, prompts, 1)
        app.pressKey("e", { ctrl: true })
        yield* app.waitFrame("Editing queued")
        yield* Effect.promise(() => app.type("_MUST_NOT_SAVE"))
        app.pressKey("escape")
        const unchanged = yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 3)
        expect(unchanged.turns.map((turn) => turn.prompt)).toEqual(prompts)

        yield* app.waitFrame("FAIL_DRAINED_1", 30_000)
        expect((yield* waitQueue(app, threadId, (queue) => queue.queuedCount === 0, 5_000)).turns).toEqual([])
        expect((yield* app.waitGone("steering: FAIL_QUEUE_2")).match(/FAIL_QUEUE_2/g) ?? []).toHaveLength(0)

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
