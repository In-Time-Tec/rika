import type { ExecutionRouteSnapshot } from "./execution-route-snapshot"
import type { Event } from "./execution-event"
import type { PromptPart } from "./execution-request"
import type { Status } from "./execution-status"
import type { ReviewIntent } from "./review-intent"
import {
  CancelTurnFailure,
  InspectTurnFailure,
  StartTurnFailure,
  SteeringFailure,
  WatchTurnFailure,
} from "./execution-gateway-failure"
import { Context, Effect, Layer, Schema, Stream } from "effect"

export * from "./execution-gateway-failure"

export const ExecutionLink = Schema.Struct({
  runId: Schema.String,
  turnId: Schema.String,
  threadId: Schema.String,
})
export type ExecutionLink = typeof ExecutionLink.Type

export interface StartTurn {
  readonly threadId: string
  readonly turnId: string
  readonly workspace: string
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRouteSnapshot
  readonly titleIntent?: { readonly _tag: "GenerateThreadTitle"; readonly expectedTitle: string }
  readonly reviewIntent?: ReviewIntent
}

export interface Interface {
  readonly startTurn: (input: StartTurn) => Effect.Effect<ExecutionLink, StartTurnFailure>
  readonly cancelTurn: (link: ExecutionLink, reason?: string) => Effect.Effect<void, CancelTurnFailure>
  readonly steerTurn: (
    link: ExecutionLink,
    input: { readonly text: string; readonly idempotencyKey: string },
  ) => Effect.Effect<void, SteeringFailure>
  readonly watchTurn: (link: ExecutionLink, cursor?: string) => Stream.Stream<Event, WatchTurnFailure>
  readonly inspectTurn: (
    link: ExecutionLink,
  ) => Effect.Effect<{ readonly status: Status | "unavailable"; readonly cursor?: string }, InspectTurnFailure>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/execution/contract/execution-gateway/Service",
) {}

export const layerTest = (overrides: Partial<Interface> = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      startTurn: (input) =>
        Effect.succeed({ runId: "opaque-test-run", turnId: input.turnId, threadId: input.threadId }),
      cancelTurn: () => Effect.void,
      steerTurn: () => Effect.void,
      watchTurn: () => Stream.empty,
      inspectTurn: () => Effect.succeed({ status: "unavailable" }),
      ...overrides,
    }),
  )
