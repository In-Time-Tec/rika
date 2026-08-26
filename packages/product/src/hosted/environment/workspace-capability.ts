import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
const Argument = Schema.String.check(Schema.isMaxLength(4_096))
const MaximumFileBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_048_576))

export const WorkspaceFileInspect = Schema.TaggedStruct("WorkspaceFileInspect", {
  requestId: Identifier,
  path: Path,
  maximumBytes: MaximumFileBytes,
})
export type WorkspaceFileInspect = typeof WorkspaceFileInspect.Type

export const WorkspaceFileContent = Schema.TaggedStruct("WorkspaceFileContent", {
  requestId: Identifier,
  path: Path,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentBase64: Schema.String,
})
export type WorkspaceFileContent = typeof WorkspaceFileContent.Type

export const WorkspaceFileRejected = Schema.TaggedStruct("WorkspaceFileRejected", {
  requestId: Identifier,
  path: Path,
  reason: Schema.Literals(["invalid", "not-found", "not-file", "too-large", "unavailable"]),
  message: Schema.String,
})
export type WorkspaceFileRejected = typeof WorkspaceFileRejected.Type

export const WorkspaceFileInspection = Schema.Union([WorkspaceFileContent, WorkspaceFileRejected])
export type WorkspaceFileInspection = typeof WorkspaceFileInspection.Type

export const RepositoryService = Schema.Struct({
  serviceId: Identifier,
  command: Identifier,
  args: Schema.Array(Argument).check(Schema.isMaxLength(128)),
  cwd: Path,
})
export type RepositoryService = typeof RepositoryService.Type

export const RepositoryServiceEnsure = Schema.TaggedStruct("RepositoryServiceEnsure", {
  requestId: Identifier,
  service: RepositoryService,
})
export type RepositoryServiceEnsure = typeof RepositoryServiceEnsure.Type

export const RepositoryServiceStop = Schema.TaggedStruct("RepositoryServiceStop", {
  requestId: Identifier,
  serviceId: Identifier,
})
export type RepositoryServiceStop = typeof RepositoryServiceStop.Type

export const RepositoryServiceRunning = Schema.TaggedStruct("RepositoryServiceRunning", {
  requestId: Identifier,
  serviceId: Identifier,
})
export type RepositoryServiceRunning = typeof RepositoryServiceRunning.Type

export const RepositoryServiceStopped = Schema.TaggedStruct("RepositoryServiceStopped", {
  requestId: Identifier,
  serviceId: Identifier,
})
export type RepositoryServiceStopped = typeof RepositoryServiceStopped.Type

export const RepositoryServiceRejected = Schema.TaggedStruct("RepositoryServiceRejected", {
  requestId: Identifier,
  serviceId: Identifier,
  reason: Schema.Literals(["conflict", "invalid", "missing", "unavailable"]),
  message: Schema.String,
})
export type RepositoryServiceRejected = typeof RepositoryServiceRejected.Type

export const RepositoryServiceResult = Schema.Union([
  RepositoryServiceRunning,
  RepositoryServiceStopped,
  RepositoryServiceRejected,
])
export type RepositoryServiceResult = typeof RepositoryServiceResult.Type

export const WorkspaceRequest = Schema.Union([WorkspaceFileInspect, RepositoryServiceEnsure, RepositoryServiceStop])
export type WorkspaceRequest = typeof WorkspaceRequest.Type

export const WorkspaceResponse = Schema.Union([WorkspaceFileInspection, RepositoryServiceResult])
export type WorkspaceResponse = typeof WorkspaceResponse.Type
