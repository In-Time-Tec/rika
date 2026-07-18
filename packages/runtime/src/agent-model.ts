import type { ModelRegistry } from "@batonfx/core"
import { Function } from "effect"
import type { ExecutionModelRoute, ExecutionRoutePin } from "./execution-contract"

const routes = (pin: ExecutionRoutePin): ReadonlyArray<ExecutionModelRoute> => [
  pin.main,
  pin.oracle,
  ...(pin.title === undefined ? [] : [pin.title]),
  ...(pin.compactionSummary === undefined ? [] : [pin.compactionSummary]),
  ...(pin.agents === undefined
    ? []
    : [pin.agents.librarian, pin.agents.painter, pin.agents.review, pin.agents.readThread, pin.agents.task]),
]

const selection = (route: ExecutionModelRoute): ModelRegistry.ModelSelection => ({
  provider: route.provider,
  model: route.model,
  registrationKey: route.registrationKey,
})

type ResolvedSpawnModel = {
  readonly selection: ModelRegistry.ModelSelection
  readonly effort: string
}

const efforts = ["low", "medium", "high", "xhigh", "max"]

const nearestRoute = (
  candidates: ReadonlyArray<ExecutionModelRoute>,
  effort: string,
): ExecutionModelRoute | undefined => {
  const exact = candidates.find((route) => route.effort === effort)
  if (exact !== undefined) return exact
  const targetRank = efforts.indexOf(effort)
  if (targetRank < 0) return candidates[0]
  return (
    candidates.reduce<ExecutionModelRoute | undefined>((nearest, candidate) => {
      const candidateRank = efforts.indexOf(candidate.effort)
      if (candidateRank < 0) return nearest
      if (nearest === undefined) return candidate
      const nearestRank = efforts.indexOf(nearest.effort)
      if (nearestRank < 0) return candidate
      const distance = Math.abs(candidateRank - targetRank)
      const nearestDistance = Math.abs(nearestRank - targetRank)
      return distance < nearestDistance || (distance === nearestDistance && candidateRank < nearestRank)
        ? candidate
        : nearest
    }, undefined) ?? candidates[0]
  )
}

const resolveSpawnModelImpl = (
  pin: ExecutionRoutePin,
  parent: ModelRegistry.ModelSelection,
  requested: string | undefined,
): ResolvedSpawnModel | undefined => {
  const available = routes(pin)
  const parentRoute = available.find(
    (route) =>
      route.provider === parent.provider &&
      route.model === parent.model &&
      route.registrationKey === parent.registrationKey,
  )
  const effort = parentRoute?.effort ?? pin.main.effort
  if (requested === undefined) return { selection: parent, effort }
  const candidates = available.filter((route) => route.model === requested)
  const resolved = nearestRoute(candidates, effort)
  return resolved === undefined ? undefined : { selection: selection(resolved), effort: resolved.effort }
}

export const resolveSpawnModel: {
  (
    parent: ModelRegistry.ModelSelection,
    requested: string | undefined,
  ): (pin: ExecutionRoutePin) => ResolvedSpawnModel | undefined
  (
    pin: ExecutionRoutePin,
    parent: ModelRegistry.ModelSelection,
    requested: string | undefined,
  ): ResolvedSpawnModel | undefined
} = Function.dual(3, resolveSpawnModelImpl)
