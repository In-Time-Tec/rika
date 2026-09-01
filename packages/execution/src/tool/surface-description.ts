import { Option, Schema, SchemaAST } from "effect"
import type { Tool } from "effect/unstable/ai"

const BoundRepresentation = Schema.Struct({
  id: Schema.String,
  payload: Schema.NullOr(
    Schema.Struct({
      exclusiveMinimum: Schema.optionalKey(Schema.Finite),
      minimum: Schema.optionalKey(Schema.Finite),
      exclusiveMaximum: Schema.optionalKey(Schema.Finite),
      maximum: Schema.optionalKey(Schema.Finite),
    }),
  ),
})

interface Bounds {
  readonly minimum?: number
  readonly maximum?: number
  readonly length?: number
}

const boundsFrom = (check: SchemaAST.Check<never>): Bounds => {
  const decoded = Schema.decodeUnknownOption(BoundRepresentation)(check.annotations?.representation)
  if (Option.isNone(decoded) || decoded.value.payload === null) return {}
  const { id, payload } = decoded.value
  if (id === "effect/schema/isGreaterThan" && payload.exclusiveMinimum !== undefined)
    return { minimum: payload.exclusiveMinimum + 1 }
  if (id === "effect/schema/isGreaterThanOrEqualTo" && payload.minimum !== undefined)
    return { minimum: payload.minimum }
  if (id === "effect/schema/isLessThan" && payload.exclusiveMaximum !== undefined)
    return { maximum: payload.exclusiveMaximum - 1 }
  if (id === "effect/schema/isLessThanOrEqualTo" && payload.maximum !== undefined) return { maximum: payload.maximum }
  if (id === "effect/schema/isLengthBetween" && payload.minimum === payload.maximum && payload.minimum !== undefined)
    return { length: payload.minimum }
  return {}
}

const boundsOf = (ast: SchemaAST.AST): string | undefined => {
  const bounds = (ast.checks ?? []).reduce<Bounds>((current, check) => Object.assign(current, boundsFrom(check)), {})
  if (ast._tag === "Arrays")
    return bounds.length === undefined
      ? "[]"
      : `[${Array.from({ length: bounds.length }, (_, index) => (index === 0 ? "start" : "end")).join(", ")}]`
  if (bounds.minimum !== undefined && bounds.maximum !== undefined) return `${bounds.minimum}-${bounds.maximum}`
  if (bounds.maximum !== undefined) return `<=${bounds.maximum}`
  if (bounds.minimum !== undefined) return `>=${bounds.minimum}`
  return undefined
}

const fieldDescription = (field: SchemaAST.PropertySignature): string => {
  const members =
    field.type._tag === "Union" ? field.type.types.filter((member) => member._tag !== "Undefined") : [field.type]
  const nullable = members.some((member) => member._tag === "Literal" && member.literal === null)
  const bounded = members.map(boundsOf).find((value) => value !== undefined)
  let suffix = bounded ?? ""
  if (nullable) suffix = suffix.length === 0 ? "null" : `${suffix}|null`
  return suffix.length === 0 ? String(field.name) : `${String(field.name)}: ${suffix}`
}

export const describeNativeToolSurface = (tools: ReadonlyArray<Tool.Any>): string =>
  tools
    .map((tool) => {
      const ast = tool.parametersSchema.ast
      if (ast._tag !== "Objects") throw new Error(`${tool.name} parameters are not a struct`)
      return `${tool.name}({ ${ast.propertySignatures.map(fieldDescription).join(", ")} })`
    })
    .join("\n")
