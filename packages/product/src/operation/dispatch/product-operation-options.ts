import { OperationUnavailable } from "../contract/product-operation"

export interface ProductLayerOptions<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
> {
  readonly repositoryLayer: import("effect").Layer.Layer<import("@rika/product/thread-repository").Service, ThreadError>
  readonly turnRepositoryLayer: import("effect").Layer.Layer<import("@rika/product/turn-repository").Service, TurnError>
  readonly threadSummaryRepositoryLayer?: import("effect").Layer.Layer<
    import("@rika/product/thread-summary-repository").Service,
    ThreadSummaryError
  >
  readonly transcriptRepositoryLayer?: import("effect").Layer.Layer<
    import("@rika/product/transcript-repository").Service,
    TranscriptError
  >
  readonly backendLayer: import("effect").Layer.Layer<import("@rika/product/execution-gateway").Service, BackendError>
  readonly executionSessionLifecycleLayer: import("effect").Layer.Layer<
    import("@rika/product/execution-session-lifecycle").Service,
    BackendError
  >
  readonly resolveExecutionRoute?: (
    mode?: import("@rika/configuration/behavior-mode").ModeId,
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => import("effect").Effect.Effect<
    import("@rika/product/execution-route-snapshot").ExecutionRouteSnapshot,
    import("../operation-error").OperationError,
    import("@rika/product/execution-gateway").Service
  >
  readonly toolRuntimeLayer?: (
    workspace: string,
  ) => import("effect").Layer.Layer<
    import("@rika/coding-tools/coding-tool-runtime").Service,
    import("../operation-error").OperationError,
    never
  >
  readonly resolvedContextLayer?: import("effect").Layer.Layer<
    import("../../context/context-resolution-service").Service,
    import("../operation-error").OperationError
  >
  readonly executionExtensions?: {
    readonly layer: import("effect").Layer.Layer<
      import("@rika/extensions/execution-extension-service").ExecutionExtensionService,
      import("../operation-error").OperationError
    >
    readonly mcpFingerprint: import("effect").Effect.Effect<string, never, never>
  }
  /**
   * The durable Goal a Thread pursues across Turns. Absent in hosts that do not persist goals, in
   * which case no goal is ever published and the indicator stays hidden.
   */
  readonly goals?: import("@rika/product/goal-service").Interface
  readonly defaultWorkspace: string
  readonly recoveredWorkGrace?: import("effect").Duration.Input
  readonly pendingTurnCapacity?: number
  readonly makeThreadId: import("effect").Effect.Effect<import("@rika/product/thread-record").ThreadId, never, never>
  readonly makeTurnId: import("effect").Effect.Effect<import("@rika/product/turn-record").TurnId, never, never>
  readonly configOperations?: import("./product-operation-integrations").ProductConfigOperations
  readonly extensionOperations?: import("./product-operation-integrations").ProductExtensionOperations
  readonly authOperations?: import("./authentication-operation-dispatch").AuthOperationOptions
  readonly interactive?: (
    input: Extract<import("../contract/product-operation").Input, { readonly _tag: "Interactive" }>,
    session: import("../interactive/session").InteractiveSession,
  ) => import("effect").Effect.Effect<void, OperationUnavailable, never>
}
