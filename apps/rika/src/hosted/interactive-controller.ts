import type * as InteractiveFeed from "@rika/product/interactive-feed"
import * as InteractiveConnection from "@rika/product/interactive-connection"
import * as InteractiveSession from "@rika/product/interactive-session"
import { Context, Crypto, Deferred, Effect, Fiber, FileSystem, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { OperationUnavailable } from "@rika/product/product-operation"
import { CredentialStore, HostedError, ThreadClient, Http, ProfileStore } from "./contract"
import { authenticated, localLoginProfile } from "./account"
import * as HostedInteractiveSession from "./interactive-session"
import { preferencePath, prepareRunnerCheckout, type PreparedRunnerCheckout } from "../runner/service"
import { RunnerAdmission } from "../runner/contract"
import type { InteractiveTuiOptions } from "../interactive/process/lifecycle/loop"
import { interactiveTui } from "../interactive/process/lifecycle/loop"

const operationFailure = (error: Error | string) =>
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

interface DeferredSession {
  readonly session: InteractiveSession.InteractiveSession
  readonly attach: (session: InteractiveSession.InteractiveSession) => void
}

const HostedInteractiveSessionFactory = Context.Reference<typeof HostedInteractiveSession.makeHostedInteractiveSession>(
  "@rika/cli/hosted/interactive-controller/HostedInteractiveSessionFactory",
  {
    defaultValue: () => HostedInteractiveSession.makeHostedInteractiveSession,
  },
)

export const makeDeferredSession = (
  ready: Deferred.Deferred<InteractiveSession.InteractiveSession, OperationUnavailable>,
): DeferredSession => {
  let attached: InteractiveSession.InteractiveSession | undefined
  const unavailable = () => Effect.fail(operationFailure("Interactive session is still initializing"))
  const session: InteractiveSession.InteractiveSession = {
    events: (dispatch) => Deferred.await(ready).pipe(Effect.flatMap((real) => real.events(dispatch))),
    currentView: () => attached?.currentView(),
    projectionCheckpoint: (turnId) => attached?.projectionCheckpoint(turnId),
    submit: (...args) => (attached === undefined ? unavailable() : attached.submit(...args)),
    shell: (...args) => (attached === undefined ? unavailable() : attached.shell(...args)),
    editQueued: (...args) => (attached === undefined ? unavailable() : attached.editQueued(...args)),
    dequeue: (...args) => (attached === undefined ? unavailable() : attached.dequeue(...args)),
    steerQueued: (...args) => (attached === undefined ? unavailable() : attached.steerQueued(...args)),
    steer: (...args) => (attached === undefined ? unavailable() : attached.steer(...args)),
    approveAuthorization: (...args) =>
      attached === undefined ? unavailable() : attached.approveAuthorization(...args),
    denyAuthorization: (...args) => attached === undefined ? unavailable() : attached.denyAuthorization(...args),
    interruptAndSend: (...args) => attached === undefined ? unavailable() : attached.interruptAndSend(...args),
    get cancel() {
      return attached?.cancel ?? unavailable()
    },
    get quit() {
      return attached?.quit ?? unavailable()
    },
    get newThread() {
      return attached?.newThread ?? unavailable()
    },
    get newOrbThread() {
      return attached?.newOrbThread ?? unavailable()
    },
    get pauseOrb() {
      return attached?.pauseOrb ?? unavailable()
    },
    get resumeOrb() {
      return attached?.resumeOrb ?? unavailable()
    },
    get enableRemoteThreadCreation() {
      return attached?.enableRemoteThreadCreation ?? unavailable()
    },
    get disableRemoteThreadCreation() {
      return attached?.disableRemoteThreadCreation ?? unavailable()
    },
    get archiveThread() {
      return attached?.archiveThread ?? unavailable()
    },
    get archiveAndNewThread() {
      return attached?.archiveAndNewThread ?? unavailable()
    },
    selectThread: (...args) => (attached === undefined ? unavailable() : attached.selectThread(...args)),
    readQueue: (...args) => (attached === undefined ? unavailable() : attached.readQueue(...args)),
    previewThread: (...args) => (attached === undefined ? unavailable() : attached.previewThread(...args)),
    get reopenThread() {
      return attached?.reopenThread ?? unavailable()
    },
  }
  return { session, attach: (real) => (attached = real) }
}

const run = Effect.fn("HostedInteractiveController.run")(function* <E extends Error, R extends object>(
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions & {
    readonly startRunner: (prepared: PreparedRunnerCheckout) => Effect.Effect<never, E, R>
  },
) {
  const profile = yield* localLoginProfile()
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
    const makeSession = yield* HostedInteractiveSessionFactory
    const createThread = (executorKind: "runner" | "orb"): Effect.Effect<string, HostedError> =>
      Effect.gen(function* () {
        const commandId = yield* crypto.randomUUIDv4
        const ticket = yield* authenticated(profile, (session) => http.issueThreadTicket(profile.origin, session))
        const request = {
          ticket,
          commandId,
          owner: profile.owner,
          executorKind,
        }
        const requestWithProject = profile.project === undefined ? request : { ...request, project: profile.project }
        if (executorKind === "orb") return yield* threads.create(requestWithProject)
        const prepared = yield* prepare
        return yield* threads.create({
          ...requestWithProject,
          runnerTarget: {
            deviceId: prepared.checkout.registration.deviceId,
            checkoutFingerprint: prepared.checkout.registration.checkoutFingerprint,
          },
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
    const hosted = yield* makeSession({
      profile,
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
    return yield* startRunnerWhenPlaced(hosted.connection, prepare, (prepared) =>
      options.startRunner(prepared).pipe(Effect.mapError(operationFailure)),
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

export const runHostedInteractive = Effect.fn("HostedInteractiveController.entry")(function* <E extends Error, R extends object>(
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions & {
    readonly startRunner: (prepared: PreparedRunnerCheckout) => Effect.Effect<never, E, R>
  },
) {
  return yield* run(input, options).pipe(Effect.mapError(operationFailure))
})

export const hostedInteractiveControllerInternals = { raceStructured, startRunnerWhenPlaced }
