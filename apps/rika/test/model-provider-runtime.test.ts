import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry } from "@batonfx/core"
import { expect, test } from "vitest"
import { OpenAiAuth } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { Runtime as RikaToolRuntime } from "@rika/tools"
import { Database } from "bun:sqlite"
import { Cause, ConfigProvider, Context, Effect, FileSystem, Layer, Redacted, Schema, Scope, Stream } from "effect"
import { LanguageModel, Response as AiResponse } from "effect/unstable/ai"
import {
  executionModelRoutes,
  executionRoutePin,
  executionRoutePinFromPrepared,
  modelRoutesForExecution,
} from "../src/main"
import * as BedrockAuthRefresh from "../src/bedrock-auth-refresh"
import * as ModelProviderRuntime from "../src/model-provider-runtime"

const credential = (fingerprint: string): OpenAiAuth.Credential => ({
  accessToken: Redacted.make("account-access-token"),
  idToken: Redacted.make("account-id-token"),
  refreshToken: Redacted.make("account-refresh-token"),
  accountId: Redacted.make("account-id"),
  fingerprint,
  generation: `${fingerprint}.generation`,
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshedAt: 1,
})

const authService = (
  status: OpenAiAuth.Status = { _tag: "Unauthenticated" },
  acquireFingerprint = status._tag === "Present" || status._tag === "RefreshRequired" ? status.fingerprint : "none",
): OpenAiAuth.ServiceInterface => ({
  loginBrowser: () => Effect.succeed(credential(acquireFingerprint)),
  loginDevice: Effect.succeed(credential(acquireFingerprint)),
  status: Effect.succeed(status),
  logout: Effect.succeed({ removed: true, revocationSupported: false }),
  acquire: Effect.succeed(credential(acquireFingerprint)),
  refreshRejected: () => Effect.succeed(credential(acquireFingerprint)),
})

const runtimeLayer = (auth: OpenAiAuth.ServiceInterface) =>
  ModelProviderRuntime.Service.layer.pipe(
    Layer.provide(Layer.succeed(OpenAiAuth.Service, auth)),
    Layer.provide(BedrockAuthRefresh.testLayer({ run: () => Effect.void })),
  )

const withRuntime = <A, E>(
  auth: OpenAiAuth.ServiceInterface,
  effect: (runtime: ModelProviderRuntime.ServiceInterface) => Effect.Effect<A, E, Scope.Scope>,
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(runtimeLayer(auth))
      return yield* effect(Context.get(context, ModelProviderRuntime.Service))
    }),
  ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)))

const openAiSettings = (baseUrl: string): ConfigContract.Settings => ({
  ...ConfigContract.defaults,
  providers: {
    ...ConfigContract.defaults.providers,
    openai: { protocol: "openai", baseUrl },
  },
})

const sseResponse = (events: ReadonlyArray<unknown>) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
      controller.close()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const response = (id: string) => ({ id, model: "test-model", created_at: 1, output: [] })
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

test("prepares distinct registrations for every default model tuple and aligns every pin", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const modes = Object.keys(ConfigContract.defaults.modes) as Array<ConfigContract.ModeId>
          const efforts = ["low", "medium", "high", "xhigh", "max"] as const
          const variants = modes.flatMap((mode) =>
            efforts.flatMap((effort) => {
              const configured = ConfigContract.defaults.modes[mode]
              const settings: ConfigContract.Settings = {
                ...ConfigContract.defaults,
                modes: {
                  ...ConfigContract.defaults.modes,
                  [mode]: {
                    main: { ...configured.main, effort },
                    oracle: { ...configured.oracle, effort },
                  },
                },
              }
              return [false, true].map((fastMode) => ({ mode, settings, tuning: { fastMode } }))
            }),
          )
          const routes = variants.flatMap(({ mode, settings, tuning }) =>
            modelRoutesForExecution(settings, mode, tuning),
          )
          const prepared = yield* runtime.prepare(routes)
          expect(prepared.registrations).toHaveLength(30)
          expect(new Set(prepared.registrations.map((item) => item.registrationKey)).size).toBe(30)
          const tuples = new Set(
            prepared.registrations.map((item) => `${item.provider}\0${item.model}\0${item.registrationKey}`),
          )
          for (const { mode, settings, tuning } of variants)
            for (const route of executionModelRoutes(executionRoutePin(settings, mode, tuning)))
              expect(tuples.has(`${route.provider}\0${route.model}\0${route.registrationKey}`)).toBe(true)
        }),
      { OPENAI_API_KEY: "test-api-key" },
    ),
  ))

