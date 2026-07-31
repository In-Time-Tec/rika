import { Effect } from "effect"
import type { Capability } from "./web-search-input-contract"
import type { SearchInput } from "./web-search-request-contract"
import type { ProviderFailure, ProviderOutcome } from "./web-search-result-contract"
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
