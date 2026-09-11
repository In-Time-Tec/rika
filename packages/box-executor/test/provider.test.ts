import { Clock, Effect, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  BoxId,
  CreateRequest,
  ForkRequest,
  ResumeRequest,
  SafeForkBody,
  idempotencyWindowMillis,
} from "../src/contract"
import { BoxTransportError, bunFetchTransport, makeBoxHttpProvider, maxProviderResponseBytes } from "../src/provider"

const createdBox = {
  id: "bx_abcdefgh",
  state: "provisioning",
  desktopAvailable: false,
  snapshotAvailable: false,
}

const json = (value: Schema.Json, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const createRequest = (from: string, issuedAtMillis = 0) =>
  Schema.decodeSync(CreateRequest)({
    idempotencyKey: "create-intent-1",
    issuedAtMillis,
    expiresAtMillis: issuedAtMillis + idempotencyWindowMillis,
    body: { from, noEnv: true, env: {}, ttlSeconds: 3_600 },
  })

const requestText = (request: Request) =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: () => BoxTransportError.make({ message: "Test transport failed" }),
  })

it.effect("retries a lost create acknowledgement with the exact key and body and rejects key reuse", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly key: string | null; readonly body: string }> = []
    let retainedBody: string | undefined
    let firstAcknowledgementLost = true
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      retryAttempts: 3,
      retryDelayMillis: 0,
      transport: {
        request: (request) =>
          requestText(request).pipe(
            Effect.map((body) => {
              const key = request.headers.get("idempotency-key")
              requests.push({ key, body })
              if (retainedBody !== undefined && retainedBody !== body)
                return json(
                  {
                    ok: false,
                    type: "box.error",
                    status: 409,
                    code: "idempotency_key_reused",
                    message: "reused",
                    error: { code: "idempotency_key_reused", message: "reused", status: 409 },
                    requestId: "req_reused",
                  },
                  409,
                )
              retainedBody = body
              if (firstAcknowledgementLost) {
                firstAcknowledgementLost = false
                return json(
                  {
                    ok: false,
                    type: "box.error",
                    status: 503,
                    code: "provider_unavailable",
                    message: "lost",
                    error: { code: "provider_unavailable", message: "lost", status: 503 },
                    requestId: "req_lost",
                  },
                  503,
                )
              }
              return json({ ok: true, type: "box.created", status: "provisioning", box: createdBox }, 202)
            }),
          ),
      },
    })
    const created = yield* provider.create(createRequest("clean-template"))
    expect(created.id).toBe("bx_abcdefgh")
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]?.key).toBe("create-intent-1")
    expect(requests[0]?.body).toBe('{"from":"clean-template","noEnv":true,"env":{},"ttlSeconds":3600}')

    const mismatch = yield* Effect.result(provider.create(createRequest("different-template")))
    expect(mismatch).toMatchObject({
      _tag: "Failure",
      failure: { kind: "idempotency-reused", code: "idempotency_key_reused" },
    })
    expect(requests).toHaveLength(3)
  }),
)

it.effect("refuses an expired billable intent before issuing another HTTP request", () =>
  Effect.gen(function* () {
    let requests = 0
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      transport: {
        request: () =>
          Effect.sync(() => {
            requests += 1
            return json({ ok: true, type: "box.created", status: "provisioning", box: createdBox }, 202)
          }),
      },
    })
    yield* TestClock.setTime(idempotencyWindowMillis)
    const result = yield* Effect.result(provider.create(createRequest("clean-template")))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "idempotency-expired" } })
    expect(requests).toBe(0)
  }),
)

it.effect("refuses a future-dated billable window before issuing an HTTP request", () =>
  Effect.gen(function* () {
    let requests = 0
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      transport: {
        request: () =>
          Effect.sync(() => {
            requests += 1
            return json({ ok: true, box: createdBox }, 202)
          }),
      },
    })

    const result = yield* Effect.result(provider.create(createRequest("clean-template", 1)))

    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-request" } })
    expect(requests).toBe(0)
  }),
)

it.effect("reports an unknown resume outcome without repeating the non-idempotent request", () =>
  Effect.gen(function* () {
    let requests = 0
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      transport: {
        request: () =>
          Effect.sync(() => {
            requests += 1
            return json(
              {
                ok: false,
                type: "box.error",
                status: 503,
                code: "provider_unavailable",
                message: "unavailable",
                error: { code: "provider_unavailable", message: "unavailable", status: 503 },
                requestId: "req_resume_unknown",
              },
              503,
            )
          }),
      },
    })
    const boxId = yield* Schema.decodeEffect(BoxId)("bx_23456789")
    const request = yield* Schema.decodeEffect(ResumeRequest)({
      boxId,
      body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
    })
    const result = yield* Effect.result(provider.resume(request))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "outcome-unknown" } })
    expect(requests).toBe(1)
  }),
)

it.effect("bounds a chunked response without relying on Content-Length", () =>
  Effect.gen(function* () {
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      transport: {
        request: () =>
          Effect.succeed(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(100_000))
                  controller.enqueue(new Uint8Array(100_000))
                  controller.close()
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      },
    })
    const boxId = yield* Schema.decodeEffect(BoxId)("bx_abcdefgh")
    const result = yield* Effect.result(provider.get(boxId))

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-response", status: 200, message: "Box response exceeded the byte bound" },
    })
    expect(maxProviderResponseBytes).toBe(131_072)
  }),
)

