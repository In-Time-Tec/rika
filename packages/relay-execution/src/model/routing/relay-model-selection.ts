import { ModelRegistry } from "@batonfx/core"
import { Function } from "effect"
import { AgentProfile } from "@rika/product/execution-child-run"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { agentKeyForName, names as agentProfileNames } from "../../agent/definition/agent-names"

export const relayModelSelection = (selection: ModelRegistry.ModelSelection) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

export const modelVariantKey: { (fast: boolean): (effort: string) => string; (effort: string, fast: boolean): string } =
  Function.dual(2, (effort: string, fast: boolean) => `effort:${effort}${fast ? ":fast" : ""}`)

export const variantSelection = (input: {
  readonly selection: ModelRegistry.ModelSelection
  readonly effort: string | undefined
  readonly fast: boolean
  readonly policy: "registration-key" | "fixed-selection"
}) =>
  input.policy === "fixed-selection" || (input.effort === undefined && !input.fast)
    ? input.selection
    : { ...input.selection, registrationKey: modelVariantKey(input.effort ?? "medium", input.fast) }

export const pinnedSelection = (route: ExecutionRoutePin["main"]): ModelRegistry.ModelSelection => ({
  provider: route.providerConnection.provider,
  model: route.model,
  registrationKey: route.registrationIdentity,
})

export const routeForProfile = (input: { readonly pin: ExecutionRoutePin; readonly profile: AgentProfile }) => {
  const key = agentKeyForName(input.profile)
  const configured = key === undefined ? undefined : input.pin.agents?.[key]
  return configured ?? (input.profile === "Task" || input.profile === "Surgeon" ? input.pin.main : input.pin.oracle)
}

export const usesMainRoute = (profile: AgentProfile) => profile === "Task" || profile === "Surgeon"

export const agentSelections = (pin: ExecutionRoutePin) =>
  pin.agents === undefined
    ? undefined
    : (Object.fromEntries(
        agentProfileNames.map((name) => [name, pinnedSelection(routeForProfile({ pin, profile: name }))]),
      ) as Partial<Readonly<Record<AgentProfile, ModelRegistry.ModelSelection>>>)
