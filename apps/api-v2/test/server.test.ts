/* oxlint-disable effecttsgo/async-function -- this test consumes the reconstructed Fetch body. */
import { expect, test } from "vitest"
import { RIKA_ORIGINAL_REQUEST_URL, RIVET_ORIGINAL_REQUEST_URL } from "../src/hosted/raw-rivet-gateway"
import { originalRequestForAuthentication } from "../src/hosted/server"

// ast-grep-ignore: effect-prefer-program-construction -- test consumes a foreign Fetch body.
test("reconstructs the original URL while retaining DPoP request method, headers, and body", async () => {
  const request = new Request("https://rivet.local/gateway/actor/request/sessions/root", {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      dpop: "proof",
      [RIKA_ORIGINAL_REQUEST_URL]: "https://rika.test/sessions/root?view=events",
      [RIVET_ORIGINAL_REQUEST_URL]: "https://attacker.test/forged",
    },
    body: "prompt",
  })

  const reconstructed = originalRequestForAuthentication(request)
  expect(reconstructed.url).toBe("https://rika.test/sessions/root?view=events")
  expect(reconstructed.method).toBe("POST")
  expect(reconstructed.headers.get("authorization")).toBe("Bearer token")
  expect(reconstructed.headers.get("dpop")).toBe("proof")
  expect(await reconstructed.text()).toBe("prompt")
})

test("does not trust a forged Rivet internal original URL when the application context is absent", () => {
  const request = new Request("https://rivet.local/request/sessions/root", {
    headers: { [RIVET_ORIGINAL_REQUEST_URL]: "https://attacker.test/forged" },
  })
  expect(originalRequestForAuthentication(request).url).toBe("https://rivet.local/request/sessions/root")
})
