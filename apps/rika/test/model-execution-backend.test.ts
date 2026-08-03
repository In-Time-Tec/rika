import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Context, Effect, FileSystem, Layer, Path } from "effect"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"

import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"

import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import { configuredBackendLayer } from "../src/resident/composition/resident-execution-layer"
import { route as ResidentConfiguration } from "../src/resident/composition/resident-configuration-adapter"

import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { withBunServices } from "./model-script-fixtures"
const { executionRoutePin } = ResidentConfiguration

const sseResponse = (events: ReadonlyArray<unknown>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const fakeOpenAiResponse = {
  id: "fake-response",
  model: "fake-model",
  created_at: 1,
  output: [],
}

test("builds the production resident execution layer without injected runtime services", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-stale-route-startup-" })
          const productDatabase = Database.layer(path.join(root, "rika.db"))
          const productDatabaseContext = yield* Layer.buildWithScope(
            productDatabase.pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const productDatabaseLayer = Layer.succeedContext(productDatabaseContext)
          const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const settings: SettingsDefaults.ConfigurationSettings = {
            ...SettingsDefaults.Defaults.defaults,
            providers: {
              ...SettingsDefaults.Defaults.defaults.providers,
              openai: {
                protocol: "openai",
                baseUrl: SettingsDefaults.Defaults.providerDefaults.openai.baseUrl,
              },
            },
          }
          const pinned = executionRoutePin(settings, "medium")
          const restored = {
            ...pinned.main,
            registrationIdentity: modelRegistrationIdentity("restored-startup"),
            requestVariant: "restored-startup",
          }
          const stale = {
            ...pinned.main,
            alias: "retired-startup",
            registrationIdentity: modelRegistrationIdentity("retired-startup"),
            requestVariant: "retired-startup",
            providerConnection: {
              ...pinned.main.providerConnection,
              provider: "retired-startup",
              protocol: "retired-startup",
              apiKeyEnvironment: "RETIRED_STARTUP_API_KEY",
            },
          }
          const auth = OpenAiAuth.Service.of({
            loginBrowser: () => Effect.die("unused"),
            loginDevice: Effect.die("unused"),
            status: Effect.succeed({ _tag: "Unauthenticated" }),
            logout: Effect.die("unused"),
            acquire: Effect.die("unused"),
            refreshRejected: () => Effect.die("unused"),
          })
          const context = yield* Layer.buildWithScope(
            configuredBackendLayer({
              filename: path.join(root, "execution.db"),
              workspace: "/work",
              repositoryLayer,
              turnRepositoryLayer,
              transcriptRepositoryLayer: TranscriptRepository.memoryLayer,
              threadSearchRepositoryLayer: ThreadSearchRepository.memoryLayer,
              threadInteractionRepositoryLayer: ThreadInteractionRepository.memoryLayer(),
              settings,
              persistedModelRoutes: [restored, restored, stale],
              threadToolGateway: yield* ThreadToolService.makeGateway,
              providerAuthLayer: Layer.succeed(OpenAiAuth.Service, auth),
              toolRuntimeLayerForWorkspace: () => ToolRuntime.testLayer(() => Effect.die("unused")),
            }),
            yield* Effect.scope,
          )
          const backend = Context.get(context, ExecutionBackend.Service)
          const failed = yield* Effect.exit(
            backend.start({
              threadId: "stale-thread",
              turnId: "stale-startup-turn",
              prompt: "stale",
              executionRoute: {
                version: pinned.version,
                mode: "medium",
                main: stale,
                oracle: { ...stale, role: "oracle" },
              },
            }),
          )
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") {
            expect(Cause.hasDies(failed.cause)).toBe(false)
            const failure = failed.cause.reasons.find(Cause.isFailReason)
            expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
              _tag: "ExecutionBackendError",
              message: expect.stringMatching(/retired-startup.*unavailable/),
            })
          }
        }),
      ),
    ),
  ))

test("executes a real provider route through the production resident composition", () => {
  const requests = new Array<URL>()
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(new URL(request.url))
      return sseResponse([
        {
          type: "response.output_text.delta",
          item_id: "fake-message",
          output_index: 0,
          content_index: 0,
          delta: "OK",
          sequence_number: 0,
        },
        { type: "response.completed", response: fakeOpenAiResponse, sequence_number: 1 },
      ])
    },
  })
  return Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-real-provider-route-" })
          const productDatabase = Database.layer(path.join(root, "rika.db"))
          const productDatabaseContext = yield* Layer.buildWithScope(
            productDatabase.pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const productDatabaseLayer = Layer.succeedContext(productDatabaseContext)
          const repositories = Layer.merge(
            ThreadRepository.layer.pipe(Layer.provide(productDatabaseLayer)),
            TurnRepository.layer.pipe(Layer.provide(productDatabaseLayer)),
          )
          const settings: SettingsDefaults.ConfigurationSettings = {
            ...SettingsDefaults.Defaults.defaults,
            providers: {
              ...SettingsDefaults.Defaults.defaults.providers,
              openai: { protocol: "openai", baseUrl: server.url.toString() },
            },
          }
          const auth = OpenAiAuth.Service.of({
            loginBrowser: () => Effect.die("unused"),
            loginDevice: Effect.die("unused"),
            status: Effect.succeed({ _tag: "Unauthenticated" }),
            logout: Effect.die("unused"),
            acquire: Effect.die("unused"),
            refreshRejected: () => Effect.die("unused"),
          })
          const context = yield* Layer.buildWithScope(
            configuredBackendLayer({
              filename: path.join(root, "execution.db"),
              workspace: root,
              repositoryLayer: repositories,
              turnRepositoryLayer: repositories,
              transcriptRepositoryLayer: TranscriptRepository.memoryLayer,
              threadSearchRepositoryLayer: ThreadSearchRepository.memoryLayer,
              threadInteractionRepositoryLayer: ThreadInteractionRepository.memoryLayer(),
              settings,
              threadToolGateway: yield* ThreadToolService.makeGateway,
              providerAuthLayer: Layer.succeed(OpenAiAuth.Service, auth),
              toolRuntimeLayerForWorkspace: () => ToolRuntime.testLayer(() => Effect.die("unused")),
            }),
            yield* Effect.scope,
          )
          const backend = Context.get(context, ExecutionBackend.Service)
          const result = yield* backend.start({
            threadId: "real-provider-thread",
            turnId: "real-provider-turn",
            prompt: "Say OK and nothing else.",
            executionRoute: executionRoutePin(settings, "medium"),
          })

          expect(requests.length).toBeGreaterThan(0)
          expect(requests.every((request) => request.pathname.endsWith("/responses"))).toBe(true)
          expect(result.status).toBe("completed")
          expect(result.events.some((event) => event.type === "model.output.completed" && event.text === "OK")).toBe(
            true,
          )
        }),
      ),
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})
