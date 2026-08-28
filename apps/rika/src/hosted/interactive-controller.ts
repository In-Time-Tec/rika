import type * as InteractiveFeed from "@rika/product/interactive-feed"
import * as InteractiveConnection from "@rika/product/interactive-connection"
import * as InteractiveSession from "@rika/product/interactive-session"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { OperationUnavailable } from "@rika/product/product-operation"
import { CredentialStore, HostedError, HostedThreadId, ThreadClient, Http, ProfileStore } from "./contract"
import { authenticated, selectedProfile } from "./account"
import * as HostedInteractiveSession from "./interactive-session"
import { preferencePath, prepareRunnerCheckout, type PreparedRunnerCheckout } from "../runner/service"
import { RunnerAdmission } from "../runner/contract"
import type { InteractiveTuiOptions } from "../interactive/process/lifecycle/loop"
import { interactiveTui } from "../interactive/process/lifecycle/loop"
import { prepareWorkspaceSeed } from "./workspace/seed"

const FailureMessage = Schema.Struct({ message: Schema.String })
type Mutable<T> = { -readonly [P in keyof T]: T[P] }
type ThreadCreateInput = Mutable<Parameters<ThreadClient["Service"]["create"]>[0]>
const operationFailure = <E>(error: E) => {
  const parsed = Schema.decodeUnknownOption(FailureMessage)(error)
  return OperationUnavailable.make({
    operation: "Interactive",
    message: parsed._tag === "Some" ? parsed.value.message : String(error),
  })
}

const startRunnerWhenPlaced = <Prepared, E, R, E2, R2>(
  connection: InteractiveConnection.Connection,
  prepare: Effect.Effect<Prepared, E, R>,
  startRunner: (prepared: Prepared, ready: Deferred.Deferred<void>) => Effect.Effect<never, E2, R2>,
  ready = Deferred.makeUnsafe<void>(),
) =>
  Stream.concat(Stream.make(connection.initialState), connection.stateChanges).pipe(
    Stream.filter((state) => state.target === "runner"),
    Stream.runHead,
    Effect.flatMap((placement) =>
      placement._tag === "Some"
        ? prepare.pipe(Effect.flatMap((prepared) => startRunner(prepared, ready)))
        : Effect.never,
    ),
  )

const runnerConnectionState = (state: InteractiveConnection.State, ready: boolean): InteractiveConnection.State =>
  state.target === "runner" && !ready && state.connectivity !== "disconnected"
    ? { ...state, connectivity: "connecting" }
    : state

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
) => {
  let attached: InteractiveSession.InteractiveSession | undefined
  const unavailable = () => Effect.fail(operationFailure("Interactive session is still initializing"))
  const deferredEffect = (
    select: (session: InteractiveSession.InteractiveSession) => Effect.Effect<void, OperationUnavailable>,
  ) => Deferred.await(ready).pipe(Effect.flatMap(select))
  const session: InteractiveSession.InteractiveSession = {
    events: (dispatch) => Deferred.await(ready).pipe(Effect.flatMap((value) => value.events(dispatch))),
    currentView: () => attached?.currentView(),
    projectionCheckpoint: (turnId) => attached?.projectionCheckpoint(turnId),
    submit: (...args) => deferredEffect((value) => value.submit(...args)),
    shell: (...args) => deferredEffect((value) => value.shell(...args)),
    editQueued: (...args) => deferredEffect((value) => value.editQueued(...args)),
    dequeue: (...args) => deferredEffect((value) => value.dequeue(...args)),
    steerQueued: (...args) => deferredEffect((value) => value.steerQueued(...args)),
    steer: (...args) => deferredEffect((value) => value.steer(...args)),
    approveAuthorization: (...args) => deferredEffect((value) => value.approveAuthorization(...args)),
    denyAuthorization: (...args) => deferredEffect((value) => value.denyAuthorization(...args)),
    interruptAndSend: (...args) => deferredEffect((value) => value.interruptAndSend(...args)),
    cancel: (...args) => deferredEffect((value) => value.cancel(...args)),
    quit: deferredEffect((value) => value.quit),
    newThread: deferredEffect((value) => value.newThread),
    newOrbThread: deferredEffect((value) => value.newOrbThread ?? unavailable()),
    archiveThread: deferredEffect((value) => value.archiveThread),
    archiveAndNewThread: deferredEffect((value) => value.archiveAndNewThread),
    selectThread: (...args) => deferredEffect((value) => value.selectThread(...args)),
    readQueue: (...args) => deferredEffect((value) => value.readQueue(...args)),
    previewThread: (...args) => deferredEffect((value) => value.previewThread(...args)),
    reopenThread: deferredEffect((value) => value.reopenThread),
  }
  return { session, attach: (real: InteractiveSession.InteractiveSession) => (attached = real) }
}

