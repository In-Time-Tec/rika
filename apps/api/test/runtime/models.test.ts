import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { it } from "@effect/vitest"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LanguageModel } from "effect/unstable/ai"
import { ModelRegistry } from "generalist"
import { expect } from "vitest"
import {
  ModelCredentialResolutionError,
  modelRegistryLayer,
  type ModelCredentialAccess,
  type ModelRegistryLayerOptions,
} from "../../src/runtime/models"

const model = {
  selection: { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
  settings: { temperature: 0.25, maxOutputTokens: 42, reasoningEffort: "max" },
  credentialRefs: [{ provider: "openai", reference: "credential://owner/openai/current" }],
} as const

const response = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: 42,
        model: "gpt-6-astra",
        output: [
          {
            id: "msg_test",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", annotations: [], logprobs: [], text: "ready" }],
          },
        ],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: "max", summary: null },
        store: true,
        temperature: 0.25,
        text: { format: { type: "text" }, verbosity: "medium" },
        tool_choice: "auto",
        tools: [],
        top_p: 1,
        truncation: "disabled",
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
        metadata: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )

const registryModel = (options: ModelRegistryLayerOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(modelRegistryLayer(options))
      const registry = Context.get(context, ModelRegistry.ModelRegistry)
      return yield* registry.withModel(options.model.selection, Effect.service(LanguageModel.LanguageModel))
    }),
  )

it.effect("registers the selected model without resolving a credential or calling its provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* Ref.make(0)
      const requests = yield* Ref.make(0)
      const credentials: ModelCredentialAccess = {
        resolve: () =>
          Effect.acquireRelease(
            Effect.as(
              Ref.update(resolved, (count) => count + 1),
              Redacted.make("test"),
            ),
            () => Effect.void,
          ),
      }
      const context = yield* Layer.build(
        modelRegistryLayer({
          ownerId: "owner",
          model,
          credentials,
          httpClientLayer: Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.as(
                Ref.update(requests, (count) => count + 1),
                response(request),
              ),
            ),
          ),
        }),
      )
      const registry = Context.get(context, ModelRegistry.ModelRegistry)
      yield* registry.withModel(model.selection, Effect.service(LanguageModel.LanguageModel))
      expect(yield* Ref.get(resolved)).toBe(0)
      expect(yield* Ref.get(requests)).toBe(0)
      expect(yield* registry.registrations).toMatchObject([
        { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
      ])
    }),
  ),
)

it.effect("uses the selected OpenAI model settings and resolves a live credential per request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<{ readonly authorization: string | undefined; readonly body: unknown }> = []
      const resolutions: Array<Parameters<ModelCredentialAccess["resolve"]>[0]> = []
      let releases = 0
      let credentialNumber = 0
      const credentials: ModelCredentialAccess = {
        resolve: (input) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              resolutions.push(input)
              credentialNumber += 1
              return Redacted.make(`test-${credentialNumber}`)
            }),
            () =>
              Effect.sync(() => {
                releases += 1
              }),
          ),
      }
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const body =
              request.body._tag === "Uint8Array"
                ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
                    new TextDecoder().decode(request.body.body),
                  ).pipe(Effect.orDie)
                : undefined
            requests.push({
              authorization: request.headers.authorization,
              body,
            })
            return response(request)
          }),
        ),
      )
      const options = { ownerId: "owner", model, credentials, httpClientLayer }
      const languageModel = yield* registryModel(options)
      yield* languageModel.generateText({ prompt: "first" })
      yield* languageModel.generateText({ prompt: "second" })
      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.authorization)).toEqual(["Bearer test-1", "Bearer test-2"])
      expect(requests[0]?.body).toMatchObject({
        model: "gpt-6-astra",
        temperature: 0.25,
        max_output_tokens: 42,
        reasoning: { effort: "max" },
      })
      expect(resolutions).toEqual([
        {
          ownerId: "owner",
          selection: { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
          reference: { provider: "openai", reference: "credential://owner/openai/current" },
        },
        {
          ownerId: "owner",
          selection: { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
          reference: { provider: "openai", reference: "credential://owner/openai/current" },
        },
      ])
      expect(releases).toBe(2)
    }),
  ),
)

for (const reason of ["missing", "revoked"] as const) {
  it.effect(`fails closed for a ${reason} credential before calling the provider`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Ref.make(0)
        const credentials: ModelCredentialAccess = {
          resolve: () =>
            Effect.fail(ModelCredentialResolutionError.make({ reason, message: "Credential access is unavailable" })),
        }
        const languageModel = yield* registryModel({
          ownerId: "owner",
          model,
          credentials,
          httpClientLayer: Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.as(
                Ref.update(requests, (count) => count + 1),
                response(request),
              ),
            ),
          ),
        })
        expect((yield* Effect.result(languageModel.generateText({ prompt: "blocked" })))._tag).toBe("Failure")
        expect(yield* Ref.get(requests)).toBe(0)
      }),
    ),
  )
}

it.effect("rejects a selected model without a matching secure credential reference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Layer.build(
          modelRegistryLayer({
            ownerId: "owner",
            model: { ...model, credentialRefs: [] },
            credentials: { resolve: () => Effect.die("Credential resolution must not be reached") },
          }),
        ),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RikaApiV2ModelRegistryConfigurationError", reason: "credential" },
      })
    }),
  ),
)
