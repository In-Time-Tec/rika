import { describe, expect, test } from "bun:test"
import { Event, Ids, Message } from "@rika/schema"
import { Effect, Fiber, Queue, Stream } from "effect"
import { Adapter, Backend, Controller, Keys, ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_tui_controller")
const turnId = Ids.TurnId.make("turn_tui_controller")
const workspacePath = "/tmp/rika-tui-controller"
const workspaceId = Ids.WorkspaceId.make("workspace_tui_controller")

describe("Controller", () => {
  test("actor-backed submit renders the user message before the actor accepts", async () => {
    const rendered: Array<ViewState.ViewState> = []
    let submitted = 0
    const backend = backendWithSubmit(() =>
      Effect.sync(() => {
        submitted += 1
      }).pipe(Effect.andThen(Effect.never)),
    )
    const renderer = rendererWithKeys(rendered, [...Keys.fromString("slow actor"), Keys.enter])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          const submittedState = yield* waitForRenderedState(
            rendered,
            (candidate) =>
              candidate.messages.some((message) => message.role === "user" && message.text === "slow actor") &&
              submitted === 1,
          )
          yield* Fiber.interrupt(fiber)
          return submittedState
        }),
      ),
    )

    expect(submitted).toBe(1)
    expect(state.active).toBe(true)
    expect(state.activity).toBe("thinking")
    expect(state.messages.at(-1)).toMatchObject({ role: "user", text: "slow actor" })
  })

  test("actor-backed submit stays active after the actor accepts until durable events arrive", async () => {
    const rendered: Array<ViewState.ViewState> = []
    let submitted = 0
    const backend = backendWithSubmit(() =>
      Effect.sync(() => {
        submitted += 1
      }),
    )
    const renderer = rendererWithKeys(rendered, [...Keys.fromString("fast actor"), Keys.enter])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          yield* waitForRenderedState(
            rendered,
            (candidate) =>
              candidate.messages.some((message) => message.role === "user" && message.text === "fast actor") &&
              submitted === 1,
          )
          yield* Effect.sleep("10 millis")
          const latest = rendered.at(-1)
          yield* Fiber.interrupt(fiber)
          if (latest === undefined) return yield* Effect.fail(new Error("expected rendered state was not observed"))
          return latest
        }),
      ),
    )

    expect(submitted).toBe(1)
    expect(state.active).toBe(true)
    expect(state.activity).toBe("thinking")
    expect(state.messages.at(-1)).toMatchObject({ role: "user", text: "fast actor" })
  })

  test("actor-backed submit failure removes the optimistic user message", async () => {
    const rendered: Array<ViewState.ViewState> = []
    const backend = backendWithSubmit(() => Effect.fail(new Error("actor unavailable")))
    const renderer = rendererWithKeys(rendered, [...Keys.fromString("failed actor"), Keys.enter])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          const failed = yield* waitForRenderedState(
            rendered,
            (candidate) => candidate.notice?.includes("actor unavailable") === true,
          )
          yield* Fiber.interrupt(fiber)
          return failed
        }),
      ),
    )

    expect(state.active).toBe(false)
    expect(state.activity).toBe("failed")
    expect(state.messages.some((message) => message.text === "failed actor")).toBe(false)
  })

  test("actor active-user rejection removes the optimistic message and queues one copy", async () => {
    const rendered: Array<ViewState.ViewState> = []
    const error = Object.assign(new Error("active turn"), { active_user_id: "user_other" })
    const backend = backendWithSubmit(() => Effect.fail(error))
    const renderer = rendererWithKeys(rendered, [...Keys.fromString("queued actor"), Keys.enter])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          const queued = yield* waitForRenderedState(
            rendered,
            (candidate) => candidate.notice?.includes("user_other is running a turn") === true,
          )
          yield* Fiber.interrupt(fiber)
          return queued
        }),
      ),
    )

    expect(state.messages.some((message) => message.text === "queued actor")).toBe(false)
    expect(state.queued).toEqual(["queued actor"])
  })

  test("actor active-user rejection preserves queue order when later input is queued", async () => {
    const rendered: Array<ViewState.ViewState> = []
    const error = Object.assign(new Error("active turn"), { active_user_id: "user_other" })
    const backend = backendWithSubmit(() => Effect.sleep("10 millis").pipe(Effect.andThen(Effect.fail(error))))
    const renderer = rendererWithKeys(rendered, [
      ...Keys.fromString("first actor"),
      Keys.enter,
      ...Keys.fromString("second actor"),
      Keys.enter,
    ])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          const queued = yield* waitForRenderedState(
            rendered,
            (candidate) =>
              candidate.notice?.includes("user_other is running a turn") === true && candidate.queued.length === 2,
          )
          yield* Fiber.interrupt(fiber)
          return queued
        }),
      ),
    )

    expect(state.messages.some((message) => message.text === "first actor")).toBe(false)
    expect(state.queued).toEqual(["first actor", "second actor"])
  })

  test("interrupting a pending actor submit removes the optimistic user message", async () => {
    const rendered: Array<ViewState.ViewState> = []
    const backend = backendWithSubmit(() => Effect.never)
    const renderer = rendererWithKeys(rendered, [
      ...Keys.fromString("interrupt actor"),
      Keys.enter,
      Keys.escape,
      Keys.escape,
    ])

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Controller.run(
            { backend, renderer, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)
          const interrupted = yield* waitForRenderedState(
            rendered,
            (candidate) => candidate.notice === "Interrupted the running turn.",
          )
          yield* Fiber.interrupt(fiber)
          return interrupted
        }),
      ),
    )

    expect(state.active).toBe(false)
    expect(state.messages.some((message) => message.text === "interrupt actor")).toBe(false)
  })

  test("queued actor turn waits for final assistant catch-up", async () => {
    const rendered: Array<ViewState.ViewState> = []
    let submitted = 0
    const text = "assistant final text should finish before the queued user starts"

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<Event.Event>()
          const ticks = yield* Queue.unbounded<void>()
          const backend = backendWithThreadEvents(
            () =>
              Effect.sync(() => {
                submitted += 1
              }),
            events,
          )
          const renderer = rendererWithKeys(rendered, [
            ...Keys.fromString("first actor"),
            Keys.enter,
            ...Keys.fromString("second actor"),
            Keys.enter,
          ])
          const fiber = yield* Controller.run(
            {
              backend,
              renderer,
              ticks: Stream.fromQueue(ticks),
              defaultMode: "smart",
              defaultWorkspace: workspacePath,
            },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)

          yield* waitForRenderedState(
            rendered,
            (candidate) => submitted === 1 && candidate.queued.includes("second actor"),
          )

          yield* Queue.offer(events, { ...modelChunk(text), sequence: 1 })
          yield* Queue.offer(events, { ...assistantMessageAdded(text), sequence: 2 })
          yield* Queue.offer(events, turnCompleted(3))

          yield* waitForRenderedState(
            rendered,
            (candidate) =>
              submitted === 1 &&
              candidate.queued.includes("second actor") &&
              ViewState.hasUncommittedStreaming(candidate),
          )

          for (let index = 0; index < 120; index += 1) {
            if (submitted >= 2) break
            yield* Queue.offer(ticks, undefined)
            yield* Effect.yieldNow
          }

          const nextStarted = yield* waitForRenderedState(
            rendered,
            (candidate) =>
              submitted === 2 &&
              candidate.messages.some((message) => message.role === "assistant" && message.text === text) &&
              candidate.messages.at(-1)?.role === "user" &&
              candidate.messages.at(-1)?.text === "second actor",
          )
          yield* Fiber.interrupt(fiber)
          return nextStarted
        }),
      ),
    )

    const messages = state.entries
      .filter(
        (entry): entry is { readonly kind: "message"; readonly message: ViewState.ThreadMessage } =>
          entry.kind === "message",
      )
      .map((entry) => ({ role: entry.message.role, text: entry.message.text }))
    expect(submitted).toBe(2)
    expect(messages).toEqual([
      { role: "user", text: "first actor" },
      { role: "assistant", text },
      { role: "user", text: "second actor" },
    ])
  })

  test("queued actor turn drains long final assistant catch-up within a bounded tick count", async () => {
    const rendered: Array<ViewState.ViewState> = []
    let submitted = 0
    const text = "x".repeat(6000)

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<Event.Event>()
          const ticks = yield* Queue.unbounded<void>()
          const backend = backendWithThreadEvents(
            () =>
              Effect.sync(() => {
                submitted += 1
              }),
            events,
          )
          const renderer = rendererWithKeys(rendered, [
            ...Keys.fromString("first long actor"),
            Keys.enter,
            ...Keys.fromString("second long actor"),
            Keys.enter,
          ])
          const fiber = yield* Controller.run(
            {
              backend,
              renderer,
              ticks: Stream.fromQueue(ticks),
              defaultMode: "smart",
              defaultWorkspace: workspacePath,
            },
            { workspace_root: workspacePath, workspace_id: workspaceId, mode: "smart" },
          ).pipe(Effect.forkScoped)

          yield* waitForRenderedState(
            rendered,
            (candidate) => submitted === 1 && candidate.queued.includes("second long actor"),
          )

          yield* Queue.offer(events, { ...modelChunk(text), sequence: 1 })
          yield* Queue.offer(events, { ...assistantMessageAdded(text), sequence: 2 })
          yield* Queue.offer(events, turnCompleted(3))

          yield* waitForRenderedState(
            rendered,
            (candidate) =>
              submitted === 1 &&
              candidate.queued.includes("second long actor") &&
              ViewState.hasUncommittedStreaming(candidate),
          )

          for (let index = 0; index < 50; index += 1) {
            if (submitted >= 2) break
            yield* Queue.offer(ticks, undefined)
            yield* Effect.yieldNow
          }

          const nextStarted = yield* waitForRenderedState(
            rendered,
            (candidate) =>
              submitted === 2 &&
              candidate.messages.some((message) => message.role === "assistant" && message.text === text) &&
              candidate.messages.at(-1)?.role === "user" &&
              candidate.messages.at(-1)?.text === "second long actor",
          )
          yield* Fiber.interrupt(fiber)
          return nextStarted
        }),
      ),
    )

    expect(submitted).toBe(2)
    expect(state.queued).toEqual([])
  })

  test("durable user messages replace matching pending user messages", () => {
    const state = ViewState.appendPendingUserMessage(
      ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: "smart" }),
      { id: "1", text: "hello" },
    )
    const next = ViewState.applyEvent(state, messageAdded("hello "))

    expect(next.messages).toHaveLength(1)
    expect(next.entries).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({ id: "message_tui_controller", role: "user", text: "hello " })
  })

  test("model stream chunks reveal across ticks instead of all at once", () => {
    const text = "hello smooth streaming across several frames"
    const initial = ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: "smart" })
    const state = ViewState.applyEvent(initial, modelChunk(text))
    let next = state

    expect(next.animation_tick).toBe(initial.animation_tick)
    expect(next.spinner_index).toBe(initial.spinner_index)
    expect(next.streaming_text).toBe("")
    expect(next.streaming_buffer).toBe(text)

    next = ViewState.applyEvent(next, modelChunk(" plus"))

    expect(next.animation_tick).toBe(initial.animation_tick)
    expect(next.spinner_index).toBe(initial.spinner_index)
    expect(next.streaming_text).toBe("")
    expect(next.streaming_buffer).toBe(`${text} plus`)

    const firstTick = ViewState.tickSpinner(next)

    expect(firstTick.streaming_text.length).toBeGreaterThan(0)
    expect(firstTick.streaming_text.length).toBeLessThan(next.streaming_buffer.length)
    expect(firstTick.spinner_index).toBe(initial.spinner_index)

    const secondTick = ViewState.tickSpinner(firstTick)
    const thirdTick = ViewState.tickSpinner(secondTick)

    expect(thirdTick.spinner_index).toBe((initial.spinner_index + 1) % ViewState.spinnerFrames.length)
    next = thirdTick

    for (let index = 0; index < 80 && next.streaming_buffer.length > 0; index += 1) {
      next = ViewState.tickSpinner(next)
    }

    expect(next.streaming_text).toBe(`${text} plus`)
    expect(next.streaming_buffer).toBe("")
  })

  test("final assistant messages wait for the visible stream to catch up", () => {
    const text = "final assistant text should not jump into place before the buffer drains"
    const initial = ViewState.applyEvent(
      ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: "smart" }),
      modelChunk(text),
    )
    const partial = ViewState.tickSpinner(ViewState.tickSpinner(ViewState.tickSpinner(initial)))
    const finalArrived = ViewState.applyEvent(partial, assistantMessageAdded(text))

    expect(partial.streaming_text.length).toBeGreaterThan(0)
    expect(partial.streaming_text.length).toBeLessThan(text.length)
    expect(finalArrived.messages).toHaveLength(0)
    expect(finalArrived.streaming_text).toBe(partial.streaming_text)
    expect(finalArrived.streaming_buffer.length).toBeGreaterThan(0)

    let next = ViewState.finishTurn(finalArrived)

    expect(next.messages).toHaveLength(0)

    for (let index = 0; index < 120 && next.messages.length === 0; index += 1) {
      next = ViewState.tickSpinner(next)
    }

    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({ role: "assistant", text })
    expect(next.streaming_text).toBe("")
    expect(next.streaming_buffer).toBe("")
    expect(next.activity).toBe("idle")
  })

  test("active streaming preserves a small reservoir before final drain", () => {
    const text = "x".repeat(200)
    const active = ViewState.applyEvent(
      ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: "smart" }),
      modelChunk(text),
    )

    const activeTick = ViewState.tickSpinner(active)
    const finalArrived = ViewState.finishTurn(ViewState.applyEvent(active, assistantMessageAdded(text)))
    const finalTick = ViewState.tickSpinner(finalArrived)

    expect(activeTick.streaming_text.length).toBe(1)
    expect(finalTick.streaming_text.length).toBeGreaterThan(activeTick.streaming_text.length)
  })
})

