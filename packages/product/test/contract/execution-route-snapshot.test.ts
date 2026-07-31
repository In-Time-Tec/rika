import { expect, test } from "vitest"
import { toExecutionRouteSnapshot } from "../../src/execution-route-snapshot"

const model = (role: string) => ({
  role,
  alias: "primary",
  provider: "openai",
  model: "gpt-5",
  registrationKey: "stable-id",
  providerProtocol: "openai",
  providerBaseUrl: "https://api.openai.com/v1",
  providerApiKeyEnv: "OPENAI_API_KEY",
  providerRuntime: { adapter: "openai", connectionIdentity: { account: "opaque" } },
  openAiAccountFingerprint: "must-not-persist",
  effort: "high",
  fast: false,
  requestVariant: "high",
  providerOptions: { temperature: 0 },
  compaction: { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 50 },
})

test("route conversion preserves every branch and removes adapter-shaped fields", () => {
  const route = {
    mode: "default",
    main: model("main"),
    oracle: model("oracle"),
    title: model("title"),
    compactionSummary: model("compaction"),
    agents: Object.fromEntries(
      ["librarian", "painter", "review", "readThread", "surgeon", "task"].map((role) => [role, model(role)]),
    ),
  }
  const snapshot = toExecutionRouteSnapshot(route)
  expect(snapshot.main.registrationIdentity).toBe("stable-id")
  expect(snapshot.agents?.task.providerConnection.provider).toBe("openai")
  expect(JSON.stringify(snapshot)).not.toContain("registrationKey")
  expect(JSON.stringify(snapshot)).not.toContain("providerRuntime")
  expect(JSON.stringify(snapshot)).not.toContain("openAiAccountFingerprint")
})

test("malformed and missing required route branches are rejected", () => {
  expect(() => toExecutionRouteSnapshot({ mode: "default", main: model("main") })).toThrow("Malformed execution route")
  expect(() => toExecutionRouteSnapshot({ mode: "default", main: {}, oracle: model("oracle") })).toThrow(
    "Malformed execution route",
  )
})
