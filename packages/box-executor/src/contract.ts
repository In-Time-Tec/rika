import {
  AssignmentIdentity,
  ExecutorBuildId,
  ExecutorGeneration,
  ExecutorProtocolVersion,
  HandshakeEvidence,
  OrbPlacement,
  WorkspaceIdentity,
} from "@rika/execution"
import { Schema } from "effect"

export const boxIdPattern = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/
export const snapshotIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const idempotencyWindowMillis = 86_400_000
export const maxProviderTtlSeconds = 2_592_000
export const maxRikaTtlSeconds = 86_400

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const EpochMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(9_007_199_254_740_991),
)
const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(9_007_199_254_740_991),
)

export const BoxId = Schema.String.check(Schema.isPattern(boxIdPattern)).pipe(Schema.brand("RikaBoxV2BoxId"))
export type BoxId = typeof BoxId.Type

export const SnapshotId = Schema.String.check(Schema.isPattern(snapshotIdPattern)).pipe(
  Schema.brand("RikaBoxV2SnapshotId"),
)
export type SnapshotId = typeof SnapshotId.Type

export const IdempotencyKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).pipe(
  Schema.brand("RikaBoxV2IdempotencyKey"),
)
export type IdempotencyKey = typeof IdempotencyKey.Type

export const TtlSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maxProviderTtlSeconds),
).pipe(Schema.brand("RikaBoxV2TtlSeconds"))
export type TtlSeconds = typeof TtlSeconds.Type

export const RikaTtlSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maxRikaTtlSeconds),
).pipe(Schema.brand("RikaBoxV2BoundedTtlSeconds"))
export type RikaTtlSeconds = typeof RikaTtlSeconds.Type

export const MachineType = Schema.Literals(["small", "default", "large", "xlarge"])
export type MachineType = typeof MachineType.Type

export const BoxState = Schema.Literals([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
])
export type BoxState = typeof BoxState.Type

export const SetupStatus = Schema.NullOr(Schema.Literals(["pending", "running", "done", "failed"]))
export type SetupStatus = typeof SetupStatus.Type

