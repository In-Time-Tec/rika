import { Context, Crypto, Effect, Encoding, Layer, Path, Schema } from "effect"
import type { LocalServer } from "./mcp-config"

export interface Record {
  readonly workspaceIdentity: string
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environmentNameFingerprint: string
  readonly effectiveCwd: string
  readonly sourceDigest: string
  readonly fingerprint: string
}

export class TrustError extends Schema.TaggedErrorClass<TrustError>()("@rika/extensions/McpTrustError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (
    workspaceIdentity: string,
    workspaceRoot: string,
    server: LocalServer,
  ) => Effect.Effect<Record, TrustError>
  readonly isTrusted: (record: Record) => Effect.Effect<boolean>
  readonly approve: (record: Record) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@rika/extensions/mcp-trust/Service") {}

const digest = (crypto: Crypto.Crypto, value: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError((cause) => TrustError.make({ operation: "fingerprint", message: String(cause) })),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const path = yield* Path.Path
    const approved = new Set<string>()
    const create = Effect.fn("McpTrust.create")(function* (
      workspaceIdentity: string,
      workspaceRoot: string,
      server: LocalServer,
    ) {
      const environmentNameFingerprint = yield* digest(crypto, Object.keys(server.environment).toSorted().join("\n"))
      const effectiveCwd = path.resolve(workspaceRoot, server.cwd ?? ".")
      const base = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))([
        workspaceIdentity,
        server.name,
        server.command,
        server.args,
        environmentNameFingerprint,
        effectiveCwd,
        server.sourceDigest,
      ]).pipe(Effect.orDie)
      const fingerprint = yield* digest(crypto, base)
      return {
        workspaceIdentity,
        server: server.name,
        command: server.command,
        args: server.args,
        environmentNameFingerprint,
        effectiveCwd,
        sourceDigest: server.sourceDigest,
        fingerprint,
      }
    })
    return Service.of({
      create,
      isTrusted: (record) => Effect.succeed(approved.has(record.fingerprint)),
      approve: (record) =>
        Effect.sync(() => {
          approved.add(record.fingerprint)
        }),
    })
  }),
)

export const testLayer = (initial: ReadonlyArray<string> = []) =>
  Layer.effect(
    Service,
    Effect.sync(() => {
      const approved = new Set(initial)
      return Service.of({
        create: () => Effect.fail(TrustError.make({ operation: "create", message: "Not configured in test layer" })),
        isTrusted: (record) => Effect.succeed(approved.has(record.fingerprint)),
        approve: (record) =>
          Effect.sync(() => {
            approved.add(record.fingerprint)
          }),
      })
    }),
  )