test("sends configured reasoning effort and summary to custom OpenAI requests", () => {
  const requests = new Array<Record<string, unknown>>()
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      request.json().then((value) => {
        requests.push(value as Record<string, unknown>)
        return Response.json({})
      }),
  })
  const settings: ConfigContract.Settings = {
    ...ConfigContract.defaults,
    providers: {
      ...ConfigContract.defaults.providers,
      openai: { protocol: "openai", baseUrl: server.url.toString() },
    },
  }
  return Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        for (const mode of ["low", "medium", "high", "ultra"] as const) {
          const prepared = yield* runtime.prepare([ConfigContract.resolveModelRoute(settings, mode, "main")])
          const context = yield* Layer.build(prepared.registrations[0]!.layer)
          yield* Effect.exit(LanguageModel.generateText({ prompt: mode }).pipe(Effect.provide(context)))
        }
        expect(requests.map((request) => request.reasoning)).toEqual([
          { effort: "low", summary: "auto" },
          { effort: "medium", summary: "auto" },
          { effort: "xhigh", summary: "auto" },
          { effort: "max", summary: "auto" },
        ])
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})

test("assembles each fragmented OpenAI function call once and sends supported stream options", () => {
  const requests = new Array<Record<string, unknown>>()
  const handled = new Array<RikaToolRuntime.Request>()
  const calls = [
    { id: "item-1", callId: "call-1", path: "first.txt" },
    { id: "item-2", callId: "call-2", path: "second.txt" },
    { id: "item-3", callId: "call-3", path: "third.txt" },
  ]
  const events = calls.flatMap((call, outputIndex) => {
    const args = JSON.stringify({ path: call.path })
    return [
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        sequence_number: outputIndex * 3,
        item: { id: call.id, type: "function_call", call_id: call.callId, name: "read", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: call.id,
        output_index: outputIndex,
        sequence_number: outputIndex * 3 + 1,
        delta: args,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: call.id,
        output_index: outputIndex,
        sequence_number: outputIndex * 3 + 2,
        arguments: args,
      },
    ]
  })
  events.push({ type: "response.completed", sequence_number: 10, response: response("response-burst") } as never)
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      Effect.promise(() => request.json()).pipe(
        Effect.map((body) => {
          requests.push(body as Record<string, unknown>)
          return requests.length === 1
            ? sseResponse(events)
            : sseResponse([{ type: "response.completed", sequence_number: 0, response: response("response-final") }])
        }),
        Effect.runPromise,
      ),
  })
  return Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const route = ConfigContract.resolveModelRoute(openAiSettings(server.url.toString()), "medium", "main")
        const prepared = yield* runtime.prepare([route])
        const context = yield* Layer.build(prepared.registrations[0]!.layer)
        const toolkitContext = yield* Layer.build(
          RikaToolRuntime.handlerLayer.pipe(
            Layer.provide(
              RikaToolRuntime.testLayer((request) =>
                Effect.sync(() => {
                  handled.push(request)
                  return { text: "read", truncated: false }
                }),
              ),
            ),
          ),
        )
        const toolkit = yield* RikaToolRuntime.toolkit.pipe(Effect.provide(toolkitContext))
        const parts = yield* LanguageModel.streamText({ prompt: "read three files", toolkit }).pipe(
          Stream.runCollect,
          Effect.provide(context),
        )
        const toolCalls = Array.from(parts).filter((part) => part.type === "tool-call")
        expect(toolCalls.map((part) => part.id)).toEqual(["call-1", "call-2", "call-3"])
        expect(toolCalls.map((part) => part.params)).toEqual(calls.map((call) => ({ path: call.path })))
        expect(handled).toEqual(calls.map((call) => ({ _tag: "Read", path: call.path })))
        expect(requests).toHaveLength(1)
        expect(requests.every((request) => request.stream === true)).toBe(true)
        expect(requests.every((request) => !("stream_options" in request))).toBe(true)
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})

