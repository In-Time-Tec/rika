import type { Redacted } from "effect"
export interface ProviderOptions {
  readonly apiKey?: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly priority?: number
}
