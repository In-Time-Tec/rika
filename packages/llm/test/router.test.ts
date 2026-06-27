import { describe, expect, test } from "bun:test"
import { Config } from "@rika/core"
import { Effect, Layer, Stream } from "effect"
import { Provider, Router } from "../src/index"

const configLayer = Config.layerFromValues(
  {
    workspace_root: "/workspace",
    data_dir: "/workspace/.rika",
    default_mode: "smart",
  },
  {},
)

const messages: ReadonlyArray<Provider.Message> = [{ role: "user", content: "ship it" }]

const routerLayer = Router.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(Provider.fakeLayer(["done"])))

describe("LLM Router", () => {
  test("routes default requests through the configured default mode", async () => {
    const routed = await Effect.runPromise(Router.route({ messages }).pipe(Effect.provide(routerLayer)))

    expect(routed).toMatchObject({
      mode: "smart",
      provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "medium",
      max_output_tokens: 12_000,
      messages,
    })
  })

  test("lets callers override mode, provider, model, and budgets", async () => {
    const routed = await Effect.runPromise(
      Router.route({
        mode: "deep",
        provider: "openai",
        model: "custom-model",
        messages,
        reasoning_effort: "xhigh",
        max_output_tokens: 99,
        temperature: 0.1,
      }).pipe(Effect.provide(routerLayer)),
    )

    expect(routed).toMatchObject({
      mode: "deep",
      provider: "openai",
      model: "custom-model",
      reasoning_effort: "xhigh",
      max_output_tokens: 99,
      temperature: 0.1,
    })
  })

  test("complete depends only on the router service and fake provider layer", async () => {
    const response = await Effect.runPromise(
      Router.complete({ mode: "rush", messages }).pipe(Effect.provide(routerLayer)),
    )

    expect(response).toMatchObject({ provider: "openai", model: "gpt-5.5", content: "done" })
  })

  test("stream emits normalized provider stream events", async () => {
    const events = await Effect.runPromise(
      Router.stream({ messages }).pipe(Stream.runCollect, Effect.provide(routerLayer)),
    )

    expect(Array.from(events).map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.completed",
    ])
  })

  test("fails explicitly when routed provider does not match the provided layer", async () => {
    const result = await Effect.runPromiseExit(
      Router.complete({ provider: "other", messages }).pipe(Effect.provide(routerLayer)),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("other")
      expect(result.cause.toString()).toContain("openai")
    }
  })
})
