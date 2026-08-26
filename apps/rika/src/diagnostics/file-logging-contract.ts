import { Schema } from "effect"

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

export const isFailureKind = (value: string): value is FailureKind => failureKindSet.has(value)

export const failure = (kind: FailureKind) => ({ "rika.failure.kind": kind })

type FailureValue = Error | { readonly _tag: string } | string | number | boolean | bigint | symbol | null | undefined

const TaggedFailure = Schema.Struct({ _tag: Schema.String })

export const failureFrom = (value: FailureValue) => {
  let candidate: string
  if (value instanceof Error) candidate = value.name
  else if (Schema.is(TaggedFailure)(value)) candidate = value._tag
  else if (Schema.is(Schema.String)(value)) candidate = "string"
  else if (Schema.is(Schema.Finite)(value)) candidate = "number"
  else if (Schema.is(Schema.Boolean)(value)) candidate = "boolean"
  else if (Schema.is(Schema.Undefined)(value)) candidate = "undefined"
  else if (Schema.is(Schema.Symbol)(value)) candidate = "symbol"
  else candidate = "object"
  return isFailureKind(candidate) ? failure(candidate) : {}
}
