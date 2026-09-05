import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import { Deferred, Effect, Queue } from "effect"
import { HostedError } from "../contract"
import type { PhysicalConnection } from "./connection"
import { HistoryView } from "./history-view"

const failure = () =>
  HostedError.make({ kind: "protocol", message: "Earlier history could not be loaded; reopen the Thread to retry" })

/** History is presentation data: it never advances durable event acknowledgements. */
export const threadHistoryState = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<{ readonly generation: number; readonly changed: Deferred.Deferred<void> }>()
  let cached: ThreadView.ThreadViewSnapshot | undefined
  let generation = 0
  let changed = Deferred.makeUnsafe<void>()
  let dispatch: (event: InteractiveEvent) => void = () => undefined
  const schedule = () => {
    Deferred.doneUnsafe(changed, Effect.void)
    changed = Deferred.makeUnsafe<void>()
    generation++
    Queue.offerUnsafe(requests, { generation, changed })
  }
  const status = (value: "loading" | "failed" | "idle") => {
    if (cached !== undefined) dispatch({ _tag: "ThreadHistoryStatus", threadId: cached.thread.id, status: value })
  }
  const publish = () => {
    if (cached !== undefined) dispatch({ _tag: "ThreadViewSnapshot", snapshot: cached })
  }
  const snapshot = (event: Extract<InteractiveEvent, { readonly _tag: "ThreadViewSnapshot" }>) => {
    cached = HistoryView.retain(cached, event.snapshot)
    publish()
    status(cached.hasOlder ? "loading" : "idle")
    schedule()
  }
  const applyPatch = (event: Extract<InteractiveEvent, { readonly _tag: "ThreadViewPatch" }>) => {
    if (cached === undefined || event.patch.threadId !== cached.thread.id) return false
    const patch =
      event.patch.header === undefined
        ? event.patch
        : {
            ...event.patch,
            header: {
              ...event.patch.header,
              hasOlder: cached.hasOlder,
              source: HistoryView.withOldest(event.patch.header.source, cached.source.oldestCursor),
            },
          }
    const view = ThreadView.fromSnapshot(cached)
    if (view._tag === "Failure" || view.success.apply(patch)._tag === "Failure") return false
    cached = view.success.snapshot()
    dispatch({ ...event, patch })
    schedule()
    return true
  }
  const load = (request: number, connection: Effect.Effect<PhysicalConnection, HostedError>) =>
    Effect.gen(function* () {
      while (cached?.hasOlder === true) {
        if (request !== generation) return
        const starting = cached
        const before = starting.source.oldestCursor
        if (before === undefined) return yield* failure()
        const physical = yield* connection
        const result = yield* physical
          .history(String(starting.thread.id), before)
          .pipe(Effect.timeoutOption("30 seconds"))
        if (request !== generation) return
        if (result._tag === "None" || !HistoryView.validPage(result.value, starting, before)) return yield* failure()
        cached = HistoryView.merge(result.value, starting)
        publish()
        status(cached.hasOlder ? "loading" : "idle")
      }
    })
  return {
    resume: () => {
      if (cached?.hasOlder === true) {
        status("loading")
        schedule()
      }
    },
    attach: (next: typeof dispatch) => {
      dispatch = next
    },
    dispatch: (event: InteractiveEvent) => {
      if (event._tag === "ThreadViewSnapshot") return snapshot(event)
      if (event._tag === "ThreadViewPatch" && applyPatch(event)) return
      dispatch(event)
    },
    run: (connection: Effect.Effect<PhysicalConnection, HostedError>) =>
      Effect.gen(function* () {
        while (true) {
          const request = yield* Queue.take(requests)
          if (request.generation !== generation) continue
          yield* load(request.generation, connection).pipe(
            Effect.raceFirst(Deferred.await(request.changed)),
            Effect.catch(() =>
              Effect.sync(() => {
                if (request.generation === generation) status("failed")
              }),
            ),
          )
        }
      }),
  }
})
