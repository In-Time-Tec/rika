import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
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
  }) =>
  (
    mode: "low" | "medium" | "high" | "ultra",
    tuning: { readonly fastMode?: boolean } | undefined,
    workspace: string,
  ) =>
    input.testModel === undefined
      ? input.effectiveConfigForWorkspace(workspace).pipe(
          Effect.flatMap((configuration) =>
            Effect.try({
              try: () => ExecutionRouteResolution.resolve(configuration.settings, mode, tuning),
              catch: (cause) =>
                ServerAuth.OperationProductError.make({
                  message: `Could not resolve execution route: ${String(cause)}`,
                }),
            }),
          ),
        )
      : Effect.succeed(ExecutionRouteSnapshot.testExecutionRoute(mode))

import * as ContextFileSystem from "@rika/product/context-file-system"
import * as ResolvedContext from "@rika/product/context-resolution-service"
import * as BunServices from "@effect/platform-bun/BunServices"

export const resolvedContextLayer = (workspaceGlob: typeof import("./server-configuration-adapter").workspaceGlob) =>
  ResolvedContext.layer(workspaceGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
