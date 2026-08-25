import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Ref, Semaphore } from "effect"

export interface ProductOperationAdmissionInput {
  readonly rawBackend: ExecutionGateway.Interface
}

export const makeProductOperationAdmission = Effect.fn("ProductOperation.makeAdmission")(function* (
  input: ProductOperationAdmissionInput,
) {
  const { rawBackend } = input
  const admission = yield* Semaphore.make(1)
  const state = yield* Ref.make({ closed: false, active: 0 })
  const drained = yield* Deferred.make<void>()
  const release = Ref.modify(state, (current) => {
    const next = { ...current, active: Math.max(0, current.active - 1) }
    return [next.closed && next.active === 0, next] as const
  }).pipe(Effect.flatMap((complete) => (complete ? Deferred.succeed(drained, undefined) : Effect.void)))
  const withExecutionAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>, closed: E): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      admission.withPermits(1)(
        Ref.modify(state, (current) =>
          current.closed ? [false, current] : [true, { ...current, active: current.active + 1 }],
        ),
      ),
      (admitted): Effect.Effect<A, E, R> => (admitted === true ? effect : Effect.fail(closed)),
      (admitted) => (admitted === true ? release : Effect.void),
    )
  const closeAdmissions = admission
    .withPermits(1)(
      Ref.modify(state, (current) => [current.active, current.closed ? current : { ...current, closed: true }]),
    )
    .pipe(
      Effect.flatMap((active) => (active === 0 ? Effect.void : Deferred.await(drained))),
      Effect.uninterruptible,
    )
  const acquiredBackend = ExecutionGateway.Service.of({
    startTurn: (backendInput) =>
      withExecutionAdmission(
        rawBackend.startTurn(backendInput),
        ExecutionGateway.StartTurnFailure.make({ message: "Runtime shutdown has closed execution admission" }),
      ),
    prepareTurn: (backendInput) =>
      withExecutionAdmission(
        rawBackend.prepareTurn(backendInput),
        ExecutionGateway.PrepareTurnFailure.make({
          kind: "unavailable",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    admitTurn: (prepared) =>
      withExecutionAdmission(
        rawBackend.admitTurn(prepared),
        ExecutionGateway.AdmitTurnFailure.make({
          kind: "unavailable",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    activateTurn: (prepared, link) =>
      withExecutionAdmission(
        rawBackend.activateTurn(prepared, link),
        ExecutionGateway.ActivateTurnFailure.make({
          kind: "unavailable",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    cancelTurn: (link, reason) =>
      withExecutionAdmission(
        rawBackend.cancelTurn(link, reason),
        ExecutionGateway.CancelTurnFailure.make({ message: "Runtime shutdown has closed execution admission" }),
      ),
    steerTurn: (link, steering) =>
      withExecutionAdmission(
        rawBackend.steerTurn(link, steering),
        ExecutionGateway.SteeringFailure.make({
          kind: "unknown",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    approveTurn: (link, approval) =>
      withExecutionAdmission(
        rawBackend.approveTurn(link, approval),
        ExecutionGateway.ApprovalResponseFailure.make({
          kind: "unavailable",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    denyTurn: (link, approval) =>
      withExecutionAdmission(
        rawBackend.denyTurn(link, approval),
        ExecutionGateway.ApprovalResponseFailure.make({
          kind: "unavailable",
          message: "Runtime shutdown has closed execution admission",
        }),
      ),
    watchTurn: (link, cursor) => rawBackend.watchTurn(link, cursor),
    inspectTurn: (link) => rawBackend.inspectTurn(link),
  })
  return { acquiredBackend, closeAdmissions }
})
