import { expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ConfigContract } from "@rika/config"
import * as Turn from "@rika/persistence/turn"
import {
  buildTestModelScript,
  canonicalDatabaseRoot,
  distinctModelRoutes,
  executionRoutePin,
  modelRoutePlan,
  parseTestModelScript,
  productionCompaction,
  withClientWorkspace,
  gatewayCredentialsForRoutes,
  persistedModelRoutesForStartup,
} from "../src/main"

test("uses one canonical directory for both resident databases", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-database-root-" })
            const other = path.join(root, "other")
            const alias = path.join(root, "alias")
            yield* fs.makeDirectory(other)
            yield* fs.symlink(root, alias)
            expect(
              yield* Effect.promise(() =>
                canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(alias, "relay.db")),
              ),
            ).toBe(yield* fs.realPath(root))
            expect(
              (yield* Effect.exit(
                Effect.promise(() => canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(other, "relay.db"))),
              ))._tag,
            ).toBe("Failure")
            expect(
              (yield* Effect.exit(
                Effect.promise(() => canonicalDatabaseRoot(path.join(root, "product.db"), path.join(root, "relay.db"))),
              ))._tag,
            ).toBe("Failure")
          }),
          context,
        ),
      ),
    ),
  ))

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 1_050_000,
    reserveTokens: 128_000,
    keepRecentTokens: 32_000,
  })
  expect(
    productionCompaction({ compaction: { contextWindow: 192_000, reserveTokens: 32_000, keepRecentTokens: 16_000 } }),
  ).toEqual({
    contextWindow: 192_000,
    reserveTokens: 32_000,
    keepRecentTokens: 16_000,
  })
})

test("content-addresses non-secret model execution semantics deterministically", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const key = modelRoutePlan(route).registrationKey
  expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(modelRoutePlan(route).registrationKey).toBe(key)
  expect(
    modelRoutePlan({ ...route, gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}/` } }).registrationKey,
  ).toBe(key)
  expect(
    modelRoutePlan({ ...route, gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}#primary` } })
      .registrationKey,
  ).toBe(key)
  const firstQuery = modelRoutePlan({
    ...route,
    gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}/?tenant=first` },
  }).registrationKey
  const secondQuery = modelRoutePlan({
    ...route,
    gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}?tenant=second` },
  }).registrationKey
  expect(firstQuery).not.toBe(secondQuery)
  expect(
    modelRoutePlan({
      ...route,
      gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}?tenant=first#ignored` },
    }).registrationKey,
  ).toBe(firstQuery)
  const changes = [
    { ...route, gateway: { ...route.gateway, protocol: "anthropic" as const } },
    { ...route, gateway: { ...route.gateway, baseUrl: "https://models.example.test/v1" } },
    { ...route, model: "claude-opus-4-8" },
    { ...route, effort: "high" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
    { ...route, gateway: { ...route.gateway, auth: { type: "none" as const } } },
    {
      ...route,
      gateway: { ...route.gateway, auth: { type: "bearer-env" as const, variable: "OTHER_API_KEY" } },
    },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
  expect(executionRoutePin(ConfigContract.defaults, "high").oracle.providerOptions).toEqual(route.options)
  expect(executionRoutePin(ConfigContract.defaults, "high").agents?.review.alias).toBe("review")
  expect(executionRoutePin(ConfigContract.defaults, "medium").tokenBudget).toBeUndefined()
  const settings = {
    ...ConfigContract.defaults,
    compaction: { summaryModel: { alias: "terra", effort: "medium" as const } },
  }
  expect(executionRoutePin(settings, "medium").compactionSummary).toMatchObject({
    role: "compaction",
    alias: "terra",
    model: "gpt-5.6-terra",
  })
})

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const second = { ...route, gatewayName: `${route.gatewayName}-secondary` }
  expect(modelRoutePlan(second).registrationKey).toBe(modelRoutePlan(route).registrationKey)
  expect(distinctModelRoutes([route, second, route])).toEqual([route, second])
})

