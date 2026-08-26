import { Context, Effect, Layer, Schema } from "effect"
import { Cell } from "tenetkit/repl"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ReplayPolicy = Schema.Literals(["pure", "provider-idempotent", "never"])

export const Request = Schema.Struct({
  operationKey: NonEmptyString,
  workspaceId: NonEmptyString,
  sessionId: NonEmptyString,
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  runId: NonEmptyString,
  rootRunId: NonEmptyString,
  toolCallId: NonEmptyString,
  code: Schema.String,
  attempt: NonNegativeInt,
  replayPolicy: ReplayPolicy,
  admittedAt: Schema.NullOr(NonEmptyString),
  deadlineAt: NonEmptyString,
})

export type Request = typeof Request.Type

export type CancellationRequest = Omit<Request, "admittedAt" | "deadlineAt">

export const InfrastructureFailure = Schema.Struct({
  kind: Schema.Literals(["unknown", "timeout", "cancelled", "execution", "fenced", "workspace"]),
  message: Schema.String,
})

export type InfrastructureFailure = typeof InfrastructureFailure.Type

export type Response =
  | { readonly _tag: "Success"; readonly result: Cell.CellResult }
  | { readonly _tag: "DomainFailure"; readonly failure: Cell.CellFailure | InfrastructureFailure }
  | { readonly _tag: "Suspend"; readonly token: string }

export type EncodedResponse =
  | { readonly _tag: "Success"; readonly result: typeof Cell.CellResult.Encoded }
  | {
      readonly _tag: "DomainFailure"
      readonly failure: typeof Cell.CellFailure.Encoded | InfrastructureFailure
    }
  | { readonly _tag: "Suspend"; readonly token: string }

export type TransportResponse =
  | { readonly _tag: "Success"; readonly result: Schema.Json }
  | { readonly _tag: "DomainFailure"; readonly failure: Schema.Json }
  | { readonly _tag: "Suspend"; readonly token: string }

export const Response: Schema.Codec<Response, EncodedResponse> = Schema.Union([
  Schema.TaggedStruct("Success", { result: Cell.CellResult }),
  Schema.TaggedStruct("DomainFailure", { failure: Schema.Union([Cell.CellFailure, InfrastructureFailure]) }),
  Schema.TaggedStruct("Suspend", { token: Schema.String }),
])

export class Unavailable extends Schema.TaggedError<Unavailable>()("@rika/execution/remote-cells/Unavailable", {
  message: Schema.String,
}) {}

export class UnknownOutcome extends Schema.TaggedError<UnknownOutcome>()(
  "@rika/execution/remote-cells/UnknownOutcome",
  { message: Schema.String },
) {}

export class AdmissionFailure extends Schema.TaggedError<AdmissionFailure>()(
  "@rika/execution/remote-cells/AdmissionFailure",
  { message: Schema.String },
) {}

export interface Interface {
  readonly execute: (
    request: Request,
    authority: Context.Context<ExecutorRuntime.CapturedServices>,
  ) => Effect.Effect<TransportResponse, Unavailable | UnknownOutcome>
  readonly cancel: (request: CancellationRequest) => Effect.Effect<TransportResponse, Unavailable | UnknownOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@rika/execution/remote-cells/Service") {}

export const layer = (service: Interface): Layer.Layer<Service> => Layer.succeed(Service, Service.of(service))
