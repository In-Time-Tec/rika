import { Schema } from "effect"

export const decode = <const S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.decodeUnknownSync(schema)
export const encode = <const S extends Schema.ConstraintEncoder<unknown>>(schema: S) => Schema.encodeSync(schema)
