import { Effect, Layer, ManagedRuntime } from "effect"
import * as Fiber from "effect/Fiber"
import { createStore } from "solid-js/store"
import { getScenarioFixture } from "../scenarios/fixtures"
import type { Activity, Client, Mode, PendingTurn, ScenarioId, ThreadView, ImageAttachment } from "./model"
import { clonePending, stateFromFixture } from "./state"
import type { StoreState, StoreThread, StoreItem } from "./state"
import { imageItem } from "./images"

export interface CreateClientOptions {
  readonly scenario?: ScenarioId
  readonly delayMs?: number
}

type PlaybackFiber = Fiber.Fiber<void, never>

type ActiveRun = {
  readonly token: number
  readonly itemIds: readonly string[]
  fiber?: PlaybackFiber
}

const defaultDelayMs = 120
const genericReply = (prompt: string): string =>
  `I received “${prompt}”.\n\nThis is a deterministic offline reply. I would inspect the relevant files, explain the trade-offs, and show a small safe patch before making any change.`

const splitReply = (text: string): readonly string[] => {
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += 22) chunks.push(text.slice(offset, offset + 22))
  return chunks
}

export const createClient = (options: CreateClientOptions = {}): Client => {
  const initialScenario = options.scenario ?? "welcome"
  const fixture = getScenarioFixture(initialScenario)
  const initialState = stateFromFixture(fixture)
  const [state, setStoreState] = createStore<StoreState>(initialState)
  const runtime = ManagedRuntime.make(Layer.empty)
  const activeRuns = new Map<string, ActiveRun>()
  const fibers = new Set<PlaybackFiber>()
  let sequence = 0
  let runToken = 0
  let disposed = false
  let scenarioGeneration = 0
  const delayMs =
    options.delayMs === undefined || !Number.isFinite(options.delayMs) ? defaultDelayMs : Math.max(0, options.delayMs)
  const nextId = (prefix: string): string => {
    sequence += 1
    return `${prefix}-${sequence}`
  }
  const threadIndex = (threadId: string): number => state.threads.findIndex((thread) => thread.id === threadId)
  const itemIndex = (threadId: string, itemId: string): number => {
    const index = threadIndex(threadId)
    if (index < 0) return -1
    return state.threads[index]?.items.findIndex((item) => item.id === itemId) ?? -1
  }
  const setActivity = (threadId: string, activity: Activity): void => {
    const index = threadIndex(threadId)
    if (index >= 0) setStoreState("threads", index, "activity", activity)
  }
  const setPending = (threadId: string, pending: readonly PendingTurn[]): void => {
    const index = threadIndex(threadId)
    if (index >= 0) setStoreState("threads", index, "pending", pending.map(clonePending))
  }
  const updateItem = (threadId: string, itemId: string, patch: Partial<StoreItem>): void => {
    const thread = threadIndex(threadId)
    const item = itemIndex(threadId, itemId)
    if (thread >= 0 && item >= 0) setStoreState("threads", thread, "items", item, patch)
  }
  const appendItem = (threadId: string, item: StoreItem): void => {
    const index = threadIndex(threadId)
    if (index >= 0) {
      setStoreState("threads", index, "items", (items: StoreItem[]) => [...items, item])
    }
  }
  const isCurrent = (threadId: string, token: number, generation = scenarioGeneration): boolean =>
    !disposed && generation === scenarioGeneration && activeRuns.get(threadId)?.token === token
  const interruptRun = (threadId: string): ActiveRun | undefined => {
    const run = activeRuns.get(threadId)
    if (run === undefined) return undefined
    activeRuns.delete(threadId)
    if (run.fiber !== undefined) run.fiber.interruptUnsafe()
    return run
  }
  const interruptAll = (): void => {
    for (const fiber of fibers) fiber.interruptUnsafe()
    fibers.clear()
    activeRuns.clear()
  }
  const launch = (threadId: string, token: number, itemIds: readonly string[], effect: Effect.Effect<void>): void => {
    if (disposed) return
    const run: ActiveRun = { token, itemIds }
    activeRuns.set(threadId, run)
    const fiber = runtime.runFork(effect)
    run.fiber = fiber
    fibers.add(fiber)
    fiber.addObserver(() => fibers.delete(fiber))
  }
  const completeRun = (threadId: string, token: number, itemIds: readonly string[]): void => {
    if (!isCurrent(threadId, token)) return
    activeRuns.delete(threadId)
    for (const itemId of itemIds) updateItem(threadId, itemId, { status: "idle" })
    setActivity(threadId, "idle")
    drainPending(threadId)
  }
  const drainPending = (threadId: string): void => {
    if (disposed || activeRuns.has(threadId)) return
    const index = threadIndex(threadId)
    if (index < 0) return
    const thread = state.threads[index]
    if (thread === undefined || thread.activity === "waiting" || thread.pending.length === 0) return
    const next = thread.pending[0]
    if (next === undefined) return
    setPending(threadId, thread.pending.slice(1))
    startTurn(threadId, next.prompt, next.images)
  }
  const startStream = (
    threadId: string,
    itemId: string,
    chunks: readonly string[],
    initialActivity: Activity = "working",
  ): void => {
    if (disposed || threadIndex(threadId) < 0 || itemIndex(threadId, itemId) < 0) return
    const token = ++runToken
    const generation = scenarioGeneration
    setActivity(threadId, initialActivity)
    const effect = Effect.gen(function* () {
      for (const chunk of chunks) {
        yield* Effect.sleep(delayMs)
        yield* Effect.sync(() => {
          if (!isCurrent(threadId, token, generation)) return
          const thread = threadIndex(threadId)
          const item = itemIndex(threadId, itemId)
          const text = thread >= 0 && item >= 0 ? (state.threads[thread]?.items[item]?.text ?? "") : ""
          updateItem(threadId, itemId, { text: text + chunk })
        })
      }
      yield* Effect.sync(() => completeRun(threadId, token, [itemId]))
    })
    launch(threadId, token, [itemId], effect)
  }
  const startTurn = (threadId: string, prompt: string, images: readonly ImageAttachment[] = []): void => {
    if (disposed) return
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    if (thread === undefined || activeRuns.has(threadId) || thread.approval !== null) return
    const userId = nextId("user")
    const assistantId = nextId("assistant")
    if (prompt.length > 0)
      appendItem(threadId, {
        id: userId,
        kind: "user",
        title: "You",
        text: prompt,
      })
    for (const image of images) appendItem(threadId, imageItem(image, nextId("image")))
    appendItem(threadId, {
      id: assistantId,
      kind: "assistant",
      title: "Rika",
      text: "",
      status: "working",
    })
    setActivity(threadId, "working")
    startStream(threadId, assistantId, splitReply(genericReply(prompt)))
  }
  const finishApproval = (threadId: string, token: number, toolId: string): void => {
    if (!isCurrent(threadId, token)) return
    const item = itemIndex(threadId, toolId)
    const thread = threadIndex(threadId)
    const currentText = thread >= 0 && item >= 0 ? (state.threads[thread]?.items[item]?.text ?? "") : ""
    updateItem(threadId, toolId, {
      text:
        currentText + "\n\nAuthorization accepted. The scripted staging step completed without touching a workspace.",
      status: "idle",
    })
    appendItem(threadId, {
      id: nextId("approval-result"),
      kind: "assistant",
      title: "Outcome",
      text: "The approval flow advanced safely in the offline simulator.",
    })
    completeRun(threadId, token, [toolId])
  }
  const startApproval = (threadId: string, toolId: string): void => {
    const token = ++runToken
    const generation = scenarioGeneration
    setActivity(threadId, "working")
    updateItem(threadId, toolId, { status: "working" })
    const effect = Effect.gen(function* () {
      yield* Effect.sleep(delayMs)
      yield* Effect.sync(() => {
        if (isCurrent(threadId, token, generation)) finishApproval(threadId, token, toolId)
      })
    })
    launch(threadId, token, [toolId], effect)
  }
  const startChildren = (threadId: string): void => {
    const childIds = ["children-child-api", "children-child-web", "children-child-cli"]
    if (childIds.some((id) => itemIndex(threadId, id) < 0)) return
    const token = ++runToken
    const generation = scenarioGeneration
    setActivity(threadId, "working")
    const childEffects = childIds.map((childId, childIndex) =>
      Effect.gen(function* () {
        yield* Effect.sleep(delayMs * (childIndex + 1))
        yield* Effect.sync(() => {
          if (!isCurrent(threadId, token, generation)) return
          let report = "terminal commands"
          if (childIndex === 0) report = "route contracts"
          if (childIndex === 1) report = "client rendering"
          updateItem(threadId, childId, {
            text: `completed: ${report}`,
          })
        })
        yield* Effect.sleep(delayMs)
        yield* Effect.sync(() => {
          if (!isCurrent(threadId, token, generation)) return
          updateItem(threadId, childId, { status: "idle" })
        })
      }),
    )
    const effect = Effect.all(childEffects, { concurrency: "unbounded" }).pipe(
      Effect.asVoid,
      Effect.tap(
        Effect.sync(() => {
          if (!isCurrent(threadId, token, generation)) return
          updateItem(threadId, "children-reasoning-1", {
            text: "Three independent checks completed. Their output is simulated and local to this thread.",
            status: "idle",
          })
          updateItem(threadId, "children-assistant-1", {
            text: "The API, web, and CLI checks all completed in parallel. No process or workspace was used.",
            status: "idle",
          })
          completeRun(threadId, token, ["children-reasoning-1", "children-assistant-1"])
        }),
      ),
    )
    launch(threadId, token, [...childIds, "children-reasoning-1", "children-assistant-1"], effect)
  }
  const startReconnect = (threadId: string): void => {
    const assistantId = "reconnect-assistant-1"
    if (itemIndex(threadId, assistantId) < 0) return
    const token = ++runToken
    const generation = scenarioGeneration
    setActivity(threadId, "waiting")
    const effect = Effect.gen(function* () {
      yield* Effect.sleep(delayMs)
      yield* Effect.sync(() => {
        if (!isCurrent(threadId, token, generation)) return
        updateItem(threadId, assistantId, {
          text: "The scripted connection is interrupted. Retry 1/2 is in progress...",
          status: "waiting",
        })
      })
      yield* Effect.sleep(delayMs)
      yield* Effect.sync(() => {
        if (!isCurrent(threadId, token, generation)) return
        setStoreState("connection", "offline")
        updateItem(threadId, assistantId, {
          text: "Connection restored in the offline simulator. The thread is ready for another prompt.",
          status: "idle",
        })
        completeRun(threadId, token, [assistantId])
      })
    })
    launch(threadId, token, [assistantId], effect)
  }
  const startScenarioPlayback = (scenario: ScenarioId): void => {
    const threadId = state.selectedThreadId
    if (scenario === "streaming")
      return startStream(
        threadId,
        "streaming-assistant-1",
        [
          "The same assistant item receives ",
          "small incremental chunks, so ",
          "scroll position and selection stay ",
          "stable while the answer grows.",
        ],
        "working",
      )
    if (scenario === "children") return startChildren(threadId)
    if (scenario === "queue")
      return startStream(
        threadId,
        "queue-assistant-1",
        [
          "\n\nThe first review is complete. ",
          "I will now work through the queued ",
          "instructions in their current order.",
        ],
        "working",
      )
    if (scenario === "reconnect") return startReconnect(threadId)
  }

  const cancelSelected = (): void => {
    const threadId = state.selectedThreadId
    const run = interruptRun(threadId)
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    if (run !== undefined) {
      for (const itemId of run.itemIds) updateItem(threadId, itemId, { status: "cancelled" })
      setActivity(threadId, "cancelled")
      if (state.connection === "reconnecting") setStoreState("connection", "offline")
      return
    }
    if (thread?.approval !== null && thread !== undefined) {
      const waitingTool = thread.items.find((item) => item.status === "waiting")
      if (waitingTool !== undefined) updateItem(threadId, waitingTool.id, { status: "cancelled" })
      setStoreState("threads", index, "approval", null)
      setActivity(threadId, "cancelled")
    }
  }

  const loadScenario = (scenario: ScenarioId): void => {
    if (disposed) return
    const nextFixture = getScenarioFixture(scenario)
    if (nextFixture === undefined) return
    interruptAll()
    scenarioGeneration += 1
    const nextState = stateFromFixture(nextFixture)
    setStoreState(nextState)
    startScenarioPlayback(scenario)
  }

  const selectThread = (threadId: string): void => {
    if (disposed || threadIndex(threadId) < 0) return
    setStoreState("selectedThreadId", threadId)
  }

  const newThread = (target: ThreadView["target"] = "runner"): void => {
    if (disposed) return
    const threadId = nextId(`thread-${target}`)
    const thread: StoreThread = {
      id: threadId,
      title: `New ${target === "runner" ? "Runner" : "Orb"} thread`,
      target,
      activity: "idle",
      items: [],
      pending: [],
      approval: null,
    }
    setStoreState("threads", (threads: StoreThread[]) => [...threads, thread])
    setStoreState("selectedThreadId", threadId)
  }

  const submit = (prompt: string, images: readonly ImageAttachment[] = []): void => {
    if (disposed) return
    const text = prompt.trim()
    if (text.length === 0 && images.length === 0) return
    const threadId = state.selectedThreadId
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    if (thread === undefined) return
    if (
      activeRuns.has(threadId) ||
      thread.activity === "working" ||
      thread.activity === "waiting" ||
      thread.approval !== null
    ) {
      setPending(threadId, [...thread.pending, { id: nextId("pending"), prompt: text, images }])
      return
    }
    startTurn(threadId, text, images)
  }

  const approve = (approved: boolean): void => {
    if (disposed) return
    const threadId = state.selectedThreadId
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    if (thread === undefined || thread.approval === null) return
    const waitingTool = thread.items.find((item) => item.status === "waiting")
    setStoreState("threads", index, "approval", null)
    if (waitingTool === undefined) {
      setActivity(threadId, "idle")
      drainPending(threadId)
      return
    }
    if (!approved) {
      updateItem(threadId, waitingTool.id, {
        text: `${waitingTool.text}\n\nAuthorization denied. The scripted command was not run.`,
        status: "cancelled",
      })
      setActivity(threadId, "idle")
      drainPending(threadId)
      return
    }
    startApproval(threadId, waitingTool.id)
  }

  const editPending = (id: string, prompt: string): void => {
    if (disposed) return
    const threadId = state.selectedThreadId
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    const pending = thread?.pending.find((turn) => turn.id === id)
    if (thread === undefined || pending === undefined) return
    const text = prompt.trim()
    if (text.length === 0 && (pending.images?.length ?? 0) === 0) return
    setPending(
      threadId,
      thread.pending.map((turn) => (turn.id === id ? { ...turn, prompt: text } : turn)),
    )
  }

  const removePending = (id: string): void => {
    if (disposed) return
    const threadId = state.selectedThreadId
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    if (thread === undefined) return
    setPending(
      threadId,
      thread.pending.filter((turn) => turn.id !== id),
    )
  }

  const steerPending = (id: string): void => {
    if (disposed) return
    const threadId = state.selectedThreadId
    const index = threadIndex(threadId)
    const thread = index >= 0 ? state.threads[index] : undefined
    const pending = thread?.pending.find((turn) => turn.id === id)
    if (thread === undefined || pending === undefined) return
    const wasBusy =
      activeRuns.has(threadId) ||
      thread.activity === "working" ||
      thread.activity === "waiting" ||
      thread.approval !== null
    setPending(
      threadId,
      thread.pending.filter((turn) => turn.id !== id),
    )
    appendItem(threadId, {
      id: nextId("steering"),
      kind: "notice",
      title: "Steering instruction",
      text: pending.prompt,
    })
    if (wasBusy) for (const image of pending.images ?? []) appendItem(threadId, imageItem(image, nextId("image")))
    if (!wasBusy && thread.approval === null) startTurn(threadId, pending.prompt, pending.images)
  }

  const interruptAndSend = (prompt: string, images: readonly ImageAttachment[] = []): void => {
    if (disposed) return
    const text = prompt.trim()
    if (text.length === 0 && images.length === 0) return
    cancelSelected()
    submit(text, images)
  }

  const setMode = (mode: Mode): void => {
    if (!disposed) setStoreState("mode", mode)
  }

  const dispose = Effect.runSync(
    Effect.cached(
      Effect.suspend(() => {
        disposed = true
        scenarioGeneration += 1
        const snapshot = [...fibers]
        interruptAll()
        return Fiber.interruptAll(snapshot).pipe(Effect.andThen(runtime.disposeEffect))
      }),
    ),
  )

  const client: Client = {
    state,
    loadScenario,
    selectThread,
    newThread,
    archiveThread: () => {
      if (disposed) return
      cancelSelected()
      const id = state.selectedThreadId
      setStoreState("threads", (threads: StoreThread[]) => threads.filter((thread) => thread.id !== id))
      const next = state.threads[0]
      if (next !== undefined) setStoreState("selectedThreadId", next.id)
    },
    submit,
    cancel: cancelSelected,
    approve,
    editPending,
    removePending,
    steerPending,
    interruptAndSend,
    setMode,
    dispose,
  }

  startScenarioPlayback(initialScenario)
  return client
}