const rendererWithKeys = (rendered: Array<ViewState.ViewState>, keys: ReadonlyArray<Keys.Key>): Adapter.Adapter => ({
  render: (state) => Effect.sync(() => rendered.push(state)),
  keys: Stream.fromIterable(keys),
  actions: Stream.empty,
  resizes: Stream.empty,
  setExit: () => Effect.void,
  openFile: () => Effect.void,
  editExternally: (text) => Effect.succeed(text),
  pasteImage: () => Effect.succeed(undefined),
})

const backendWithSubmit = (submit: () => Effect.Effect<void, Error>): Backend.SessionBackend<Error> => ({
  loadInitial: ({ workspace_path, mode }) =>
    Effect.succeed({
      thread_id: threadId,
      state: ViewState.initial({ thread_id: threadId, workspace_path, mode, events: [] }),
      last_sequence: 0,
    }),
  streamTurn: () => Stream.empty,
  submitTurn: submit,
  subscribeThreadEvents: () => Stream.empty,
  cancelTurn: () => Effect.void,
  runCommand: (context) => Effect.succeed(Backend.commandResult(context)),
  listThreads: () => Effect.succeed([]),
  loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
    Effect.succeed({
      thread_id,
      state: ViewState.initial({ thread_id, workspace_path, mode, events: [] }),
    }),
})

