import { Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { ModelRegistry, Pins } from "generalist"
import { makeContextMaterializer, type SessionAuthorizationService } from "@rika/context"
import { ExecutorTransportError, WorkspaceBinding, type WorkspaceExecutorService } from "@rika/execution"
import { tools } from "@rika/execution/tools"
import type { ApiV2ContextComposition } from "../../src/runtime/host"

export const workspaceBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: "assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace", checkoutFingerprint: "checkout" },
  buildId: "build",
  protocolVersion: 1,
})

export const unavailableWorkspace = (binding: WorkspaceBinding): WorkspaceExecutorService => {
  const unavailable = Effect.fail(
    ExecutorTransportError.make({ phase: "before-dispatch", message: "This fixture has no Executor" }),
  )
  return {
    binding,
    handshake: () => unavailable,
    dispatch: () => unavailable,
    receipt: () => unavailable,
    cancel: () => unavailable,
  }
}

export const threadContext = (
  binding: WorkspaceBinding,
  sessionId: string,
  model: Layer.Layer<LanguageModel.LanguageModel>,
  authorization?: SessionAuthorizationService,
) =>
  Effect.gen(function* () {
    const materializer = makeContextMaterializer({
      readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "Use the selected fixture workspace." }]),
      listSkills: () => Effect.succeed([]),
    })
    const selection = { provider: "test", model: "hosted-fixture" }
    const materialization = yield* materializer.discover({
      binding,
      sessionId,
      guidanceScope: `${sessionId}/workspace`,
      capturedAt: "2026-09-09T12:00:00.000Z",
      model: { selection, settings: {}, credentialRefs: [] },
      tools: tools.map((tool) => ({
        name: tool.name,
        pin: Pins.makeCapability({ fixture: "native", name: tool.name }),
      })),
    })
    return {
      materialization,
      authorization: authorization ?? {
        current: () =>
          Effect.succeed({
            allowedTools: tools.map((tool) => tool.name),
            allowedModels: [materialization.modelPin],
            allowedCredentials: [],
          }),
      },
      modelRegistry: ModelRegistry.layer([ModelRegistry.registration({ ...selection, layer: model })]),
    } satisfies ApiV2ContextComposition
  })
