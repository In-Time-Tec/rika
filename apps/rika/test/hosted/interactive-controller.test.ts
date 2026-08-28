import { createTestRenderer } from "@opentui/core/testing"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { it } from "@effect/vitest"
import type * as InteractiveSession from "@rika/product/interactive-session"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ThreadView from "@rika/product/thread-view"
import { OperationUnavailable } from "@rika/product/product-operation"
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import { CredentialStore, ProfileStore, type PrivateJwk, type Profile } from "../../src/hosted/contract"
import * as HostedCli from "../../src/hosted/cli"
import {
  hostedInteractiveControllerInternals,
  makeDeferredSession,
  runHostedInteractive,
} from "../../src/hosted/interactive-controller"
import * as Runner from "../../src/runner/service"

const { raceStructured, runnerConnectionState, startRunnerWhenPlaced } = hostedInteractiveControllerInternals
const neverRunner = (): Effect.Effect<never> => Effect.never

const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
}

const placement = (target: "orb" | "runner") => ({
  connectivity: "connected" as const,
  target,
  participants: 1,
})

it("keeps local submission disconnected until the concrete Runner reports ready", () => {
  expect(runnerConnectionState(placement("runner"), false)).toEqual({
    connectivity: "connecting",
    target: "runner",
    participants: 1,
  })
  expect(runnerConnectionState(placement("runner"), true)).toEqual(placement("runner"))
  expect(runnerConnectionState(placement("orb"), false)).toEqual(placement("orb"))
  expect(runnerConnectionState({ ...placement("runner"), connectivity: "disconnected" }, false)).toEqual({
    ...placement("runner"),
    connectivity: "disconnected",
  })
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

it.effect("deferred commands wait while unavailable and synchronous projections delegate after attachment", () =>
  Effect.gen(function* () {
    const ready = Deferred.makeUnsafe<InteractiveSession.InteractiveSession, OperationUnavailable>()
    const deferred = makeDeferredSession(ready)
    const submitted = yield* Deferred.make<void>()
    const early = yield* deferred.session.submit("early").pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(yield* Deferred.poll(submitted)).toEqual(Option.none())
    expect(deferred.session.currentView()).toBeUndefined()
    const view = yield* Schema.decodeEffect(ThreadView.ThreadViewSnapshot)({
      thread: {
        id: "thread-attached",
        workspace: "/workspace",
        title: "Attached",
        labels: [],
        pinned: false,
        archived: false,
        lineage: { _tag: "Original" },
        createdAt: 1,
        updatedAt: 1,
      },
      revision: 0,
      source: { projectionVersion: ExecutionProjection.projectionVersion },
      turns: [],
      pending: [],
      hasOlder: false,
      hasNewer: false,
      usage: { state: ExecutionProjection.emptyUsageState() },
    })
    const checkpoint = yield* Schema.decodeEffect(ExecutionProjection.Checkpoint)({
      version: 6,
      cursor: "7",
      state: "{}",
    })
    const real: InteractiveSession.InteractiveSession = {
      ...deferred.session,
      currentView: () => view,
      projectionCheckpoint: () => checkpoint,
      submit: () => Deferred.succeed(submitted, undefined),
    }
    deferred.attach(real)
    yield* Deferred.succeed(ready, real)
    yield* Fiber.join(early)
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
    const real: InteractiveSession.InteractiveSession = {
      ...deferred.session,
      quit: Effect.sync(() => called.push("quit")),
      cancel: () => Effect.sync(() => called.push("cancel")),
      newThread: Effect.sync(() => called.push("newThread")),
    }
    deferred.attach(real)
    yield* Deferred.succeed(ready, real)
    yield* deferred.session.quit
    yield* deferred.session.cancel()
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
    const real: InteractiveSession.InteractiveSession = {
      ...deferred.session,
      events: () => Deferred.succeed(delegated, undefined),
    }
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
  test.effect("draws before loading the local profile or credential and authenticates once", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const rendererRequested = Deferred.makeUnsafe<void>()
      const profileRequested = Deferred.makeUnsafe<void>()
      const credentialRequested = Deferred.makeUnsafe<void>()
      let profileLoads = 0
      let credentialLoads = 0
      const profileStore = ProfileStore.of({
        load: Effect.sync(() => {
          profileLoads += 1
          Deferred.doneUnsafe(profileRequested, Effect.void)
          return Option.some(profile)
        }),
        save: () => Effect.void,
      })
      const credentialStore = CredentialStore.of({
        load: () =>
          Effect.sync(() => {
            credentialLoads += 1
            Deferred.doneUnsafe(credentialRequested, Effect.void)
            return Option.some({ refreshToken: Redacted.make("refresh"), privateJwk: key })
          }),
        save: () => Effect.void,
        remove: () => Effect.succeed(true),
        serialized: (effect) => effect,
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        {
          makeRenderer: () => {
            Deferred.doneUnsafe(rendererRequested, Effect.void)
            return Effect.succeed(setup.renderer)
          },
          writeTerminalTitle: () => undefined,
          startRunner: neverRunner,
        },
      ).pipe(Effect.provideService(ProfileStore, profileStore), Effect.provideService(CredentialStore, credentialStore))
      const fiber = yield* operation.pipe(Effect.forkChild)

      yield* Deferred.await(rendererRequested)
      expect(profileLoads).toBe(0)
      expect(credentialLoads).toBe(0)
      yield* Effect.tryPromise(() => setup.renderOnce())
      yield* Deferred.await(profileRequested)
      yield* Deferred.await(credentialRequested)
      expect(profileLoads).toBe(1)
      expect(credentialLoads).toBe(1)
      expect(setup.captureCharFrame()).toContain("Welcome to Rika")
      yield* Fiber.interrupt(fiber)
      setup.renderer.destroy()
    }),
  )

  test.effect("draws before reporting that the local profile is missing", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const rendererRequested = Deferred.makeUnsafe<void>()
      let firstFrame = ""
      let profileLoads = 0
      const profileStore = ProfileStore.of({
        load: Effect.sync(() => {
          profileLoads += 1
          return Option.none()
        }),
        save: () => Effect.void,
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        {
          makeRenderer: () => {
            Deferred.doneUnsafe(rendererRequested, Effect.void)
            return Effect.succeed(setup.renderer)
          },
          writeTerminalTitle: () => undefined,
          onFirstDraw: () => {
            firstFrame = setup.captureCharFrame()
          },
          startRunner: neverRunner,
        },
      ).pipe(Effect.provideService(ProfileStore, profileStore))
      const fiber = yield* operation.pipe(Effect.forkChild)
      yield* Deferred.await(rendererRequested)
      expect(profileLoads).toBe(0)
      yield* Effect.tryPromise(() => setup.renderOnce())
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("Run rika auth login first")
      expect(firstFrame).toContain("Welcome to Rika")
      setup.renderer.destroy()
    }),
  )

  test.effect("draws before reporting that the local credential is missing", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const rendererRequested = Deferred.makeUnsafe<void>()
      let firstFrame = ""
      let profileLoads = 0
      let credentialLoads = 0
      const profileStore = ProfileStore.of({
        load: Effect.sync(() => {
          profileLoads += 1
          return Option.some(profile)
        }),
        save: () => Effect.void,
      })
      const credentialStore = CredentialStore.of({
        load: () =>
          Effect.sync(() => {
            credentialLoads += 1
            return Option.none()
          }),
        save: () => Effect.void,
        remove: () => Effect.succeed(false),
        serialized: (effect) => effect,
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        {
          makeRenderer: () => {
            Deferred.doneUnsafe(rendererRequested, Effect.void)
            return Effect.succeed(setup.renderer)
          },
          writeTerminalTitle: () => undefined,
          onFirstDraw: () => {
            firstFrame = setup.captureCharFrame()
          },
          startRunner: neverRunner,
        },
      ).pipe(Effect.provideService(ProfileStore, profileStore), Effect.provideService(CredentialStore, credentialStore))
      const fiber = yield* operation.pipe(Effect.forkChild)
      yield* Deferred.await(rendererRequested)
      expect(profileLoads).toBe(0)
      expect(credentialLoads).toBe(0)
      yield* Effect.tryPromise(() => setup.renderOnce())
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("Run rika auth login first")
      expect(firstFrame).toContain("Welcome to Rika")
      setup.renderer.destroy()
    }),
  )
})
