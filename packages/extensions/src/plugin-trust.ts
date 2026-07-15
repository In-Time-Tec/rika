import { Context, Effect, Layer, Schema } from "effect"

export interface Record {
  readonly workspaceIdentity: string
  readonly extensionId: string
  readonly sourceDigest: string
  readonly configurationDigest: string
  readonly verification: "trusted-local"
  readonly generation: string
  readonly toolSchemaDigest: string
}

export class TrustRequired extends Schema.TaggedErrorClass<TrustRequired>()("@rika/extensions/PluginTrustRequired", {
  workspaceIdentity: Schema.String,
  extensionId: Schema.String,
  sourceDigest: Schema.String,
}) {}

export interface Interface {
  readonly isTrusted: (workspaceIdentity: string, extensionId: string, sourceDigest: string) => Effect.Effect<boolean>
  readonly approve: (workspaceIdentity: string, extensionId: string, sourceDigest: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@rika/extensions/plugin-trust/Service") {}

const key = (workspace: string, extension: string, digest: string) => JSON.stringify([workspace, extension, digest])

export const memoryLayer = (initial: ReadonlyArray<string> = []) =>
  Layer.sync(Service, () => {
    const approved = new Set(initial)
    return Service.of({
      isTrusted: (workspace, extension, digest) => Effect.succeed(approved.has(key(workspace, extension, digest))),
      approve: (workspace, extension, digest) =>
        Effect.sync(() => void approved.add(key(workspace, extension, digest))),
    })
  })
