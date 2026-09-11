import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { NestedOperation, ToolExecutor, ToolPlacement } from "generalist"
import { ToolIdentity } from "generalist/host"

import { WorkspaceLifecycleError, WorkspaceLifecycleIntent, WorkspaceLifecycleOutcome } from "./contract"
import { BoxWorkspaceLifecycle, type BoxWorkspaceLifecycleService } from "./lifecycle"

export const WorkspaceLifecycleToolFailure = Schema.Union([
  WorkspaceLifecycleError,
  NestedOperation.Divergence,
  NestedOperation.Unknown,
  NestedOperation.Denied,
  NestedOperation.Suspended,
])

export const boxWorkspaceLifecycleTool = Tool.make("box_workspace_lifecycle", {
  description: "Apply one already-accepted canonical Orb workspace lifecycle intent.",
  parameters: WorkspaceLifecycleIntent,
  success: WorkspaceLifecycleOutcome,
  failure: WorkspaceLifecycleToolFailure,
  failureMode: "return",
}).annotate(ToolIdentity, { implementation: "box-executor-v2", policy: "orb-lifecycle-v2" })

const frameworkFailure = (stage: "decode-input" | "encode-success" | "encode-domain-failure") =>
  ToolExecutor.FrameworkFailure.make({
    stage,
    tool: boxWorkspaceLifecycleTool.name,
    message: `Box lifecycle ${stage} failed`,
  })

const execute = (lifecycle: BoxWorkspaceLifecycleService) => (request: ToolExecutor.Request) =>
  Schema.decodeUnknownEffect(WorkspaceLifecycleIntent)(request.call.params).pipe(
    Effect.mapError(() => frameworkFailure("decode-input")),
    Effect.flatMap((intent) => Effect.result(lifecycle.execute(intent))),
    Effect.flatMap((result): Effect.Effect<ToolExecutor.Outcome, ToolExecutor.FrameworkFailure> => {
      if (result._tag === "Success")
        return Schema.encodeEffect(WorkspaceLifecycleOutcome)(result.success).pipe(
          Effect.map((encodedResult) => ({ _tag: "Success" as const, result: result.success, encodedResult })),
          Effect.mapError(() => frameworkFailure("encode-success")),
        )
      if (Schema.is(NestedOperation.Suspended)(result.failure))
        return Effect.succeed({ _tag: "Suspend", token: result.failure.token })
      return Schema.encodeEffect(WorkspaceLifecycleToolFailure)(result.failure).pipe(
        Effect.map((encodedFailure) => ({
          _tag: "DomainFailure" as const,
          failure: result.failure,
          encodedFailure,
        })),
        Effect.mapError(() => frameworkFailure("encode-domain-failure")),
      )
    }),
  )

export const boxWorkspaceLifecycleRoute: Effect.Effect<
  ToolPlacement.Route<never>,
  never,
  BoxWorkspaceLifecycle
> = Effect.map(BoxWorkspaceLifecycle, (lifecycle) =>
  ToolExecutor.route<never>({
    tools: [boxWorkspaceLifecycleTool.name],
    matches: (request) => request.call.name === boxWorkspaceLifecycleTool.name,
    replayPolicy: () => "provider-idempotent",
    execute: execute(lifecycle),
  }),
)

export const boxWorkspaceLifecycleExecutorLayer: Layer.Layer<ToolExecutor.ToolExecutor, never, BoxWorkspaceLifecycle> =
  Layer.effect(
    ToolExecutor.ToolExecutor,
    Effect.map(BoxWorkspaceLifecycle, (lifecycle) =>
      ToolExecutor.ToolExecutor.of({
        replayPolicy: (request) =>
          request.call.name === boxWorkspaceLifecycleTool.name ? "provider-idempotent" : "never",
        execute: (request) =>
          request.call.name === boxWorkspaceLifecycleTool.name
            ? execute(lifecycle)(request)
            : Effect.fail(
                ToolExecutor.FrameworkFailure.make({
                  stage: "route",
                  tool: request.call.name,
                  message: "Box lifecycle ToolExecutor received an unmatched tool",
                }),
              ),
      }),
    ),
  )

export const boxWorkspaceLifecycleToolkit = Toolkit.make(boxWorkspaceLifecycleTool)

export const boxWorkspaceLifecycleRegistrationLayer = boxWorkspaceLifecycleToolkit.toLayer({
  box_workspace_lifecycle: () => Effect.die("Box lifecycle bypassed its durable ToolExecutor route"),
})

export const boxWorkspaceLifecycleToolLayer = Layer.merge(
  boxWorkspaceLifecycleExecutorLayer,
  boxWorkspaceLifecycleRegistrationLayer,
)
