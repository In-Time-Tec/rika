import type { ModeId } from "./behavior-mode"
import type { ModelRoute } from "./model-route"
import type { ConfigurationSettings } from "../settings/configuration-settings"
import { resolveModelRoute } from "./model-route-resolution"

export interface ModeRouteLabel {
  readonly name: string
  readonly effort: string
  readonly fast: boolean
}

const routeLabel = (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role): ModeRouteLabel => {
  const configured = settings.modes[mode][role]
  try {
    const route = resolveModelRoute(settings, mode, role)
    return { name: route.displayName, effort: route.effort, fast: route.fast }
  } catch {
    return {
      name: settings.models[configured.alias]?.displayName ?? configured.alias,
      effort: configured.effort,
      fast: configured.fast === true,
    }
  }
}

export const modeRouteLabels = (
  settings: ConfigurationSettings,
): Readonly<Record<ModeId, { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }>> =>
  Object.fromEntries(
    (Object.keys(settings.modes) as ReadonlyArray<ModeId>).map((mode) => [
      mode,
      { main: routeLabel(settings, mode, "main"), oracle: routeLabel(settings, mode, "oracle") },
    ]),
  ) as Readonly<Record<ModeId, { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }>>
