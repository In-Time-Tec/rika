import type { RunEvent, RunTree, Runtime } from "@batonfx/runtime"
import { Effect, Function } from "effect"

type ModelResponseEvent = Extract<
  RunEvent.RunEvent,
  { readonly _tag: "ModelResponseCommitted" | "ModelResponseInterrupted" }
>

export type SemanticModelResponseEvent = ModelResponseEvent & {
  readonly response: RunEvent.CompletedModelResponse
}

type SemanticRunEvent =
  | Exclude<RunEvent.RunEvent, ModelResponseEvent | { readonly part: unknown }>
  | SemanticModelResponseEvent

export type SemanticTreeEvent = Omit<RunTree.TreeEvent, "event"> & {
  readonly event: SemanticRunEvent
}

type ResolveModelResponse = Runtime.Interface["resolveModelResponse"]

export const resolveSemanticTreeEvent: {
  (
    input: RunTree.TreeEvent,
    resolveModelResponse: ResolveModelResponse,
  ): Effect.Effect<SemanticTreeEvent, Runtime.ResolveModelResponseError>
  (
    resolveModelResponse: ResolveModelResponse,
  ): (input: RunTree.TreeEvent) => Effect.Effect<SemanticTreeEvent, Runtime.ResolveModelResponseError>
} = Function.dual(2, (input: RunTree.TreeEvent, resolveModelResponse: ResolveModelResponse) => {
  const event = input.event
  return event._tag === "ModelResponseCommitted" || event._tag === "ModelResponseInterrupted"
    ? resolveModelResponse(event).pipe(
        Effect.map((response) => ({ ...input, event: { ...event, response } }) as SemanticTreeEvent),
      )
    : Effect.succeed(input as SemanticTreeEvent)
})