test("rejects a malformed OpenAI terminal without completing a partial function call", () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 0,
      item: { id: "partial-item", type: "function_call", call_id: "partial-call", name: "read", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "partial-item",
      output_index: 0,
      sequence_number: 1,
      delta: '{"path":"partial.txt"}',
    },
    { type: "response.completed", sequence_number: 2 },
  ]
  const server = Bun.serve({ port: 0, fetch: () => sseResponse(events) })
  return Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const route = ConfigContract.resolveModelRoute(openAiSettings(server.url.toString()), "medium", "main")
        const prepared = yield* runtime.prepare([route])
        const context = yield* Layer.build(prepared.registrations[0]!.layer)
        const toolkitContext = yield* Layer.build(
          RikaToolRuntime.handlerLayer.pipe(
            Layer.provide(RikaToolRuntime.testLayer(() => Effect.die("tool handlers are not executed by this test"))),
          ),
        )
        const toolkit = yield* RikaToolRuntime.toolkit.pipe(Effect.provide(toolkitContext))
        const exit = yield* Effect.exit(
          LanguageModel.streamText({ prompt: "read one file", toolkit }).pipe(
            Stream.runCollect,
            Effect.provide(context),
          ),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const failure = Cause.pretty(exit.cause)
          expect(failure).toContain("response")
          expect(failure).not.toContain("partial.txt")
        }
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})

test("classifies a nested OpenAI Responses context error without exposing the Effect AI decoder failure", () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      sseResponse([
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
            param: "input",
          },
          sequence_number: 3,
        },
      ]),
  })
  return Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const route = ConfigContract.resolveModelRoute(openAiSettings(server.url.toString()), "medium", "main")
          const prepared = yield* runtime.prepare([route])
          const registration = prepared.registrations[0]!
          const context = yield* Layer.build(registration.layer)
          const parts = yield* LanguageModel.streamText({ prompt: "overflow" }).pipe(
            Stream.runCollect,
            Effect.provide(context),
          )
          const error = parts.find((part) => part.type === "error")
          expect(error?.type).toBe("error")
          if (error?.type !== "error") return
          const rendered = encodeJson(error.error)

          expect(registration.classifyFailure?.(error.error)).toBe("context-overflow")
          expect(rendered).toContain("context_length_exceeded")
          expect(rendered).not.toContain("Invalid output: Missing key")
        }),
      { OPENAI_API_KEY: "test-api-key" },
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})

