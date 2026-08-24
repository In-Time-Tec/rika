export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

const railwayDomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.up\.railway\.app$/

export const runtimeEnvironment = (environment: RuntimeEnvironment) => {
  const railwayEnvironment = environment.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (railwayEnvironment === undefined || railwayEnvironment.length === 0 || railwayEnvironment === "production")
    return environment
  const domain = environment.RIKA_PROXY_PUBLIC_DOMAIN?.trim()
  if (domain === undefined || !railwayDomain.test(domain))
    throw new Error("RIKA_PROXY_PUBLIC_DOMAIN must be a Railway public hostname in a preview environment")
  const origin = `https://${domain}`
  return {
    ...environment,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_TRUSTED_ORIGINS: origin,
    RIKA_EXECUTOR_API_URL: `wss://${domain}/api/v1/executors`,
  }
}
