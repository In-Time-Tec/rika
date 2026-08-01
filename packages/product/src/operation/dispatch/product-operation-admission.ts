import * as ExecutionBackend from "@rika/product/execution-service"
import * as Turn from "@rika/product/turn-record"
import { Effect, Ref } from "effect"

export const makeProductOperationAdmission = (input: any) => {
  const { rawBackend, replacementAdmission, replacementState, activeWorkflows, workflowReplacementKey } = input
  const withExecutionAdmission = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ExecutionBackend.BackendError, R> =>
    Effect.acquireUseRelease(
      replacementAdmission.withPermits(1)(
        Ref.modify(replacementState, (state: { closed: boolean; active: number }) =>
          state.closed ? [false, state] : [true, { ...state, active: state.active + 1 }],
        ),
      ),
      (admitted): Effect.Effect<A, E | ExecutionBackend.BackendError, R> =>
        admitted === true
          ? effect
          : Effect.fail(
              ExecutionBackend.BackendError.make({ message: "Resident replacement has closed execution admission" }),
            ),
      (admitted) =>
        admitted === true
          ? Ref.update(replacementState, (state: { closed: boolean; active: number }) => ({
              ...state,
              active: Math.max(0, state.active - 1),
            }))
          : Effect.void,
    )
  const acquiredBackend = ExecutionBackend.Service.of({
    ...rawBackend,
    start: (backendInput: Parameters<typeof rawBackend.start>[0]) =>
      withExecutionAdmission(rawBackend.start(backendInput)),
    ...(rawBackend.follow === undefined
      ? {}
      : {
          follow: (
            turnId: Turn.TurnId,
            afterCursor: string | undefined,
            onEvent: any,
            reference: any,
            eventScope: any,
          ) => rawBackend.follow!(turnId, afterCursor, onEvent, reference, eventScope),
        }),
    cancel: (turnId: Turn.TurnId, reference?: any) => withExecutionAdmission(rawBackend.cancel(turnId, reference)),
    invokeChild: (backendInput: Parameters<typeof rawBackend.invokeChild>[0]) =>
      withExecutionAdmission(rawBackend.invokeChild(backendInput)),
    createFanOut: (backendInput: Parameters<typeof rawBackend.createFanOut>[0]) =>
      withExecutionAdmission(rawBackend.createFanOut(backendInput)),
    startWorkflow: (name: string, runId: string, revision: number, ownerTurnId?: string, workspace?: string) =>
      withExecutionAdmission(
        rawBackend.startWorkflow(name, runId, revision, ownerTurnId, workspace).pipe(
          Effect.tap((inspection: any) =>
            Effect.sync(() => {
              const key = workflowReplacementKey(runId, ownerTurnId, workspace)
              if (inspection.status === "running")
                activeWorkflows.set(key, {
                  runId,
                  ...(ownerTurnId === undefined ? {} : { ownerTurnId }),
                  ...(workspace === undefined ? {} : { workspace }),
                })
              else activeWorkflows.delete(key)
            }),
          ),
        ),
      ),
  })
  return { withExecutionAdmission, acquiredBackend }
}
