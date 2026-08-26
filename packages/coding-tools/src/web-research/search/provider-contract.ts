import { Effect } from "effect"
import type { Capability } from "./input"
import type { SearchInput } from "./request"
import type { ProviderFailure, ProviderOutcome } from "./result"
export interface SearchRequest extends SearchInput {
  readonly kind: Capability
  readonly strategy: "auto" | "compare"
}
export interface SearchProvider {
  readonly id: string
  readonly capabilities: ReadonlySet<Capability>
  readonly priority: number
  readonly search: (
    request: SearchRequest,
  ) => Effect.Effect<Omit<ProviderOutcome, "provider" | "error">, ProviderFailure>
}
