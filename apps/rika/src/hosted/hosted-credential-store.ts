import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { CredentialStore, HostedError, PrivateJwk, type Credential } from "./hosted-contract"

const service = "com.rika.cli"
const CredentialDisk = Schema.Struct({
  formatVersion: Schema.Literal(1),
  refreshToken: Schema.String,
  privateJwk: PrivateJwk,
})

export interface SecretVault {
  readonly get: (options: { readonly service: string; readonly name: string }) => Promise<string | null>
  readonly set: (options: { readonly service: string; readonly name: string; readonly value: string }) => Promise<void>
  readonly delete: (options: { readonly service: string; readonly name: string }) => Promise<boolean>
}

const liveVault = (Bun as unknown as { readonly secrets: SecretVault }).secrets
const name = (origin: string, deviceId: string) => `${new URL(origin).origin}/${deviceId}`
const failure = (message: string) => HostedError.make({ kind: "storage", message })

export const layer = (vault: SecretVault = liveVault) =>
  Layer.sync(CredentialStore, () => {
    const load = Effect.fn("HostedCredentialStore.load")(function* (origin: string, deviceId: string) {
      const identity = name(origin, deviceId)
      const stored = yield* Effect.tryPromise({
        try: () => vault.get({ service, name: identity }),
        catch: () => failure("Platform credential storage is unavailable"),
      })
      if (stored === null) return Option.none<Credential>()
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialDisk))(stored).pipe(
        Effect.mapError(() => failure("Hosted credentials are corrupt")),
      )
      return Option.some({
        refreshToken: Redacted.make(decoded.refreshToken),
        privateJwk: decoded.privateJwk,
      })
    })
    const save = Effect.fn("HostedCredentialStore.save")(function* (
      origin: string,
      deviceId: string,
      credential: Credential,
    ) {
      const identity = name(origin, deviceId)
      const value = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDisk))({
        formatVersion: 1,
        refreshToken: Redacted.value(credential.refreshToken),
        privateJwk: credential.privateJwk,
      }).pipe(Effect.mapError(() => failure("Hosted credentials could not be encoded")))
      yield* Effect.tryPromise({
        try: () => vault.set({ service, name: identity, value }),
        catch: () => failure("Platform credential storage is unavailable"),
      })
    })
    const remove = Effect.fn("HostedCredentialStore.remove")(function* (origin: string, deviceId: string) {
      const identity = name(origin, deviceId)
      return yield* Effect.tryPromise({
        try: () => vault.delete({ service, name: identity }),
        catch: () => failure("Platform credential storage is unavailable"),
      })
    })
    return CredentialStore.of({ load, save, remove })
  })
