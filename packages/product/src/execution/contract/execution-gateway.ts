import type { Unit } from "@rika/transcript/transcript-unit"
import { Checkpoint, type Change } from "./execution-projection"
import type { ActivationStatus, Status } from "./execution-status"
import type { ModelPreviewEvent } from "./model-preview"
import { AuthorizationResponse, ExecutionLink, PreparedTurn, StartTurn } from "./execution-gateway-request"
import { SteeringInput, SteeringReceipt } from "./execution-steering"
import {
  ApprovalResponseFailure,
  ActivateTurnFailure,
  AdmitTurnFailure,
  CancelTurnFailure,
  InspectTurnFailure,
  PrepareTurnFailure,
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
  readonly prepareTurn: (input: StartTurn) => Effect.Effect<PreparedTurn, PrepareTurnFailure>
  readonly admitTurn: (input: PreparedTurn) => Effect.Effect<ExecutionLink, AdmitTurnFailure>
  readonly activateTurn: (
    input: PreparedTurn,
    link: ExecutionLink,
  ) => Effect.Effect<ActivationStatus, ActivateTurnFailure>
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
  ) => Effect.Effect<
    { readonly status: "unavailable" } | { readonly status: Status; readonly cursor: string },
    InspectTurnFailure
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/execution/contract/execution-gateway/Service",
) {}

export const makeTest = (overrides: Partial<Interface> = {}): Interface =>
  Service.of({
    startTurn: (input) => Effect.succeed({ runId: "opaque-test-run", turnId: input.turnId, threadId: input.threadId }),
    prepareTurn: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: input.turnId,
        runId: input.turnId,
        rootAdmissionJson: "{}",
        ...(input.reviewIntent === undefined ? {} : { reviewIntent: input.reviewIntent }),
      }),
    admitTurn: (input) =>
      Effect.succeed({
        runId: input.runId,
        ...(input.titleRunId === undefined ? {} : { titleRunId: input.titleRunId }),
        turnId: input.turnId,
        threadId: input.threadId,
      }),
    activateTurn: () => Effect.succeed("running"),
    cancelTurn: () => Effect.void,
    steerTurn: () => Effect.succeed({ entryId: "test-steering", sequence: 0 }),
    approveTurn: () => Effect.void,
    denyTurn: () => Effect.void,
    watchTurn: () => Stream.empty,
    inspectTurn: () => Effect.succeed({ status: "unavailable" }),
    ...overrides,
  })

export const layerTest = (overrides: Partial<Interface> = {}) => Layer.succeed(Service, makeTest(overrides))
