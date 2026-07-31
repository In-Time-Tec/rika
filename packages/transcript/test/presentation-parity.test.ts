import * as ToolPolicy from "@rika/coding-tools/coding-tool-policy"
import { describe, expect, it } from "vitest"
import { Presentation } from "../src/schema/transcript-presentation-model"

const shape = (ast: {
  readonly _tag: string
  readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey; readonly type: never }>
  readonly types?: ReadonlyArray<never>
  readonly literal?: unknown
}): unknown => {
  if (ast._tag === "Objects")
    return { object: (ast.propertySignatures ?? []).map((property) => [String(property.name), shape(property.type)]) }
  if (ast._tag === "Union") return { union: (ast.types ?? []).map(shape) }
  if (ast._tag === "Literal") return { literal: ast.literal }
  return { tag: ast._tag }
}

describe("Presentation parity", () => {
  it("matches the ToolPolicy definition exactly", () => {
    expect(shape(Presentation.ast as never)).toEqual(shape(ToolPolicy.Presentation.ast as never))
  })
})
