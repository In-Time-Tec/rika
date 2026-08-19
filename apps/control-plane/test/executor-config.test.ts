import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "effect"
import { config } from "../src/executor"

const environment = {
  E2B_API_KEY: "e2b-api-key",
  E2B_APP_ID: "rika",
  E2B_DEPLOYMENT_ID: "deployment-1",
  E2B_TEMPLATE_ID: "ar7-template-alias",
  E2B_TEMPLATE_BUILD_ID: "7d0-build-receipt",
  RIKA_EXECUTOR_CONTROLLER_URL: "wss://controller.example.test/api/v1/executors",
}

describe("executor configuration", () => {
  it("requires the E2B template ID separately from the immutable build receipt", () => {
    const configured = config(environment)
    expect(configured).toMatchObject({
      templateId: "ar7-template-alias",
      templateBuildId: "7d0-build-receipt",
    })
    expect(Redacted.value(configured.apiKey)).toBe("e2b-api-key")
    expect(() => config({ ...environment, E2B_TEMPLATE_ID: "" })).toThrow("E2B_TEMPLATE_ID is required")
  })
})
