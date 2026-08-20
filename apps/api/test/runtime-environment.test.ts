import { describe, expect, it } from "@effect/vitest"
import { runtimeEnvironment } from "../src/runtime-environment"

describe("API runtime environment", () => {
  it("keeps explicit origins outside Railway previews", () => {
    const environment = {
      BETTER_AUTH_URL: "https://rika-app.up.railway.app",
      RIKA_EXECUTOR_API_URL: "wss://explicit/api",
    }
    expect(runtimeEnvironment(environment)).toBe(environment)
    expect(runtimeEnvironment({ ...environment, RAILWAY_ENVIRONMENT_NAME: "production" })).toMatchObject(environment)
  })

  it("uses the preview proxy origin for identity and executor callbacks", () => {
    expect(
      runtimeEnvironment({
        RAILWAY_ENVIRONMENT_NAME: "pr-12",
        RIKA_PROXY_PUBLIC_DOMAIN: "rika-pr-12.up.railway.app",
        BETTER_AUTH_URL: "https://production.example.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://production.example.test",
        RIKA_EXECUTOR_API_URL: "wss://production.example.test/api/v1/executors",
      }),
    ).toMatchObject({
      BETTER_AUTH_URL: "https://rika-pr-12.up.railway.app",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://rika-pr-12.up.railway.app",
      RIKA_EXECUTOR_API_URL: "wss://rika-pr-12.up.railway.app/api/v1/executors",
    })
  })

  it("rejects non-Railway preview public domains", () => {
    expect(() =>
      runtimeEnvironment({ RAILWAY_ENVIRONMENT_NAME: "pr-12", RIKA_PROXY_PUBLIC_DOMAIN: "attacker.example" }),
    ).toThrow("RIKA_PROXY_PUBLIC_DOMAIN must be a Railway public hostname in a preview environment")
  })
})
