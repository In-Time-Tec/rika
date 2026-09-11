/* oxlint-disable effecttsgo/async-function -- this test consumes the reconstructed Fetch body. */
import { expect, test } from "vitest"
import {
  RIKA_ORIGINAL_AUTHORIZATION,
  RIKA_ORIGINAL_REQUEST_METHOD,
  RIKA_ORIGINAL_REQUEST_URL,
  RIVET_ORIGINAL_REQUEST_URL,
} from "../../src/transport/raw-rivet-gateway"
import { originalRequestForAuthentication } from "../../src/runtime/server"

// ast-grep-ignore: effect-prefer-program-construction -- test consumes a foreign Fetch body.
test("reconstructs the original URL while retaining DPoP request method, headers, and body", async () => {
  const request = new Request("https://rivet.local/gateway/actor/request/sessions/root", {
    method: "GET",
    headers: {
      authorization: "Bearer token",
      dpop: "proof",
      [RIKA_ORIGINAL_REQUEST_METHOD]: "POST",
      [RIKA_ORIGINAL_REQUEST_URL]: "https://rika.test/sessions/root?view=events",
      [RIVET_ORIGINAL_REQUEST_URL]: "https://attacker.test/forged",
    },
  })

  const reconstructed = originalRequestForAuthentication(request)
  expect(reconstructed.url).toBe("https://rika.test/sessions/root?view=events")
  expect(reconstructed.method).toBe("POST")
  expect(reconstructed.headers.get("authorization")).toBe("Bearer token")
  expect(reconstructed.headers.get("dpop")).toBe("proof")
  expect(reconstructed.headers.get(RIKA_ORIGINAL_REQUEST_METHOD)).toBeNull()
})

// ast-grep-ignore: effect-prefer-program-construction -- test consumes a foreign Fetch body.
test("restores a DPoP authorization after the Rivet bearer transport normalization", async () => {
  const request = new Request("https://rivet.local/gateway/actor/request/sessions/root", {
    method: "POST",
    headers: {
      authorization: "Bearer access-token",
      dpop: "proof",
      [RIKA_ORIGINAL_AUTHORIZATION]: "DPoP access-token",
      [RIKA_ORIGINAL_REQUEST_METHOD]: "POST",
      [RIKA_ORIGINAL_REQUEST_URL]: "https://rika.test/sessions/root?view=events",
    },
    body: "prompt",
  })

  const reconstructed = originalRequestForAuthentication(request)
  expect(reconstructed.headers.get("authorization")).toBe("DPoP access-token")
  expect(reconstructed.headers.get("dpop")).toBe("proof")
  expect(reconstructed.headers.get(RIKA_ORIGINAL_AUTHORIZATION)).toBeNull()
  expect(reconstructed.headers.get(RIKA_ORIGINAL_REQUEST_METHOD)).toBeNull()
  expect(reconstructed.headers.get(RIKA_ORIGINAL_REQUEST_URL)).toBeNull()
  expect(await reconstructed.text()).toBe("prompt")
})

test("does not trust a forged Rivet internal original URL when the application context is absent", () => {
  const request = new Request("https://rivet.local/request/sessions/root", {
    headers: { [RIVET_ORIGINAL_REQUEST_URL]: "https://attacker.test/forged" },
  })
  expect(originalRequestForAuthentication(request).url).toBe("https://rivet.local/request/sessions/root")
})
