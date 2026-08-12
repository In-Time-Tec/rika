import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Effect, Ref } from "effect"
import type { QueueItem } from "./interactive-runtime-event"
import { operationError } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

export const queueItem = (turn: Turn.AgentExecutionTurn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  return attachments === undefined || attachments.length === 0
    ? { id: turn.id, prompt: turn.prompt, createdAt: turn.createdAt }
    : { id: turn.id, prompt: turn.prompt, createdAt: turn.createdAt, attachments }
}

export type InteractiveQueueInput = Pick<
  InteractiveRuntimeContext,
  "dependencyContext" | "executionDependencies" | "interactiveThread"
>

export const makeInteractiveQueue = (input: InteractiveQueueInput) => {
  const readQueue = Effect.fn("ProductOperation.interactive.readQueue")(function* (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = Context.get(input.dependencyContext, TurnRepository.Service)
    const queue = yield* turns.readQueue(threadId)
    dispatch({
      _tag: "QueueUpdated",
      selectionEpoch: 0,
      threadId,
      revision: queue.revision,
      queuedCount: queue.queuedCount,
      change: { _tag: "Reset", items: queue.turns.map(queueItem) },
    })
  })
  const activeInThread = Effect.fn("ProductOperation.interactive.activeInThread")(function* (
    threadId: Thread.ThreadId,
  ) {
    const turns = Context.get(input.dependencyContext, TurnRepository.Service)
    const turn = yield* turns.findActive(threadId)
    if (turn === undefined) return yield* operationError("No active turn")
    return turn
  })
  const active = Effect.gen(function* () {
    const thread = yield* Ref.get(input.interactiveThread)
    if (thread === undefined) return yield* operationError("No thread selected")
    return yield* activeInThread(thread.id)
  }).pipe(Effect.withSpan("ProductOperation.interactive.active"))
  const threadForTurn = Effect.fn("ProductOperation.interactive.threadForTurn")(function* (
    turn: import("@rika/product/turn-record").Turn,
  ) {
    const thread = yield* Context.get(input.dependencyContext, ThreadRepository.Service).get(turn.threadId)
    if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
    return thread
  })
  return { readQueue, activeInThread, active, threadForTurn }
}
