import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

const emptyProviderCatalog = (): NormalizedProviderListResponse => ({ all: new Map(), connected: [], default: {} })

const openRouterCatalog = (catalog: NormalizedProviderListResponse): NormalizedProviderListResponse => {
  const provider = catalog.all.get("openrouter")
  if (!provider) return emptyProviderCatalog()
  const model = catalog.default.openrouter
  return {
    all: new Map([["openrouter", provider]]),
    connected: catalog.connected.includes("openrouter") ? ["openrouter"] : [],
    default: model ? { openrouter: model } : {},
  }
}

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput =
  | {
      explicit: true
      directory?: string
      catalog?: DirectoryCatalog
    }
  | {
      explicit: false
      directory?: string
      catalog?: DirectoryCatalog
      global: NormalizedProviderListResponse
    }

export function selectProviderCatalog(input: ProviderCatalogInput) {
  if (input.directory && input.catalog?.ready) return openRouterCatalog(input.catalog.providers)
  if (input.explicit) return emptyProviderCatalog()
  return openRouterCatalog(input.global)
}
