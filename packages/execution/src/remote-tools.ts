import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import { Context, Effect, Layer, Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ReplayPolicy = Schema.Literals(["pure", "provider-idempotent", "never"])

/** One durably fenced native tool operation sent to a Runner or Orb. */
export const Request = Schema.Struct({
  operationKey: NonEmptyString,
  workspaceId: NonEmptyString,
  sessionId: NonEmptyString,
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  runId: NonEmptyString,
  rootRunId: NonEmptyString,
  toolCallId: NonEmptyString,
  toolName: NonEmptyString,
  request: NativeToolRuntime.Request,
  attempt: NonNegativeInt,
  replayPolicy: ReplayPolicy,
  admittedAt: Schema.NullOr(NonEmptyString),
  deadlineAt: NonEmptyString,
})
export type Request = typeof Request.Type

export type CancellationRequest = Omit<Request, "admittedAt" | "deadlineAt">

/** The native tool placement response transported without provider-specific wrapping. */
export const Response = Schema.Union([
  Schema.TaggedStruct("Success", { result: Schema.Json }),
  Schema.TaggedStruct("DomainFailure", { failure: Schema.Json }),
  Schema.TaggedStruct("Suspend", { token: Schema.String }),
])
export type Response = typeof Response.Type

export const TerminalResponse = Schema.Union([
  Schema.TaggedStruct("Success", { result: Schema.Json }),
  Schema.TaggedStruct("DomainFailure", { failure: Schema.Json }),
])
export type TerminalResponse = typeof TerminalResponse.Type

export const CancellationResponse = Schema.Union([
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("AlreadyTerminal", { response: TerminalResponse }),
])
export type CancellationResponse = typeof CancellationResponse.Type

/**
 * The Executor could not take the operation. `retryable` marks transient causes (Executor still connecting or a
 * transport hiccup) that Generalist's idempotent remote route may retry under the same operation key.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("@rika/execution/remote-tools/Unavailable", {
  message: Schema.String,
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class UnknownOutcome extends Schema.TaggedError<UnknownOutcome>()(
  "@rika/execution/remote-tools/UnknownOutcome",
  { message: Schema.String },
) {}

export class AdmissionFailure extends Schema.TaggedError<AdmissionFailure>()(
  "@rika/execution/remote-tools/AdmissionFailure",
  { message: Schema.String },
) {}

export interface Interface {
  readonly execute: (request: Request) => Effect.Effect<Response, Unavailable | UnknownOutcome>
  readonly cancel: (request: CancellationRequest) => Effect.Effect<CancellationResponse, Unavailable | UnknownOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@rika/execution/remote-tools/Service") {}

export const layer = (service: Interface): Layer.Layer<Service> => Layer.succeed(Service, Service.of(service))
