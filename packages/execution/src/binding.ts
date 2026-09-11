/* oxlint-disable effecttsgo/missing-pipeable-signature -- equality guards intentionally accept both complete records. */
import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const BuildIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(9_007_199_254_740_991))
const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1024))

export const WorkspaceIdentity = Identifier.pipe(Schema.brand("RikaExecutionV2WorkspaceIdentity"))
export type WorkspaceIdentity = typeof WorkspaceIdentity.Type

export const AssignmentIdentity = Identifier.pipe(Schema.brand("RikaExecutionV2AssignmentIdentity"))
export type AssignmentIdentity = typeof AssignmentIdentity.Type

export const ExecutorGeneration = Generation.pipe(Schema.brand("RikaExecutionV2ExecutorGeneration"))
export type ExecutorGeneration = typeof ExecutorGeneration.Type

export const ExecutorBuildId = BuildIdentifier.pipe(Schema.brand("RikaExecutionV2ExecutorBuildId"))
export type ExecutorBuildId = typeof ExecutorBuildId.Type

export const ExecutorProtocolVersion = ProtocolVersion.pipe(Schema.brand("RikaExecutionV2ExecutorProtocolVersion"))
export type ExecutorProtocolVersion = typeof ExecutorProtocolVersion.Type

export const RunnerPlacement = Schema.TaggedStruct("Runner", {
  checkoutFingerprint: Identifier,
  workspaceId: WorkspaceIdentity,
})
export type RunnerPlacement = typeof RunnerPlacement.Type

export const OrbPlacement = Schema.TaggedStruct("Orb", {
  workspaceId: WorkspaceIdentity,
  lineageId: Identifier,
})
export type OrbPlacement = typeof OrbPlacement.Type

/** The placement chosen when the Thread is created. It is never inferred during dispatch. */
export const WorkspacePlacement = Schema.Union([RunnerPlacement, OrbPlacement])
export type WorkspacePlacement = typeof WorkspacePlacement.Type

/** Immutable binding admitted before a native operation can reach an Executor. */
export const WorkspaceBinding = Schema.Struct({
  workspaceId: WorkspaceIdentity,
  assignmentId: AssignmentIdentity,
  generation: ExecutorGeneration,
  placement: WorkspacePlacement,
  buildId: ExecutorBuildId,
  protocolVersion: ExecutorProtocolVersion,
})
export type WorkspaceBinding = typeof WorkspaceBinding.Type

export const WorkspaceBindingEvidence = Schema.Struct({
  workspaceId: WorkspaceIdentity,
  assignmentId: AssignmentIdentity,
  generation: ExecutorGeneration,
  placement: WorkspacePlacement,
  buildId: ExecutorBuildId,
  protocolVersion: ExecutorProtocolVersion,
})
export type WorkspaceBindingEvidence = typeof WorkspaceBindingEvidence.Type

export const BindingMismatchReason = Schema.Literals([
  "workspace",
  "assignment",
  "generation",
  "placement",
  "build",
  "protocol",
])
export type BindingMismatchReason = typeof BindingMismatchReason.Type

const placementEqual = (left: WorkspacePlacement, right: WorkspacePlacement): boolean =>
  left._tag === right._tag &&
  (left._tag === "Runner"
    ? right._tag === "Runner" &&
      left.workspaceId === right.workspaceId &&
      left.checkoutFingerprint === right.checkoutFingerprint
    : right._tag === "Orb" && left.workspaceId === right.workspaceId && left.lineageId === right.lineageId)

const placementMatchesWorkspace = (binding: WorkspaceBinding): boolean =>
  binding.workspaceId === binding.placement.workspaceId

export const sameWorkspacePolicy = (left: WorkspaceBinding, right: WorkspaceBinding): boolean =>
  placementMatchesWorkspace(left) &&
  placementMatchesWorkspace(right) &&
  left.workspaceId === right.workspaceId &&
  left.buildId === right.buildId &&
  left.protocolVersion === right.protocolVersion &&
  placementEqual(left.placement, right.placement)

/** Compare every immutable field used by the dispatch fence. */
export const sameBinding = (left: WorkspaceBinding, right: WorkspaceBinding): boolean =>
  sameWorkspacePolicy(left, right) && left.assignmentId === right.assignmentId && left.generation === right.generation

/** Compare executor handshake evidence with the binding admitted by Generalist. */
export const sameEvidence = (binding: WorkspaceBinding, evidence: WorkspaceBindingEvidence): boolean =>
  binding.workspaceId === evidence.workspaceId &&
  binding.assignmentId === evidence.assignmentId &&
  binding.generation === evidence.generation &&
  placementEqual(binding.placement, evidence.placement) &&
  binding.buildId === evidence.buildId &&
  binding.protocolVersion === evidence.protocolVersion

export const bindingMismatchReason = (
  binding: WorkspaceBinding,
  evidence: WorkspaceBindingEvidence,
): BindingMismatchReason | undefined => {
  if (binding.workspaceId !== evidence.workspaceId) return "workspace"
  if (binding.assignmentId !== evidence.assignmentId) return "assignment"
  if (binding.generation !== evidence.generation) return "generation"
  if (!placementEqual(binding.placement, evidence.placement)) return "placement"
  if (binding.buildId !== evidence.buildId) return "build"
  if (binding.protocolVersion !== evidence.protocolVersion) return "protocol"
  return undefined
}

export const toEvidence = (binding: WorkspaceBinding): WorkspaceBindingEvidence => ({
  workspaceId: binding.workspaceId,
  assignmentId: binding.assignmentId,
  generation: binding.generation,
  placement: binding.placement,
  buildId: binding.buildId,
  protocolVersion: binding.protocolVersion,
})

export const Binding = {
  AssignmentIdentity,
  ExecutorBuildId,
  ExecutorGeneration,
  ExecutorProtocolVersion,
  OrbPlacement,
  RunnerPlacement,
  WorkspaceBinding,
  WorkspaceBindingEvidence,
  WorkspaceIdentity,
  WorkspacePlacement,
  bindingMismatchReason,
  sameBinding,
  sameEvidence,
  sameWorkspacePolicy,
  toEvidence,
}
