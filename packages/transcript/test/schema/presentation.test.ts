import * as ToolPolicy from "@rika/coding-tools/coding-tool-policy"
import { SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import { Presentation } from "../../src/schema/presentation"

type SchemaContract =
  | { readonly object: ReadonlyArray<readonly [string, SchemaContract]> }
  | { readonly union: ReadonlyArray<SchemaContract> }
  | { readonly literal: SchemaAST.LiteralValue }
  | { readonly tag: SchemaAST.AST["_tag"] }

const contractOf = (ast: SchemaAST.AST): SchemaContract => {
  if (ast._tag === "Objects")
    return { object: ast.propertySignatures.map((property) => [String(property.name), contractOf(property.type)]) }
  if (ast._tag === "Union") return { union: ast.types.map(contractOf) }
  if (ast._tag === "Literal") return { literal: ast.literal }
  return { tag: ast._tag }
}

describe("Presentation parity", () => {
  it("matches the ToolPolicy definition exactly", () => {
    expect(contractOf(Presentation.ast)).toEqual(contractOf(ToolPolicy.Presentation.ast))
  })
})
