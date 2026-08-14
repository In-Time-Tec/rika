import { expect, test } from "vitest"
import { Schema } from "effect"
import { ExecutionRouteSnapshot, toExecutionRouteSnapshot } from "../../src/execution/contract/execution-route-snapshot"

const model = (role: string) => ({
  role,
  alias: "primary",
  registrationIdentity: "stable-route-id",
  effort: "high",
  fast: false,
  candidates: [
    {
      model: "gpt-5",
      providerConnection: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "OPENAI_API_KEY",
        credentialIdentity: "stable-account",
      },
      registrationIdentity: "stable-candidate-id",
      providerOptions: { temperature: 0 },
    },
  ],
  compaction: { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 50 },
})

test("canonical route conversion preserves every branch and field", () => {
  const route = {
    version: 2 as const,
    mode: "default",
    subagents: { maxDepth: 2, maxSubagents: 3 },
    compaction: { strategy: "default" as const, summaryPrompt: "Pinned summary prompt" },
    main: model("main"),
    oracle: model("oracle"),
    title: model("title"),
    compactionSummary: model("compaction"),
    agents: Object.fromEntries(
      ["librarian", "painter", "readThread", "review", "surgeon", "task"].map((role) => [role, model(role)]),
    ),
  }
  const snapshot = toExecutionRouteSnapshot(route)
  expect(snapshot).toEqual(route)
  expect(snapshot.main.registrationIdentity).toBe("stable-route-id")
  expect(snapshot.agents.task.candidates[0]?.providerConnection).toEqual(route.main.candidates[0]?.providerConnection)
})

test("decodes the previous persisted route and always re-encodes the current version", () => {
  const current = routeWithModels()
  const { subagents: _subagents, ...withoutSubagents } = current
  const previous = { ...withoutSubagents, version: 1 as const }
  const decoded = Schema.decodeUnknownSync(ExecutionRouteSnapshot)(previous)
  expect(decoded).toEqual({
    ...withoutSubagents,
    version: 2,
    subagents: { maxDepth: 1, maxSubagents: 4 },
  })
  expect(Schema.encodeSync(ExecutionRouteSnapshot)(decoded)).toEqual(decoded)
})

test("preserves the pinned OpenAI account identity and rejects incomplete account routes", () => {
  const accountModel = (role: string) => ({
    ...model(role),
    candidates: model(role).candidates.map((candidate) => ({
      ...candidate,
      providerConnection: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        authentication: "account" as const,
        credentialIdentity: "account-fingerprint",
      },
    })),
  })
  const route = {
    version: 2 as const,
    mode: "default",
    subagents: { maxDepth: 1, maxSubagents: 4 },
    compaction: { strategy: "default" as const, summaryPrompt: "Pinned summary prompt" },
    main: accountModel("main"),
    oracle: accountModel("oracle"),
    title: accountModel("title"),
    compactionSummary: accountModel("compaction"),
    agents: Object.fromEntries(
      ["librarian", "painter", "readThread", "review", "surgeon", "task"].map((role) => [role, accountModel(role)]),
    ),
  }
  expect(toExecutionRouteSnapshot(route).main.candidates[0]?.providerConnection).toMatchObject({
    authentication: "account",
    credentialIdentity: "account-fingerprint",
  })
  const incomplete = {
    ...route,
    main: {
      ...route.main,
      candidates: route.main.candidates.map((candidate) => ({
        ...candidate,
        providerConnection: { ...candidate.providerConnection, credentialIdentity: undefined },
      })),
    },
  }
  expect(() => toExecutionRouteSnapshot(incomplete)).toThrow("Malformed OpenAI account provider connection")
})

test("malformed, adapter-shaped, and future route branches are rejected", () => {
  expect(() => toExecutionRouteSnapshot({ mode: "default", main: model("main") })).toThrow("Malformed execution route")
  expect(() => toExecutionRouteSnapshot({ version: 2, mode: "default", main: {}, oracle: model("oracle") })).toThrow(
    "Malformed execution route",
  )
  expect(() => toExecutionRouteSnapshot({ ...routeWithModels(), version: 1 })).toThrow(
    "Unsupported execution route version",
  )
  expect(() => toExecutionRouteSnapshot({ ...routeWithModels(), version: 99 })).toThrow(
    "Unsupported execution route version",
  )
  expect(() => toExecutionRouteSnapshot({ ...routeWithModels(), future: true })).toThrow(
    "Unsupported execution route field",
  )
  expect(() => toExecutionRouteSnapshot({ ...routeWithModels(), main: legacyModel("main") })).toThrow(
    "Unsupported execution route model field",
  )
})

const routeWithModels = () => ({
  version: 2 as const,
  mode: "default",
  subagents: { maxDepth: 4, maxSubagents: 4 },
  compaction: { strategy: "default" as const, summaryPrompt: "Pinned summary prompt" },
  main: model("main"),
  oracle: model("oracle"),
  title: model("title"),
  compactionSummary: model("compaction"),
  agents: Object.fromEntries(
    ["librarian", "painter", "readThread", "review", "surgeon", "task"].map((role) => [role, model(role)]),
  ),
})
const legacyModel = (role: string) => ({
  ...model(role),
  provider: "openai",
  registrationKey: "legacy",
  providerProtocol: "openai",
  providerBaseUrl: "https://api.openai.com/v1",
})
