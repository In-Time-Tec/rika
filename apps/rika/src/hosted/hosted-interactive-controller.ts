import type * as InteractiveFeed from "@rika/product/interactive-feed"
import * as InteractiveConnection from "@rika/product/interactive-connection"
import * as InteractiveSession from "@rika/product/interactive-session"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { OperationUnavailable } from "@rika/product/product-operation"
import { CredentialStore, HostedError, ThreadClient, Http, ProfileStore } from "./hosted-contract"
import { authenticated, selectedProfile } from "./hosted-account"
import { makeHostedInteractiveSession } from "./hosted-interactive-session"
import { preferencePath, prepareRunnerCheckout, type PreparedRunnerCheckout } from "../runner/runner"
import { RunnerAdmission } from "../runner/runner-contract"
import type { InteractiveTuiOptions } from "../interactive/process/interactive-process-loop"
import { interactiveTui } from "../interactive/process/interactive-process-loop"

const operationFailure = (error: unknown) =>
  OperationUnavailable.make({
    operation: "Interactive",
    message: error instanceof Error ? error.message : String(error),
  })

const startRunnerWhenPlaced = <Prepared, E, R, E2, R2>(
  connection: InteractiveConnection.Connection,
  prepare: Effect.Effect<Prepared, E, R>,
  startRunner: (prepared: Prepared) => Effect.Effect<never, E2, R2>,
) =>
  Stream.concat(Stream.make(connection.initialState), connection.stateChanges).pipe(
    Stream.filter((state) => state.target === "runner"),
    Stream.runHead,
    Effect.flatMap((placement) =>
      placement._tag === "Some" ? prepare.pipe(Effect.flatMap((prepared) => startRunner(prepared))) : Effect.never,
    ),
  )

const raceStructured = <A, E, R, A2, E2, R2>(left: Effect.Effect<A, E, R>, right: Effect.Effect<A2, E2, R2>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const leftFiber = yield* left.pipe(Effect.forkScoped)
      const rightFiber = yield* right.pipe(Effect.forkScoped)
      const winner = yield* Effect.race(Fiber.await(leftFiber), Fiber.await(rightFiber))
      yield* Fiber.interrupt(leftFiber)
      yield* Fiber.interrupt(rightFiber)
      return yield* winner
    }),
  )

export const makeDeferredSession = (
  ready: Deferred.Deferred<InteractiveSession.InteractiveSession, OperationUnavailable>,
): {
  readonly session: InteractiveSession.InteractiveSession
  readonly attach: (session: InteractiveSession.InteractiveSession) => void
} => {
  let attached: InteractiveSession.InteractiveSession | undefined
  const effects = new Set([
    "cancel",
    "quit",
    "newThread",
    "newOrbThread",
    "pauseOrb",
    "resumeOrb",
    "enableRemoteThreadCreation",
    "disableRemoteThreadCreation",
    "archiveThread",
    "archiveAndNewThread",
    "reopenThread",
  ])
  const session = new Proxy({} as InteractiveSession.InteractiveSession, {
    get: (_, property: keyof InteractiveSession.InteractiveSession) => {
      if (property === "currentView" || property === "projectionCheckpoint")
        return (...args: ReadonlyArray<unknown>) =>
          attached === undefined
            ? undefined
            : (attached[property] as (...values: ReadonlyArray<unknown>) => unknown)(...args)
      if (property === "events")
        return (...args: ReadonlyArray<unknown>) =>
          Deferred.await(ready).pipe(
            Effect.flatMap((attachedSession) =>
              (attachedSession.events as (...values: ReadonlyArray<unknown>) => Effect.Effect<void, OperationUnavailable>)(
                ...args,
              ),
            ),
          )
      if (effects.has(property)) {
        if (attached !== undefined) return attached[property]
        return Effect.fail(operationFailure("Interactive session is still initializing"))
      }
      return (...args: ReadonlyArray<unknown>) =>
        attached === undefined
          ? Effect.fail(operationFailure("Interactive session is still initializing"))
          : (attached[property] as (...values: ReadonlyArray<unknown>) => Effect.Effect<void>)(...args)
    },
  })
  return { session, attach: (real) => (attached = real) }
}

