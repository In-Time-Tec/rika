import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { it } from "@effect/vitest"
import { createTestRenderer } from "@opentui/core/testing"
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import * as HostedCli from "../../../src/hosted/cli"
import { CredentialStore, ProfileStore, type PrivateJwk, type Profile } from "../../../src/hosted/contract"
import { runHostedInteractive } from "../../../src/hosted/interactive-controller"
import * as Runner from "../../../src/runner/service"

const neverRunner = (): Effect.Effect<never> => Effect.never
type TestRenderer = Awaited<ReturnType<typeof createTestRenderer>>

const startupOptions = (
  setup: TestRenderer,
  callbacks: { readonly onRenderer?: () => void; readonly onFirstDraw?: () => void } = {},
) => {
  const options = {
    makeRenderer: () => {
      callbacks.onRenderer?.()
      return Effect.succeed(setup.renderer)
    },
    writeTerminalTitle: () => undefined,
    startRunner: neverRunner,
  }
  if (callbacks.onFirstDraw !== undefined) Object.assign(options, { onFirstDraw: callbacks.onFirstDraw })
  return options
}

const missingCredentialStore = (onLoad: () => void = () => undefined) =>
  CredentialStore.of({
    load: () =>
      Effect.sync(() => {
        onLoad()
        return Option.none()
      }),
    save: () => Effect.void,
    remove: () => Effect.succeed(false),
    serialized: (effect) => effect,
  })

const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
}

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
        { _tag: "Interactive", prompt: [], ephemeral: false, threadId: "thread-existing" },
        startupOptions(setup, { onRenderer: () => Deferred.doneUnsafe(rendererRequested, Effect.void) }),
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
        { _tag: "Interactive", prompt: [], ephemeral: false, threadId: "thread-existing" },
        startupOptions(setup, {
          onRenderer: () => Deferred.doneUnsafe(rendererRequested, Effect.void),
          onFirstDraw: () => {
            firstFrame = setup.captureCharFrame()
          },
        }),
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

  test.effect("reports a missing credential for existing and initial Thread startup", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
      const rendererRequested = Deferred.makeUnsafe<void>()
      const credentialRequested = Deferred.makeUnsafe<void>()
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
      const credentialStore = missingCredentialStore(() => {
        credentialLoads += 1
        Deferred.doneUnsafe(credentialRequested, Effect.void)
      })
      const operation = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false, threadId: "thread-existing" },
        startupOptions(setup, {
          onRenderer: () => Deferred.doneUnsafe(rendererRequested, Effect.void),
          onFirstDraw: () => {
            firstFrame = setup.captureCharFrame()
          },
        }),
      ).pipe(Effect.provideService(ProfileStore, profileStore), Effect.provideService(CredentialStore, credentialStore))
      const fiber = yield* operation.pipe(Effect.forkChild)
      yield* Deferred.await(rendererRequested)
      expect(profileLoads).toBe(0)
      expect(credentialLoads).toBe(0)
      yield* Effect.tryPromise(() => setup.renderOnce())
      yield* Deferred.await(credentialRequested)
      let failureFrame = ""
      for (let attempt = 0; attempt < 100 && !failureFrame.includes("Run rika auth login first"); attempt += 1) {
        yield* Effect.yieldNow
        yield* Effect.tryPromise(() => setup.renderOnce())
        failureFrame = setup.captureCharFrame()
      }
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(failureFrame).toContain("Run rika auth login first")
      expect(firstFrame).toContain("Welcome to Rika")
      yield* Fiber.interrupt(fiber)
      setup.renderer.destroy()

      const initialSetup = yield* Effect.tryPromise(() =>
        createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }),
      )
      const initial = runHostedInteractive(
        { _tag: "Interactive", prompt: [], ephemeral: false },
        startupOptions(initialSetup),
      ).pipe(Effect.provideService(ProfileStore, profileStore), Effect.provideService(CredentialStore, credentialStore))
      const initialFiber = yield* initial.pipe(Effect.forkChild)
      yield* Effect.tryPromise(() => initialSetup.renderOnce())
      const initialExit = yield* Fiber.await(initialFiber)
      expect(initialExit._tag).toBe("Failure")
      expect(String(initialExit)).toContain("Run rika auth login first")
      initialSetup.renderer.destroy()
    }),
  )
})