test("compacts a restored durable session and replays a nested OpenAI Responses context error", () => {
  let modelCalls = 0
  const overflow = {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    param: "input",
  }
  const settings = ConfigContract.defaults
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-openai-overflow-" })
          yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "durable overflow fixture")
          const providerContext = yield* Layer.build(runtimeLayer(authService()))
          const runtime = Context.get(providerContext, ModelProviderRuntime.Service)
          const route = ConfigContract.resolveModelRoute(settings, "medium", "main")
          const prepared = yield* runtime.prepare([route])
          const preparedRegistration = prepared.registrations[0]!
          const selection = ModelProviderRuntime.modelRoutePlan(route).selection
          const model = yield* LanguageModel.make({
            generateText: () => Effect.die("the conversation model is streaming only"),
            streamText: () => {
              modelCalls += 1
              if (modelCalls === 1)
                return Stream.make(
                  AiResponse.makePart("tool-call", {
                    id: "overflow-read",
                    name: "read",
                    params: { path: "fixture.txt" },
                    providerExecuted: false,
                  }),
                )
              if (modelCalls === 2)
                return Stream.make(AiResponse.makePart("text-delta", { id: "history", delta: "history ready" }))
              if (modelCalls === 3)
                return Stream.make(
                  Schema.encodeSync(AiResponse.ResponseMetadataPart)(
                    AiResponse.makePart("response-metadata", {
                      id: "overflow-response",
                      modelId: "overflow-model",
                      timestamp: undefined,
                      request: undefined,
                    }),
                  ),
                  AiResponse.makePart("error", { error: overflow }),
                )
              return Stream.make(AiResponse.makePart("text-delta", { id: "recovered", delta: "recovered" }))
            },
          })
          const registration = yield* ModelRegistry.registration({
            ...selection,
            layer: Layer.succeed(LanguageModel.LanguageModel, model),
            ...(preparedRegistration.classifyFailure === undefined
              ? {}
              : { classifyFailure: preparedRegistration.classifyFailure }),
          })
          const summarySelection = {
            provider: "test",
            model: "compaction-summary",
            registrationKey: "compaction-summary",
          }
          const summaryModel = yield* LanguageModel.make({
            generateText: () =>
              Effect.succeed([
                { type: "text", text: "Goal: Recover the rejected request from one compacted projection." },
              ]),
            streamText: () => Stream.empty,
          })
          const summaryRegistration = yield* ModelRegistry.registration({
            ...summarySelection,
            layer: Layer.succeed(LanguageModel.LanguageModel, summaryModel),
          })
          const backendContext = yield* Layer.build(
            RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration,
              additionalRegistrations: [summaryRegistration],
              selection,
              compactionSummarySelection: summarySelection,
              modelVariantPolicy: "fixed-selection",
              compaction: { contextWindow: 100_000, reserveTokens: 1, keepRecentTokens: 1 },
            }),
          )
          const backend = Context.get(backendContext, ExecutionBackend.Service)
          const historyExecution = yield* backend.start({
            threadId: "thread-openai-overflow",
            turnId: "turn-openai-history",
            prompt: "read fixture.txt and retain the result for the next turn",
            startedAt: 1,
            executionRoute: executionRoutePin(settings, "medium"),
          })
          expect(historyExecution.status, encodeJson(historyExecution.events)).toBe("completed")

          const execution = yield* backend.start({
            threadId: "thread-openai-overflow",
            turnId: "turn-openai-overflow",
            prompt: "recover the restored session from the provider overflow",
            startedAt: 2,
            executionRoute: executionRoutePin(settings, "medium"),
          })
          const database = new Database(`${directory}/relay.db`, { readonly: true })
          const checkpoint = database
            .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
            .get("execution:turn-openai-overflow") as { count: number }
          database.close()
          const renderedEvents = encodeJson(execution.events)

          expect(execution.status, renderedEvents).toBe("completed")
          expect(checkpoint.count).toBe(1)
          expect(modelCalls).toBe(4)
          expect(historyExecution.events.filter((event) => event.type === "tool.result.received")).toHaveLength(1)
          expect(execution.events.some((event) => event.type === "agent.compaction.started")).toBe(true)
          expect(
            execution.events
              .filter((event) => event.type === "model.output.delta")
              .map((event) => event.text)
              .join(""),
          ).toBe("recovered")
          expect(renderedEvents).not.toContain("Invalid output: Missing key")
        }).pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ OPENAI_API_KEY: "test-api-key" }),
      ),
    ),
  )
}, 30_000)

