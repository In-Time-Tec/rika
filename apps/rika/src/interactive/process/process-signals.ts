import { Effect, Queue, Stream } from "effect"

export { forceQuitWindow, interruptDecision, type InterruptDecision } from "./process-interrupt"
export { writeGoodbye } from "./process-goodbye"

export type LifecycleSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGTSTP" | "SIGCONT"

export type LifecycleEvent = { readonly _tag: "Signal"; readonly signal: LifecycleSignal } | { readonly _tag: "Hangup" }

const watchedSignals: ReadonlyArray<LifecycleSignal> = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGCONT"]

export const lifecycleEvents = (input: {
  readonly signals: ReadonlyArray<LifecycleSignal>
  readonly stdin: NodeJS.ReadStream
  readonly process: NodeJS.EventEmitter
}): Stream.Stream<LifecycleEvent> =>
  Stream.callback<LifecycleEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const signalHandlers = input.signals.map((signal) => {
          const handler = () => {
            Queue.offerUnsafe(queue, { _tag: "Signal", signal })
          }
          input.process.on(signal, handler)
          return { signal, handler }
        })
        const hangup = () => {
          Queue.offerUnsafe(queue, { _tag: "Hangup" })
        }
        for (const event of ["end", "error", "close"] as const) input.stdin.on(event, hangup)
        return { signalHandlers, hangup }
      }),
      (registered) =>
        Effect.sync(() => {
          for (const { signal, handler } of registered.signalHandlers) input.process.off(signal, handler)
          for (const event of ["end", "error", "close"] as const) input.stdin.off(event, registered.hangup)
        }),
    ),
  )

export const watchLifecycleSignals = (handlers: {
  readonly interrupt: Effect.Effect<void>
  readonly terminate: () => void
  readonly hangup: () => void
  readonly suspend: () => void
  readonly continueFromSuspend: () => void
}): Effect.Effect<void> => {
  const dispatch = (event: LifecycleEvent) => {
    if (event._tag === "Hangup") return Effect.sync(handlers.hangup)
    if (event.signal === "SIGINT") return handlers.interrupt
    if (event.signal === "SIGTERM") return Effect.sync(handlers.terminate)
    if (event.signal === "SIGHUP") return Effect.sync(handlers.hangup)
    if (event.signal === "SIGTSTP") return Effect.sync(handlers.suspend)
    return Effect.sync(handlers.continueFromSuspend)
  }
  return Effect.scoped(
    lifecycleEvents({ signals: watchedSignals, stdin: process.stdin, process }).pipe(
      Stream.runForEach(dispatch),
      Effect.onExit(() => Effect.logInfo("tui.signals.released")),
    ),
  )
}
