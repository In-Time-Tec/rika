import { Effect } from "effect"
import { buildProductOperationExecutionState } from "./product-operation-runtime-execution-state"
import { queueMutationEvent } from "./product-operation-runtime-support"
import { makeProductOperationInteractiveSession } from "./product-operation-runtime-session"

export const makeProductOperationRuntimeState = (input: any): Effect.Effect<any, Error, never> =>
  Effect.gen(function* () {
    const runtime = yield* buildProductOperationExecutionState({ ...input, queueMutationEvent })
    const makeInteractiveSession = makeProductOperationInteractiveSession({ ...input, ...runtime })
    return { ...runtime, makeInteractiveSession }
  })
