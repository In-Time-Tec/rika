import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"

const ModeRouteLabelSchema = Schema.Struct({ name: Schema.String, effort: Schema.String, fast: Schema.Boolean })
const ModeRouteMapSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ main: ModeRouteLabelSchema, oracle: ModeRouteLabelSchema }),
)
export type ModeRouteLabel = typeof ModeRouteLabelSchema.Type
export type ModeRouteMap = typeof ModeRouteMapSchema.Type
const modeLabel = (route: { readonly displayName: string; readonly effort: string; readonly fast: boolean }) =>
  ({ name: route.displayName, effort: route.effort, fast: route.fast }) satisfies ModeRouteLabel
export const defaultModeRouteMap: ModeRouteMap = Object.fromEntries(
  Object.keys(SettingsDefaults.Defaults.defaults.modes).map((mode) => [
    mode,
    {
      main: modeLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "main")),
      oracle: modeLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "oracle")),
    },
  ]),
)
export const modeRouteMapSchema = ModeRouteMapSchema
export const modeId = ModeId
