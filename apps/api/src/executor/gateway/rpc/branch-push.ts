import type { ControllerError, Interface as Controller } from "@rika/e2b-executor/controller"
import { redactAccess, type AccessWire, type ApiMessage, type BranchPushOutcome } from "@rika/remote-execution/protocol"
import { Clock, Deferred, Effect, Option, Ref, type Semaphore } from "effect"
import { GatewayError, type Gateway, type PhaseAuthority, type PreparationStore, type Socket } from "../contract"
import type { BranchPushCall, GatewaySession } from "./model"
import { gatewayProtocol } from "../protocol"

export interface BranchPushRpcDependencies {
  readonly controller: Controller
  readonly phases: PhaseAuthority
  readonly preparation: PreparationStore
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly quiescing: Ref.Ref<Set<string>>
  readonly calls: Ref.Ref<Map<string, BranchPushCall>>
  readonly admission: Semaphore.Semaphore
  readonly awaitSession: (assignmentId: string) => Effect.Effect<GatewaySession, GatewayError>
  readonly send: (socket: Socket, message: ApiMessage) => void
  readonly expired: () => GatewayError
  readonly accessFailure: (error: ControllerError) => GatewayError
}

const sameScope = (call: BranchPushCall, input: Parameters<Gateway["pushBranch"]>[0]) =>
  call.assignmentId === input.assignmentId &&
  call.ownerId === input.ownerId &&
  call.repositoryId === input.repositoryId &&
  call.workspaceId === input.workspaceId &&
  call.branch === input.branch &&
  call.ref === input.ref &&
  call.commitSha === input.commitSha

export const branchPushRpcFactory = (dependencies: BranchPushRpcDependencies) => {
  const fail = Effect.fn("ExecutorGateway.branchPush.fail")(function* (
    predicate: (call: BranchPushCall) => boolean,
    message: string,
  ) {
    const failed = yield* Ref.modify(dependencies.calls, (current) => {
      const calls = [...current.values()].filter(predicate)
      if (calls.length === 0) return [calls, current] as const
      const next = new Map(current)
      for (const call of calls) next.delete(call.publicationId)
      return [calls, next] as const
    })
    yield* Effect.forEach(
      failed,
      (call) => Deferred.fail(call.result, GatewayError.make({ kind: "disconnected", message })),
      { discard: true },
    )
  })

  const receive = Effect.fn("ExecutorGateway.branchPush.receive")(function* (
    socket: Socket,
    access: AccessWire,
    publicationId: string,
    branch: string,
    commitSha: string,
    outcome: BranchPushOutcome,
  ) {
    const call = (yield* Ref.get(dependencies.calls)).get(publicationId)
    const succeeded = outcome._tag === "Succeeded" ? outcome : undefined
    if (
      call === undefined ||
      call.socket !== socket ||
      !gatewayProtocol.sameAccess(call.access, access) ||
      call.branch !== branch ||
      call.commitSha !== commitSha ||
      (succeeded !== undefined &&
        (succeeded.branch !== call.branch || succeeded.ref !== call.ref || succeeded.commitSha !== call.commitSha))
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Branch push result scope is stale" })
    yield* Deferred.succeed(call.result, outcome)
  })

  const admit = Effect.fn("ExecutorGateway.branchPush.admit")(function* (input: Parameters<Gateway["pushBranch"]>[0]) {
    return yield* dependencies.admission.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(dependencies.sessions)).get(input.assignmentId)
        if (session === undefined || !session.ready)
          return yield* GatewayError.make({ kind: "disconnected", message: "Approved workspace is not ready" })
        if ((yield* Ref.get(dependencies.quiescing)).has(input.assignmentId))
          return yield* GatewayError.make({ kind: "fenced", message: "Approved workspace is quiescing" })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* dependencies.expired()
        yield* dependencies.controller
          .validateAccess(redactAccess(session.access))
          .pipe(Effect.mapError(dependencies.accessFailure))
        yield* dependencies.preparation.ready(session.access)
        const result = yield* Deferred.make<BranchPushOutcome, GatewayError>()
        const candidate: BranchPushCall = { ...input, socket: session.socket, access: session.access, result }
        const call = yield* Ref.modify(dependencies.calls, (current) => {
          const known = current.get(input.publicationId)
          return known === undefined
            ? ([candidate, new Map(current).set(input.publicationId, candidate)] as const)
            : ([known, current] as const)
        })
        if (call !== candidate || !sameScope(call, input))
          return yield* GatewayError.make({ kind: "fenced", message: "Publication id was reused with another scope" })
        return candidate
      }),
    )
  })

  const pushBranch: Gateway["pushBranch"] = (input) =>
    Effect.gen(function* () {
      const connected = yield* dependencies.awaitSession(input.assignmentId).pipe(Effect.timeoutOption("30 seconds"))
      if (Option.isNone(connected))
        return yield* GatewayError.make({ kind: "timeout", message: "Approved workspace did not connect in time" })
      const call = yield* admit(input)
      return yield* dependencies.phases
        .publication(call.access, () =>
          Effect.try({
            try: () =>
              dependencies.send(call.socket, { _tag: "BranchPush", request: { ...input, access: call.access } }),
            catch: () => GatewayError.make({ kind: "transport", message: "Could not send approved branch push" }),
          }).pipe(
            Effect.andThen(Deferred.await(call.result)),
            Effect.timeoutOption("60 seconds"),
            Effect.flatMap((outcome) =>
              Option.isSome(outcome)
                ? Effect.succeed(outcome.value)
                : GatewayError.make({ kind: "timeout", message: "Approved branch push outcome is unknown" }),
            ),
          ),
        )
        .pipe(
          Effect.ensuring(
            Ref.update(dependencies.calls, (current) => {
              if (current.get(input.publicationId) !== call) return current
              const next = new Map(current)
              next.delete(input.publicationId)
              return next
            }),
          ),
        )
    })

  return { fail, pushBranch, receive }
}
