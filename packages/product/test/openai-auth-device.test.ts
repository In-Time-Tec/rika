import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { Presenter, Http } from "./openai-auth-test-contract"
import { Flow } from "./openai-auth-test-contract"
import { Service } from "./openai-auth-test-service"
import { dependencies, provideLayer, unusedHttp, memoryStore } from "./openai-auth-test-layers"
import { tokens } from "./openai-auth-test-credentials"

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
