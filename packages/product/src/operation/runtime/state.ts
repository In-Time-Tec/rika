import { Effect } from "effect"
import {
  buildProductOperationExecutionState,
  type ProductOperationExecutionState,
  type ProductOperationExecutionStateInput,
} from "./execution-state"
import { queueMutationEvent } from "./support"
import {
  makeProductOperationInteractiveSession,
  type ProductOperationInteractiveSessionFactory,
} from "./session"

export type ProductOperationRuntimeState = ProductOperationExecutionState & {
  readonly makeInteractiveSession: ProductOperationInteractiveSessionFactory
}

export const makeProductOperationRuntimeState = (
  input: ProductOperationExecutionStateInput,
): Effect.Effect<ProductOperationRuntimeState, Error, never> =>
  Effect.gen(function* () {
    const runtime = yield* buildProductOperationExecutionState({ ...input, queueMutationEvent })
    const makeInteractiveSession = makeProductOperationInteractiveSession({ ...input, ...runtime })
    return { ...runtime, makeInteractiveSession }
  })
