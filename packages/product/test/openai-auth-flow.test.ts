import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, Redacted, Flow } from "./openai-auth-support"
import { digest } from "./openai-auth-support"

describe("OpenAI authentication flow", () => {
  it.effect("creates independent deterministic PKCE values and the exact S256 challenge", () =>
    Effect.gen(function* () {
      const first = yield* Flow.Flow.makePkce
      const second = yield* Flow.Flow.makePkce
      expect(Redacted.value(first.verifier)).not.toBe(Redacted.value(first.state))
      expect(Redacted.value(first.state)).not.toBe(Redacted.value(second.state))
      const expected = Encoding.encodeBase64Url(
        new Uint8Array(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(first.verifier))),
          ),
        ),
      )
      expect(first.challenge).toBe(expected)
      expect(Redacted.value(first.verifier)).toHaveLength(86)
      expect(Redacted.value(first.state)).toHaveLength(43)
    }).pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (() => {
            let next = 0
            return (size: number) => Uint8Array.from({ length: size }, () => next++ & 255)
          })(),
          digest,
        }),
      ),
    ),
  )

  it("constructs the exact Codex authorization request without exposing redacted state", () => {
    const state = Redacted.make("private-state")
    const url = Flow.Flow.authorizationUrl("challenge", state)
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: Flow.configuration.clientId,
      redirect_uri: Flow.configuration.redirectUri,
      scope: Flow.configuration.scopes,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "private-state",
      originator: Flow.configuration.originator,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    })
    expect(String(state)).not.toContain("private-state")
  })
})
