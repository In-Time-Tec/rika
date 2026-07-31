import { describe, expect, test } from "vitest"
import { classifyTestKind, scanImports } from "./repository-graph"

describe("repository graph classification", () => {
  test("classifies every supported test class", () => {
    expect(classifyTestKind("packages/a/src/a.test.ts")).toBe("unit")
    expect(classifyTestKind("apps/a/src/a.integration.test.ts")).toBe("integration")
    expect(classifyTestKind("apps/a/test/a.tui.test.ts")).toBe("tui")
    expect(classifyTestKind("apps/a/test/a.proc.test.ts")).toBe("proc")
    expect(classifyTestKind("apps/a/test/a.native.test.ts")).toBe("native")
    expect(classifyTestKind("apps/a/test/a.journey.test.ts")).toBe("journey")
    expect(classifyTestKind("tooling/a/test/fixtures/example.ts")).toBe("fixture")
  })

  test("enumerates static and dynamic imports without semantic indexing", () => {
    expect(
      scanImports(
        'import x from "./repository-graph"; export { y } from "./repository-graph.test"; await import("./dependency-cruiser-spike.test")',
      ),
    ).toEqual([
      { specifier: "./dependency-cruiser-spike.test", kind: "dynamic-import" },
      { specifier: "./repository-graph", kind: "import" },
      { specifier: "./repository-graph.test", kind: "import" },
    ])
  })
})
