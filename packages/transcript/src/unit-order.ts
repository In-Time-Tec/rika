import { Function } from "effect"
import type { Unit, UnitOrder, UnitOrderSegment } from "./schema"

const numberWidth = 16
const edgeSequence = 0
const edgePart = 0
const wellFormedString = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/

const assertKey = (value: string): void => {
  if (value.length === 0 || !wellFormedString.test(value))
    throw new RangeError("Unit order keys must be well-formed text")
}

const assertNumber = (value: number, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`Unit order numbers must be safe integers greater than or equal to ${minimum}`)
}

const assertSegment = (segment: UnitOrderSegment): void => {
  assertNumber(segment.sequence, -1)
  assertNumber(segment.part, 0)
  assertKey(segment.key)
}

const assertOrder = (order: UnitOrder): void => {
  if (order.length === 0) throw new RangeError("Unit orders must contain at least one segment")
  for (const segment of order) assertSegment(segment)
}

const encodeNumber = (value: number, offset: number): string =>
  (BigInt(value) + BigInt(offset)).toString(10).padStart(numberWidth, "0")

const encodeKey = (value: string): string => {
  let encoded = ""
  for (let index = 0; index < value.length; index += 1) encoded += value.charCodeAt(index).toString(16).padStart(4, "0")
  return `${encoded}/`
}

const encodeSegment = (segment: UnitOrderSegment): string =>
  `${encodeNumber(segment.sequence, 1)}${encodeNumber(segment.part, 0)}${encodeKey(segment.key)}`

const immutableOrder = (segments: ReadonlyArray<UnitOrderSegment>): UnitOrder =>
  Object.freeze(segments.map((segment) => Object.freeze({ ...segment }))) as UnitOrder

export const unitOrder: {
  (key: string, sequence: number, part?: number): UnitOrder
  (sequence: number, part?: number): (key: string) => UnitOrder
} = Function.dual(
  (args) => typeof args[0] === "string",
  (key: string, sequence: number, part = 0): UnitOrder => {
    const segment = { sequence, part, key }
    assertSegment(segment)
    return immutableOrder([segment])
  },
)

export const childOrder: {
  (parent: UnitOrder, childExecutionId: string, local: UnitOrder): UnitOrder
  (childExecutionId: string, local: UnitOrder): (parent: UnitOrder) => UnitOrder
} = Function.dual(3, (parent: UnitOrder, childExecutionId: string, local: UnitOrder): UnitOrder => {
  assertOrder(parent)
  assertKey(childExecutionId)
  assertOrder(local)
  return immutableOrder([
    ...parent,
    { sequence: edgeSequence, part: edgePart, key: `@child:${childExecutionId}` },
    ...local,
  ])
})

export const localOrder = (order: UnitOrder): UnitOrder => {
  assertOrder(order)
  return immutableOrder([order[order.length - 1]!])
}

export const encodeUnitOrder = (order: UnitOrder): string => {
  assertOrder(order)
  return order.map(encodeSegment).join("")
}

export const compareUnitOrder: {
  (left: UnitOrder, right: UnitOrder): number
  (right: UnitOrder): (left: UnitOrder) => number
} = Function.dual(2, (left: UnitOrder, right: UnitOrder): number => {
  const encodedLeft = encodeUnitOrder(left)
  const encodedRight = encodeUnitOrder(right)
  if (encodedLeft < encodedRight) return -1
  if (encodedLeft > encodedRight) return 1
  return 0
})

export const hasIntrinsicOrder = (unit: Unit): boolean => unit.order[unit.order.length - 1]?.key === unit.key