test("retains Anthropic registration behavior", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            modes: {
              ...ConfigContract.defaults.modes,
              low: { ...ConfigContract.defaults.modes.low, main: { alias: "fable", effort: "low" } },
            },
          }
          const route = ConfigContract.resolveModelRoute(settings, "low", "main")
          const prepared = yield* runtime.prepare([route])
          expect(prepared.registrations[0]).toMatchObject({
            provider: "anthropic",
            model: "claude-fable-5",
            registrationKey: ModelProviderRuntime.modelRoutePlan(route).registrationKey,
          })
        }),
      { ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("registers Bedrock routes and pins only non-secret connection identity", () =>
  Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const refresh = { command: "aws", args: ["sso", "login", "--profile", "engineering"] }
        const settings: ConfigContract.Settings = {
          ...ConfigContract.defaults,
          providers: {
            ...ConfigContract.defaults.providers,
            bedrock: {
              protocol: "amazon-bedrock",
              region: "us-east-1",
              profile: "engineering",
              authMode: "default",
              authRefresh: refresh,
            },
          },
          models: {
            ...ConfigContract.defaults.models,
            "bedrock-fable": {
              ...ConfigContract.defaults.models.fable!,
              provider: "bedrock",
              candidates: ["us.anthropic.claude-sonnet-4-20250514-v1:0"],
            },
          },
          modes: {
            ...ConfigContract.defaults.modes,
            low: { ...ConfigContract.defaults.modes.low, main: { alias: "bedrock-fable", effort: "low" } },
          },
        }
        const route = ConfigContract.resolveModelRoute(settings, "low", "main")
        const prepared = yield* runtime.prepare([route])
        expect(prepared.registrations[0]).toMatchObject({
          provider: "bedrock",
          model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        })
        expect(prepared.plans[0]?.runtime).toMatchObject({
          adapter: "amazon-bedrock",
          connectionIdentity: {
            authMode: "default",
            region: "us-east-1",
            profile: "engineering",
            authRefreshFingerprint: expect.stringMatching(/^sha256:/),
          },
        })
        const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(executionRoutePin(settings, "low"))
        expect(encoded).not.toContain(`"command":"${refresh.command}"`)
        expect(encoded).not.toContain('"args"')
      }),
    ),
  ))

test("keys Bedrock registrations by connection and refresh identity without ambient credentials", () => {
  const base = ConfigContract.resolveModelRoute(
    {
      ...ConfigContract.defaults,
      providers: {
        ...ConfigContract.defaults.providers,
        bedrock: {
          protocol: "amazon-bedrock",
          region: "us-east-1",
          profile: "engineering",
          authMode: "default",
          authRefresh: { command: "aws", args: ["sso", "login", "--profile", "engineering"] },
        },
      },
      models: {
        ...ConfigContract.defaults.models,
        "bedrock-fable": {
          ...ConfigContract.defaults.models.fable!,
          provider: "bedrock",
          candidates: ["model"],
        },
      },
      modes: {
        ...ConfigContract.defaults.modes,
        low: { ...ConfigContract.defaults.modes.low, main: { alias: "bedrock-fable", effort: "low" } },
      },
    },
    "low",
  )
  const key = ModelProviderRuntime.modelRoutePlan(base).registrationKey
  for (const connection of [
    { ...base.providerConnection, region: "us-west-2" },
    { ...base.providerConnection, profile: "production" },
    { ...base.providerConnection, authMode: "bearer" as const },
    { ...base.providerConnection, authRefresh: { command: "aws", args: ["sso", "login"] } },
  ])
    expect(ModelProviderRuntime.modelRoutePlan({ ...base, providerConnection: connection }).registrationKey).not.toBe(
      key,
    )
  expect(ModelProviderRuntime.modelRoutePlan(base).registrationKey).toBe(key)
})

test("fails before registration when an API credential is missing without exposing a secret", () =>
  Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
        const exit = yield* Effect.exit(runtime.prepare([route]))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const text = Cause.pretty(exit.cause)
          expect(text).toContain("OPENAI_API_KEY")
          expect(text).toContain("openai")
          expect(text).not.toContain("account-access-token")
        }
      }),
    ),
  ))

test("uses a native OpenAI account without an API key and applies account request constraints", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }), (runtime) =>
      Effect.gen(function* () {
        const routes = modelRoutesForExecution(ConfigContract.defaults, "medium")
        const prepared = yield* runtime.prepare(routes)
        expect(prepared.registrations.length).toBeGreaterThan(0)
        expect(prepared.plans[0]?.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
        expect(prepared.plans[0]?.options).toMatchObject({ store: false })
        expect(prepared.plans[0]?.options).not.toHaveProperty("max_output_tokens")
        const execution = executionRoutePinFromPrepared("medium", prepared)
        expect(execution.main.providerRuntime).toEqual({
          adapter: "openai-account",
          credentialIdentity: "account-a",
        })
        expect(execution.main.openAiAccountFingerprint).toBe("account-a")
      }),
    ),
  ))

