import { Effect, Exit, Ref, Scope, Semaphore } from "effect"
import {
  ExecutorFenceError,
  ExecutorTransportError,
  bindingMismatchReason,
  sameBinding,
  type HandshakeEvidence,
  type WorkspaceBinding,
  type WorkspaceExecutorService,
  type WorkspaceExecutorWebSocketPeer,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import * as RunnerConnection from "./runner-connection"

const maximumConnections = 512

interface Reservation {
  readonly token: symbol
  readonly binding: WorkspaceBinding
  readonly scope: Scope.Closeable
}

interface Registration extends Reservation {
  readonly connection: WorkspaceExecutorWebSocketServer
  readonly enrollment: Ref.Ref<Exit.Exit<HandshakeEvidence, ExecutorFenceError | ExecutorTransportError> | undefined>
}

interface GatewayState {
  readonly closed: boolean
  readonly reservations: ReadonlyMap<string, Reservation>
  readonly connections: ReadonlyMap<string, Registration>
}

export interface RunnerGateway {
  readonly bindingForThread: (input: {
    readonly request: Request
    readonly threadId: string
  }) => Effect.Effect<WorkspaceBinding, RunnerConnection.RunnerConnectionError>
  readonly connect: (input: {
    readonly request: Request
    readonly threadId: string
    readonly peer: WorkspaceExecutorWebSocketPeer
  }) => Effect.Effect<
    WorkspaceExecutorWebSocketServer,
    RunnerConnection.RunnerConnectionError | ExecutorFenceError | ExecutorTransportError,
    Scope.Scope
  >
  readonly executor: (binding: WorkspaceBinding) => WorkspaceExecutorService
  readonly ready: (
    binding: WorkspaceBinding,
  ) => Effect.Effect<HandshakeEvidence | undefined, ExecutorFenceError | ExecutorTransportError>
}

const unavailableConnection = () =>
  ExecutorTransportError.make({ phase: "connection", message: "Runner connection is unavailable" })

const unavailableRegistration = () =>
  RunnerConnection.RunnerConnectionError.make({ kind: "unavailable", message: "Runner connection is unavailable" })

const conflictingRegistration = () =>
  ExecutorFenceError.make({ reason: "assignment", message: "Runner assignment already has a connection" })

const mismatchedConnection = (expected: WorkspaceBinding, current: WorkspaceBinding) =>
  ExecutorFenceError.make({
    reason: bindingMismatchReason(expected, current) ?? "assignment",
    message: "Runner connection does not match the current assignment",
  })

export const makeWorkspaceGateway = Effect.fn("Rika.WorkspaceGateway.make")(function* (
  authorize: (
    request: Request,
    routingId: string,
  ) => Effect.Effect<RunnerConnection.RunnerConnectionAuthorization, RunnerConnection.RunnerConnectionError>,
): Effect.fn.Return<RunnerGateway, never, Scope.Scope> {
  const state = yield* Ref.make<GatewayState>({
    closed: false,
    reservations: new Map(),
    connections: new Map(),
  })
  const lock = yield* Semaphore.make(1)

  const reserve = (reservation: Reservation) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const assignmentId = reservation.binding.assignmentId
        if (current.closed) return yield* unavailableRegistration()
        if (current.reservations.has(assignmentId) || current.connections.has(assignmentId))
          return yield* conflictingRegistration()
        if (current.reservations.size + current.connections.size >= maximumConnections)
          return yield* unavailableRegistration()
        const reservations = new Map(current.reservations)
        reservations.set(assignmentId, reservation)
        yield* Ref.set(state, { ...current, reservations })
      }),
    )

  const install = (registration: Registration) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const assignmentId = registration.binding.assignmentId
        if (
          current.closed ||
          current.reservations.get(assignmentId)?.token !== registration.token ||
          current.connections.has(assignmentId)
        )
          return false
        const reservations = new Map(current.reservations)
        reservations.delete(assignmentId)
        const connections = new Map(current.connections)
        connections.set(assignmentId, registration)
        yield* Ref.set(state, { ...current, reservations, connections })
        return true
      }),
    )

  const unregister = (registration: Reservation) =>
    lock.withPermits(1)(
      Ref.modify(state, (current): readonly [boolean, GatewayState] => {
        const assignmentId = registration.binding.assignmentId
        const reservation = current.reservations.get(assignmentId)?.token === registration.token
        const connection = current.connections.get(assignmentId)?.token === registration.token
        if (!reservation && !connection) return [false, current]
        const reservations = new Map(current.reservations)
        const connections = new Map(current.connections)
        if (reservation) reservations.delete(assignmentId)
        if (connection) connections.delete(assignmentId)
        return [true, { ...current, reservations, connections }]
      }),
    )

  const release = (registration: Registration) =>
    unregister(registration).pipe(
      Effect.flatMap((removed) => (removed ? Scope.close(registration.scope, Exit.void) : Effect.void)),
    )

  yield* Effect.addFinalizer(() =>
    lock
      .withPermits(1)(
        Ref.modify(state, (current): readonly [ReadonlyArray<Reservation>, GatewayState] => {
          if (current.closed) return [[], current]
          return [
            [...current.reservations.values(), ...current.connections.values()],
            { closed: true, reservations: new Map(), connections: new Map() },
          ]
        }),
      )
      .pipe(
        Effect.flatMap((registrations) =>
          Effect.forEach(registrations, (registration) => Scope.close(registration.scope, Exit.void), {
            discard: true,
          }),
        ),
      ),
  )

  const connectionFor = Effect.fn("Rika.RunnerGateway.connectionFor")(function* (
    binding: WorkspaceBinding,
  ): Effect.fn.Return<WorkspaceExecutorService, ExecutorFenceError | ExecutorTransportError> {
    const current = yield* Ref.get(state)
    if (current.closed) return yield* unavailableConnection()
    const registration = current.connections.get(binding.assignmentId)
    if (registration === undefined) return yield* unavailableConnection()
    if (!sameBinding(binding, registration.binding)) return yield* mismatchedConnection(binding, registration.binding)
    return registration.connection.executor
  })

  const executor = (binding: WorkspaceBinding): WorkspaceExecutorService => ({
    binding,
    handshake: (request) => connectionFor(binding).pipe(Effect.flatMap((current) => current.handshake(request))),
    dispatch: (intent, input, handshake) =>
      connectionFor(binding).pipe(Effect.flatMap((current) => current.dispatch(intent, input, handshake))),
    receipt: (operationId) => connectionFor(binding).pipe(Effect.flatMap((current) => current.receipt(operationId))),
    cancel: (operationId) => connectionFor(binding).pipe(Effect.flatMap((current) => current.cancel(operationId))),
  })

  const connect: RunnerGateway["connect"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).closed) return yield* unavailableRegistration()
        const authorization = yield* restore(authorize(input.request, input.threadId))
        const token = Symbol("runner-connection")
        const binding = authorization.binding.workspaceBinding
        const connectionScope = yield* Scope.make()
        const reservation: Reservation = { token, binding, scope: connectionScope }
        const reserved = yield* Effect.exit(reserve(reservation))
        if (reserved._tag === "Failure") {
          yield* Scope.close(connectionScope, Exit.void)
          return yield* Effect.failCause(reserved.cause)
        }
        const acquired = yield* Effect.exit(
          restore(
            RunnerConnection.makeAuthorizedRunnerConnection({ authorization, peer: input.peer }).pipe(
              Scope.provide(connectionScope),
            ),
          ),
        )
        if (acquired._tag === "Failure") {
          yield* unregister(reservation)
          yield* Scope.close(connectionScope, Exit.void)
          return yield* Effect.failCause(acquired.cause)
        }
        const registration: Registration = {
          token,
          binding,
          scope: connectionScope,
          connection: acquired.value,
          enrollment: yield* Ref.make<
            Exit.Exit<HandshakeEvidence, ExecutorFenceError | ExecutorTransportError> | undefined
          >(undefined),
        }
        if (!(yield* install(registration))) {
          yield* Scope.close(connectionScope, Exit.void)
          return yield* unavailableRegistration()
        }
        yield* Effect.addFinalizer(() => release(registration))
        yield* registration.connection.ready.pipe(
          Effect.exit,
          Effect.flatMap((result) => Ref.set(registration.enrollment, result)),
          Effect.forkIn(connectionScope),
        )
        return {
          executor: registration.connection.executor,
          ready: registration.connection.ready,
          receive: registration.connection.receive,
          disconnected: () => release(registration),
        } satisfies WorkspaceExecutorWebSocketServer
      }),
    )

  return {
    connect,
    executor,
    ready: (binding) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.closed) return yield* unavailableConnection()
        const registration = current.connections.get(binding.assignmentId)
        if (registration === undefined) return undefined
        if (!sameBinding(binding, registration.binding))
          return yield* mismatchedConnection(binding, registration.binding)
        const enrollment = yield* Ref.get(registration.enrollment)
        if (enrollment === undefined) return undefined
        if (enrollment._tag === "Failure") return yield* Effect.failCause(enrollment.cause)
        return yield* registration.connection.ready
      }),
    bindingForThread: (input) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).closed) return yield* unavailableRegistration()
        const authorization = yield* authorize(input.request, input.threadId)
        return authorization.binding.workspaceBinding
      }),
  }
})

export const makeRunnerGateway = (options: RunnerConnection.RunnerConnectionOptions) =>
  makeWorkspaceGateway((request, threadId) => RunnerConnection.authorizeRunnerConnection(request, threadId, options))
