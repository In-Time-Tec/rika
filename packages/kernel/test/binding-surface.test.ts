import { describe, expect, it } from "vitest"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { make, surface } from "../src/binding/binding-modules"

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
    const described = mounted.map(
      (module) => `rika.${module.name}: ${module.operations.map((operation) => operation.name).join(", ")}`,
    )
    expect(surface.split("\n")).toEqual(described)
  })
})