it.live("times out and cancels a stalled body, then retries the exact billable request", () =>
  Effect.gen(function* () {
    const issuedAtMillis = yield* Clock.currentTimeMillis
    const requests: Array<{ readonly key: string | null; readonly body: string }> = []
    let bodyCancelled = false
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      requestTimeoutMillis: 20,
      retryAttempts: 2,
      retryDelayMillis: 0,
      transport: {
        request: (request) =>
          Effect.tryPromise({
            try: () => request.text(),
            catch: () => BoxTransportError.make({ message: "Test transport failed" }),
          }).pipe(
            Effect.map((body) => {
              requests.push({ key: request.headers.get("idempotency-key"), body })
              if (requests.length === 1)
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode('{"box":'))
                    },
                    cancel() {
                      bodyCancelled = true
                    },
                  }),
                  { status: 201, headers: { "content-type": "application/json" } },
                )
              return Response.json({ box: { ...createdBox, id: "bx_bcdefghj" } })
            }),
          ),
      },
    })

    const box = yield* provider.create(createRequest("stalled-response", issuedAtMillis))

    expect(box.id).toBe("bx_bcdefghj")
    expect(bodyCancelled).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
  }),
)

it.live("retries an unreadable billable response with the exact request", () =>
  Effect.gen(function* () {
    const issuedAtMillis = yield* Clock.currentTimeMillis
    const requests: Array<{ readonly key: string | null; readonly body: string }> = []
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      retryAttempts: 2,
      retryDelayMillis: 0,
      transport: {
        request: (request) =>
          Effect.tryPromise({
            try: () => request.text(),
            catch: () => BoxTransportError.make({ message: "Test transport failed" }),
          }).pipe(
            Effect.map((body) => {
              requests.push({ key: request.headers.get("idempotency-key"), body })
              if (requests.length === 1)
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.error(new Error("untrusted provider body error"))
                    },
                  }),
                  { status: 201, headers: { "content-type": "application/json" } },
                )
              return Response.json({ box: { ...createdBox, id: "bx_cdefghjk" } })
            }),
          ),
      },
    })

    const box = yield* provider.create(createRequest("unreadable-response", issuedAtMillis))

    expect(box.id).toBe("bx_cdefghjk")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
  }),
)

it("requires noEnv, an empty environment, and a finite bounded TTL", () => {
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: 3_600 })).toBe(true)
  expect(Schema.is(SafeForkBody)({ noEnv: false, env: {}, ttlSeconds: 3_600 })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: { EXTRA: "present" }, ttlSeconds: 3_600 })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: null })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: Number.NaN })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: Number.POSITIVE_INFINITY })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: 3_600.5 })).toBe(false)
  expect(Schema.is(SafeForkBody)({ noEnv: true, env: {}, ttlSeconds: 86_401 })).toBe(false)
})

it("rejects non-finite, fractional, and out-of-range HTTP policy options", () => {
  const options = {
    baseUrl: "http://box.invalid",
    apiKey: Redacted.make(""),
    transport: bunFetchTransport,
  }

  expect(() => makeBoxHttpProvider({ ...options, requestTimeoutMillis: Number.NaN })).toThrow(RangeError)
  expect(() => makeBoxHttpProvider({ ...options, requestTimeoutMillis: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  expect(() => makeBoxHttpProvider({ ...options, retryAttempts: 1.5 })).toThrow(RangeError)
  expect(() => makeBoxHttpProvider({ ...options, retryAttempts: 0 })).toThrow(RangeError)
  expect(() => makeBoxHttpProvider({ ...options, retryDelayMillis: -1 })).toThrow(RangeError)
})

it.effect("keeps an invalid successful create acknowledgement unknown without exposing its bytes", () =>
  Effect.gen(function* () {
    const untrusted = "provider-private-response-payload"
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      retryAttempts: 1,
      transport: {
        request: () => Effect.succeed(new Response(untrusted, { status: 201 })),
      },
    })

    const result = yield* Effect.result(provider.create(createRequest("invalid-success")))

    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "retry-exhausted" } })
    if (result._tag === "Failure") {
      expect(result.failure.message).not.toContain(untrusted)
      expect(result.failure.code).toBeUndefined()
    }
  }),
)

it.effect("keeps an invalid successful fork acknowledgement unknown under its exact identity", () =>
  Effect.gen(function* () {
    const sourceBoxId = yield* Schema.decodeEffect(BoxId)("bx_23456789")
    const request = yield* Schema.decodeEffect(ForkRequest)({
      sourceBoxId,
      idempotencyKey: "fork-invalid-success",
      issuedAtMillis: 0,
      expiresAtMillis: idempotencyWindowMillis,
      body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
    })
    const observed: Array<{ readonly key: string | null; readonly body: string }> = []
    const provider = makeBoxHttpProvider({
      baseUrl: "http://box.invalid",
      apiKey: Redacted.make(""),
      retryAttempts: 2,
      retryDelayMillis: 0,
      transport: {
        request: (httpRequest) =>
          Effect.tryPromise({
            try: () => httpRequest.text(),
            catch: () => BoxTransportError.make({ message: "Test transport failed" }),
          }).pipe(
            Effect.map((body) => {
              observed.push({ key: httpRequest.headers.get("idempotency-key"), body })
              return new Response("not-a-box-response", { status: 201 })
            }),
          ),
      },
    })

    const result = yield* Effect.result(provider.fork(request))

    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "retry-exhausted" } })
    expect(observed).toHaveLength(2)
    expect(observed[1]).toEqual(observed[0])
    expect(observed[0]).toEqual({
      key: "fork-invalid-success",
      body: '{"noEnv":true,"env":{},"ttlSeconds":3600}',
    })
  }),
)
