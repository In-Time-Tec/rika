import { describe, expect, it } from "@effect/vitest"
import {
  cliClientRegistrationRevocation,
  cliInstallRegistrationRequest,
  cliTokenRevocationRequest,
} from "../../src/device/cli"

const identity = {
  baseUrl: "https://api.example.com",
  resource: "https://api.example.com/api/v1",
}

describe("CLI device companion", () => {
  it("builds a distinct public DPoP registration request for each installation", () => {
    const request = cliInstallRegistrationRequest({ config: identity, softwareVersion: "1.2.3" })
    expect(request).toEqual({
      endpoint: "https://api.example.com/api/auth/oauth2/register",
      body: {
        client_name: "Rika CLI",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        scope: "openid profile email offline_access account",
        software_id: "rika-cli",
        software_version: "1.2.3",
        dpop_bound_access_tokens: true,
        resources: ["https://api.example.com/api/v1"],
      },
    })
  })

  it("builds RFC 7009 public-client token revocation", () => {
    expect(
      cliTokenRevocationRequest({
        config: identity,
        clientId: "client-1",
        token: "token-1",
        tokenType: "refresh_token",
      }),
    ).toEqual({
      endpoint: "https://api.example.com/api/auth/oauth2/revoke",
      body: {
        client_id: "client-1",
        token: "token-1",
        token_type_hint: "refresh_token",
      },
    })
  })

  it("reports registration deletion as explicitly unsupported", () => {
    expect(cliClientRegistrationRevocation()).toEqual({
      _tag: "unsupported",
      reason: "better-auth-1.7.1-does-not-issue-registration-management-credentials",
    })
  })
})
