import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider"
import type { IdentityConfig } from "../config"

export interface CliInstallRegistration {
  readonly client_name: string
  readonly application_type: "native"
  readonly token_endpoint_auth_method: "none"
  readonly grant_types: ReadonlyArray<typeof DEVICE_CODE_GRANT_TYPE | "refresh_token">
  readonly scope: string
  readonly software_id: "rika-cli"
  readonly software_version?: string
  readonly dpop_bound_access_tokens: true
  readonly resources: ReadonlyArray<string>
}

export interface CliInstallRegistrationRequest {
  readonly endpoint: string
  readonly body: CliInstallRegistration
}

export interface CliTokenRevocationRequest {
  readonly endpoint: string
  readonly body: {
    readonly client_id: string
    readonly token: string
    readonly token_type_hint: "access_token" | "refresh_token"
  }
}

export interface CliClientRegistrationRevocationUnsupported {
  readonly _tag: "unsupported"
  readonly reason: "better-auth-1.7.1-does-not-issue-registration-management-credentials"
}

export const cliInstallRegistrationRequest = (input: {
  readonly config: Pick<IdentityConfig, "baseUrl" | "resource">
  readonly softwareVersion?: string
}): CliInstallRegistrationRequest => ({
  endpoint: `${input.config.baseUrl}/api/auth/oauth2/register`,
  body: {
    client_name: "Rika CLI",
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
    scope: "openid profile email offline_access account",
    software_id: "rika-cli",
    ...(input.softwareVersion === undefined ? {} : { software_version: input.softwareVersion }),
    dpop_bound_access_tokens: true,
    resources: [input.config.resource],
  },
})

export const cliTokenRevocationRequest = (input: {
  readonly config: Pick<IdentityConfig, "baseUrl">
  readonly clientId: string
  readonly token: string
  readonly tokenType: "access_token" | "refresh_token"
}): CliTokenRevocationRequest => ({
  endpoint: `${input.config.baseUrl}/api/auth/oauth2/revoke`,
  body: {
    client_id: input.clientId,
    token: input.token,
    token_type_hint: input.tokenType,
  },
})

export const cliClientRegistrationRevocation = (): CliClientRegistrationRevocationUnsupported => ({
  _tag: "unsupported",
  reason: "better-auth-1.7.1-does-not-issue-registration-management-credentials",
})