const run = Effect.fn("HostedInteractiveController.run")(function* <E, R extends object>(
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions & {
    readonly startRunner: (prepared: PreparedRunnerCheckout) => Effect.Effect<never, E, R>
  },
) {
  const firstDraw = yield* Deferred.make<void>()
  const sessionReady = yield* Deferred.make<InteractiveSession.InteractiveSession, OperationUnavailable>()
  const deferred = makeDeferredSession(sessionReady)
  const connectionState = yield* SubscriptionRef.make<InteractiveConnection.State>({
    connectivity: "connecting",
    target: "resolving",
    activity: "authenticating",
    participants: 0,
  })
  const connection: InteractiveConnection.Connection = {
    initialState: yield* SubscriptionRef.get(connectionState),
    stateChanges: SubscriptionRef.changes(connectionState),
  }
  const initialize = Effect.gen(function* () {
    yield* Deferred.await(firstDraw)
    const profile = yield* selectedProfile()
    const http = yield* Http
    yield* authenticated(profile, (session) => http.context(profile.origin, session))
    const checkout = prepareRunnerCheckout({
      workspace: input.workspace ?? process.cwd(),
      preferencePath: yield* preferencePath,
    })
    const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner
    const fileSystem = yield* FileSystem.FileSystem
    const profiles = yield* ProfileStore
    const runnerAdmission = yield* RunnerAdmission
    const scope = yield* Scope.Scope
    const prepare = yield* Effect.cached(
      checkout.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcesses),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(ProfileStore, profiles),
        Effect.provideService(RunnerAdmission, runnerAdmission),
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    const threads = yield* ThreadClient
    const crypto = yield* Crypto.Crypto
    const credentials = yield* CredentialStore
    const createThread = (executorKind: "runner" | "orb"): Effect.Effect<string, HostedError> =>
      Effect.gen(function* () {
        const prepared = executorKind === "runner" ? yield* prepare : undefined
        const commandId = yield* crypto.randomUUIDv4
        const ticket = yield* authenticated(profile, (session) => http.issueThreadTicket(profile.origin, session))
        return yield* threads.create({
          ticket,
          commandId,
          owner: profile.owner,
          ...(profile.project === undefined ? {} : { project: profile.project }),
          executorKind,
          ...(executorKind === "runner"
            ? {
                runnerTarget: {
                  deviceId: prepared!.checkout.registration.deviceId,
                  checkoutFingerprint: prepared!.checkout.registration.checkoutFingerprint,
                },
              }
            : {}),
        })
      }).pipe(
        Effect.provideService(Http, http),
        Effect.provideService(CredentialStore, credentials),
        Effect.mapError((error) =>
          Schema.is(HostedError)(error)
            ? error
            : HostedError.make({ kind: "host", message: "Could not create a hosted Thread identifier" }),
        ),
      )
    const setRemoteThreadCreation = (preference: "allowed" | "denied") =>
      prepare.pipe(
        Effect.flatMap((prepared) =>
          authenticated(profile, (session) =>
            http.setRemoteThreadCreation(
              profile.origin,
              prepared.checkout.registration.checkoutFingerprint,
              preference,
              session,
            ),
          ),
        ),
        Effect.provideService(Http, http),
        Effect.provideService(CredentialStore, credentials),
        Effect.mapError((error) =>
          Schema.is(HostedError)(error)
            ? error
            : HostedError.make({ kind: "host", message: "Could not update Runner admission" }),
        ),
      )
    const threadId = input.threadId ?? (yield* createThread("runner"))
    const hosted = yield* makeHostedInteractiveSession({
      threadId,
      createThread: (executorKind) => createThread(executorKind).pipe(Effect.map(String)),
      setRemoteThreadCreation,
    })
    yield* hosted.connection.stateChanges.pipe(
      Stream.runForEach((state) => SubscriptionRef.set(connectionState, state)),
      Effect.forkScoped,
    )
    deferred.attach(hosted.session)
    yield* Deferred.succeed(sessionReady, hosted.session)
    return yield* startRunnerWhenPlaced(
      hosted.connection,
      prepare,
      (prepared) => options.startRunner(prepared).pipe(Effect.mapError(operationFailure)),
    )
  }).pipe(Effect.mapError(operationFailure))
  yield* raceStructured(
    interactiveTui({
      ...options,
      onFirstDraw: () => {
        options.onFirstDraw?.()
        Deferred.doneUnsafe(firstDraw, Effect.void)
      },
    })({ ...input }, deferred.session, connection),
    initialize,
  )
})

export const runHostedInteractive = Effect.fn("HostedInteractiveController.entry")(function* <E, R extends object>(
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions & {
    readonly startRunner: (prepared: PreparedRunnerCheckout) => Effect.Effect<never, E, R>
  },
) {
  return yield* run(input, options).pipe(Effect.mapError(operationFailure))
})

export const hostedInteractiveControllerInternals = { raceStructured, startRunnerWhenPlaced }