const run = Effect.fn("HostedInteractiveController.run")(function* <E, R extends object>(
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions & {
    readonly startRunner: (
      prepared: PreparedRunnerCheckout,
      ready: Deferred.Deferred<void>,
    ) => Effect.Effect<never, E, R>
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
    const workspace = input.workspace ?? process.cwd()
    const createThread = (
      executorKind: "runner" | "orb",
      archiveThreadId?: string,
    ): Effect.Effect<string, HostedError> =>
      Effect.gen(function* () {
        const prepared = executorKind === "runner" ? yield* prepare : undefined
        const workspaceSeed =
          executorKind === "orb"
            ? yield* prepareWorkspaceSeed(workspace).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcesses),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Scope.Scope, scope),
              )
            : undefined
        const commandId = yield* crypto.randomUUIDv4
        const created = yield* authenticated(profile, (session) =>
          Effect.gen(function* () {
            const seed =
              workspaceSeed === undefined
                ? undefined
                : yield* http.uploadWorkspaceSeed(
                    profile.origin,
                    workspaceSeed.archive,
                    workspaceSeed.sourceRepository,
                    session,
                  )
            const ticket = yield* http.issueThreadTicket(profile.origin, session)
            return { seed, ticket }
          }),
        )
        const createInput: ThreadCreateInput = {
          ticket: created.ticket,
          commandId,
          owner: profile.owner,
          executorKind,
        }
        if (profile.project !== undefined) createInput.project = profile.project
        if (archiveThreadId !== undefined) createInput.archiveThreadId = HostedThreadId.make(archiveThreadId)
        if (executorKind === "runner" && prepared !== undefined)
          createInput.runnerTarget = {
            deviceId: prepared.checkout.registration.deviceId,
            checkoutFingerprint: prepared.checkout.registration.checkoutFingerprint,
          }
        if (created.seed !== undefined) createInput.workspaceSeedId = created.seed.id
        return yield* threads.create(createInput)
      }).pipe(
        Effect.provideService(Http, http),
        Effect.provideService(CredentialStore, credentials),
        Effect.mapError((error) =>
          Schema.is(HostedError)(error)
            ? error
            : HostedError.make({ kind: "host", message: "Could not create a Thread identifier" }),
        ),
      )
    const threadId = input.threadId ?? (yield* createThread("runner"))
    const listThreads = authenticated(profile, (session) =>
      http.listThreads(profile.origin, profile.owner, profile.project, session),
    ).pipe(Effect.provideService(Http, http), Effect.provideService(CredentialStore, credentials))
    const previewThread = (selectedThreadId: string) =>
      authenticated(profile, (session) => http.previewThread(profile.origin, selectedThreadId, session)).pipe(
        Effect.provideService(Http, http),
        Effect.provideService(CredentialStore, credentials),
      )
    const hosted = yield* HostedInteractiveSession.makeHostedInteractiveSession({
      profile,
      threadId,
      createThread,
      listThreads,
      previewThread,
    })
    const runnerReady = yield* Deferred.make<void>()
    let runnerConnected = false
    let latestHostedState = hosted.connection.initialState
    yield* hosted.connection.stateChanges.pipe(
      Stream.runForEach((state) =>
        Effect.sync(() => {
          latestHostedState = state
        }).pipe(Effect.andThen(SubscriptionRef.set(connectionState, runnerConnectionState(state, runnerConnected)))),
      ),
      Effect.forkScoped,
    )
    yield* Deferred.await(runnerReady).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          runnerConnected = true
        }),
      ),
      Effect.andThen(
        Effect.suspend(() => SubscriptionRef.set(connectionState, runnerConnectionState(latestHostedState, true))),
      ),
      Effect.forkScoped,
    )
    deferred.attach(hosted.session)
    yield* Deferred.succeed(sessionReady, hosted.session)
    return yield* startRunnerWhenPlaced(
      hosted.connection,
      prepare,
      (prepared, ready) => options.startRunner(prepared, ready).pipe(Effect.mapError(operationFailure)),
      runnerReady,
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
    readonly startRunner: (
      prepared: PreparedRunnerCheckout,
      ready: Deferred.Deferred<void>,
    ) => Effect.Effect<never, E, R>
  },
) {
  return yield* run(input, options).pipe(Effect.mapError(operationFailure))
})

export const hostedInteractiveControllerInternals = { raceStructured, runnerConnectionState, startRunnerWhenPlaced }
