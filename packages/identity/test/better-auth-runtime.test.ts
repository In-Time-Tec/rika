import { describe, expect, it } from "vitest"
import { identityOAuthResourceContract } from "../src/better-auth-runtime"

describe("identity OAuth resource contract", () => {
  it("pins the Better Auth issuer and JWKS below its public base path", () => {
    expect(
      identityOAuthResourceContract({
        baseUrl: "https://rika-app.up.railway.app",
        resource: "https://rika-app.up.railway.app/api/v1",
      }),
    ).toEqual({
      resource: "https://rika-app.up.railway.app/api/v1",
      issuer: "https://rika-app.up.railway.app/api/auth",
      jwksUrl: "https://rika-app.up.railway.app/api/auth/jwks",
    })
  })
})
