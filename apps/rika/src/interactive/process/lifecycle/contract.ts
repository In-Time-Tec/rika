import { Duration, Effect, Fiber, Function } from "effect"

export const interruptTrackedFibers = (fibers: Iterable<Fiber.Fiber<void, never>>) =>
  Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded", discard: true })

export const tuiSignalExitCode = (signal: "SIGINT" | "SIGTERM" | "SIGHUP"): number => {
  if (signal === "SIGINT") return 130
  if (signal === "SIGTERM") return 143
  return 129
}

export const quitStopWorkBound = Duration.seconds(3)

const interruptAndClearTrackedFiberImpl = (
  fiber: Fiber.Fiber<void, never>,
  clear: (fiber: Fiber.Fiber<void, never>) => void,
) => Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(() => clear(fiber))))

export const interruptAndClearTrackedFiber: {
  (
    clear: (fiber: Fiber.Fiber<void, never>) => void,
  ): (fiber: Fiber.Fiber<void, never>) => ReturnType<typeof interruptAndClearTrackedFiberImpl>
  (
    fiber: Fiber.Fiber<void, never>,
    clear: (fiber: Fiber.Fiber<void, never>) => void,
  ): ReturnType<typeof interruptAndClearTrackedFiberImpl>
} = Function.dual(2, interruptAndClearTrackedFiberImpl)

const refreshThreadsOnSwitcherOpenImpl = <E, R>(
  wasOpen: boolean,
  isOpen: boolean,
  initialize: Effect.Effect<void, E, R>,
) => (!wasOpen && isOpen ? initialize : Effect.void)

export const refreshThreadsOnSwitcherOpen: {
  <E, R>(isOpen: boolean, initialize: Effect.Effect<void, E, R>): (wasOpen: boolean) => Effect.Effect<void, E, R>
  <E, R>(wasOpen: boolean, isOpen: boolean, initialize: Effect.Effect<void, E, R>): Effect.Effect<void, E, R>
} = Function.dual(3, refreshThreadsOnSwitcherOpenImpl)

const settleTuiInitializationImpl = <T, E, E2>(
  task: Effect.Effect<T, E, never>,
  isClosed: () => boolean,
  destroy: (value: T) => Effect.Effect<void, E2, never>,
) =>
  task.pipe(
    Effect.flatMap((value) => (!isClosed() ? Effect.succeed(value) : destroy(value).pipe(Effect.as(undefined)))),
  )

export const settleTuiInitialization: {
  <T, E2>(
    isClosed: () => boolean,
    destroy: (value: T) => Effect.Effect<void, E2, never>,
  ): <E>(task: Effect.Effect<T, E, never>) => Effect.Effect<T | undefined, E | E2>
  <T, E, E2>(
    task: Effect.Effect<T, E, never>,
    isClosed: () => boolean,
    destroy: (value: T) => Effect.Effect<void, E2, never>,
  ): Effect.Effect<T | undefined, E | E2>
} = Function.dual(3, settleTuiInitializationImpl)
