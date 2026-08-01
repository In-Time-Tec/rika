import { expect, test } from "vitest"
import { toExecutionRouteSnapshot } from "../../src/execution/contract/execution-route-snapshot"

const model = (role: string) => ({
  role,
  alias: "primary",
  model: "gpt-5",
  providerConnection: {
    provider: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    authentication: "api-key" as const,
    apiKeyEnvironment: "OPENAI_API_KEY",
    credentialIdentity: "stable-account",
  },
  registrationIdentity: "stable-id",
  effort: "high",
  fast: false,
  requestVariant: "high",
  providerOptions: { temperature: 0 },
  compaction: { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 50 },
})

test("canonical route conversion preserves every branch and field", () => {
  const route = {
    version: 1 as const,
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
  expect(snapshot).toEqual(route)
  expect(snapshot.main.registrationIdentity).toBe("stable-id")
  expect(snapshot.agents?.task.providerConnection).toEqual(route.main.providerConnection)
})

test("malformed, adapter-shaped, and future route branches are rejected", () => {
  expect(() => toExecutionRouteSnapshot({ mode: "default", main: model("main") })).toThrow("Malformed execution route")
  expect(() => toExecutionRouteSnapshot({ version: 1, mode: "default", main: {}, oracle: model("oracle") })).toThrow(
    "Malformed execution route",
  )
  expect(() =>
    toExecutionRouteSnapshot({ version: 2, mode: "default", main: model("main"), oracle: model("oracle") }),
  ).toThrow("Unsupported execution route version")
  expect(() =>
    toExecutionRouteSnapshot({ version: 99, mode: "default", main: model("main"), oracle: model("oracle") }),
  ).toThrow("Unsupported execution route version")
  expect(() => toExecutionRouteSnapshot({ ...routeWithModels(), future: true })).toThrow(
    "Unsupported execution route field",
  )
  expect(() =>
    toExecutionRouteSnapshot({ version: 1, mode: "default", main: legacyModel("main"), oracle: model("oracle") }),
  ).toThrow("Unsupported execution route model field")
})

const routeWithModels = () => ({ version: 1 as const, mode: "default", main: model("main"), oracle: model("oracle") })
const legacyModel = (role: string) => ({
  ...model(role),
  provider: "openai",
  registrationKey: "legacy",
  providerProtocol: "openai",
  providerBaseUrl: "https://api.openai.com/v1",
})
