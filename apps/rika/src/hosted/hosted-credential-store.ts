import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { ForegroundLocalExecutorSnapshot } from "@rika/remote-execution/foreground"
import {
  CredentialStore,
  HostedError,
  LocalExecutorReceiptStore,
  PrivateJwk,
  type Credential,
} from "./hosted-contract"

const service = "com.rika.cli"
const receiptService = "com.rika.cli.local-executor"
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

const liveVault: SecretVault =
  (globalThis as typeof globalThis & { readonly Bun?: { readonly secrets?: SecretVault } }).Bun?.secrets ?? {
    get: () => Promise.resolve(null),
    set: () => Promise.reject(new Error("Platform credential storage is unavailable")),
    delete: () => Promise.resolve(false),
  }
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

export const receiptLayer = (vault: SecretVault = liveVault) =>
  Layer.sync(LocalExecutorReceiptStore, () => {
    const load = Effect.fn("HostedLocalExecutorReceiptStore.load")(function* (scope: string) {
      const stored = yield* Effect.tryPromise({
        try: () => vault.get({ service: receiptService, name: scope }),
        catch: () => failure("Platform receipt storage is unavailable"),
      })
      if (stored === null) return Option.none<ForegroundLocalExecutorSnapshot>()
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ForegroundLocalExecutorSnapshot))(stored).pipe(
        Effect.mapError(() => failure("Local executor receipts are corrupt")),
      )
      return Option.some(decoded)
    })
    const save = Effect.fn("HostedLocalExecutorReceiptStore.save")(function* (
      scope: string,
      snapshot: ForegroundLocalExecutorSnapshot,
    ) {
      const value = yield* Schema.encodeEffect(Schema.fromJsonString(ForegroundLocalExecutorSnapshot))(snapshot).pipe(
        Effect.mapError(() => failure("Local executor receipts could not be encoded")),
      )
      yield* Effect.tryPromise({
        try: () => vault.set({ service: receiptService, name: scope, value }),
        catch: () => failure("Platform receipt storage is unavailable"),
      })
    })
    const remove = Effect.fn("HostedLocalExecutorReceiptStore.remove")(function* (scope: string) {
      return yield* Effect.tryPromise({
        try: () => vault.delete({ service: receiptService, name: scope }),
        catch: () => failure("Platform receipt storage is unavailable"),
      })
    })
    return LocalExecutorReceiptStore.of({ load, save, remove })
  })
