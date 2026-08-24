import { Redacted } from "effect"
import { configuredReadPageCredential, providerRegistry } from "./provider"
export const providerAvailability = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => ({
  search: providerRegistry.some((provider) => credentials[provider.id] !== undefined),
  readPage: configuredReadPageCredential(credentials) !== undefined,
})
