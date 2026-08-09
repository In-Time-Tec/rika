import { describe, expect, it } from "vitest"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { cellInstructions, make, surface } from "../src/binding/binding-modules"

const options = {
  workspace: "/workspace",
  workspaceDigest: "digest",
  trustMode: "trusted-local",
  servers: [] as ReadonlyArray<McpDiscovery.ConfiguredServer>,
} as never

describe("mounted surface", () => {
  it("describes every module and operation a cell can reach", () => {
    // A model only uses what it is told it has, and the description is prose while the surface is
    // code, so the two are compared rather than trusted to agree.
    const mounted = make({
      workspace: "/workspace",
      workspaceDigest: "digest",
      trustMode: "trusted-local",
      servers: [] as ReadonlyArray<McpDiscovery.ConfiguredServer>,
    } as never)
    const lines = surface({
      workspace: "/workspace",
      workspaceDigest: "digest",
      trustMode: "trusted-local",
      servers: [] as ReadonlyArray<McpDiscovery.ConfiguredServer>,
    } as never).split("\n")
    expect(lines).toHaveLength(mounted.length)
    for (const [index, module] of mounted.entries()) {
      const line = lines[index] ?? ""
      expect(line).toContain(`rika.${module.name} -> `)
      for (const operation of module.operations) expect(line).toContain(`${operation.name}(`)
    }
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
