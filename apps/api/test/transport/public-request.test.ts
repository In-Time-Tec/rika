import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { canonicalPublicRequest } from "../../src/transport/public-request"

it("preserves the original request for explicit local hosts without a public origin", () => {
  const request = new Request("http://127.0.0.1:3000/healthz")
  expect(canonicalPublicRequest({ request, baseUrl: undefined })).toBe(request)
})

it.effect("restores the configured public origin without trusting proxy header claims or changing signed input", () =>
  Effect.gen(function* () {
    const request = new Request("http://api.railway.internal:3000/api/v2/threads/thread%2Fone?after=a%2Fb", {
      method: "POST",
      headers: {
        authorization: "DPoP fixture-access",
        dpop: "fixture-proof",
        "content-type": "application/json",
        forwarded: "proto=http;host=attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-port": "9999",
        "x-forwarded-proto": "http",
      },
      body: '{"input":"preserve this body"}',
      signal: yield* Effect.abortSignal,
    })
    const canonical = canonicalPublicRequest({ request, baseUrl: "https://rika.example.com" })
    expect(canonical.url).toBe("https://rika.example.com/api/v2/threads/thread%2Fone?after=a%2Fb")
    expect(canonical.method).toBe("POST")
    expect(canonical.headers.get("host")).toBe("rika.example.com")
    expect(canonical.headers.get("authorization")).toBe("DPoP fixture-access")
    expect(canonical.headers.get("dpop")).toBe("fixture-proof")
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"])
      expect(canonical.headers.has(name)).toBe(false)
    expect(yield* Effect.tryPromise(() => canonical.text())).toBe('{"input":"preserve this body"}')
  }),
)
