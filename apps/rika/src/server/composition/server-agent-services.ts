import { Catalog as CodingToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import type * as ConfigurationSettings from "@rika/configuration/configuration-settings"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolAction from "@rika/product/thread-tool-action"
import { Effect, Layer } from "effect"
import { defaultWorkspaceToolRuntimeLayer } from "./server-runtime-tools"

export const makeAgentServices =
  <E>(options: {
    readonly effectiveConfigForWorkspace: (
      workspace: string,
    ) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, E, never>
    readonly queryFactory: Layer.Layer<ThreadQuery.Factory, never, never>
  }) =>
  (workspace: string) => {
    const runtime = defaultWorkspaceToolRuntimeLayer(workspace, options.effectiveConfigForWorkspace)
    return Layer.mergeAll(
      CodingToolCatalog.handlerLayer.pipe(Layer.provide(runtime)),
      ThreadToolAction.handlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactory)),
      ThreadToolAction.findHandlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactory)),
    )
  }