export const Box = Schema.Struct({
  id: BoxId,
  state: BoxState,
  snapshotAvailable: Schema.Boolean,
  snapshotCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  archiveAfter: Schema.optionalKey(Schema.NullOr(Schema.String)),
  setupStatus: Schema.optionalKey(SetupStatus),
  environment: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type Box = typeof Box.Type

export const SnapshotReference = Schema.Struct({
  id: SnapshotId,
  boxId: BoxId,
  generation: Schema.NullOr(NonNegativeInt),
  completedAt: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(NonNegativeInt),
  fileCount: Schema.NullOr(NonNegativeInt),
})
export type SnapshotReference = typeof SnapshotReference.Type

export const TemplatePin = Schema.Struct({
  sourceBoxId: BoxId,
  snapshotId: SnapshotId,
})
export type TemplatePin = typeof TemplatePin.Type

const StringRecord = Schema.Record(Schema.String, Schema.String)
export const EmptyEnvironment = StringRecord.check(Schema.isMaxProperties(0))
export type EmptyEnvironment = typeof EmptyEnvironment.Type

export const SafeCreateBody = Schema.Struct({
  from: Identifier,
  noEnv: Schema.Literal(true),
  env: EmptyEnvironment,
  ttlSeconds: RikaTtlSeconds,
  type: Schema.optionalKey(MachineType),
})
export type SafeCreateBody = typeof SafeCreateBody.Type

export const SafeForkBody = Schema.Struct({
  noEnv: Schema.Literal(true),
  env: EmptyEnvironment,
  ttlSeconds: RikaTtlSeconds,
  type: Schema.optionalKey(MachineType),
})
export type SafeForkBody = typeof SafeForkBody.Type

export const SafeResumeBody = Schema.Struct({
  noEnv: Schema.Literal(true),
  env: EmptyEnvironment,
  ttlSeconds: RikaTtlSeconds,
  type: Schema.optionalKey(MachineType),
})
export type SafeResumeBody = typeof SafeResumeBody.Type

export const SafeStopBody = Schema.Struct({ force: Schema.Literal(false) })
export type SafeStopBody = typeof SafeStopBody.Type

const BillableIdentity = {
  idempotencyKey: IdempotencyKey,
  issuedAtMillis: EpochMillis,
  expiresAtMillis: EpochMillis,
}

export const CreateRequest = Schema.Struct({
  ...BillableIdentity,
  body: SafeCreateBody,
})
export type CreateRequest = typeof CreateRequest.Type

export const ForkRequest = Schema.Struct({
  ...BillableIdentity,
  sourceBoxId: BoxId,
  body: SafeForkBody,
})
export type ForkRequest = typeof ForkRequest.Type

export const ResumeRequest = Schema.Struct({
  boxId: BoxId,
  body: SafeResumeBody,
})
export type ResumeRequest = typeof ResumeRequest.Type

export const StopRequest = Schema.Struct({
  boxId: BoxId,
  body: SafeStopBody,
})
export type StopRequest = typeof StopRequest.Type

export const OrbWorkspaceBinding = Schema.Struct({
  workspaceId: WorkspaceIdentity,
  assignmentId: AssignmentIdentity,
  generation: ExecutorGeneration,
  placement: OrbPlacement,
  buildId: ExecutorBuildId,
  protocolVersion: ExecutorProtocolVersion,
})
export type OrbWorkspaceBinding = typeof OrbWorkspaceBinding.Type

export const WorkspaceSnapshot = Schema.Struct({
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
  snapshot: SnapshotReference,
})
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type

export const PrepareIntent = Schema.TaggedStruct("Prepare", {
  intentId: Identifier,
  acceptedInputId: Identifier,
  template: TemplatePin,
  binding: OrbWorkspaceBinding,
  request: ForkRequest,
})
export type PrepareIntent = typeof PrepareIntent.Type

export const StopIntent = Schema.TaggedStruct("Stop", {
  intentId: Identifier,
  checkpointIntentId: Identifier,
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
  request: StopRequest,
})
export type StopIntent = typeof StopIntent.Type

export const ResumeIntent = Schema.TaggedStruct("Resume", {
  intentId: Identifier,
  source: WorkspaceSnapshot,
  binding: OrbWorkspaceBinding,
  request: ResumeRequest,
})
export type ResumeIntent = typeof ResumeIntent.Type

export const ForkIntent = Schema.TaggedStruct("Fork", {
  intentId: Identifier,
  source: WorkspaceSnapshot,
  binding: OrbWorkspaceBinding,
  request: ForkRequest,
})
export type ForkIntent = typeof ForkIntent.Type

export const WorkspaceLifecycleIntent = Schema.Union([PrepareIntent, StopIntent, ResumeIntent, ForkIntent])
export type WorkspaceLifecycleIntent = typeof WorkspaceLifecycleIntent.Type

export const ReadyWorkspace = Schema.TaggedStruct("Ready", {
  lifecycle: Schema.Literals(["prepared", "resumed", "forked"]),
  intentId: Identifier,
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
  evidence: HandshakeEvidence,
})
export type ReadyWorkspace = typeof ReadyWorkspace.Type

export const StoppedWorkspace = Schema.TaggedStruct("Stopped", {
  intentId: Identifier,
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
  snapshot: SnapshotReference,
})
export type StoppedWorkspace = typeof StoppedWorkspace.Type

export const WorkspaceLifecycleOutcome = Schema.Union([ReadyWorkspace, StoppedWorkspace])
export type WorkspaceLifecycleOutcome = typeof WorkspaceLifecycleOutcome.Type

export const LifecyclePolicy = Schema.Struct({
  template: TemplatePin,
  ttlSeconds: RikaTtlSeconds,
  readinessAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(120)),
  readinessDelayMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(30_000)),
})
export type LifecyclePolicy = typeof LifecyclePolicy.Type

export class WorkspaceLifecycleError extends Schema.TaggedError<WorkspaceLifecycleError>()(
  "RikaBoxV2WorkspaceLifecycleError",
  {
    operation: Schema.Literals(["prepare", "stop", "resume", "fork"]),
    kind: Schema.Literals([
      "invalid-intent",
      "durability-unavailable",
      "provider",
      "provider-outcome-unknown",
      "reconciliation-required",
      "template-mismatch",
      "snapshot-mismatch",
      "not-ready",
      "enrollment",
      "checkpoint",
      "fenced",
    ]),
    message: Schema.String,
  },
) {}
