import { describe, expect, it } from "vitest"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { Schema } from "effect"
import { cellInstructions, surface, surfaceOf } from "../src/binding/binding-modules"

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
    const text = surface(options)
    expect(text).toContain('scope: "thread"|"workspace"|"global"')
    expect(text).toContain('profile: "Oracle"')
  })
})
