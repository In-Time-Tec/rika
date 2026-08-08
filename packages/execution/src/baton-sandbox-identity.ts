import type { SandboxExecutor } from "@batonfx/core"
import { Errors } from "@batonfx/runtime"
import { Effect, Function, Schema } from "effect"

export const Identity = Schema.Struct({
  language: Schema.Literal("javascript"),
  implementation: Schema.String.check(Schema.isNonEmpty()),
  version: Schema.String.check(Schema.isNonEmpty()),
  memoryBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  stackBytes: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type Identity = typeof Identity.Type

export const Registration = Schema.Struct({
  ...Identity.fields,
  workspace: Schema.String.check(Schema.isNonEmpty()),
})

export type Registration = typeof Registration.Type

export const payload: {
  (workspace: string): (identity: Identity) => Registration
  (identity: Identity, workspace: string): Registration
} = Function.dual(
  2,
  (identity: Identity, workspace: string): Registration => ({
    language: identity.language,
    implementation: identity.implementation,
    version: identity.version,
    memoryBytes: identity.memoryBytes,
    stackBytes: identity.stackBytes,
    workspace,
  }),
)

export const decode = (
  sandbox: SandboxExecutor.Interface,
): Effect.Effect<Identity, Errors.ExecutableRegistrationInvalid> =>
  Schema.decodeUnknownEffect(Identity, { onExcessProperty: "error" })(sandbox.identity).pipe(
    Effect.mapError((cause) =>
      Errors.ExecutableRegistrationInvalid.make({
        message: `sandbox executor identity is not admitted by Rika: ${String(cause)}`,
      }),
    ),
  )
