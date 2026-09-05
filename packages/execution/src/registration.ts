import { Pins } from "generalist"
import { Errors, ExecutableRegistration } from "generalist/runtime"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { Effect, Function, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Catalog } from "@rika/extensions/mcp-capability-contract"

export interface Codec<A, I> {
  readonly codec: string
  readonly version: string
  readonly payload: Schema.Codec<A, I>
  readonly identity: { readonly contract: string; readonly version: number }
}

const codec = <A, I>(name: string, version: string, payload: Schema.Codec<A, I>): Codec<A, I> => ({
  codec: name,
  version,
  payload,
  identity: { contract: name, version: Number(version) },
})

const ToolPayload = Schema.Struct({
  name: Schema.String,
  description: Schema.UndefinedOr(Schema.String),
  schema: Schema.Record(Schema.String, Schema.Unknown),
})

const ApplicationContextPayload = Schema.Struct({
  workspace: Schema.String.check(Schema.isNonEmpty()),
  mcp: Schema.optionalKey(Catalog),
  executionIdentity: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.String.check(Schema.isNonEmpty()),
      turnId: Schema.String.check(Schema.isNonEmpty()),
    }),
  ),
  executionRoute: ExecutionRoute.ExecutionRouteSnapshot,
})

const { role: _role, ...modelRegistryFields } = ExecutionRoute.ExecutionRouteModelSnapshot.fields

const ModelRegistryRoutePayload = Schema.Struct(modelRegistryFields)

export const codecs = {
  applicationContext: codec("rika-application-context", "2", ApplicationContextPayload),
  modelRoute: codec("rika-model-route", "1", ExecutionRoute.ExecutionRouteModelSnapshot),
  modelRegistryRoute: codec("rika-model-registry-route", "1", ModelRegistryRoutePayload),
  compaction: codec("rika-compaction", "1", ExecutableRegistration.CompactionPolicy),
  tool: codec("rika-tool", "1", ToolPayload),
}

export const toolPayload = (value: Tool.Any): typeof ToolPayload.Type => {
  const metadata = Schema.decodeUnknownSync(
    Schema.Struct({ name: Schema.String, description: Schema.UndefinedOr(Schema.String) }),
  )(value)
  return { ...metadata, schema: Tool.getJsonSchema(value) }
}

export const toolPin = (value: Tool.Any): Pins.CapabilityPin =>
  Pins.makeCapability({ ...codecs.tool.identity, ...toolPayload(value) })

const makeImpl = <A, I>(
  definition: Codec<A, I>,
  pin: string,
  payload: A,
): ExecutableRegistration.ExecutableRegistration => ({
  pin,
  codec: definition.codec,
  version: definition.version,
  payload: Schema.encodeSync(definition.payload)(payload),
})

export const make: {
  <A>(pin: string, payload: A): <I>(definition: Codec<A, I>) => ExecutableRegistration.ExecutableRegistration
  <A, I>(definition: Codec<A, I>, pin: string, payload: A): ExecutableRegistration.ExecutableRegistration
} = Function.dual(3, makeImpl)

const decodeImpl = <A, I>(
  definition: Codec<A, I>,
  registration: ExecutableRegistration.ExecutableRegistration,
): Effect.Effect<A, Errors.ExecutableRegistrationInvalid> =>
  registration.codec !== definition.codec || registration.version !== definition.version
    ? Errors.ExecutableRegistrationInvalid.make({
        message: `expected ${definition.codec}@${definition.version} for ${registration.pin}`,
      })
    : Schema.decodeUnknownEffect(definition.payload, { onExcessProperty: "error" })(registration.payload).pipe(
        Effect.mapError((cause) =>
          Errors.ExecutableRegistrationInvalid.make({ message: `${definition.codec}: ${String(cause)}` }),
        ),
      )

export const decode: {
  (
    registration: ExecutableRegistration.ExecutableRegistration,
  ): <A, I>(definition: Codec<A, I>) => Effect.Effect<A, Errors.ExecutableRegistrationInvalid>
  <A, I>(
    definition: Codec<A, I>,
    registration: ExecutableRegistration.ExecutableRegistration,
  ): Effect.Effect<A, Errors.ExecutableRegistrationInvalid>
} = Function.dual(2, decodeImpl)

const readImpl = <A, I>(
  definition: Codec<A, I>,
  registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>,
): Effect.Effect<A, Errors.ExecutableRegistrationInvalid | Errors.ExecutableRegistrationMissing> => {
  const matching = registrations.filter(
    (registration) => registration.codec === definition.codec && registration.version === definition.version,
  )
  if (matching.length === 0) return Errors.ExecutableRegistrationMissing.make({ pin: definition.codec })
  if (matching.length > 1)
    return Errors.ExecutableRegistrationInvalid.make({
      message: `duplicate ${definition.codec} registrations`,
    })
  return Schema.decodeUnknownEffect(definition.payload, { onExcessProperty: "error" })(matching[0]!.payload).pipe(
    Effect.mapError((cause) =>
      Errors.ExecutableRegistrationInvalid.make({ message: `${definition.codec}: ${String(cause)}` }),
    ),
  )
}

export const read: {
  (
    registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>,
  ): <A, I>(
    definition: Codec<A, I>,
  ) => Effect.Effect<A, Errors.ExecutableRegistrationInvalid | Errors.ExecutableRegistrationMissing>
  <A, I>(
    definition: Codec<A, I>,
    registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>,
  ): Effect.Effect<A, Errors.ExecutableRegistrationInvalid | Errors.ExecutableRegistrationMissing>
} = Function.dual(2, readImpl)

export const verify = (options: {
  readonly expected: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly actual: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly required: ReadonlySet<string>
}): Effect.Effect<void, Errors.ExecutableRegistrationInvalid | Errors.ExecutableRegistrationMissing> =>
  Effect.gen(function* () {
    const admitted = new Map(
      options.expected.map((registration) => [registration.pin, ExecutableRegistration.digest(registration)] as const),
    )
    const seen = new Set<string>()
    for (const registration of options.actual) {
      if (seen.has(registration.pin))
        return yield* Errors.ExecutableRegistrationInvalid.make({
          message: `duplicate registration pin: ${registration.pin}`,
        })
      seen.add(registration.pin)
      if (!options.required.has(registration.pin))
        return yield* Errors.ExecutableRegistrationInvalid.make({
          message: `registration pin is not required by the executable: ${registration.pin}`,
        })
      const digest = admitted.get(registration.pin)
      if (digest === undefined)
        return yield* Errors.ExecutableRegistrationInvalid.make({
          message: `registration pin is outside the admitted Rika executable: ${registration.pin}`,
        })
      if (digest !== ExecutableRegistration.digest(registration))
        return yield* Errors.ExecutableRegistrationInvalid.make({
          message: `registration payload changed: ${registration.pin}`,
        })
    }
    for (const pin of options.required) {
      if (!seen.has(pin)) return yield* Errors.ExecutableRegistrationMissing.make({ pin })
    }
  })
