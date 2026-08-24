import { createTestRenderer } from "@opentui/core/testing"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { it } from "@effect/vitest"
import type * as InteractiveSession from "@rika/product/interactive-session"
import { OperationUnavailable } from "@rika/product/product-operation"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import { ProfileStore } from "../src/hosted/hosted-contract"
import * as HostedCli from "../src/hosted/hosted-cli"
import {
  hostedInteractiveControllerInternals,
  makeDeferredSession,
  runHostedInteractive,
} from "../src/hosted/hosted-interactive-controller"
import * as Runner from "../src/runner/runner"

const { raceStructured, startRunnerWhenPlaced } = hostedInteractiveControllerInternals

const placement = (target: "orb" | "runner") => ({
  connectivity: "connected" as const,
  target,
  participants: 1,
})

it.effect("prepares no Runner for Orb placement, then starts one Runner once despite repeated states", () =>
  Effect.gen(function* () {
    const runnerPlacement = yield* Deferred.make<void>()
    const runnerStarted = yield* Deferred.make<void>()
    let prepareCount = 0
    let startCount = 0
    const stateChanges = Stream.concat(
      Stream.make(placement("orb"), placement("orb")),
      Stream.fromEffect(Deferred.await(runnerPlacement)).pipe(
        Stream.flatMap(() => Stream.make(placement("runner"), placement("runner"))),
      ),
    )
    const fiber = yield* startRunnerWhenPlaced(
      { initialState: placement("orb"), stateChanges },
      Effect.sync(() => ++prepareCount),
      () =>
        Effect.sync(() => ++startCount).pipe(
          Effect.andThen(Deferred.succeed(runnerStarted, undefined)),
          Effect.andThen(Effect.never),
        ),
    ).pipe(Effect.forkChild)

    expect(prepareCount).toBe(0)
    expect(startCount).toBe(0)
    yield* Deferred.succeed(runnerPlacement, undefined)
    yield* Deferred.await(runnerStarted)
    expect(prepareCount).toBe(1)
    expect(startCount).toBe(1)
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("terminates the structured run when Runner startup fails", () =>
  Effect.gen(function* () {
    const failure = new Error("runner startup failed")
    const exit = yield* startRunnerWhenPlaced(
      { initialState: placement("runner"), stateChanges: Stream.make(placement("runner")) },
      Effect.succeed("prepared"),
      () => Effect.fail(failure),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("runner startup failed")
  }),
)

it.effect("does not let a completed placement stream close an active TUI", () =>
  Effect.gen(function* () {
    const tuiStarted = yield* Deferred.make<void>()
    const tuiFinalized = yield* Deferred.make<void>()
    const run = raceStructured(
      Effect.acquireUseRelease(
        Deferred.succeed(tuiStarted, undefined),
        () => Effect.never,
        () => Deferred.succeed(tuiFinalized, undefined),
      ),
      startRunnerWhenPlaced(
        { initialState: placement("orb"), stateChanges: Stream.empty },
        Effect.die("prepare must not run"),
        () => Effect.die("runner must not start"),
      ),
    )
    const fiber = yield* run.pipe(Effect.forkChild)
    yield* Deferred.await(tuiStarted)
    expect(yield* Deferred.poll(tuiFinalized)).toEqual(Option.none())
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(tuiFinalized)
  }),
)

it.effect("Runner then Orb during blocked preparation starts the first Runner placement exactly once", () =>
  Effect.gen(function* () {
    const preparationStarted = yield* Deferred.make<void>()
    const releasePreparation = yield* Deferred.make<void>()
    const runnerStarted = yield* Deferred.make<void>()
    let prepareCount = 0
    let startCount = 0
    const fiber = yield* startRunnerWhenPlaced(
      { initialState: placement("runner"), stateChanges: Stream.make(placement("orb"), placement("runner")) },
      Effect.sync(() => ++prepareCount).pipe(
        Effect.andThen(Deferred.succeed(preparationStarted, undefined)),
        Effect.andThen(Deferred.await(releasePreparation)),
      ),
      () =>
        Effect.sync(() => ++startCount).pipe(
          Effect.andThen(Deferred.succeed(runnerStarted, undefined)),
          Effect.andThen(Effect.never),
        ),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(preparationStarted)
    expect(prepareCount).toBe(1)
    expect(startCount).toBe(0)
    yield* Deferred.succeed(releasePreparation, undefined)
    yield* Deferred.await(runnerStarted)
    expect(prepareCount).toBe(1)
    expect(startCount).toBe(1)
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("interrupts Runner and observes its finalizer when the TUI side completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const tuiComplete = yield* Deferred.make<void>()
    const runner = startRunnerWhenPlaced(
      { initialState: placement("runner"), stateChanges: Stream.make(placement("runner")) },
      Effect.succeed("prepared"),
      () =>
        Effect.acquireUseRelease(
          Deferred.succeed(started, undefined),
          () => Effect.never,
          () => Deferred.succeed(finalized, undefined),
        ),
    )
    const run = raceStructured(Deferred.await(tuiComplete), runner)
    const fiber = yield* run.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Deferred.succeed(tuiComplete, undefined)
    yield* Fiber.join(fiber)
    yield* Deferred.await(finalized)
  }),
)

it.effect("propagates TUI failure and interrupts the initializer", () =>
  Effect.gen(function* () {
    const initializerStarted = yield* Deferred.make<void>()
    const initializerFinalized = yield* Deferred.make<void>()
    const failure = new Error("TUI failed")
    const exit = yield* raceStructured(
      Deferred.await(initializerStarted).pipe(Effect.andThen(Effect.fail(failure))),
      Effect.acquireUseRelease(
        Deferred.succeed(initializerStarted, undefined),
        () => Effect.never,
        () => Deferred.succeed(initializerFinalized, undefined),
      ),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("TUI failed")
    yield* Deferred.await(initializerFinalized)
  }),
)

it.effect("Runner failure interrupts and finalizes the TUI", () =>
  Effect.gen(function* () {
    const tuiStarted = yield* Deferred.make<void>()
    const tuiFinalized = yield* Deferred.make<void>()
    const failure = new Error("Runner failed")
    const exit = yield* raceStructured(
      Effect.acquireUseRelease(
        Deferred.succeed(tuiStarted, undefined),
        () => Effect.never,
        () => Deferred.succeed(tuiFinalized, undefined),
      ),
      Deferred.await(tuiStarted).pipe(Effect.andThen(Effect.fail(failure))),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    yield* Deferred.await(tuiFinalized)
  }),
)

it.effect("parent interruption observes both active finalizers", () =>
  Effect.gen(function* () {
    const leftStarted = yield* Deferred.make<void>()
    const rightStarted = yield* Deferred.make<void>()
    const leftFinalized = yield* Deferred.make<void>()
    const rightFinalized = yield* Deferred.make<void>()
    const active = (started: Deferred.Deferred<void>, finalized: Deferred.Deferred<void>) =>
      Effect.acquireUseRelease(
        Deferred.succeed(started, undefined),
        () => Effect.never,
        () => Deferred.succeed(finalized, undefined),
      )
    const fiber = yield* raceStructured(active(leftStarted, leftFinalized), active(rightStarted, rightFinalized)).pipe(
      Effect.forkChild,
    )
    yield* Deferred.await(leftStarted)
    yield* Deferred.await(rightStarted)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(leftFinalized)
    yield* Deferred.await(rightFinalized)
  }),
)

it.effect("deferred commands fail while unavailable and synchronous projections delegate after attachment", () =>
  Effect.gen(function* () {
    const ready = Deferred.makeUnsafe<InteractiveSession.InteractiveSession, OperationUnavailable>()
    const deferred = makeDeferredSession(ready)
    const unavailable = yield* Effect.flip(deferred.session.submit("early"))
    expect(unavailable).toBeInstanceOf(OperationUnavailable)
    expect(deferred.session.currentView()).toBeUndefined()
    const view = { thread: { id: "thread-attached" } }
    const checkpoint = { sequence: 7 }
    const real = {
      currentView: () => view,
      projectionCheckpoint: () => checkpoint,
      submit: () => Effect.void,
    } as unknown as InteractiveSession.InteractiveSession
    deferred.attach(real)
    yield* Deferred.succeed(ready, real)
    expect(deferred.session.currentView()).toBe(view)
    expect(deferred.session.projectionCheckpoint("turn-1")).toBe(checkpoint)
    yield* deferred.session.submit("attached")
  }),
)

it.effect("direct Effect members delegate after attachment", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<InteractiveSession.InteractiveSession, OperationUnavailable>()
    const deferred = makeDeferredSession(ready)
    const called: Array<string> = []
    const real = {
      quit: Effect.sync(() => called.push("quit")),
      cancel: Effect.sync(() => called.push("cancel")),
      newThread: Effect.sync(() => called.push("newThread")),
    } as unknown as InteractiveSession.InteractiveSession
    deferred.attach(real)
    yield* Deferred.succeed(ready, real)
    yield* deferred.session.quit
    yield* deferred.session.cancel
    yield* deferred.session.newThread
    expect(called).toEqual(["quit", "cancel", "newThread"])
  }),
)

it.effect("events waits before attachment, delegates after attachment, and fails when readiness fails", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<InteractiveSession.InteractiveSession, OperationUnavailable>()
    const deferred = makeDeferredSession(ready)
    const delegated = yield* Deferred.make<void>()
    const waiting = yield* deferred.session.events(() => undefined).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(yield* Deferred.poll(delegated)).toEqual(Option.none())
    const real = {
      events: () => Deferred.succeed(delegated, undefined),
    } as unknown as InteractiveSession.InteractiveSession
    deferred.attach(real)
    yield* Deferred.succeed(ready, real)
    yield* Fiber.join(waiting)
    yield* Deferred.await(delegated)

    const failedReady = yield* Deferred.make<InteractiveSession.InteractiveSession, OperationUnavailable>()
    const failed = makeDeferredSession(failedReady)
    const unavailable = OperationUnavailable.make({ operation: "Interactive", message: "initialization failed" })
    const eventFiber = yield* failed.session.events(() => undefined).pipe(Effect.forkChild)
    yield* Deferred.fail(failedReady, unavailable)
    const exit = yield* Fiber.await(eventFiber)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("initialization failed")
  }),
)

const platformLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)
const hostedLayer = HostedCli.liveLayer(process.cwd()).pipe(Layer.provide(platformLayer))
const startupLayer = Layer.mergeAll(
  platformLayer,
  BunSocket.layerWebSocketConstructor,
  hostedLayer,
  Runner.liveAdmissionLayer.pipe(Layer.provide(hostedLayer)),
)

it.layer(startupLayer)((test) => {
  test.effect("does not load the hosted profile until the first complete local frame", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const profileGate = Deferred.makeUnsafe<void>()
      const profileLoadStarted = Deferred.makeUnsafe<void>()
      let rendererRequested = false
      const profileStore = ProfileStore.of({
        load: Deferred.succeed(profileLoadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(profileGate)),
          Effect.as(Option.none()),
        ),
        save: () => Effect.void,
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        {
          makeRenderer: () => {
            rendererRequested = true
            return Effect.succeed(setup.renderer)
          },
          writeTerminalTitle: () => undefined,
          startRunner: () => Effect.never,
        },
      ).pipe(Effect.provideService(ProfileStore, profileStore))
      const fiber = yield* operation.pipe(Effect.forkChild)

      expect((yield* Deferred.poll(profileLoadStarted))._tag).toBe("None")
      yield* Effect.tryPromise(() => setup.renderOnce())
      yield* Deferred.await(profileLoadStarted)
      expect(rendererRequested).toBe(true)
      expect(setup.captureCharFrame()).toContain("Welcome to Rika")
      yield* Fiber.interrupt(fiber)
      setup.renderer.destroy()
    }),
  )

  test.effect("fails the hosted run truthfully when profile selection fails", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const profileStore = ProfileStore.of({
        load: Effect.succeed(Option.none()),
        save: () => Effect.void,
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        {
          makeRenderer: () => Effect.succeed(setup.renderer),
          writeTerminalTitle: () => undefined,
          startRunner: () => Effect.never,
        },
      ).pipe(Effect.provideService(ProfileStore, profileStore))
      const fiber = yield* operation.pipe(Effect.forkChild)

      yield* Effect.tryPromise(() => setup.renderOnce())
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      expect(setup.captureCharFrame()).not.toContain("Reconnecting")
      yield* Fiber.interrupt(fiber)
      setup.renderer.destroy()
    }),
  )
})
