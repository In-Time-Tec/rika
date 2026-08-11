import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import * as Settings from "@rika/configuration/configuration-settings"
import { Effect, Layer } from "effect"
import * as ServerAuth from "./server-auth-layer"

export interface TestModel {
  readonly script?: string
  readonly response?: string
}

/**
 * The execution route one workspace resolves to. A scripted test model names its own route, because
 * a scripted run must not depend on whatever the user's settings happen to select.
 */
export const workspaceExecutionRoute =
  (input: {
    readonly testModel: TestModel | undefined
    readonly effectiveConfigForWorkspace: (
      workspace: string,
    ) => Effect.Effect<
      { readonly settings: Parameters<typeof ExecutionRouteResolution.resolve>[0] },
      ServerAuth.OperationProductError
    >
    readonly openAiAccountStatus?: Effect.Effect<OpenAiAuthContract.Status, { readonly message: string }>
  }) =>
  (
    mode: "low" | "medium" | "high" | "ultra",
    tuning: { readonly fastMode?: boolean } | undefined,
    workspace: string,
  ) => {
    if (input.testModel !== undefined) return Effect.succeed(ExecutionRouteSnapshot.testExecutionRoute(mode))
    return Effect.gen(function* () {
      const configuration = yield* input.effectiveConfigForWorkspace(workspace)
      const resolve = (openAiAccountFingerprint?: string) =>
        Effect.try({
          try: () =>
            ExecutionRouteResolution.resolve(
              configuration.settings,
              mode,
              tuning,
              openAiAccountFingerprint === undefined ? undefined : { openAiAccountFingerprint },
            ),
          catch: (cause) =>
            ServerAuth.OperationProductError.make({
              message: `Could not resolve execution route: ${String(cause)}`,
            }),
        })
      const unresolved = yield* resolve()
      const models = [
        unresolved.main,
        unresolved.oracle,
        unresolved.title,
        unresolved.compactionSummary,
        ...Object.values(unresolved.agents),
      ]
      const usesNativeOpenAi = models.some((model) =>
        model.candidates.some(
          (candidate) =>
            candidate.providerConnection.provider === "openai" &&
            candidate.providerConnection.protocol === "openai" &&
            candidate.providerConnection.baseUrl === Settings.Defaults.providerDefaults.openai.baseUrl,
        ),
      )
      if (!usesNativeOpenAi || input.openAiAccountStatus === undefined) return unresolved
      const status = yield* input.openAiAccountStatus.pipe(
        Effect.mapError((error) =>
          ServerAuth.OperationProductError.make({
            message: `OpenAI account credentials could not be read: ${error.message}`,
          }),
        ),
      )
      if (status._tag === "Unauthenticated") return unresolved
      if (status._tag === "Corrupt")
        return yield* ServerAuth.OperationProductError.make({
          message: "OpenAI account credentials are corrupt; log out, then log in again",
        })
      return yield* resolve(status.fingerprint)
    })
  }

import * as ContextFileSystem from "@rika/product/context-file-system"
import * as ResolvedContext from "@rika/product/context-resolution-service"
import * as BunServices from "@effect/platform-bun/BunServices"

export const resolvedContextLayer = (workspaceGlob: typeof import("./server-configuration-adapter").workspaceGlob) =>
  ResolvedContext.layer(workspaceGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
