import { Encoding, Option, Result, Schema } from "effect"

const prefix = "bxa_"
const RawAssignmentIdentity = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,255}$/))
export const BoxAssignmentGeneration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Payload = Schema.Tuple([RawAssignmentIdentity, BoxAssignmentGeneration])
const JsonPayload = Schema.fromJsonString(Payload)

const EncodedBoxAssignmentIdentity = Schema.String.check(
  Schema.isPattern(/^bxa_[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(256),
)

export interface DecodedBoxAssignmentIdentity {
  readonly rawAssignmentId: string
  readonly generation: number
}

const encodeCanonical = (rawAssignmentId: string, generation: number): Option.Option<string> => {
  const payload = Schema.encodeOption(JsonPayload)([rawAssignmentId, generation])
  if (Option.isNone(payload)) return Option.none()
  return Schema.decodeOption(EncodedBoxAssignmentIdentity)(`${prefix}${Encoding.encodeBase64Url(payload.value)}`)
}

const decodeCanonical = (value: string): Option.Option<DecodedBoxAssignmentIdentity> => {
  const identity = Schema.decodeOption(EncodedBoxAssignmentIdentity)(value)
  if (Option.isNone(identity)) return Option.none()
  const json = Result.getOrUndefined(Encoding.decodeBase64UrlString(identity.value.slice(prefix.length)))
  if (json === undefined) return Option.none()
  const payload = Schema.decodeOption(JsonPayload)(json)
  if (Option.isNone(payload)) return Option.none()
  const canonical = encodeCanonical(payload.value[0], payload.value[1])
  if (Option.isNone(canonical) || canonical.value !== identity.value) return Option.none()
  return Option.some({ rawAssignmentId: payload.value[0], generation: payload.value[1] })
}

export const BoxAssignmentIdentity = EncodedBoxAssignmentIdentity.check(
  Schema.makeFilter((identity) =>
    Option.isSome(decodeCanonical(identity)) ? [] : [{ path: [], issue: "Box assignment identity must be canonical" }],
  ),
)
export type BoxAssignmentIdentity = typeof BoxAssignmentIdentity.Type

export const encodeBoxAssignmentIdentity = (input: {
  readonly rawAssignmentId: string
  readonly generation: number
}): Option.Option<BoxAssignmentIdentity> => {
  const identity = encodeCanonical(input.rawAssignmentId, input.generation)
  return Option.isNone(identity) ? identity : Schema.decodeOption(BoxAssignmentIdentity)(identity.value)
}

export const decodeBoxAssignmentIdentity = (value: string): Option.Option<DecodedBoxAssignmentIdentity> => {
  const identity = Schema.decodeOption(BoxAssignmentIdentity)(value)
  return Option.isNone(identity) ? Option.none() : decodeCanonical(identity.value)
}
