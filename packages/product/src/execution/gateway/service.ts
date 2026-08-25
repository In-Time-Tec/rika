import type { Unit } from "@rika/transcript/transcript-unit"
import { Checkpoint, type Change } from "../projection/contract"
import type { ActivationStatus, Status } from "../session/status"
import type { ModelPreviewEvent } from "../model/preview"
import { AuthorizationResponse, ExecutionLink, PreparedTurn, StartTurn } from "./request"
import { SteeringInput, SteeringReceipt } from "../session/steering"
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
} from "./failure"
import { Context, Effect, Layer, Stream } from "effect"

export * from "./failure"
export * from "./request"
export * from "../session/steering"
export * from "../model/preview"

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
  "@rika/product/execution/gateway/service",
) {}

export const makeTest = (overrides: Partial<Interface> = {}): Interface =>
  Service.of({
    startTurn: (input) => Effect.succeed({ runId: "opaque-test-run", turnId: input.turnId, threadId: input.threadId }),
    prepareTurn: (input) => {
      const prepared: PreparedTurn = {
        threadId: input.threadId,
        turnId: input.turnId,
        runId: input.turnId,
        rootAdmissionJson: "{}",
      }
      return Effect.succeed(
        input.reviewIntent === undefined ? prepared : { ...prepared, reviewIntent: input.reviewIntent },
      )
    },
    admitTurn: (input) => {
      const link: ExecutionLink = {
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
      }
      return Effect.succeed(input.titleRunId === undefined ? link : { ...link, titleRunId: input.titleRunId })
    },
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
