import { Schema } from "effect"

export const ModeId = Schema.NonEmptyString
export type ModeId = typeof ModeId.Type
