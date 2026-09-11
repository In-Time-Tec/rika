import type { Environment } from "@rika/identity"

export const executionEnvironment = {
  RIKA_PROVIDER_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  RIKA_WORKSPACE_INPUT_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=",
  RIKA_MODEL_PROVIDER: "openai",
  RIKA_MODEL_ID: "gpt-6-astra",
  RIKA_MODEL_MAX_OUTPUT_TOKENS: "4096",
  RIKA_MODEL_REASONING_EFFORT: "max",
  GITHUB_APP_ID: "1234",
  GITHUB_APP_PRIVATE_KEY: "test-only-github-private-key",
  BOX_API_URL: "https://box.example.com/api",
  BOX_API_KEY: "test-only-box-api-key",
  RIKA_BOX_TEMPLATE_BOX_ID: "bx_23456789",
  RIKA_BOX_TEMPLATE_SNAPSHOT_ID: "00000000-0000-4000-8000-000000000000",
  RIKA_BOX_PROVIDER_SCOPE: "production-box-account",
} satisfies Environment