test("pins provider runtime identity, roundtrips JSON, and normalizes old account pins", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
  const api = ModelProviderRuntime.modelRoutePlan(route)
  const account = ModelProviderRuntime.modelRoutePlan(route, "account-a")
  expect(api.runtime).toEqual({ adapter: "openai", credentialIdentity: "OPENAI_API_KEY" })
  expect(account.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
  expect(account.registrationKey).not.toBe(api.registrationKey)
  const pin = executionRoutePin(ConfigContract.defaults, "medium")
  const encoded = Schema.decodeUnknownSync(Turn.ExecutionRoutePin)(JSON.parse(JSON.stringify(pin)))
  expect(encoded.main.providerRuntime).toEqual(pin.main.providerRuntime)
  const { providerRuntime: _, ...oldPin } = pin.main
  expect(
    ModelProviderRuntime.normalizePinnedRuntime(
      Schema.decodeUnknownSync(Turn.ExecutionModelRoute)({
        ...oldPin,
        openAiAccountFingerprint: "old-account",
      }),
    ),
  ).toEqual({ adapter: "openai-account", credentialIdentity: "old-account" })
})

test("custom OpenAI and Anthropic routes never evaluate corrupt account status", () =>
  Effect.runPromise(
    withRuntime(
      { ...authService(), status: Effect.fail(OpenAiAuth.StoreError.make({ kind: "corrupt", message: "hidden" })) },
      (runtime) =>
        Effect.gen(function* () {
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            providers: {
              ...ConfigContract.defaults.providers,
              openai: { protocol: "openai", baseUrl: "https://models.example.test/v1" },
            },
          }
          const routes = [
            ConfigContract.resolveModelRoute(settings, "medium", "main"),
            ConfigContract.resolveModelRoute(settings, "low", "main"),
          ]
          const prepared = yield* runtime.prepare(routes)
          expect(prepared.registrations).toHaveLength(2)
        }),
      { OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("observes a login between prepare calls without rebuilding the runtime", () => {
  let status: OpenAiAuth.Status = { _tag: "Unauthenticated" }
  const auth = { ...authService(), status: Effect.sync(() => status), acquire: Effect.succeed(credential("account-a")) }
  return Effect.runPromise(
    withRuntime(
      auth,
      (runtime) =>
        Effect.gen(function* () {
          const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          status = { _tag: "Present", fingerprint: "account-a" }
          const second = yield* runtime.prepare([route])
          expect(first.plans[0]?.runtime.adapter).toBe("openai")
          expect(second.plans[0]?.runtime.adapter).toBe("openai-account")
        }),
      { OPENAI_API_KEY: "test" },
    ),
  )
})

test("reuses one scoped registration across repeated prepare calls", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          const second = yield* runtime.prepare([route])
          expect(second.registrations[0]).toBe(first.registrations[0])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))

test("fails a mismatched account fingerprint before a request", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }, "account-b"), (runtime) =>
      Effect.gen(function* () {
        const prepared = yield* runtime.prepare([
          ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main"),
        ])
        const context = yield* Layer.build(prepared.registrations[0]!.layer)
        const exit = yield* Effect.exit(
          LanguageModel.generateText({ prompt: "must not send" }).pipe(Effect.provide(context)),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("account credential acquire failed")
      }),
    ),
  ))

test("restores old API and account routes with their stored registration keys", () =>
  Effect.runPromise(
    withRuntime(
      authService({ _tag: "Present", fingerprint: "account-a" }),
      (runtime) =>
        Effect.gen(function* () {
          const base = executionRoutePin(ConfigContract.defaults, "medium").main
          const { providerRuntime: _, ...oldBase } = base
          const api = yield* Schema.decodeUnknownEffect(Turn.ExecutionModelRoute)({
            ...oldBase,
            registrationKey: "stored-api",
          })
          const { providerApiKeyEnv: __, ...accountBase } = oldBase
          const account = yield* Schema.decodeUnknownEffect(Turn.ExecutionModelRoute)({
            ...accountBase,
            openAiAccountFingerprint: "account-a",
            registrationKey: "stored-account",
          })
          const restored = yield* runtime.restore([api, account])
          expect(restored.map((item) => item.registrationKey)).toEqual(["stored-api", "stored-account"])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))