const backendWithThreadEvents = (
  submit: () => Effect.Effect<void, Error>,
  events: Queue.Queue<Event.Event>,
): Backend.SessionBackend<Error> => ({
  ...backendWithSubmit(submit),
  subscribeThreadEvents: () => Stream.fromQueue(events),
})

const waitForRenderedState = (
  rendered: ReadonlyArray<ViewState.ViewState>,
  predicate: (state: ViewState.ViewState) => boolean,
) =>
  Effect.gen(function* () {
    for (let index = 0; index < 100; index += 1) {
      const state = rendered.findLast(predicate)
      if (state !== undefined) return state
      yield* Effect.sleep("1 millis")
    }
    return yield* Effect.fail(new Error("expected rendered state was not observed"))
  })

const messageAdded = (content: string): Event.MessageAdded => ({
  id: Ids.EventId.make("event_tui_controller"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: 2,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("message_tui_controller"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: 2,
    }),
  },
})

const assistantMessageAdded = (content: string): Event.MessageAdded => ({
  id: Ids.EventId.make("event_tui_assistant_message"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 4,
  version: 1,
  created_at: 4,
  type: "message.added",
  data: {
    message: Message.assistant({
      id: Ids.MessageId.make("message_tui_assistant"),
      thread_id: threadId,
      turn_id: turnId,
      content: [Message.text(content)],
      created_at: 4,
    }),
  },
})

const modelChunk = (text: string): Event.ModelStreamChunk => ({
  id: Ids.EventId.make("event_tui_model_chunk"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 3,
  version: 1,
  created_at: 3,
  type: "model.stream.chunk",
  data: { text, provider: "test", model: "test-model" },
})

const turnCompleted = (sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event_tui_turn_completed_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: {},
})