test("sends each client's workspace to the resident service", () => {
  const interactive = {
    _tag: "Interactive" as const,
    prompt: [],
    ephemeral: false,
  }
  expect(withClientWorkspace(interactive, "/client-a")).toEqual({
    ...interactive,
    clientWorkspace: "/client-a",
    workspace: "/client-a",
  })
  expect(withClientWorkspace({ ...interactive, workspace: "/explicit" }, "/client-b")).toEqual({
    ...interactive,
    clientWorkspace: "/client-b",
    workspace: "/explicit",
  })
  expect(withClientWorkspace({ _tag: "Config", action: "list" }, "/client-c")).toEqual({
    _tag: "Config",
    action: "list",
    clientWorkspace: "/client-c",
  })
  expect(withClientWorkspace({ _tag: "Thread", action: "new" }, "/client-d")).toEqual({
    _tag: "Thread",
    action: "new",
    clientWorkspace: "/client-d",
  })
  expect(withClientWorkspace({ _tag: "Mcp", action: "approve", name: "server" }, "/client-e")).toEqual({
    _tag: "Mcp",
    action: "approve",
    name: "server",
    workspace: "/client-e",
    clientWorkspace: "/client-e",
  })
})

test("loads credentials named by configured and persisted routes", () => {
  const configured = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
  const persisted = {
    ...executionRoutePin(ConfigContract.defaults, "medium").oracle,
    gatewayAuth: "bearer-env:RESTART_ORACLE_KEY",
  }
  const values = { OPENAI_API_KEY: "starter", RESTART_ORACLE_KEY: "persisted" } as const
  const credentials = gatewayCredentialsForRoutes(
    [configured],
    [persisted],
    {},
    (name) => values[name as keyof typeof values],
  )
  expect(Redacted.value(credentials.OPENAI_API_KEY!)).toBe("starter")
  expect(Redacted.value(credentials.RESTART_ORACLE_KEY!)).toBe("persisted")
  expect(JSON.stringify(credentials)).not.toContain("starter")
  expect(JSON.stringify(credentials)).not.toContain("persisted")
})

test("keeps a review route owner's workspace-specific models in the startup registration set", () => {
  const route = executionRoutePin(ConfigContract.defaults, "high")
  const owner: Turn.Turn = {
    id: Turn.TurnId.make("review-owner"),
    threadId: "review-thread" as Turn.Turn["threadId"],
    prompt: "Review workspace changes",
    status: "running",
    executionRoute: {
      ...route,
      main: { ...route.main, registrationKey: "workspace-main" },
      oracle: { ...route.oracle, registrationKey: "workspace-oracle" },
    },
    reviewFanOutId: "review:review-owner",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(persistedModelRoutesForStartup([owner]).map((candidate) => candidate.registrationKey)).toEqual([
    "workspace-main",
    "workspace-oracle",
    route.compactionSummary!.registrationKey,
    route.agents!.librarian.registrationKey,
    route.agents!.painter.registrationKey,
    route.agents!.review.registrationKey,
    route.agents!.readThread.registrationKey,
    route.agents!.task.registrationKey,
  ])
})

test("parses and builds multi-part, object, and delayed TestModel turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const json = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
        {
          parts: [
            { type: "reasoning", text: "inspect" },
            { type: "toolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1" },
          ],
          delayMs: 25,
        },
        { parts: [{ type: "text", text: "done" }] },
        { object: { summary: "reviewed", findings: [] }, delayMs: 10 },
      ])
      const parsed = yield* parseTestModelScript(json)
      expect(parsed).toHaveLength(3)
      const built = yield* buildTestModelScript(json)
      expect(built).toEqual([
        {
          _tag: "Turn",
          parts: [
            { _tag: "Reasoning", text: "inspect" },
            { _tag: "ToolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
          ],
          delay: 25,
        },
        { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
        { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
      ])
    }),
  ))

test("rejects malformed, empty, and unsafe scripts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          "not json",
          "[]",
          '[{"parts":[]}]',
          '[{"parts":[{"type":"toolCall","name":4}]}]',
          '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
        ].map((value) => Effect.exit(parseTestModelScript(value))),
      )
      expect(results.every((result) => result._tag === "Failure")).toBe(true)
    }),
  ))
