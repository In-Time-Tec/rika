import { ModeId } from "./behavior-mode"
import { Schema } from "effect"
import type { ModelRoute } from "./model-route"
import type { ConfigurationSettings } from "../settings/model"
import { resolveModelRoute } from "./model-route-resolution"

export interface ModeRouteLabel {
  readonly name: string
  readonly effort: string
  readonly fast: boolean
}

export interface ModeRouteLabels {
  readonly [mode: ModeId]: { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }
}

interface MutableModeRouteLabels {
  [mode: ModeId]: { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }
}

const routeLabel = (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role): ModeRouteLabel => {
  const configured = (Object.hasOwn(settings.modes, mode) ? settings.modes[mode] : undefined)?.[role]
  if (configured === undefined) return { name: mode, effort: "", fast: false }
  try {
    const route = resolveModelRoute(settings, mode, role)
    return { name: route.displayName, effort: route.effort, fast: route.fast }
  } catch {
    return {
      name:
        "alias" in configured
          ? ((Object.hasOwn(settings.models, configured.alias) ? settings.models[configured.alias] : undefined)
              ?.displayName ?? configured.alias)
          : configured.model,
      effort: configured.effort,
      fast: configured.fast === true,
    }
  }
}

export const modeRouteLabels = (settings: ConfigurationSettings): ModeRouteLabels => {
  const labels: MutableModeRouteLabels = {}
  for (const mode of Schema.decodeSync(Schema.Array(ModeId))(Object.keys(settings.modes)))
    labels[mode] = { main: routeLabel(settings, mode, "main"), oracle: routeLabel(settings, mode, "oracle") }
  return labels
}
