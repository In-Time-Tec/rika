import { Cause, Option, Schema } from "effect"

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  const tagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(failure)
  return Option.isSome(tagged) ? tagged.value._tag : "Unknown"
}
