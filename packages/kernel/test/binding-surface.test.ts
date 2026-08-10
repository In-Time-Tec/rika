import { describe, expect, it } from "vitest"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { Schema } from "effect"
import { cellInstructions, make, surfaceOf } from "../src/binding/binding-modules"

const options = {
  workspace: "/workspace",
  workspaceDigest: "digest",
  trustMode: "trusted-local",
  servers: [] as ReadonlyArray<McpDiscovery.ConfiguredServer>,
} as never

describe("mounted surface", () => {
  it("names each field, its allowed values, and the shapes a union accepts", () => {
    // Asserting only on names derived from the same modules passes an implementation that prints no
    // arguments at all, which is the whole thing this description exists to carry.
    const probe = [
      {
        name: "probe",
        operations: [
          { name: "one", input: Schema.Struct({ path: Schema.String, mode: Schema.Literals(["a", "b"]) }) },
          {
            name: "two",
            input: Schema.Struct({
              pick: Schema.Union([Schema.Struct({ kind: Schema.String }), Schema.Struct({ id: Schema.Int })]),
            }),
          },
          { name: "none", input: Schema.Struct({}) },
        ],
      },
    ] as unknown as Parameters<typeof surfaceOf>[0]
    expect(surfaceOf(probe)).toBe(
      '//   rika.probe -> one({ path, mode: "a"|"b" }), two({ pick: { kind }|{ id } }), none()',
    )
  })

  it("names the one tool that exists and shows the bindings as code", () => {
    // A model answered with "rika.workspace" as a tool name when the bindings read as a list, and
    // guessed a string argument when only their names were shown. Both cost a live turn.
    const text = cellInstructions(options)
    expect(text).toContain("exactly one tool, named typescript")
    expect(text).toContain("It is not a tool")
    expect(text).toContain('await rika.workspace.search({ pattern: "secret" })')
    expect(text).toContain("search({ pattern, regex })")
  })

  it("names the values a field will accept when it accepts only a few", () => {
    // A model spent a turn inventing a scope that does not exist, and another guessing at profiles.
    // A field with a closed set of values is cheaper to name than to discover.
    const text = surfaceOf(make(options))
    expect(text).toContain('scope: "thread"|"workspace"|"global"')
    expect(text).toContain('profile: "Oracle"')
  })

  it("refuses to describe an operation whose input is not a struct", () => {
    // Printing an empty argument list would tell a model the operation takes nothing, which it would
    // believe. No binding does this today, so the guard is what keeps it that way.
    const odd = [{ name: "odd", operations: [{ name: "one", input: Schema.String }] }] as unknown as Parameters<
      typeof surfaceOf
    >[0]
    expect(() => surfaceOf(odd)).toThrow("rika.odd.one has an input that is not a struct")
  })
})

it("names the tag that tells one shape of an argument from another", () => {
  // A model shown several alternatives with nothing to choose between them guesses, and a tag
  // carries one `literal` rather than a list, so reading only lists dropped the deciding value.
  const surface = surfaceOf(make({ workspace: "/w", workspaceDigest: "", trustMode: "trusted-local", servers: [] }))
  const threads = surface.split("\n").find((line) => line.includes("rika.threads")) ?? ""
  expect(threads).toContain('mode: "overview"')
  expect(threads).toContain('mode: "recent"')
  expect(threads).toContain('mode: "relevant"')
  expect(threads).toContain('mode: "subtree"')
})

it("shows an example whose fields the surface actually has", () => {
  // An example is the first thing a model copies, so a field it invents is a defect that costs a
  // turn. `search` returns { text, truncated }, and an earlier draft of this example read `matches`.
  const instructions = cellInstructions({
    workspace: "/w",
    workspaceDigest: "",
    trustMode: "trusted-local",
    servers: [],
  } as never)
  expect(instructions).toContain("found.text")
  expect(instructions).not.toContain("found.matches")
})
