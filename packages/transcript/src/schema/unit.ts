import { Schema } from "effect"
import { Content } from "./presentation"

const OrderSequence = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
)
const OrderPart = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const WellFormedString = Schema.String.check(Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/))
const WellFormedNonEmptyString = WellFormedString.check(Schema.isMinLength(1))

export const UnitOrderSegment = Schema.Struct({
  sequence: OrderSequence,
  part: OrderPart,
  key: WellFormedNonEmptyString,
})
export type UnitOrderSegment = typeof UnitOrderSegment.Type

export const UnitOrder = Schema.NonEmptyArray(UnitOrderSegment)
export type UnitOrder = typeof UnitOrder.Type

export const Unit = Schema.Struct({
  key: WellFormedNonEmptyString,
  turnId: WellFormedString,
  parentId: Schema.optionalKey(WellFormedString),
  modelResponseId: Schema.optionalKey(WellFormedNonEmptyString),
  order: UnitOrder,
  revision: Schema.Finite,
  executionOutcome: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "failed", "cancelled"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  content: Content,
})
export type Unit = typeof Unit.Type
