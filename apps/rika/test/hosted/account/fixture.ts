import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer } from "effect"
import { Http, type HttpInterface, type PrivateJwk, type Profile } from "../../../src/hosted/contract"

export const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
export const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
export const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "organization", organizationId: "org-1" },
}
export const authorization = {
  deviceCode: "device-secret",
  userCode: "ABCD-EFGH",
  verificationUri: "https://hosted.example.test/device",
  expiresIn: 30,
  interval: 1,
}
export const unusedHttp: HttpInterface = {
  register: () => Effect.die("unused"),
  startDeviceAuthorization: () => Effect.die("unused"),
  pollDeviceAuthorization: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  context: () => Effect.die("unused"),
  invite: () => Effect.die("unused"),
  devices: () => Effect.die("unused"),
  revokeDevice: () => Effect.die("unused"),
  revokeAllDevices: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
  putOpenAiAccount: () => Effect.die("unused"),
  getOpenAiAccount: () => Effect.die("unused"),
  revokeOpenAiAccount: () => Effect.die("unused"),
  createProject: () => Effect.die("unused"),
  putEnvironment: () => Effect.die("unused"),
  revokeEnvironment: () => Effect.die("unused"),
}

export const http = (overrides: Partial<HttpInterface> = {}) => Http.of({ ...unusedHttp, ...overrides })
