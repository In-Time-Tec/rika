import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Ref, Semaphore } from "effect"

export interface ProductOperationAdmissionInput {
  readonly rawBackend: ExecutionGateway.Interface
  readonly replacementAdmission: Semaphore.Semaphore
  readonly replacementState: Ref.Ref<{ readonly closed: boolean; readonly active: number }>
}

export const makeProductOperationAdmission = (input: ProductOperationAdmissionInput) => {
  const { rawBackend, replacementAdmission, replacementState } = input
  const withExecutionAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>, closed: E): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      replacementAdmission.withPermits(1)(
        Ref.modify(replacementState, (state) =>
          state.closed ? [false, state] : [true, { ...state, active: state.active + 1 }],
        ),
      ),
      (admitted): Effect.Effect<A, E, R> => (admitted === true ? effect : Effect.fail(closed)),
      (admitted) =>
        admitted === true
          ? Ref.update(replacementState, (state: { closed: boolean; active: number }) => ({
              ...state,
              active: Math.max(0, state.active - 1),
            }))
          : Effect.void,
    )
  const acquiredBackend = ExecutionGateway.Service.of({
    startTurn: (backendInput) =>
      withExecutionAdmission(
        rawBackend.startTurn(backendInput),
        ExecutionGateway.StartTurnFailure.make({ message: "Server replacement has closed execution admission" }),
      ),
    cancelTurn: (link, reason) =>
      withExecutionAdmission(
        rawBackend.cancelTurn(link, reason),
        ExecutionGateway.CancelTurnFailure.make({ message: "Server replacement has closed execution admission" }),
      ),
    steerTurn: (link, steering) =>
      withExecutionAdmission(
        rawBackend.steerTurn(link, steering),
        ExecutionGateway.SteeringFailure.make({ message: "Server replacement has closed execution admission" }),
      ),
    approveTurn: (link, approval) =>
      withExecutionAdmission(
        rawBackend.approveTurn(link, approval),
        ExecutionGateway.ApprovalResponseFailure.make({
          kind: "unavailable",
          message: "Server replacement has closed execution admission",
        }),
      ),
    denyTurn: (link, approval) =>
      withExecutionAdmission(
        rawBackend.denyTurn(link, approval),
        ExecutionGateway.ApprovalResponseFailure.make({
          kind: "unavailable",
          message: "Server replacement has closed execution admission",
        }),
      ),
    watchTurn: (link, cursor) => rawBackend.watchTurn(link, cursor),
    inspectTurn: (link) => rawBackend.inspectTurn(link),
  })
  return { withExecutionAdmission, acquiredBackend }
}
