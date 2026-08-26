import { Predicate, Schema } from "effect"

export const modelBackendKinds = ["provider", "test-script", "test-response"] as const

export type ModelBackendKind = (typeof modelBackendKinds)[number]

export const modelBackend = (kind: ModelBackendKind) => ({ "rika.model.backend.kind": kind })

export const failureKinds = [
  "@rika/product/ExtensionOperationError",
  "@rika/extensions/McpConfigError",
  "@rika/extensions/McpDiagnostic",
  "@rika/extensions/McpOAuthError",
  "@rika/extensions/PluginContractError",
  "@rika/extensions/PluginDigestError",
  "@rika/extensions/PluginLoadError",
  "ArchivedThreadError",
  "BedrockAuthRefreshFailure",
  "ConfigurationSettingsFileError",
  "ConfigOperationsAdapterError",
  "Error",
  "StartTurnFailure",
  "CancelTurnFailure",
  "SteeringFailure",
  "WatchTurnFailure",
  "InspectTurnFailure",
  "ExternalBoundaryError",
  "FixtureProcessError",
  "InvalidInput",
  "LocalPathError",
  "MediaAnalysisError",
  "MediaMissingError",
  "MediaOversizedError",
  "ModelConfigurationError",
  "ModelProviderRuntimeError",
  "ModelRouteError",
  "MultiAgentProcessFixtureError",
  "OpenAiAuthError",
  "OpenAiCredentialStoreError",
  "OperationError",
  "OperationUnavailable",
  "ProductDatabaseError",
  "ProjectionRecoveryFailure",
  "PromoteTurnError",
  "PromptAttachmentError",
  "QueuedTurnStartFailure",
  "QueuedTurnUnavailable",
  "RangeError",
  "ReadWebPageContentError",
  "ReadWebPageHttpError",
  "RecoveryProcessFixtureError",
  "ServerReplacementStatusFailure",
  "ServerServiceError",
  "ReleaseUpdateError",
  "StaleQueuedTurns",
  "ThreadAdmissionRejected",
  "ThreadForkFailure",
  "ThreadInvocationConflict",
  "ThreadNotFoundError",
  "ThreadQueryError",
  "ThreadRepositoryError",
  "ThreadSearchRepositoryError",
  "ThreadSummaryRepairFailure",
  "ThreadSummaryRepositoryError",
  "ThreadToolError",
  "TokenExpiredError",
  "ToolError",
  "TranscriptRefoldStale",
  "TranscriptRepositoryError",
  "TuiAdapterError",
  "TurnQueueFull",
  "TurnRepositoryError",
  "TypeError",
  "UnsupportedMediaError",
  "WebSearchExecutionError",
  "WebSearchProviderFailure",
  "WebSearchSelectionError",
  "WorkspaceFileError",
  "WorkspaceIndexError",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
] as const

export type FailureKind = (typeof failureKinds)[number]

const failureKindSet: ReadonlySet<string> = new Set(failureKinds)
const TaggedFailure = Schema.Struct({ _tag: Schema.String })

export const isFailureKind = <Value>(value: Value): value is Value & FailureKind =>
  Schema.is(Schema.String)(value) && failureKindSet.has(value)

export const failure = (kind: FailureKind) => ({ "rika.failure.kind": kind })

export const failureFrom = <Value>(value: Value) => {
  let candidate: string
  if (value instanceof Error) candidate = value.name
  else if (Schema.is(TaggedFailure)(value)) candidate = value._tag
  else if (Schema.is(Schema.String)(value)) candidate = "string"
  else if (Predicate.isNumber(value)) candidate = "number"
  else if (Schema.is(Schema.Boolean)(value)) candidate = "boolean"
  else if (Predicate.isSymbol(value)) candidate = "symbol"
  else if (Schema.is(Schema.Undefined)(value)) candidate = "undefined"
  else if (Predicate.isFunction(value)) candidate = "function"
  else candidate = "object"
  return isFailureKind(candidate) ? failure(candidate) : {}
}
