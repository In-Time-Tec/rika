import type { Unit } from "@rika/transcript/transcript-unit"
import { Checkpoint, type Change } from "./execution-projection"
import type { Status } from "./execution-status"
import type { ModelPreviewEvent } from "./model-preview"
import { AuthorizationResponse, ExecutionLink, StartTurn } from "./execution-gateway-request"
import { SteeringInput, SteeringReceipt } from "./execution-steering"
import {
  ApprovalResponseFailure,
  CancelTurnFailure,
  InspectTurnFailure,
  StartTurnFailure,
  SteeringFailure,
  WatchTurnFailure,
} from "./execution-gateway-failure"
import { Context, Effect, Layer, Stream } from "effect"

export * from "./execution-gateway-failure"
export * from "./execution-gateway-request"
export * from "./execution-steering"
export * from "./model-preview"

export type WatchEvent = Change | ModelPreviewEvent

export interface Interface {
  readonly startTurn: (input: StartTurn) => Effect.Effect<ExecutionLink, StartTurnFailure>
  readonly cancelTurn: (link: ExecutionLink, reason: string) => Effect.Effect<void, CancelTurnFailure>
  readonly steerTurn: (link: ExecutionLink, input: SteeringInput) => Effect.Effect<SteeringReceipt, SteeringFailure>
  readonly approveTurn: (
    link: ExecutionLink,
    input: AuthorizationResponse,
  ) => Effect.Effect<void, ApprovalResponseFailure>
  readonly denyTurn: (link: ExecutionLink, input: AuthorizationResponse) => Effect.Effect<void, ApprovalResponseFailure>
  readonly watchTurn: (
    link: ExecutionLink,
    input?: {
      readonly prompt?: string
      readonly checkpoint?: Checkpoint
      readonly units?: ReadonlyArray<Unit>
      readonly pricing?: "included" | "metered"
    },
  ) => Stream.Stream<WatchEvent, WatchTurnFailure>
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
      steerTurn: () => Effect.succeed({ entryId: "test-steering", sequence: 0 }),
      approveTurn: () => Effect.void,
      denyTurn: () => Effect.void,
      watchTurn: () => Stream.empty,
      inspectTurn: () => Effect.succeed({ status: "unavailable" }),
      ...overrides,
    }),
  )
