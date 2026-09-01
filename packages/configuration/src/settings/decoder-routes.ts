import { supportedEfforts } from "../model-routing/model-catalog"
import { isBoolean, isObject, isProviderId, isString, type Decoded, type UnknownObject } from "./decoder-schema"
import { DecoderValidation } from "./decoder-validation"

const { exactKeys } = DecoderValidation
const fail: (path: string, message: string) => never = DecoderValidation.fail

const validateRouteIdentity = (path: string, owner: string, route: UnknownObject) => {
  const hasAlias = route.alias !== undefined
  const hasModel = route.model !== undefined
  if (hasAlias === hasModel) fail(path, `${owner} must set exactly one of alias or model`)
  if (hasAlias && (!isString(route.alias) || route.alias.length === 0)) fail(path, `${owner} alias must be non-empty`)
  if (hasModel && (!isString(route.model) || route.model.length === 0)) fail(path, `${owner} model must be non-empty`)
  if (hasAlias && route.provider !== undefined) fail(path, `${owner} alias route cannot set provider`)
  if (hasModel && !isProviderId(route.provider)) fail(path, `${owner} direct route must set a known provider`)
}

const validateRoleRoute = (path: string, owner: string, input: Decoded) => {
  if (!isObject(input)) fail(path, `${owner} must be a route object`)
  exactKeys(path, owner, input, ["alias", "model", "provider", "effort", "fast"])
  validateRouteIdentity(path, owner, input)
  if (input.effort !== undefined && !supportedEfforts.some((effort) => effort === input.effort))
    fail(path, `${owner} effort must be one of ${supportedEfforts.join(", ")}`)
  if (input.fast !== undefined && !isBoolean(input.fast)) fail(path, `${owner} fast must be true or false`)
}

const validateAgents = (path: string, mode: string, agents: Decoded) => {
  if (agents === undefined) return
  if (!isObject(agents)) fail(path, `Mode ${mode} agents must be an object`)
  exactKeys(path, `Mode ${mode} agents`, agents, ["librarian", "painter", "review", "surgeon", "task"])
  for (const [agent, route] of Object.entries(agents)) validateRoleRoute(path, `Mode ${mode} agent ${agent}`, route)
}

const validateMode = (path: string, mode: string, configured: Decoded) => {
  if (mode.length === 0 || !isObject(configured)) fail(path, "Mode names must be non-empty and map to objects")
  exactKeys(path, `Mode ${mode}`, configured, ["main", "oracle", "agents"])
  if (configured.main !== undefined) validateRoleRoute(path, `Mode ${mode} main`, configured.main)
  if (configured.oracle !== undefined) validateRoleRoute(path, `Mode ${mode} oracle`, configured.oracle)
  validateAgents(path, mode, configured.agents)
}

const validateModes = (path: string, modes: Decoded) => {
  if (modes === undefined) return
  if (!isObject(modes)) fail(path, "Modes must be an object")
  if (Object.keys(modes).length === 0) fail(path, "Modes must not be empty")
  for (const [mode, configured] of Object.entries(modes)) validateMode(path, mode, configured)
}

const validateLeafRoutes = (path: string, routes: Decoded) => {
  if (routes === undefined) return
  if (!isObject(routes)) fail(path, "Model routes must be an object")
  exactKeys(path, "Model routes", routes, ["title", "compaction"])
  if (routes.title !== undefined) validateRoleRoute(path, "Model route title", routes.title)
  if (routes.compaction !== undefined) validateRoleRoute(path, "Model route compaction", routes.compaction)
}

const validateRoutes = (path: string, value: UnknownObject) => {
  if (value.defaultMode !== undefined && (!isString(value.defaultMode) || value.defaultMode.length === 0))
    fail(path, "Default mode must be a non-empty string")
  validateModes(path, value.modes)
  validateLeafRoutes(path, value.modelRoutes)
}

export const RouteDecoder = { validate: validateRoutes }
