import { cruise } from "dependency-cruiser"
import { describe, expect, test } from "vitest"

describe("dependency-cruiser compatibility spike", () => {
  test("parses Effect syntax, workspace imports, prompt assets, and unit edges", async () => {
    const result = await cruise(
      ["tooling/repository-graph/test/fixtures/dependency-cruiser-spike/bun-workspace.ts"],
      { doNotFollow: { path: ".*" } },
      undefined,
      { tsConfig: { module: "ESNext", moduleResolution: "Bundler" } },
    )
    if (typeof result.output === "string") throw new Error(result.output)
    const module = result.output.modules[0]
    expect(module?.dependencies.map((dependency) => dependency.module).toSorted()).toEqual([
      "./prompt.prompt.txt",
      "@rika/config/data-root",
      "effect",
    ])
    expect(
      module?.dependencies.find((dependency) => dependency.module === "./prompt.prompt.txt")?.couldNotResolve,
    ).toBe(false)
    expect(
      module?.dependencies.find((dependency) => dependency.module === "@rika/config/data-root")?.couldNotResolve,
    ).toBe(true)
  })
})
