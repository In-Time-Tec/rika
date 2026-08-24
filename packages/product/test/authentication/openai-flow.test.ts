import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Host, Presenter, Http } from "./openai-service.fixture"
import { Flow } from "./openai-service.fixture"
import { Service, TokenResponse } from "./openai-service.fake"
import { dependencies, provideLayer, unusedHttp, memoryStore } from "./openai-service.harness"
import { expiryJwt, jwt, tokens } from "./openai-flow.fixture"

describe("OpenAI device authentication", () => {
  it.effect("shows the exact anti-phishing device prompt, polls pending, and uses the device redirect", () => {
    let polls = 0
    let prompt: unknown
    let exchangeRedirect = ""
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "device-secret", user_code: "ABCD", interval: "1" }),
      devicePoll: () =>
        Effect.sync(() =>
          ++polls < 3
            ? Option.none()
            : Option.some({
                authorization_code: "authorization-secret",
                code_challenge: "challenge",
                code_verifier: "verifier-secret",
              }),
        ),
      exchange: (input) =>
        Effect.sync(() => {
          exchangeRedirect = input.redirectUri
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const fiber = yield* Effect.forkChild(service.loginDevice)
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(fiber)
      expect(prompt).toEqual({
        verificationUrl: Flow.configuration.deviceVerificationUrl,
        userCode: "ABCD",
        warning:
          "Continue only if you started this login in Rika. If a website or another person gave you this code, cancel.",
      })
      expect(polls).toBe(3)
      expect(exchangeRedirect).toBe(Flow.configuration.deviceExchangeRedirect)
    }).pipe(
      provideLayer(
        dependencies(
          memoryStore().layer,
          http,
          undefined,
          Presenter.of({
            device: (value) =>
              Effect.sync(() => {
                prompt = value
              }),
          }),
        ),
      ),
    )
  })

  it.effect("times device login out with TestClock and remains interruptible while polling", () => {
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "id", user_code: "code", interval: "1" }),
      devicePoll: () => Effect.succeed(Option.none()),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const timed = yield* Effect.forkChild(service.loginDevice)
      yield* TestClock.adjust("5 seconds")
      const error = yield* Effect.flip(Fiber.join(timed))
      expect(error.kind).toBe("timeout")
      expect(error.message).toBe("Device authorization expired")
      const cancelled = yield* Effect.forkChild(service.loginDevice)
      yield* Fiber.interrupt(cancelled)
      const cancelledExit = yield* Fiber.await(cancelled)
      expect(Exit.isFailure(cancelledExit) && Cause.hasInterruptsOnly(cancelledExit.cause)).toBe(true)
    }).pipe(provideLayer(dependencies(memoryStore().layer, http)))
  })

  it.effect("rejects a device authorization poll that completes after expiry", () => {
    let exchanges = 0
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "id", user_code: "code", interval: "1" }),
      devicePoll: () =>
        Effect.sleep("5 seconds").pipe(
          Effect.as(
            Option.some({
              authorization_code: "authorization-secret",
              code_challenge: "challenge",
              code_verifier: "verifier-secret",
            }),
          ),
        ),
      exchange: () =>
        Effect.sync(() => {
          exchanges++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* Service).loginDevice)
      yield* TestClock.adjust("6 seconds")
      const error = yield* Effect.flip(Fiber.join(fiber))
      expect(error.kind).toBe("timeout")
      expect(exchanges).toBe(0)
    }).pipe(provideLayer(dependencies(memoryStore().layer, http)))
  })
})

describe("OpenAI token credentials", () => {
  it.effect("uses access-token expiry without requiring identity claims in that token", () => {
    const store = memoryStore()
    const host = Host.of({
      authorize: (_url, state) => Effect.succeed({ code: Redacted.make("authorization-secret"), state }),
    })
    const http = Http.of({
      ...unusedHttp,
      exchange: () =>
        Effect.succeed({
          access_token: expiryJwt(1_900_000_000),
          id_token: jwt.make("account-secret", "user-secret", 1_800_000_000),
          refresh_token: "refresh-secret",
        }),
    })
    return Effect.gen(function* () {
      const credential = yield* (yield* Service).loginBrowser()
      expect(credential.expiresAt).toBe(1_900_000_000_000)
    }).pipe(provideLayer(dependencies(store.layer, http, host)))
  })

  it.effect("validates token response shape without weakening initial exchange requirements", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeEffect(TokenResponse)({})).toEqual({})
    }),
  )
})
