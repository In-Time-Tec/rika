import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"

const ModeRouteSchema = Schema.Struct({
  name: Schema.String,
  effort: Schema.String,
  fast: Schema.Boolean,
  contextWindow: Schema.Finite,
  reserveTokens: Schema.Finite,
})
const ModeRouteMapSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ main: ModeRouteSchema, oracle: ModeRouteSchema }),
)
export type ModeRoute = typeof ModeRouteSchema.Type
export type ModeRouteMap = typeof ModeRouteMapSchema.Type
const modeRoute = (route: ModelRouteResolution.ResolvedModelRoute) =>
  ({
    name: route.displayName,
    effort: route.effort,
    fast: route.fast,
    contextWindow: route.compaction.contextWindow,
    reserveTokens: route.compaction.reserveTokens,
  }) satisfies ModeRoute
export const defaultModeRouteMap: ModeRouteMap = Object.fromEntries(
  Object.keys(SettingsDefaults.Defaults.defaults.modes).map((mode) => [
    mode,
    {
      main: modeRoute(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "main")),
      oracle: modeRoute(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "oracle")),
    },
  ]),
)
export const modeRouteMapSchema = ModeRouteMapSchema
export const modeId = ModeId
