import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Sha256 } from "../src/server/server-service-sha256"
import { Sha256Bun } from "../src/server/server-service-sha256-bun"
import { Sha256Node } from "../src/server/server-service-sha256-node"
import { Sha256Web } from "../src/server/server-service-sha256-web"

const vectors: ReadonlyArray<{ readonly token: string; readonly fields: ReadonlyArray<string | number> }> = [
  { token: "token", fields: ["rika-server-client", 8, "identity", "nonce", "run", "launch", "build"] },
  {
    token: "tok3n",
    fields: [
      "rika-server-response",
      8,
      "ident",
      "nonce",
      "product",
      "reattach",
      "build",
      "accepted",
      "absent",
      "service-nonce",
      "connection",
      8,
      "build",
      123,
    ],
  },
  { token: "x".repeat(64), fields: ["interactive", 8, "identity", "nonce", "desktop", "launch", "build"] },
  { token: "token-with-emoji-🙂", fields: ["web", 8, "identity", "nonce", "thread-continue", "reattach", "build"] },
]

const knownAnswerFields = ["rika-server-client", 8, "identity-1", "nonce-1", "run", "launch", "rika-development-build"]
const knownAnswer = "dad405de1e8eef8652d846d8ed4b571b1c0425b8ce7916525f4f54daf874ae48"
const knownAnswerMessage = JSON.stringify(knownAnswerFields)
const vectorMessages = vectors.map((vector) => JSON.stringify(vector.fields))

const proofEquivalenceToken = "proof-equivalence-token"
const proofEquivalenceClientFields = ["rika-server-client", 8, "identity", "nonce", "web", "launch", "build-a"]
const proofEquivalenceServerFields = [
  "rika-server-response",
  8,
  "identity",
  "nonce",
  "web",
  "launch",
  "build-a",
  "accepted",
  "absent",
  "service-nonce",
  "connection",
  8,
  "build-a",
  "absent",
]
const proofEquivalenceMessages = [
  JSON.stringify(proofEquivalenceClientFields),
  JSON.stringify(proofEquivalenceServerFields),
]

describe("Rika Server handshake digest equivalence", () => {
  it.effect("matches the precomputed HMAC-SHA256 known answer", () =>
    Effect.gen(function* () {
      for (const implementation of [Sha256Bun, Sha256Node, Sha256Web]) {
        const digest = yield* implementation.hmac("known-answer-token", knownAnswerMessage)
        expect(digest).toBe(knownAnswer)
      }
    }).pipe(Effect.provideService(Sha256, Sha256Bun)),
  )

  it.effect("produces byte-identical proofs across Bun, Node, and Web digests", () =>
    Effect.gen(function* () {
      for (const [index, vector] of vectors.entries()) {
        const message = vectorMessages[index]!
        const bun = yield* Sha256Bun.hmac(vector.token, message)
        const node = yield* Sha256Node.hmac(vector.token, message)
        const web = yield* Sha256Web.hmac(vector.token, message)
        expect(node).toBe(bun)
        expect(web).toBe(bun)
        expect(bun).toMatch(/^[a-f0-9]{64}$/)
      }
    }),
  )

  it.effect("agrees on full client and server proof construction", () =>
    Effect.gen(function* () {
      for (const message of proofEquivalenceMessages) {
        const bun = yield* Sha256Bun.hmac(proofEquivalenceToken, message)
        const node = yield* Sha256Node.hmac(proofEquivalenceToken, message)
        const web = yield* Sha256Web.hmac(proofEquivalenceToken, message)
        expect(node).toBe(bun)
        expect(web).toBe(bun)
        expect(bun).toMatch(/^[a-f0-9]{64}$/)
      }
    }),
  )
})
