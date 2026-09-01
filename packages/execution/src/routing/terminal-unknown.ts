import { Schema } from "effect"

export const terminalUnknownKind = "rika-native-tool-terminal-unknown"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())

/** Stable payload recorded when a durable native tool reaches a terminal unknown outcome. */
export const TerminalUnknownPayload = Schema.Struct({
  sourceOperationKey: NonEmptyString,
  toolCallId: NonEmptyString,
  toolName: NonEmptyString,
})
export type TerminalUnknownPayload = typeof TerminalUnknownPayload.Type

/** Generalist nested-operation input used to recover the marker without relying on its ordinal. */
export const TerminalUnknownInput = Schema.Struct({
  kind: Schema.Literal(terminalUnknownKind),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  payload: TerminalUnknownPayload,
})
export type TerminalUnknownInput = typeof TerminalUnknownInput.Type

/** Operator-authored terminal marker failure used when the ambiguous effect is aborted. */
export const TerminalUnknownFailure = Schema.TaggedStruct("UserAbortedUnknownOperation", {
  message: Schema.NonEmptyString,
})
export type TerminalUnknownFailure = typeof TerminalUnknownFailure.Type
