import { Effect, Queue, Stream } from "effect"
import process, { stdin } from "node:process"
import {
  clientSigintOwnership,
  type ProcessListenerTarget,
  type SigintOwnership,
} from "../../../client/signal-ownership"

export { forceQuitWindow, interruptDecision, type InterruptDecision } from "./interrupt"
export { writeGoodbye } from "./goodbye"

type LifecycleSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGTSTP" | "SIGCONT"

type LifecycleEvent = { readonly _tag: "Signal"; readonly signal: LifecycleSignal } | { readonly _tag: "Hangup" }

const watchedSignals: ReadonlyArray<LifecycleSignal> = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGCONT"]
const processEmitter: NodeJS.EventEmitter = process

export const lifecycleEvents = (input: {
  readonly signals: ReadonlyArray<LifecycleSignal>
  readonly stdin: ProcessListenerTarget<"end" | "error" | "close">
  readonly process: ProcessListenerTarget<LifecycleSignal>
  readonly ownership?: SigintOwnership
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
        const releaseOwnership = input.signals.includes("SIGINT") ? input.ownership?.acquireTui() : undefined
        return { signalHandlers, hangup, releaseOwnership }
      }),
      (registered) =>
        Effect.sync(() => {
          for (const { signal, handler } of registered.signalHandlers) input.process.off(signal, handler)
          for (const event of ["end", "error", "close"] as const) input.stdin.off(event, registered.hangup)
          registered.releaseOwnership?.()
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
    lifecycleEvents({ signals: watchedSignals, stdin, process: processEmitter, ownership: clientSigintOwnership }).pipe(
      Stream.runForEach(dispatch),
      Effect.onExit(() => Effect.logInfo("tui.signals.released")),
    ),
  )
}
