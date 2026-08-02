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
  "AgentToolError",
  "ArchivedThreadError",
  "BedrockAuthRefreshFailure",
  "ConfigFileError",
  "ConfigOperationsAdapterError",
  "Error",
  "ExecutionBackendError",
  "ExecutionIngestFailure",
  "ExecutionIngestFollowFailure",
  "ExecutionIngestProjectionWatchOverflow",
  "ExecutionInspectionFailure",
  "ExecutionRecoveryAbandonmentFailure",
  "ExecutionStopCancelFailure",
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
  "ParallelSearchError",
  "ProductAgentInvocationError",
  "ProductDatabaseError",
  "ProductWorkflowError",
  "ProjectionRecoveryFailure",
  "PromoteTurnError",
  "PromptAttachmentError",
  "QueuedTurnStartFailure",
  "QueuedTurnUnavailable",
  "RangeError",
  "ReadWebPageContentError",
  "ReadWebPageHttpError",
  "RecoveryProcessFixtureError",
  "RecoveredRootCancelFailure",
  "ResidentAbandonmentCancelFailure",
  "ResidentReplacementStatusFailure",
  "ResidentServiceError",
  "ReleaseUpdateError",
  "StaleQueuedTurns",
  "ThreadAdmissionRejected",
  "ThreadForkFailure",
  "ThreadInteractionQueueFull",
  "ThreadInteractionRepositoryError",
  "ThreadInvocationConflict",
  "ThreadNotFoundError",
  "ThreadQueryError",
  "ThreadRepositoryError",
  "ThreadResultNotReady",
  "ThreadSearchRepositoryError",
  "ThreadSummaryRepairFailure",
  "ThreadSummaryRepositoryError",
  "ThreadToolError",
  "ThreadToolGatewayUnavailable",
  "TokenExpiredError",
  "ToolError",
  "TranscriptRefoldStale",
  "TranscriptRepositoryError",
  "TuiAdapterError",
  "TurnQueueFull",
  "TurnRepositoryError",
  "TypeError",
  "UnsupportedMediaError",
  "UsageProjectionFailure",
  "UsageRepositoryError",
  "WebSearchExecutionError",
  "WebSearchProviderFailure",
  "WebSearchSelectionError",
  "WorkspaceFileError",
  "WorkflowProcessFixtureError",
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

export const isFailureKind = (value: unknown): value is FailureKind =>
  typeof value === "string" && failureKindSet.has(value)

export const failure = (kind: FailureKind) => ({ "rika.failure.kind": kind })

export const failureFrom = (value: unknown) => {
  let candidate: string
  if (value instanceof Error) candidate = value.name
  else if (value !== null && typeof value === "object" && "_tag" in value && typeof value._tag === "string")
    candidate = value._tag
  else candidate = typeof value
  return isFailureKind(candidate) ? failure(candidate) : {}
}
