import { Context, Effect, Option, Redacted, Schema } from "effect"

export class ProviderCredentialStoreError extends Schema.TaggedError<ProviderCredentialStoreError>()(
  "ProviderCredentialStoreError",
  { kind: Schema.Literals(["corrupt", "io", "missing", "unsafe"]), message: Schema.String },
) {}

export interface ProviderCredentialStoreService {
  readonly load: (
    identity: string,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, ProviderCredentialStoreError>
  readonly save: (
    identity: string,
    apiKey: Redacted.Redacted<string>,
  ) => Effect.Effect<void, ProviderCredentialStoreError>
  readonly remove: (identity: string) => Effect.Effect<boolean, ProviderCredentialStoreError>
}

export class ProviderCredentialStore extends Context.Service<ProviderCredentialStore, ProviderCredentialStoreService>()(
  "@rika/product/authentication/credential-store/ProviderCredentialStore",
) {}
